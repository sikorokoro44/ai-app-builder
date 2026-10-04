import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { createInitialState } from '../shared/state.ts';
import { ProjectStates } from '../shared/types.ts';

// Uses a fixed, reproducible root rather than a random temp dir so a failing
// run leaves artifacts behind to inspect. isolate.mjs creates the unique leaf
// under it; the tracked `.builder/live` must never be involved.
process.env.BUILDER_TEST_TMP_ROOT = join(
  process.env.PREFIX || process.env.HOME, 'tmp', 'opencode', 'builder-test-recovery'
);
await import('./isolate.mjs');

const STATE_DIR = process.env.BUILDER_STATE_DIR!;
const CP_DIR = process.env.BUILDER_CHECKPOINT_DIR!;
const TMP = dirname(STATE_DIR); // isolate.mjs has already created this

/**
 * Advances a state to `target` along a legal transition path and persists each
 * hop. writeState enforces transitions centrally, so a fixture that assigns a
 * distant state directly would be (correctly) rejected; walking the real path
 * keeps the fixtures honest about how the lifecycle is actually driven.
 */
function advanceTo(s: any, target: string) {
  const { VALID_TRANSITIONS } = validator;
  const path = legalPath(s.projectState, target, VALID_TRANSITIONS);
  assert.ok(path, `no legal path from ${s.projectState} to ${target}`);
  for (const step of path) {
    s.projectState = step;
    store.writeState(s);
  }
  return s;
}

function legalPath(from: string, to: string, table: Record<string, string[]>): string[] | null {
  if (from === to) return [];
  const queue: { at: string; path: string[] }[] = [{ at: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of table[cur.at] || []) {
      if (seen.has(next)) continue;
      const path = [...cur.path, next];
      if (next === to) return path;
      seen.add(next);
      queue.push({ at: next, path });
    }
  }
  return null;
}

let store: typeof import('../scripts/live/stateStore.ts');
let cp: typeof import('../scripts/live/checkpointStore.ts');
let rec: typeof import('../scripts/live/recoveryManager.ts');
let validator: typeof import('../scripts/live/stateValidator.ts');
let ev: typeof import('../scripts/live/evidenceChain.ts');

before(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(CP_DIR, { recursive: true });
  store = await import('../scripts/live/stateStore.ts');
  validator = await import('../scripts/live/stateValidator.ts');
  cp = await import('../scripts/live/checkpointStore.ts');
  rec = await import('../scripts/live/recoveryManager.ts');
  ev = await import('../scripts/live/evidenceChain.ts');
  store.initStateStore();
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function freshState() {
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });
  store.initStateStore();
  return store.readState();
}

describe('checkpoint persistence', () => {
  test('persisting a checkpoint writes a parseable file', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.BUILDING);
    const file = cp.persistCheckpoint('unit-test');
    assert.ok(existsSync(file));
    const loaded = cp.loadCheckpoint(file);
    assert.strictEqual(loaded?.projectState, ProjectStates.BUILDING);
  });

  test('multiple checkpoints are listed newest last', () => {
    const s = freshState();
    for (const st of [ProjectStates.ANALYZING, ProjectStates.DESIGNING, ProjectStates.PLANNING]) {
      advanceTo(s, st);
      cp.persistCheckpoint(`seq-${st}`);
    }
    const cps = cp.listCheckpoints();
    assert.ok(cps.length >= 3);
    const times = cps.map((c) => c.createdAt);
    assert.deepStrictEqual(times, [...times].sort());
  });

  test('getLastCheckpoint skips corrupt files and returns a valid one', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.TESTING);
    cp.persistCheckpoint('good');
    writeFileSync(join(CP_DIR, 'zzz-broken.json'), '{"projectState": trunc');
    const last = cp.getLastCheckpoint();
    assert.ok(last, 'expected a valid checkpoint');
    assert.strictEqual(cp.loadCheckpoint(last)?.projectState, ProjectStates.TESTING);
  });

  test('a torn checkpoint is never restored', () => {
    const bad = join(CP_DIR, 'newest-torn.json');
    writeFileSync(bad, '{"projectState": "BUIL');
    assert.strictEqual(cp.loadCheckpoint(bad), null);
  });
});

