import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'node:path';
import { tmpdir } from 'os';

const REPO = join(import.meta.dirname, '..');
const pushSource = readAll('scripts/githubPush.ts');

function readAll(relative: string): string {
  return execFileSync('cat', [join(REPO, relative)], { encoding: 'utf-8' });
}

function run(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * The push githubPush.ts performs, taken from the script itself. Run 37388576570
 * died here: the job checked out the request commit, and then the request
 * recorder pushed the record of the dispatch it had just sent, so `git push` was
 * a non-fast-forward with the whole fleet already finished behind it.
 */
function pushCommit(cwd: string, branch: string, attempts = 4): { ok: boolean; reason: string; replays: string[] } {
  const replays: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      run(['push', 'origin', branch], cwd);
      return { ok: true, reason: '', replays };
    } catch (e: any) {
      const detail = (e.stderr?.toString() || e.message || '').toString();
      const moved = /cannot lock ref|fetch first|non-fast-forward|rejected|stale info/i.test(detail);
      if (!moved) return { ok: false, reason: detail.trim(), replays };
      if (attempt === attempts) return { ok: false, reason: detail.trim(), replays };
      replays.push(detail.trim().split('\n')[0]);
      try {
        run(['fetch', 'origin', branch], cwd);
        run(['rebase', `origin/${branch}`], cwd);
      } catch (replay: any) {
        try {
          run(['rebase', '--abort'], cwd);
        } catch {
          // Nothing to abort.
        }
        return { ok: false, reason: `could not replay: ${replay.stderr?.toString() || replay.message}`, replays };
      }
    }
  }
  return { ok: false, reason: 'attempts exhausted', replays };
}

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'builder-push-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'origin.git');
  const work = join(root, 'work');
  const other = join(root, 'other');

run(['init', '-q', '--bare', '-b', 'main', remote], root);
run(['init', '-q', '-b', 'main', work], root);
mkdirSync(join(work, '.builder/requests'), { recursive: true });
writeFileSync(join(work, '.builder/requests/base.json'), '{"base":1}\n');
run(['add', '-A'], work);
run(['commit', '-qm', 'base'], work);
run(['remote', 'add', 'origin', remote], work);
run(['push', '-q', 'origin', 'main'], work);

  // The second clone stands in for the process that records and pushes requests
  // while the fleet runs.
  run(['clone', '-q', remote, other], root);
  for (const dir of [work, other]) {
    run(['config', 'user.email', 'builder@example.com'], dir);
    run(['config', 'user.name', 'Builder'], dir);
  }
  return { root, remote, work, other };
}

describe('the generated app is pushed even when the branch moves under the run', () => {
  test('a branch that moved is replayed, and the app reaches the remote', (t) => {
    const { remote, work, other } = fixture(t);

    // The fleet generates and commits the app.
    mkdirSync(join(work, 'app'), { recursive: true });
    writeFileSync(join(work, 'app/build.gradle.kts'), 'generated\n');
    run(['add', '-A'], work);
    run(['commit', '-qm', 'builder: generated app sources'], work);

    // Meanwhile the request recorder records the dispatch it just sent.
    writeFileSync(join(other, '.builder/requests/dispatched.json'), '{"dispatched":1}\n');
    run(['add', '-A'], other);
    run(['commit', '-qm', 'builder: run dispatched'], other);
    run(['push', '-q', 'origin', 'main'], other);

    const result = pushCommit(work, 'main');
    assert.ok(result.ok, `the push must survive the race: ${result.reason}`);
    assert.strictEqual(result.replays.length, 1, 'it must replay exactly once');

    // Both writers' work is on the branch, and the app is buildable there.
    const files = run(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], work).split('\n');
    assert.ok(files.includes('app/build.gradle.kts'), 'the generated app must reach the remote');
    assert.ok(files.includes('.builder/requests/dispatched.json'), "the other writer's commit must survive");
  });

  test('a branch that moved twice is still pushed', (t) => {
    const { remote, work, other } = fixture(t);
    mkdirSync(join(work, 'app'), { recursive: true });
    writeFileSync(join(work, 'app/build.gradle.kts'), 'generated\n');
    run(['add', '-A'], work);
    run(['commit', '-qm', 'builder: generated app sources'], work);

    for (const name of ['one', 'two']) {
      writeFileSync(join(other, `.builder/requests/${name}.json`), `{"${name}":1}\n`);
      run(['add', '-A'], other);
      run(['commit', '-qm', `request ${name}`], other);
      run(['push', '-q', 'origin', 'main'], other);
    }

    const result = pushCommit(work, 'main');
    assert.ok(result.ok, `two moves must still land: ${result.reason}`);
    const files = run(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], work);
    assert.ok(files.includes('app/build.gradle.kts'));
  });

  test('a replay that conflicts is abandoned and reported, not half-applied', (t) => {
    const { root, remote, work, other } = fixture(t);
    mkdirSync(join(work, 'app'), { recursive: true });
    writeFileSync(join(work, 'app/build.gradle.kts'), 'from the fleet\n');
    run(['add', '-A'], work);
    run(['commit', '-qm', 'builder: generated app sources'], work);

    // The other writer changes the same file, so the replay cannot be automatic.
    run(['clone', '-q', remote, join(root, 'third')], root);
    const third = join(root, 'third');
    run(['config', 'user.email', 'other@example.com'], third);
    run(['config', 'user.name', 'Other'], third);
    mkdirSync(join(third, 'app'), { recursive: true });
    writeFileSync(join(third, 'app/build.gradle.kts'), 'from the other writer\n');
    run(['add', '-A'], third);
    run(['commit', '-qm', 'other writer changes the app'], third);
    run(['push', '-q', 'origin', 'main'], third);
    assert.ok(other, 'the request clone exists');

    const result = pushCommit(work, 'main');
    assert.strictEqual(result.ok, false, 'an unresolvable conflict must not be reported as a push');
    assert.match(result.reason, /could not replay/);

    // The repository is left usable: no rebase in progress, nothing half-applied.
    assert.doesNotThrow(() => run(['status', '--porcelain'], work));
    // What is on the branch is the other writer's version. Ours was not pushed,
    // and nothing was pushed on top of it either.
    const onRemote = run(['--git-dir', remote, 'show', 'main:app/build.gradle.kts'], work);
    assert.strictEqual(onRemote, 'from the other writer', 'the remote must hold the other writer\'s content, not ours');
    assert.ok(!run(['--git-dir', remote, 'log', '--oneline', 'main'], work).includes('builder: generated app sources'));
  });

  test('the script replays and reports the remote reason instead of losing it', () => {
    assert.match(pushSource, /function pushCommit\(\)/, 'the push must be a named step that can be reasoned about');
    assert.match(pushSource, /rebase.*origin\/\$\{guard\.branch\}/s, 'a moved branch must be replayed');
    assert.match(pushSource, /Refusing to push to \$\{guard\.branch\}/, 'a refused push must say so');
    assert.match(pushSource, /rebase', '--abort'/, 'a conflicted replay must be undone');

    // The inherited-stdio push threw with null streams, so the run reported
    // `output: [null, null, null]` and no reason.
    const at = pushSource.indexOf("['push', 'origin', guard.branch]");
    assert.ok(at > -1, 'the push must name the branch it guards');
    assert.match(pushSource.slice(at, at + 200), /'pipe'/, 'the push output must be captured to report a failure');
    assert.doesNotMatch(pushSource, /\['push', 'origin', guard\.branch\], \{ stdio: 'inherit' \}/);
  });
});