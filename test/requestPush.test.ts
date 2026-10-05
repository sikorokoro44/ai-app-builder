import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * The fleet writes to `main` while a request is being recorded: a run that
 * publishes its live state, or a coordinator that commits the generated app,
 * moves the branch between this process's fetch and its push. Recording the
 * request durably is the whole point of the request ledger, so losing the
 * commit to that race loses the idea.
 */
function run(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryRun(args: string[], cwd: string): boolean {
  try {
    run(args, cwd);
    return true;
  } catch {
    return false;
  }
}

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'builder-request-push-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const remote = join(root, 'origin.git');
  const work = join(root, 'work');
  run(['init', '-q', '--bare', '-b', 'main', remote], root);
  run(['init', '-q', '-b', 'main', work], root);
  run(['config', 'user.email', 'builder@example.com'], work);
  run(['config', 'user.name', 'Builder'], work);
  mkdirSync(join(work, '.builder/requests'), { recursive: true });
  writeFileSync(join(work, '.builder/requests/base.json'), '{"base":1}\n');
  run(['add', '-A'], work);
  run(['commit', '-qm', 'base'], work);
  run(['remote', 'add', 'origin', remote], work);
  run(['push', '-q', 'origin', 'main'], work);
  return { root, remote, work };
}

/** Someone else takes the branch while this process is preparing its commit. */
function moveRemoteBehindUs(remote: string, work: string, name: string) {
  run(['checkout', '-qb', `other-${name}`], work);
  writeFileSync(join(work, `.builder/requests/${name}.json`), `{"${name}":1}\n`);
  run(['add', '-A'], work);
  run(['commit', '-qm', `${name} moves main`], work);
  run(['push', '-q', 'origin', `other-${name}:main`], work);
  run(['checkout', '-q', 'main'], work);
}

// The behaviour under test, taken from scripts/requestRun.ts.
function pushWithRebase(cwd: string, branch: string, message: string, attempts = 4): string {
  run(['add', '-A', '.builder/requests'], cwd);
  if (!run(['status', '--porcelain', '.builder/requests'], cwd)) return 'nothing to push';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const staged = run(['diff', '--cached', '--name-only', '--', '.builder/requests'], cwd);
    if (staged) run(['commit', '-m', message, '--only', '--', '.builder/requests'], cwd);

    try {
      run(['push', 'origin', `HEAD:${branch}`], cwd);
      return 'pushed';
    } catch (e: any) {
      const detail = e.stderr?.toString() || e.message || '';
      const behind = /cannot lock ref|fetch first|non-fast-forward|rejected|stale info/i.test(detail);
      if (!behind || attempt === attempts) return `failed: ${detail.trim()}`;
      if (!tryRun(['fetch', 'origin', branch], cwd)) return 'failed: fetch';
      if (!tryRun(['rebase', `origin/${branch}`], cwd)) tryRun(['rebase', '--abort'], cwd);
    }
  }
  return 'failed: exhausted';
}

test('a branch that moves between fetch and push is replayed, not lost', (t) => {
  const { remote, work } = fixture(t);
  moveRemoteBehindUs(remote, work, 'live');
  writeFileSync(join(work, '.builder/requests/mine.json'), '{"mine":1}\n');

  const outcome = pushWithRebase(work, 'main', 'builder: record run request mine');
  assert.strictEqual(outcome, 'pushed');

  // Both the request and the commit that arrived underneath it survive.
  const files = run(['--git-dir', remote, 'ls-tree', '--name-only', '-r', 'main', '.builder/requests'], work).split('\n');
  assert.ok(files.includes('.builder/requests/mine.json'), 'the request must be on the remote');
  assert.ok(files.includes('.builder/requests/live.json'), "the other writer's commit must not be dropped");
});

test('a replay does not die re-committing work it already committed', (t) => {
  const { remote, work } = fixture(t);
  moveRemoteBehindUs(remote, work, 'live');
  writeFileSync(join(work, '.builder/requests/mine.json'), '{"mine":1}\n');

  assert.strictEqual(pushWithRebase(work, 'main', 'builder: record run request mine'), 'pushed');

  // The failure this guards: after a successful rebase the commit was already
  // carried, so committing again exits 1 with "nothing to commit" and the
  // request never reaches the remote.
  const log = run(['--git-dir', remote, 'log', '--oneline', '-3', 'main'], work);
  const requestCommits = log.split('\n').filter((l) => l.includes('record run request mine'));
  assert.strictEqual(requestCommits.length, 1, `expected exactly one request commit, got:\n${log}`);
});

test('three consecutive moves still land the request', (t) => {
  const { remote, work } = fixture(t);
  for (const name of ['one', 'two', 'three']) {
    moveRemoteBehindUs(remote, work, name);
    writeFileSync(join(work, `.builder/requests/${name}-mine.json`), `{"${name}-mine":1}\n`);
    const outcome = pushWithRebase(work, 'main', `builder: record run request ${name}`);
    assert.strictEqual(outcome, 'pushed', `the request for ${name} must survive`);
  }
  const files = run(['--git-dir', remote, 'ls-tree', '--name-only', '-r', 'main', '.builder/requests'], work);
  for (const name of ['one-mine', 'two-mine', 'three-mine']) {
    assert.ok(files.includes(`.builder/requests/${name}.json`), `${name} must be on the remote`);
  }
});

test('a rejection that is not a moved branch is reported, not retried forever', (t) => {
  const { remote, work } = fixture(t);
  // A branch that does not fast-forward is a moved branch. A refusal from the
  // remote that has nothing to do with the branch's position is not, and must
  // be reported rather than retried until the attempts run out.
  const hook = join(remote, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  writeFileSync(join(work, '.builder/requests/mine.json'), '{"mine":1}\n');

  const outcome = pushWithRebase(work, 'main', 'builder: record run request mine', 2);
  assert.ok(outcome.startsWith('failed'), `expected a reported failure, got ${outcome}`);
  assert.match(outcome, /protected branch/, 'the remote\'s own reason must survive to the caller');
});