describe('atomic state writes and interruption safety', () => {
  test('state.json.bak exists after a second write', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.ANALYZING);
    advanceTo(s, ProjectStates.DESIGNING);
    assert.ok(store.listStateBackups().includes('state.json.bak'));
  });

  test('corrupt state.json falls back to the backup, not a reset', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.PLANNING);
    advanceTo(s, ProjectStates.READY);
    writeFileSync(join(STATE_DIR, 'state.json'), '{ this is not json');
    const recovered = store.readState();
    assert.ok(
      recovered.projectState === ProjectStates.PLANNING || recovered.projectState === ProjectStates.READY,
      `unexpected recovered state ${recovered.projectState}`
    );
  });

  test('state and backup both destroyed rebuilds from the event log', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.ANALYZING);
    store.appendEvent({ type: 'PROJECT_STATUS_CHANGED', projectState: 'DESIGNING', activity: 'design done' });
    store.appendEvent({ type: 'BUILD_PASSED', runId: '12345' });
    writeFileSync(join(STATE_DIR, 'state.json'), 'garbage');
    rmSync(join(STATE_DIR, 'state.json.bak'), { force: true });
    const recovered = store.readState();
    assert.strictEqual(recovered.projectState, ProjectStates.DESIGNING);
    assert.strictEqual(recovered.cloudBuild.status, 'passed');
  });

  test('a state.json write never leaves a partial file', () => {
    const s = freshState();
    for (let i = 0; i < 20; i++) {
      s.completedTasks = i;
      store.writeState(s);
      JSON.parse(readFileSync(join(STATE_DIR, 'state.json'), 'utf-8'));
    }
  });
});

describe('resume after interruption', () => {
  test('restoreLastCheckpoint returns the last valid checkpoint', () => {
    const s = freshState();
    s.cloudBuild.status = 'running';
    advanceTo(s, ProjectStates.CLOUD_BUILDING);
    cp.persistCheckpoint('before-interrupt');

    s.cloudBuild.status = 'failed';
    advanceTo(s, ProjectStates.FAILED);

    const restored = cp.restoreLastCheckpoint();
    assert.strictEqual(restored?.projectState, ProjectStates.CLOUD_BUILDING);
    assert.strictEqual(store.readState().projectState, ProjectStates.CLOUD_BUILDING);
  });

  test('an interrupted run is detected by planRecovery', () => {
    const s = freshState();
    s.cloudBuild.status = 'running';
    advanceTo(s, ProjectStates.CLOUD_BUILDING);
    const plan = rec.planRecovery();
    assert.strictEqual(plan.interrupted, true);
    assert.strictEqual(plan.needsRepair, true);
  });

  test('a clean terminal state needs no recovery', () => {
    const s = freshState();
    s.cloudBuild.status = 'idle';
    advanceTo(s, ProjectStates.PLANNING);
    const plan = rec.planRecovery();
    assert.strictEqual(plan.needsRepair, false);
    assert.strictEqual(plan.failed, null);
  });
});

describe('failure detection at each lifecycle stage', () => {
  test('detects cloud build failure', () => {
    const s = freshState();
    s.cloudBuild.status = 'failed';
    assert.strictEqual(rec.detectFailure(s), 'cloud_build_failed');
  });

  test('detects APK verification failure', () => {
    const s = freshState();
    s.cloudBuild.status = 'passed';
    s.apkVerification = 'failed';
    assert.strictEqual(rec.detectFailure(s), 'apk_verification_failed');
  });

  test('detects release failure', () => {
    const s = freshState();
    s.cloudBuild.status = 'passed';
    s.apkVerification = 'passed';
    s.release.status = 'failed';
    assert.strictEqual(rec.detectFailure(s), 'release_failed');
  });

  test('detects test failures', () => {
    const s = freshState();
    s.testStats = { discovered: 3, running: 0, passed: 2, failed: 1 };
    assert.strictEqual(rec.detectFailure(s), 'tests_failed');
  });

  test('healthy state reports no failure', () => {
    const s = freshState();
    s.cloudBuild.status = 'passed';
    s.apkVerification = 'passed';
    s.release.status = 'created';
    s.testStats = { discovered: 3, running: 0, passed: 3, failed: 0 };
    assert.strictEqual(rec.detectFailure(s), null);
  });
});

