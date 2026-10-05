import { execFileSync } from 'child_process';

/**
 * Git refuses to author a commit without an identity, exiting 128 with
 * "Author identity unknown". An operator's machine has one configured globally;
 * a fresh CI checkout does not, because `actions/checkout` only configures
 * credentials. A commit that dies that way loses the whole run after the work
 * is already done, and the failure surfaces only as an exit status, so the
 * agent that owns the commit settles the question instead of relying on ambient
 * configuration from a step that may never have run.
 */
const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

function configured(cwd: string, key: string, env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd, encoding: 'utf-8', env: env ?? process.env }).trim();
  } catch {
    return '';
  }
}

export type IdentityResult = { ok: true; author: string; configured: boolean } | { ok: false; reason: string };

/**
 * Makes sure this repository can author a commit. An identity that is already
 * configured is left alone, so a real contributor's name and email are never
 * replaced by the bot's; only a repository with no identity at all gets one,
 * and that identity is written to the repository's own config rather than to
 * the machine's.
 */
export function ensureCommitIdentity(cwd: string = process.cwd(), env?: NodeJS.ProcessEnv): IdentityResult {
  const name = configured(cwd, 'user.name', env);
  const email = configured(cwd, 'user.email', env);

  if (name && email) {
    return { ok: true, author: `${name} <${email}>`, configured: true };
  }

  const writeEnv = { ...(env ?? process.env) };
  try {
    if (!name) execFileSync('git', ['config', 'user.name', BOT_NAME], { cwd, stdio: 'pipe', env: writeEnv });
    if (!email) execFileSync('git', ['config', 'user.email', BOT_EMAIL], { cwd, stdio: 'pipe', env: writeEnv });
  } catch (e: any) {
    return { ok: false, reason: `could not configure a commit identity: ${e.message?.trim() || e}` };
  }

  const applied = `${configured(cwd, 'user.name', writeEnv)} <${configured(cwd, 'user.email', writeEnv)}>`;
  if (applied === ' <>') {
    return { ok: false, reason: 'git still reports no usable identity' };
  }
  return { ok: true, author: applied, configured: false };
}