import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

/*
 * Regression tests for the cloud path that incident 3q1yb5m7ltvb exposed.
 *
 * Every workflow run between 19:31 and 20:30 UTC on 2026-10-05 was accepted by
 * GitHub and then queued without ever being handed a runner: run 37364005643
 * (coordinator), 37365748844 and 37368567311 (coordinator again), and the
 * android-build probes 37366633800 and 37368408479. Each ended `cancelled` with a
 * startedAt stamp, zero steps, zero billable milliseconds and no logs at all.
 *
 * Two things had to be true for those runs to be harmless, and neither was:
 * a new idea had to start from an empty state rather than inherit the previous
 * app's evidence chain, and an interrupted run had to be resumable from the
 * repository rather than from a cache key that never matched. These tests pin
 * both, plus the release of the run store after a run.
 */
const REPO = join(dirname(new URL(import.meta.url).pathname), '..');

const coordinatorWorkflow = () => readFileSync(join(REPO, '.github/workflows/builder-coordinator.yml'), 'utf-8');
const androidWorkflow = () => readFileSync(join(REPO, '.github/workflows/builder-android-build.yml'), 'utf-8');

describe('a new idea starts from an empty state in a workflow checkout', () => {
  test('the coordinator routes a new idea through startNewRun, not straight into the coordinator', () => {
    const cli = readFileSync(join(REPO, 'scripts/coordinator.ts'), 'utf-8');
    assert.match(cli, /startNewRun\(/, 'a new idea must go through the path that clears the previous state');
    assert.doesNotMatch(
      cli,
      /runCoordinator\(\{[^}]*idea: argv/,
      'the CLI must not pass a new idea straight to runCoordinator'
    );
  });

  test('startNewRun clears evidence before the new run begins', () => {
    const recovery = readFileSync(join(REPO, 'scripts/agents/recovery.ts'), 'utf-8');
    assert.match(recovery, /export async function startNewRun/);
    const body = recovery.slice(recovery.indexOf('export async function startNewRun'));
    assert.match(body, /persistCheckpoint\('before-restart'/, 'the replaced state must be checkpointed');
    assert.match(body, /createInitialState\(\)/, 'the new run starts from an empty state');
    assert.match(body, /allowUncheckedTransition: true/, 'the abandonment is explicit, not silent');
    assert.match(body, /reason: `restarting/, 'and it says which run it is replacing');
  });

  test('a checkout of main carries the previous run, so the workflow must not assume otherwise', () => {
    assert.ok(
      existsSync(join(REPO, '.builder/live/state.json')),
      'the live state is committed, which is exactly why a new run must clear it'
    );
  });
});

describe('an interrupted run can actually be resumed in the cloud', () => {
  test('the run store cache is keyed so a later run finds the earlier store', () => {
    const wf = coordinatorWorkflow();
    const key = (wf.split('\n').find((l) => l.trim().startsWith('key: builder-run')) ?? '').trim();
    assert.ok(key, 'the coordinator workflow must cache the run store under a stable key');
    assert.match(
      key,
      /\$\{\{\s*github\.sha\s*\}\}/,
      `the cache key must follow the commit, not github.run_id, or --resume finds nothing: ${key}`
    );
    assert.doesNotMatch(key, /github\.run_id/, 'a per-dispatch key gives every resume an empty store');
    assert.match(
      wf,
      /restore-keys:[^\n]*\n\s*builder-run-store-/,
      'the restore prefix must reach the store an earlier attempt left'
    );
  });

  test('the cached run store is what a resume reads', () => {
    const wf = coordinatorWorkflow();
    assert.match(wf, /BUILDER_AGENT_DIR: \.builder\/agents/, 'the fleet reads the cached store');
    assert.match(wf, /node --experimental-strip-types scripts\/coordinator\.ts --resume/, 'and a stopped run can be resumed');
  });

  test('the workflow has room for a slow build plus its retries', () => {
    const wf = coordinatorWorkflow();
    const minutes = Number(wf.match(/timeout-minutes:\s*(\d+)/)?.[1] ?? 0);
    const pollMs = Number(wf.match(/BUILDER_POLL_TIMEOUT_MS: '(\d+)'/)?.[1] ?? 0);
    assert.ok(minutes >= 90, `coordinator timeout must cover a build poll (${minutes} minutes)`);
    assert.ok(pollMs > 0, 'the build poll timeout must be explicit rather than the script default');
    assert.ok(
      minutes * 60 * 1000 > pollMs,
      `a coordinator that can wait ${pollMs / 60000} minutes for a build needs more than ${minutes} minutes of job time`
    );
  });

  test('the build is retried with backoff rather than in a tight loop', () => {
    const wf = coordinatorWorkflow();
    assert.match(wf, /BUILDER_RETRY_BACKOFF_MS: '(\d+)'/);
    assert.match(wf, /BUILDER_MAX_ATTEMPTS: '(\d+)'/);
  });
});

describe('the delivered evidence ends up in the repository', () => {
  test('the live state is committed after the run, not left in an expiring artifact', () => {
    const wf = coordinatorWorkflow();
    assert.match(wf, /Publish the live state to the authoritative branch/);
    assert.match(wf, /git add -A \.builder\/live/);
    assert.match(wf, /git commit -m "builder: live state after run/);
    assert.match(wf, /git push origin HEAD:main/);
  });

  test('publishing the state never touches what repo-publisher owns', () => {
    const wf = coordinatorWorkflow();
    const step = wf.slice(wf.indexOf('Publish the live state'), wf.indexOf('Upload the run store'));
    assert.ok(step.includes('git add -A .builder/live'));
    assert.doesNotMatch(step, /git add -A\s*$/m, 'a bare `git add -A` here would commit the run store too');
    assert.doesNotMatch(step, /--force/, 'the branch is the truth; nothing is forced over it');
    assert.match(step, /pull --rebase/, 'a push that lost a race rebases instead of failing the run');
  });

  test('it runs even when the fleet failed, because a failed run is evidence too', () => {
    const wf = coordinatorWorkflow();
    const step = wf.slice(wf.indexOf('Publish the live state'), wf.indexOf('Upload the run store'));
    assert.match(wf.slice(0, wf.indexOf('Publish the live state')), /if: always\(\)/);
    assert.ok(step.includes('if: always()') || wf.includes('if: always()\n        run: |\n          set -euo pipefail'));
  });

  test('the run store and the requests travel with the artifact for later inspection', () => {
    const wf = coordinatorWorkflow();
    const upload = wf.slice(wf.indexOf('Upload the run store'));
    assert.match(upload, /\.builder\/agents/);
    assert.match(upload, /\.builder\/live/);
    assert.match(upload, /\.builder\/requests/);
    assert.match(upload, /retention-days: \d+/);
  });
});

describe('the cloud build builds what was committed', () => {
  test('the build proves it assembled the project that was pushed', () => {
    const wf = androidWorkflow();
    assert.match(wf, /Refuse to build a project that differs from the committed one/);
    assert.match(wf, /git -c core\.fileMode=false diff --quiet/, 'file modes depend on the runner umask, not the generator');
    assert.match(wf, /git ls-files --error-unmatch/, 'a commit with no generated project is still buildable');
  });

  test('one stuck build no longer blocks every other commit', () => {
    const wf = androidWorkflow();
    const group = (wf.split('\n').find((l) => l.trim().startsWith('group: android-build')) ?? '').trim();
    assert.ok(group, 'the build workflow must serialise duplicate work');
    assert.match(
      group,
      /inputs\.head_sha \|\| github\.sha/,
      `the concurrency group must be per commit: ${group} blocks unrelated commits behind one stuck build`
    );
  });

  test('the build still refuses to report an APK it cannot identify', () => {
    const wf = androidWorkflow();
    assert.match(wf, /if-no-files-found: error/);
    assert.match(wf, /produced no package id/);
    assert.match(wf, /Verify the compiled launcher icon with aapt2/);
    assert.match(wf, /Verify the compiled launcher icon against the generated source/);
  });
});

describe('the pipeline keeps GitHub as the source of truth', () => {
  test('run requests are recorded in the repository before a dispatch is sent', () => {
    const script = readFileSync(join(REPO, 'scripts/requestRun.ts'), 'utf-8');
    const writeAt = script.indexOf('writeRequest(request)');
    const pushAt = script.indexOf("git(['push', 'origin', BRANCH])");
    const dispatchAt = script.indexOf("gh(['workflow', 'run', WORKFLOW");
    assert.ok(writeAt > -1 && pushAt > -1 && dispatchAt > -1, 'the script must write, push and dispatch');
    assert.ok(writeAt < pushAt, 'the request is written before it is pushed');
    assert.ok(pushAt < dispatchAt, 'the request reaches the remote before the dispatch is sent');
  });

  test('a redrive reuses the open request instead of recording the idea twice', () => {
    const script = readFileSync(join(REPO, 'scripts/requestRun.ts'), 'utf-8');
    assert.match(script, /findOpenRequest\(listRequests\(\), idea, mode\)/);
  });

  test('a refused dispatch leaves the request open with the reason recorded', () => {
    const script = readFileSync(join(REPO, 'scripts/requestRun.ts'), 'utf-8');
    assert.match(script, /outcome: 'refused'/);
    assert.match(script, /re-drive it with/);
  });
});