describe('stage-scoped repair, not full restart', () => {
  test('a build failure repairs from CLOUD_BUILD only', () => {
    const s = freshState();
    for (const stage of ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'IMPLEMENT', 'TESTGEN', 'VALIDATE'] as const) {
      ev.recordStage(s, stage, 'done');
    }
    s.cloudBuild.status = 'failed';
    const signal = rec.buildFailureSignal(s, 'cloud_build_failed', 'compilation failed');
    assert.strictEqual(rec.repairPointFor(signal), 'CLOUD_BUILD');
    rec.enterRepair(s, signal);
    assert.strictEqual(s.projectState, ProjectStates.REPAIRING);
    assert.deepStrictEqual(rec.missingStagesMissing(s), ['CLOUD_BUILD', 'BUILD_SUCCESS', 'REAL_APK', 'APK_VERIFY', 'RELEASE', 'RELEASE_ASSET', 'PUBLIC_HTTPS_URL', 'PUBLIC_DOWNLOAD', 'FINAL_VERIFY']);
    for (const stage of ['IDEA', 'DESIGN', 'IMPLEMENT', 'VALIDATE'] as const) {
      assert.ok(ev.hasStage(s, stage), `${stage} evidence must be preserved across a build failure`);
    }
  });

  test('a release failure keeps the verified APK evidence', () => {
    const s = freshState();
    for (const stage of ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'IMPLEMENT', 'TESTGEN', 'VALIDATE', 'CLOUD_BUILD', 'BUILD_SUCCESS', 'REAL_APK', 'APK_VERIFY'] as const) {
      ev.recordStage(s, stage, 'done');
    }
    s.cloudBuild.status = 'passed';
    s.apkVerification = 'passed';
    s.release.status = 'failed';
    const signal = rec.buildFailureSignal(s, 'release_failed', 'gh release create failed');
    assert.strictEqual(signal.repairFrom, 'RELEASE');
    rec.enterRepair(s, signal);
    assert.ok(ev.hasStage(s, 'APK_VERIFY'));
    assert.ok(!ev.hasStage(s, 'RELEASE'));
    assert.ok(!ev.hasStage(s, 'PUBLIC_DOWNLOAD'));
    assert.strictEqual(s.apkVerification, 'passed', 'a release repair must not discard a verified APK');
    assert.strictEqual(s.cloudBuild.status, 'passed', 'a release repair must not discard a successful build');
    assert.strictEqual(s.release.status, 'idle');
  });

  test('an APK verification failure does not discard the build', () => {
    const s = freshState();
    for (const stage of ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'IMPLEMENT', 'TESTGEN', 'VALIDATE', 'CLOUD_BUILD', 'BUILD_SUCCESS'] as const) {
      ev.recordStage(s, stage, 'done');
    }
    s.cloudBuild.status = 'passed';
    s.apkVerification = 'failed';
    const signal = rec.buildFailureSignal(s, 'apk_verification_failed', 'package mismatch');
    assert.strictEqual(signal.repairFrom, 'APK_VERIFY');
    rec.enterRepair(s, signal);
    assert.ok(ev.hasStage(s, 'BUILD_SUCCESS'));
    assert.ok(!ev.hasStage(s, 'APK_VERIFY'));
    assert.ok(!ev.hasStage(s, 'RELEASE'));
  });

  test('a build failure clears prior artifact claims', () => {
    const s = freshState();
    s.apkVerification = 'passed';
    s.release.status = 'created';
    s.finalDownloadUrl = 'https://github.com/sikorokoro44/ai-app-builder/releases/download/t/a.apk';
    s.evidence = { stages: [], publicDownloadVerified: true };
    rec.invalidateFrom(s, 'CLOUD_BUILD');
    assert.strictEqual(s.release.status, 'idle');
    assert.strictEqual(s.apkVerification, 'failed');
    assert.strictEqual(s.finalDownloadUrl, undefined);
  });
});

