import { execSync } from 'child_process';
import { readdirSync, readFileSync, statSync } from 'fs';

export const REQUIRED_REPO = 'sikorokoro44/ai-app-builder';
export const FORBIDDEN_REPOS = ['opencode-chat'];

export interface RepoGuardResult {
  ok: boolean;
  errors: string[];
  repo?: string;
  branch?: string;
  headSha?: string;
}

export function assertRepoSafety(cwd = process.cwd()): RepoGuardResult {
  const errors: string[] = [];
  let remote = '';
  try {
    remote = execSync('git remote get-url origin', { cwd, encoding: 'utf-8' }).trim();
  } catch (e) {
    errors.push('No git remote "origin" found');
    return { ok: false, errors };
  }
  remote = remote.replace(/\.git$/, '');
  const m = remote.match(/github\.com[:/]([^/]+\/[^/]+)/);
  const repo = m ? m[1] : '';
  if (repo !== REQUIRED_REPO) {
    errors.push(`Repository mismatch: expected ${REQUIRED_REPO}, got ${repo || remote}`);
  }
  for (const bad of FORBIDDEN_REPOS) {
    if (repo.includes(bad)) errors.push(`Forbidden repository detected: ${bad}`);
  }
  let branch = '';
  try { branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8' }).trim(); } catch { errors.push('Cannot determine branch'); }
  let headSha = '';
  try { headSha = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim(); } catch { errors.push('Cannot determine HEAD'); }
  return { ok: errors.length === 0, errors, repo, branch, headSha };
}

const SECRET_PATTERNS: { re: RegExp; name: string }[] = [
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/, name: 'GitHub token' },
  { re: /AKIA[0-9A-Z]{16}/, name: 'AWS access key' },
  { re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, name: 'Private key' },
  { re: /AIza[0-9A-Za-z\-_]{35}/, name: 'Google API key' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, name: 'Slack token' },
  { re: /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{16,}["']?/i, name: 'Credential assignment' }
];

export function scanForSecrets(text: string): string[] {
  const found: string[] = [];
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) found.push(p.name);
  }
  return found;
}

/** Directories whose contents are never scanned for credentials. */
export const SECRET_SCAN_EXCLUDE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.gradle', '.idea', '.npm', '.builder'
];

const MAX_SCAN_BYTES = 2_000_000;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|jar|zip|apk|aab|so|dex|keystore|jks|p12|pem|woff2?|ttf|otf|mp[34]|pdf)$/i;

/**
 * Recursively collects scannable files. A directory path given by the caller is
 * walked in full: skipping it outright would silently scan zero files and report
 * a clean result for a repository that is full of secrets.
 */
export function collectScannableFiles(cwd: string, paths: string[]): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];

  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 12) return;
    let st;
    try { st = statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      if (SECRET_SCAN_EXCLUDE_DIRS.includes(rel.split('/').pop() || '')) return;
      let entries: string[];
      try { entries = readdirSync(abs); } catch { return; }
      for (const name of entries.sort()) walk(`${abs}/${name}`, rel ? `${rel}/${name}` : name, depth + 1);
      return;
    }
    if (!st.isFile()) return;
    if (BINARY_EXT.test(rel)) return;
    if (st.size > MAX_SCAN_BYTES) return;
    out.push({ rel, abs });
  };

  for (const rel of paths) {
    if (!rel) continue;
    walk(`${cwd}/${rel}`, rel, 0);
  }
  return out;
}

export function assertNoSecretsInFiles(cwd = process.cwd(), paths: string[]): string[] {
  const problems: string[] = [];
  for (const file of collectScannableFiles(cwd, paths)) {
    try {
      const content = readFileSync(file.abs);
      // A NUL byte in the first block means binary, not a credential.
      if (content.subarray(0, 4096).includes(0)) continue;
      for (const h of scanForSecrets(content.toString('utf-8'))) {
        problems.push(`${file.rel}: possible ${h}`);
      }
    } catch { }
  }
  return problems;
}
