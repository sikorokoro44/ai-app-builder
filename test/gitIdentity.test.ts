import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureCommitIdentity } from '../scripts/live/gitIdentity.ts';

/**
 * Reproduces the checkout a GitHub Actions job starts from: a git repository with
 * credentials but no author identity, so `git commit` exits 128.
 */
function ciRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'builder-git-identity-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  writeFileSync(join(dir, 'empty.gitconfig'), '');
  return dir;
}

const noAmbientConfig = (dir: string) => ({
  GIT_CONFIG_GLOBAL: join(dir, 'empty.gitconfig'),
  GIT_CONFIG_SYSTEM: join(dir, 'empty.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0'
});

test('a checkout with no identity cannot commit, which is what the cloud run hit', (t) => {
  const dir = ciRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'app.txt'), 'generated');
  execFileSync('git', ['add', '-A'], { cwd: dir, env: { ...process.env, ...noAmbientConfig(dir) } });

  let status = 0;
  try {
    execFileSync('git', ['commit', '-m', 'no identity'], { cwd: dir, env: { ...process.env, ...noAmbientConfig(dir) }, stdio: 'pipe' });
  } catch (e: any) {
    status = e.status;
  }
  assert.strictEqual(status, 128, 'git must refuse the commit so the fix has something to repair');
});

test('the bot identity is written to the repository, not to the machine', (t) => {
  const dir = ciRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const env = { ...process.env, ...noAmbientConfig(dir) };
  const result = ensureCommitIdentity(dir, env);
  assert.ok(result.ok, result.ok ? '' : result.reason);
  assert.strictEqual(result.configured, false, 'no identity existed, so the bot had to supply one');

  // The commit succeeds and carries the bot identity the fix installed.
  writeFileSync(join(dir, 'app.txt'), 'generated');
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-m', 'builder: generated app sources'], { cwd: dir, env, stdio: 'pipe' });

  const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: dir, encoding: 'utf-8' }).trim();
  assert.ok(author.includes('github-actions[bot]'), `expected the bot identity, got ${author}`);

  // Machine-wide config was not touched: it is still empty.
  const globalConfig = execFileSync('git', ['config', '--file', join(dir, 'empty.gitconfig'), '--list'], { env: noAmbientConfig(dir), encoding: 'utf-8' });
  assert.strictEqual(globalConfig.trim(), '', 'no identity may be written outside the repository');
});

test('an identity that already exists is kept, so a real contributor is never overwritten', (t) => {
  const dir = ciRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['config', 'user.name', 'Rin Okazaki'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'rin@example.com'], { cwd: dir });

  const result = ensureCommitIdentity(dir);
  assert.ok(result.ok);
  assert.strictEqual(result.author, 'Rin Okazaki <rin@example.com>');
});

test('a half-configured identity is completed rather than accepted', (t) => {
  const dir = ciRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['config', 'user.name', 'Rin Okazaki'], { cwd: dir });

  const env = { ...process.env, ...noAmbientConfig(dir) };
  const result = ensureCommitIdentity(dir, env);
  assert.ok(result.ok, result.ok ? '' : result.reason);

  writeFileSync(join(dir, 'app.txt'), 'generated');
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-m', 'half configured'], { cwd: dir, env, stdio: 'pipe' });
  const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: dir, encoding: 'utf-8' }).trim();
  assert.strictEqual(author, 'Rin Okazaki <41898282+github-actions[bot]@users.noreply.github.com>');
});