describe('recover() is deterministic', () => {
  test('same input yields the same recovery actions', () => {
    const run = () => {
      const s = freshState();
      s.cloudBuild.status = 'failed';
      s.cloudBuild.failureClass = 'infrastructure_transient';
      advanceTo(s, ProjectStates.CLOUD_BUILDING);
      return rec.recover();
    };
    const a = run();
    const b = run();
    assert.deepStrictEqual(a.actions, b.actions);
    assert.strictEqual(a.state, b.state);
  });

  test('recover enters repair when a build failed', () => {
    const s = freshState();
    s.cloudBuild.status = 'failed';
    advanceTo(s, ProjectStates.CLOUD_BUILDING);
    const report = rec.recover();
    assert.ok(report.actions.some((x) => x.includes('entered repair')));
    assert.strictEqual(store.readState().projectState, ProjectStates.REPAIRING);
  });

  test('recover on a healthy run reports no action', () => {
    freshState();
    const report = rec.recover();
    assert.deepStrictEqual(report.actions, ['no recovery needed']);
  });

  test('recover after interruption restores a checkpoint', () => {
    const s = freshState();
    s.cloudBuild.status = 'passed';
    s.cloudBuild.runId = '999';
    for (const stage of ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'IMPLEMENT', 'TESTGEN', 'VALIDATE', 'CLOUD_BUILD', 'BUILD_SUCCESS'] as const) {
      ev.recordStage(s, stage, 'done', '999');
    }
    advanceTo(s, ProjectStates.VERIFYING);
    cp.persistCheckpoint('stable-verify');

    s.cloudBuild.status = 'running';
    advanceTo(s, ProjectStates.CLOUD_BUILDING);

    const report = rec.recover();
    assert.ok(report.actions.some((x) => x.includes('restored checkpoint')), report.actions.join(' | '));
    assert.strictEqual(store.readState().projectState, ProjectStates.VERIFYING);
    assert.strictEqual(store.readState().cloudBuild.status, 'passed',
      'resuming must keep the successful build instead of rebuilding');
    assert.strictEqual(store.readState().cloudBuild.runId, '999');
    assert.ok(ev.hasStage(store.readState(), 'BUILD_SUCCESS'), 'build success evidence survives resume');
    assert.ok(!ev.hasStage(store.readState(), 'APK_VERIFY'), 'artifact claims must be re-proven after resume');
  });
});

describe('event log integrity', () => {
  test('events survive and are read back in order', () => {
    freshState();
    store.appendEvent({ type: 'PROJECT_STATUS_CHANGED', projectState: 'ANALYZING' });
    store.appendEvent({ type: 'PROJECT_STATUS_CHANGED', projectState: 'DESIGNING' });
    const evts = store.readEvents();
    assert.ok(evts.length >= 2);
    assert.strictEqual(evts[evts.length - 2].projectState, 'ANALYZING');
    assert.strictEqual(evts[evts.length - 1].projectState, 'DESIGNING');
  });

  test('a malformed event line does not break the whole log', () => {
    freshState();
    store.appendEvent({ type: 'PROJECT_STATUS_CHANGED', projectState: 'ANALYZING' });
    appendFileSync(join(STATE_DIR, 'events.jsonl'), 'not-json\n');
    store.appendEvent({ type: 'PROJECT_STATUS_CHANGED', projectState: 'DESIGNING' });
    const evts = store.readEvents();
    assert.strictEqual(evts.filter((e) => e.projectState === 'DESIGNING').length, 1);
  });
});
describe('transitions are enforced centrally by writeState', () => {
  test('a script that skips a stage cannot persist the skipped state', () => {
    const s = freshState();
    s.projectState = ProjectStates.ANALYZING;
    store.writeState(s);
    // ANALYZING -> READY would skip DESIGNING and PLANNING entirely.
    s.projectState = ProjectStates.READY;
    assert.throws(() => store.writeState(s), /Refusing to persist ANALYZING -> READY/);
    assert.strictEqual(store.readState().projectState, ProjectStates.ANALYZING,
      'the refused write must leave the previous state untouched');
  });

  test('a refused write does not corrupt the backup or the state file', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.ANALYZING);
    const before = readFileSync(join(STATE_DIR, 'state.json'), 'utf-8');
    s.projectState = ProjectStates.COMPLETED;
    assert.throws(() => store.writeState(s));
    assert.strictEqual(readFileSync(join(STATE_DIR, 'state.json'), 'utf-8'), before);
    assert.strictEqual(store.readState().projectState, ProjectStates.ANALYZING);
  });

  test('rewriting the same state is always allowed', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.ANALYZING);
    s.latestActivity = 'progress note';
    store.writeState(s);
    s.latestActivity = 'another note';
    store.writeState(s);
    assert.strictEqual(store.readState().latestActivity, 'another note');
  });

  test('a legal forward transition is accepted', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.ANALYZING);
    s.projectState = ProjectStates.DESIGNING;
    store.writeState(s);
    assert.strictEqual(store.readState().projectState, ProjectStates.DESIGNING);
  });
});

describe('checkpoint restore is a verified rollback, not a bypass', () => {
  test('restoring returns to a state the checkpoint file actually records', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.VERIFYING);
    const file = cp.persistCheckpoint('known-good');

    s.cloudBuild.status = 'running';
    advanceTo(s, ProjectStates.CLOUD_BUILDING);

    const restored = cp.restoreLastCheckpoint();
    assert.strictEqual(restored?.projectState, ProjectStates.VERIFYING);
    assert.strictEqual(store.readState().projectState, ProjectStates.VERIFYING);
    assert.strictEqual(JSON.parse(readFileSync(file, 'utf-8')).projectState, ProjectStates.VERIFYING);
  });

  test('the rollback is recorded in the event log for audit', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.VERIFYING);
    cp.persistCheckpoint('audited');
    advanceTo(s, ProjectStates.CLOUD_BUILDING);
    cp.restoreLastCheckpoint();
    const rollbacks = store.readEvents().filter((e: any) =>
      typeof e.activity === 'string' && e.activity.includes('rolled back from'));
    assert.ok(rollbacks.length >= 1, 'expected an auditable rollback event');
    assert.ok(
      rollbacks.some((e: any) => e.activity.includes('VERIFYING') && e.projectState === ProjectStates.VERIFYING),
      `expected a rollback to VERIFYING, saw: ${rollbacks.map((e: any) => e.activity).join(' | ')}`
    );
  });

  test('a caller cannot use the restore option to jump to an arbitrary stage', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.VERIFYING);
    const file = cp.persistCheckpoint('guard');

    s.projectState = ProjectStates.COMPLETED;
    assert.throws(
      () => store.writeState(s, { restoringCheckpoint: file }),
      /records VERIFYING but COMPLETED was offered/
    );
    assert.strictEqual(store.readState().projectState, ProjectStates.VERIFYING);
  });

  test('an unreadable checkpoint cannot authorise any write', () => {
    const s = freshState();
    advanceTo(s, ProjectStates.ANALYZING);
    const bogus = join(TMP, 'not-a-checkpoint.json');
    writeFileSync(bogus, 'not json at all');
    s.projectState = ProjectStates.COMPLETED;
    assert.throws(() => store.writeState(s, { restoringCheckpoint: bogus }), /unreadable or not a state/);
  });
});

describe('the event log rebuilds the evidence chain, not just the URL', () => {
  test('evidence stages and checksums survive a total loss of state files', () => {
    const s = freshState();
    const stages = ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'IMPLEMENT', 'TESTGEN', 'VALIDATE'] as const;
    for (const stage of stages) ev.recordStage(s, stage, `proof for ${stage}`, 'run-777');

    s.cloudBuild.status = 'passed';
    s.cloudBuild.runId = 'run-777';
    s.cloudBuild.artifactSha256 = 'a'.repeat(64);
    s.apkVerification = 'passed';
    s.apkPath = '/tmp/app.apk';
    s.apkSha256 = 'b'.repeat(64);
    s.apkPackageId = 'com.builder.app';
    s.release.status = 'created';
    s.release.repo = 'sikorokoro44/ai-app-builder';
    s.release.tag = 'build-1';
    s.release.assetName = 'app-debug.apk';
    s.release.assetUrl = 'https://github.com/sikorokoro44/ai-app-builder/releases/download/build-1/app-debug.apk';
    s.release.assetSha256 = 'b'.repeat(64);
    s.finalDownloadUrl = s.release.assetUrl;
    s.evidence = { ...s.evidence, publicDownloadVerified: true };
    // Mirror the events the real stage scripts emit, so this proves the recovery
    // path against the payloads production actually writes.
    store.appendEvent({ type: 'ARTIFACT_VERIFIED', path: s.apkPath, sha256: s.apkSha256, packageId: s.apkPackageId });
    store.appendEvent({
      type: 'RELEASE_CREATED',
      url: s.release.assetUrl,
      tag: 'build-1',
      sha256: 'b'.repeat(64),
      repo: 'sikorokoro44/ai-app-builder',
      assetName: 'app-debug.apk'
    });
    store.appendEvent({ type: 'PUBLIC_DOWNLOAD_VERIFIED', verified: true, url: s.release.assetUrl, status: 200 });
    store.appendEvent({ type: 'DOWNLOAD_READY', url: s.release.assetUrl, status: 200 });
    advanceTo(s, ProjectStates.VERIFYING);

    writeFileSync(join(STATE_DIR, 'state.json'), 'destroyed');
    rmSync(join(STATE_DIR, 'state.json.bak'), { force: true });

    const rebuilt = store.readState();
    for (const stage of stages) {
      assert.ok(ev.hasStage(rebuilt, stage), `${stage} evidence must be rebuilt from the event log`);
    }
    assert.strictEqual(rebuilt.apkSha256, 'b'.repeat(64));
    assert.strictEqual(rebuilt.apkPackageId, 'com.builder.app');
    assert.strictEqual(rebuilt.release.assetSha256, 'b'.repeat(64));
    assert.strictEqual(rebuilt.release.tag, 'build-1');
    assert.strictEqual(rebuilt.finalDownloadUrl, s.release.assetUrl);
    assert.strictEqual(rebuilt.evidence?.publicDownloadVerified, true);
  });

  test('a release alone never rebuilds a verified public download claim', () => {
    const s = freshState();
    s.release.status = 'created';
    s.release.assetUrl = 'https://github.com/sikorokoro44/ai-app-builder/releases/download/build-9/app-debug.apk';
    s.finalDownloadUrl = s.release.assetUrl;
    advanceTo(s, ProjectStates.RELEASING);
    // Only the release event, no DOWNLOAD_READY and no PUBLIC_DOWNLOAD_VERIFIED.
    store.appendEvent({
      type: 'RELEASE_CREATED',
      url: s.release.assetUrl,
      tag: 'build-9',
      sha256: 'c'.repeat(64),
      repo: 'sikorokoro44/ai-app-builder',
      assetName: 'app-debug.apk'
    });

    writeFileSync(join(STATE_DIR, 'state.json'), 'destroyed');
    rmSync(join(STATE_DIR, 'state.json.bak'), { force: true });

    const rebuilt = store.readState();
    assert.strictEqual(rebuilt.release.assetUrl, s.release.assetUrl, 'the published asset is real evidence');
    assert.strictEqual(rebuilt.finalDownloadUrl, undefined,
      'an asset URL is not proof the download was reachable');
    assert.notStrictEqual(rebuilt.evidence?.publicDownloadVerified, true,
      'the public download must be re-proven after a rebuild');
  });

  test('evidence stage order is rebuilt in canonical order', () => {
    const s = freshState();
    // Recorded deliberately out of order; the chain must still read in order.
    for (const stage of ['VALIDATE', 'IDEA', 'PLAN'] as const) ev.recordStage(s, stage, 'x');
    advanceTo(s, ProjectStates.ANALYZING);
    const order = store.readState().evidence!.stages.map((x) => x.stage);
    assert.deepStrictEqual(order, ['IDEA', 'PLAN', 'VALIDATE']);
  });
});
