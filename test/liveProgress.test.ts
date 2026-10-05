import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createInitialState } from '../shared/state.ts';
import type { LiveState } from '../shared/state.ts';
import { FailureRepairStates, ProjectStates } from '../shared/types.ts';
import { buildLiveProgress, ProgressStages, statusGlyph } from '../shared/liveProgress.ts';
import { LifecycleStages, recordStage } from '../scripts/live/evidenceChain.ts';
import { initStateStore, readState, writeState, readEvents } from '../scripts/live/stateStore.ts';
import { isValidTransition } from '../scripts/live/stateValidator.ts';

const REPO = join(import.meta.dirname, '..');
const VIEW = join(REPO, 'opencode', 'live-progress.ts');

const DOWNLOAD_URL = 'https://github.test/o/r/releases/download/build-1/app-debug.apk';

/**
 * The evidence links in chain order. `GITHUB_PUSH` is absent on purpose: it is
 * displayed but proven by the pushed commit inside the IMPLEMENT link, so it
 * needs no step of its own.
 */
const WALK: { stage: string; prove: (s: LiveState) => void }[] = [
  { stage: 'IDEA', prove: (s) => recordStage(s, 'IDEA', 'idea captured') },
  { stage: 'ANALYZE', prove: (s) => recordStage(s, 'ANALYZE', 'requirements analyzed') },
  { stage: 'DESIGN', prove: (s) => recordStage(s, 'DESIGN', 'ui designed') },
  { stage: 'PLAN', prove: (s) => recordStage(s, 'PLAN', 'planned feature feat-001') },
  { stage: 'SCAFFOLD', prove: (s) => recordStage(s, 'SCAFFOLD', 'scaffold ready') },
  { stage: 'IMPLEMENT', prove: (s) => recordStage(s, 'IMPLEMENT', 'pushed commit ' + 'a'.repeat(40)) },
  { stage: 'TESTGEN', prove: (s) => recordStage(s, 'TESTGEN', 'registered 2 generated tests') },
  { stage: 'VALIDATE', prove: (s) => recordStage(s, 'VALIDATE', 'project validated') },
  { stage: 'CLOUD_BUILD', prove: (s) => recordStage(s, 'CLOUD_BUILD', 'run 1 completed') },
  { stage: 'BUILD_SUCCESS', prove: (s) => recordStage(s, 'BUILD_SUCCESS', 'run 1 conclusion=success') },
  { stage: 'REAL_APK', prove: (s) => recordStage(s, 'REAL_APK', 'apk=/tmp/app-debug.apk bytes=10') },
  { stage: 'APK_VERIFY', prove: (s) => recordStage(s, 'APK_VERIFY', 'sha256=' + 'b'.repeat(64)) },
  {
    stage: 'REAL_ICON_VERIFY',
    prove: (s) => recordStage(s, 'REAL_ICON_VERIFY', 'icon=@mipmap/ic_launcher densities=mdpi,hdpi similarity=0')
  },
  { stage: 'RELEASE', prove: (s) => recordStage(s, 'RELEASE', 'tag=build-1') },
  { stage: 'RELEASE_ASSET', prove: (s) => recordStage(s, 'RELEASE_ASSET', 'app-debug.apk') },
  {
    stage: 'DOWNLOAD_READY',
    prove: (s) => {
      recordStage(s, 'PUBLIC_HTTPS_URL', 'HTTPS 200 https://example.test/apk');
      recordStage(s, 'PUBLIC_DOWNLOAD', 'bytes match');
      s.evidence = { ...s.evidence!, publicDownloadVerified: true };
      s.finalDownloadUrl = DOWNLOAD_URL;
    }
  },
  {
    stage: 'COMPLETED',
    prove: (s) => {
      recordStage(s, 'FINAL_VERIFY', 'download_ready');
      s.projectState = ProjectStates.COMPLETED;
    }
  }
];

/** Display order, with GITHUB_PUSH inserted where the user expects it. */
const DISPLAY_ORDER = [
  'IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'IMPLEMENT', 'TESTGEN', 'VALIDATE',
  'GITHUB_PUSH', 'CLOUD_BUILD', 'BUILD_SUCCESS', 'REAL_APK', 'APK_VERIFY',
  'REAL_ICON_VERIFY', 'RELEASE', 'RELEASE_ASSET', 'DOWNLOAD_READY', 'COMPLETED'
];

function stageView(view: ReturnType<typeof buildLiveProgress>, stage: string) {
  const found = view.stages.find((s) => s.stage === stage);
  assert.ok(found, `expected stage ${stage} in the view`);
  return found;
}

/** Builds a state proven up to (but not including) `upTo`. */
function stateAt(upTo: number): LiveState {
  const s = createInitialState();
  if (upTo === 0) return s;
  s.projectState = ProjectStates.ANALYZING;
  for (const link of WALK.slice(0, upTo)) link.prove(s);
  return s;
}

describe('live progress view', () => {
  test('a fresh run shows every stage pending and nothing to download', () => {
    const view = buildLiveProgress(createInitialState());
    assert.strictEqual(view.overallPct, 0);
    assert.strictEqual(view.currentStage, 'IDEA');
    assert.strictEqual(view.status, 'IDLE');
    assert.ok(view.stages.every((s) => s.status === 'pending'));
    assert.strictEqual(view.downloadUrl, undefined);
    assert.strictEqual(view.completed, false);
  });

  test('submitting an idea immediately reports BUILDING with real progress', () => {
    const s = stateAt(1);
    s.latestActivity = 'idea captured';
    const view = buildLiveProgress(s);
    assert.strictEqual(view.status, 'BUILDING', 'a live run must not read as IDLE');
    assert.strictEqual(stageView(view, 'IDEA').status, 'completed');
    assert.strictEqual(stageView(view, 'IDEA').evidence, 'idea captured');
    assert.strictEqual(view.currentStage, 'ANALYZE');
    assert.strictEqual(stageView(view, 'ANALYZE').status, 'running');
    assert.ok(view.overallPct > 0 && view.overallPct < 100);
    assert.strictEqual(view.latestActivity, 'idea captured');
    assert.strictEqual(view.downloadUrl, undefined, 'no URL before DOWNLOAD_READY');
  });

  test('stages advance one at a time and each reports the evidence that proves it', () => {
    assert.deepStrictEqual([...ProgressStages], DISPLAY_ORDER, 'displayed stage order must not drift');

    // Walk the chain links in order. Recording IMPLEMENT also completes the
    // displayed GITHUB_PUSH step, because the pushed commit is the proof, so
    // the count of completed stages is checked per link rather than assuming
    // one displayed stage per recorded link.
    for (let i = 0; i < WALK.length; i++) {
      const link = WALK[i];
      const view = buildLiveProgress(stateAt(i + 1));
      assert.strictEqual(
        stageView(view, link.stage).status, 'completed',
        `${link.stage} must be complete once its evidence is recorded`
      );
      assert.ok(stageView(view, link.stage).evidence, `${link.stage} must show the evidence that proves it`);

      const laterLinks = WALK.slice(i + 1).map((l) => l.stage);
      for (const later of laterLinks) {
        assert.notStrictEqual(
          stageView(view, later).status, 'completed',
          `${later} must not complete before its own evidence is recorded`
        );
      }

      const remaining = view.stages.filter((s) => s.status !== 'completed');
      if (remaining.length > 0) {
        assert.strictEqual(
          remaining[0].stage, view.currentStage,
          `${link.stage}: current stage must be the first unproven link`
        );
      } else {
        assert.strictEqual(view.currentStage, null, `${link.stage}: a fully proven run has no current stage`);
      }
      if (view.currentStage) {
        assert.ok(
          view.stages.some((s) => s.status === 'running' || s.status === 'pending'),
          `${link.stage}: unproven stages must still be visible`
        );
      } else {
        assert.ok(view.stages.every((s) => s.status === 'completed'), `${link.stage}: nothing left to show as pending`);
      }
    }
  });

  test('percentage changes with progress and never reaches 100 before COMPLETED', () => {
    const seen: number[] = [];
    for (let i = 0; i < WALK.length; i++) {
      seen.push(buildLiveProgress(stateAt(i + 1)).overallPct);
    }
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] > seen[i - 1], `percentage must increase at step ${i}: ${seen[i - 1]} -> ${seen[i]}`);
    }
    assert.strictEqual(seen[seen.length - 1], 100);
    assert.ok(seen[seen.length - 2] < 100, 'DOWNLOAD_READY alone must not read as 100%');
  });

  test('current stage and activity come from authoritative state', () => {
    const s = stateAt(2);
    s.projectState = ProjectStates.DESIGNING;
    s.latestActivity = 'designing screen 2 of 5';
    const view = buildLiveProgress(s);
    assert.strictEqual(view.currentStage, 'DESIGN');
    assert.strictEqual(stageView(view, 'DESIGN').status, 'running');
    assert.strictEqual(view.latestActivity, 'designing screen 2 of 5');
    assert.strictEqual(view.projectState, ProjectStates.DESIGNING);
  });

  test('a failed cloud build shows FAILED with the real reason and recovery action', () => {
    const s = stateAt(8);
    s.projectState = ProjectStates.CLOUD_BUILDING;
    s.cloudBuild.status = 'failed';
    s.cloudBuild.failedReason = 'gradle: task :app:assembleDebug failed';
    s.cloudBuild.failureClass = 'build';
    s.failureRepair = { state: FailureRepairStates.REPAIRING, rootCause: 'missing app name resource' };
    s.latestActivity = 'cloud build failed';

    const view = buildLiveProgress(s);
    assert.strictEqual(view.status, 'FAILED');
    assert.strictEqual(view.failure?.stage, 'CLOUD_BUILD');
    assert.strictEqual(view.failure?.reason, 'gradle: task :app:assembleDebug failed');
    assert.match(view.failure?.recoveryAction || '', /repairing: missing app name resource/);
    assert.strictEqual(stageView(view, 'CLOUD_BUILD').status, 'failed');
    assert.strictEqual(stageView(view, 'CLOUD_BUILD').evidence, undefined, 'nothing is proven for a failed stage');
    assert.strictEqual(stageView(view, 'ANALYZE').status, 'completed');
    assert.strictEqual(view.downloadUrl, undefined);
  });

  test('a release failure and an apk failure are attributed to their own stage', () => {
    // Proven through RELEASE, so the failing link is the asset upload.
    const released = stateAt(14);
    released.projectState = ProjectStates.RELEASING;
    released.release.status = 'failed';
    released.release.failedReason = 'gh release upload failed: 502';
    const releaseView = buildLiveProgress(released);
    assert.strictEqual(releaseView.failure?.stage, 'RELEASE_ASSET');
    assert.strictEqual(releaseView.failure?.reason, 'gh release upload failed: 502');

    const verified = stateAt(12);
    verified.projectState = ProjectStates.VERIFYING;
    verified.apkVerification = 'failed';
    verified.apkVerificationErrors = ['APK contains no mipmap launcher icon'];
    const apkView = buildLiveProgress(verified);
    assert.strictEqual(apkView.failure?.stage, 'REAL_ICON_VERIFY');
    assert.match(apkView.failure?.reason || '', /no mipmap launcher icon/);
  });

  test('a push only counts as done when the evidence records one', () => {
    const s = stateAt(5);
    recordStage(s, 'IMPLEMENT', 'wrote 3 files locally');
    s.projectState = ProjectStates.BUILDING;
    const view = buildLiveProgress(s);
    assert.strictEqual(stageView(view, 'IMPLEMENT').status, 'completed');
    assert.strictEqual(
      stageView(view, 'GITHUB_PUSH').status, 'pending',
      'an unpushed local commit must not read as a completed push'
    );
    s.cloudBuild.headSha = 'c'.repeat(40);
    assert.strictEqual(
      stageView(buildLiveProgress(s), 'GITHUB_PUSH').status, 'completed',
      'a head sha from a real cloud build proves the commit reached the remote'
    );
  });

  test('the view never marks a stage done the evidence chain has not proven', () => {
    // A state that lies about projectState but has a short chain must not
    // render as further along than the chain actually is.
    const s = stateAt(2);
    s.projectState = ProjectStates.COMPLETED;
    s.finalDownloadUrl = 'https://github.test/o/r/releases/download/build-1/app-debug.apk';
    const view = buildLiveProgress(s);
    assert.strictEqual(view.completed, false);
    assert.strictEqual(view.stages.filter((s) => s.status === 'completed').length, 2);
    assert.ok(view.overallPct < 100);
    assert.strictEqual(view.downloadUrl, undefined, 'a chain that short cannot unlock the URL');
  });

  test('a fully proven run reports 100% and unlocks the completed screen', () => {
    const s = stateAt(WALK.length);
    s.overallProgressPct = 100;
    s.latestActivity = 'Completed: full evidence chain verified';
    s.apkPackageId = 'com.builder.todo';
    s.apkSha256 = 'd'.repeat(64);
    s.cloudBuild.runId = '37300693527';
    s.cloudBuild.headSha = 'e'.repeat(40);
    s.icon.status = 'passed';
    s.icon.similarity = 0;
    s.icon.byteIdentical = true;
    s.icon.matchedDensities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
    s.release.releaseUrl = 'https://github.test/o/r/releases/tag/build-1';

    const view = buildLiveProgress(s);
    assert.strictEqual(view.overallPct, 100);
    assert.strictEqual(view.completed, true);
    assert.strictEqual(view.status, 'COMPLETED');
    assert.strictEqual(view.currentStage, null);
    assert.ok(view.stages.every((s) => s.status === 'completed'));
    assert.strictEqual(view.downloadReady, true);
    assert.strictEqual(view.downloadUrl, 'https://github.test/o/r/releases/download/build-1/app-debug.apk');
    assert.strictEqual(view.verification?.packageId, 'com.builder.todo');
    assert.strictEqual(view.verification?.cloudRunId, '37300693527');
    assert.deepStrictEqual(view.verification?.iconMatchedDensities, ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']);
    assert.strictEqual(view.verification?.iconSimilarity, 0);
  });

  test('every displayed stage is either a chain link or proven by one', () => {
    const displayOnly = ProgressStages.filter(
      (s) => !(LifecycleStages as readonly string[]).includes(s)
    );
    assert.deepStrictEqual(displayOnly, ['GITHUB_PUSH', 'DOWNLOAD_READY', 'COMPLETED']);
  });

  test('the completed screen only appears after the gate would pass', () => {
    // Same gate the download URL is behind: an incomplete chain must not render
    // a completed screen even if projectState says COMPLETED.
    const s = stateAt(WALK.length - 1);
    s.projectState = ProjectStates.COMPLETED;
    const view = buildLiveProgress(s);
    assert.strictEqual(view.completed, false);
    assert.strictEqual(view.overallPct < 100, true);
    assert.ok(missingFinalVerify(view));
  });
});

function missingFinalVerify(view: ReturnType<typeof buildLiveProgress>): boolean {
  return view.stages.find((s) => s.stage === 'COMPLETED')?.status !== 'completed';
}

describe('live progress render and restart', () => {
  // The store modules bound their paths at import time to the isolated dir
  // `isolate.mjs` picked, so the child process is pointed at the same dir.
  // That is what makes this a real restart: a separate process reads only the
  // persisted state, with nothing shared from the parent.
  const stateDir = process.env.BUILDER_STATE_DIR as string;

  function renderOnce(extraEnv: Record<string, string> = {}): string {
    return execFileSync(
      process.execPath,
      ['--experimental-strip-types', VIEW, '--once'],
      {
        cwd: REPO,
        encoding: 'utf-8',
        env: { ...process.env, BUILDER_STATE_DIR: stateDir, ...extraEnv }
      }
    );
  }

  test('the rendered screen shows ordered statuses, percentage and the URL when ready', () => {
    const s = createInitialState();
    s.projectState = ProjectStates.ANALYZING;
    for (const link of WALK.slice(0, 3)) link.prove(s);
    initStateStore();
    writeState(s, { allowUncheckedTransition: true });

    const out = renderOnce();
    const lines = out.trim().split('\n');
    assert.match(out, /Build progress .* \d+%/, 'a percentage must be shown');
    assert.match(out, /Status: BUILDING/);
    assert.match(out, /Current stage: PLAN/);
    assert.ok(out.includes(statusGlyph('completed')), 'completed marker');
    assert.ok(out.includes(statusGlyph('running')), 'running marker');
    assert.ok(out.includes(statusGlyph('pending')), 'pending marker');
    assert.ok(!out.includes('Download:'), 'no download line before DOWNLOAD_READY');

    // Stage order on screen must match the requested order. The `u` flag matters:
    // the running marker is an astral-plane glyph, so without it the character
    // class would split it into surrogates and drop that line.
    const rendered = lines
      .filter((l) => /^\s+\S+\s+\S+\s+(completed|running|pending|failed)\b/u.test(l))
      .map((l) => l.trim().split(/\s+/u)[1]);
    assert.deepStrictEqual(rendered, [...ProgressStages]);
  });

  test('a completed run renders the completed screen with the download link', () => {
    const s = stateAt(WALK.length);
    s.projectState = ProjectStates.COMPLETED;
    s.apkPackageId = 'com.builder.todo';
    initStateStore();
    writeState(s, { allowUncheckedTransition: true });

    const out = renderOnce();
    assert.match(out, /100%/);
    assert.match(out, /COMPLETED/);
    assert.match(out, new RegExp(`Download: ${DOWNLOAD_URL.replace(/[/.]/g, '\\$&')}`));
    assert.match(out, /package: com\.builder\.todo/);
  });

  test('a restarted view resumes from persisted state without losing progress', () => {
    const s = createInitialState();
    s.projectState = ProjectStates.ANALYZING;
    for (const link of WALK.slice(0, 6)) link.prove(s);
    initStateStore();
    writeState(s, { allowUncheckedTransition: true });
    assert.ok(existsSync(join(stateDir, 'state.json')));

    const before = buildLiveProgress(readState());
    // Six recorded links, plus GITHUB_PUSH which the pushed commit proves.
    assert.strictEqual(before.stages.filter((x) => x.status === 'completed').length, 7);

    // A fresh process reads the same authoritative state and agrees with it.
    const out = renderOnce();
    assert.match(out, /Status: BUILDING/);
    assert.match(out, /Current stage: TESTGEN/);
    assert.ok(out.includes(statusGlyph('completed')));

    // And the run survives a crash that truncates state.json. The store recovers
    // from the .bak copy, which is the previous good write, so the state is
    // written twice here to make that copy the state under test.
    writeState(s, { allowUncheckedTransition: true });
    writeFileSync(join(stateDir, 'state.json'), '{"projectState": "BUILD');
    assert.ok(readFileSync(join(stateDir, 'state.json'), 'utf-8').startsWith('{"projectState'), 'the state file is now truncated');
    const recovered = buildLiveProgress(readState());
    assert.strictEqual(
      recovered.stages.filter((x) => x.status === 'completed').length,
      before.stages.filter((x) => x.status === 'completed').length,
      'a truncated state file must not erase proven progress'
    );
  });

  test('the view names the fleet and the agents that are working', () => {
    const s = stateAt(ProjectStates.TESTING);
    s.agents = {
      'idea-intake': { id: 'idea-intake', index: 1, name: 'Idea Intake Analyst', state: 'COMPLETED', activity: 'normalized the brief', updatedAt: new Date().toISOString() },
      'test-engineer': { id: 'test-engineer', index: 14, name: 'Test Engineer', state: 'WORKING', activity: 'wrote 7 unit tests', updatedAt: new Date().toISOString() },
      'quality-auditor': { id: 'quality-auditor', index: 15, name: 'Quality Auditor', state: 'IDLE', activity: 'waiting for dependencies', updatedAt: new Date().toISOString() }
    };
    const view = buildLiveProgress(s);
    assert.deepStrictEqual(view.agents.map((a) => a.id), ['idea-intake', 'test-engineer', 'quality-auditor'],
      'agents should be listed in fleet order, not insertion order');
    assert.strictEqual(view.activeAgents, 1, 'one agent is working');
    const working = view.agents.find((a) => a.id === 'test-engineer');
    assert.strictEqual(working?.activity, 'wrote 7 unit tests');
    assert.strictEqual(view.agents.find((a) => a.id === 'quality-auditor')?.state, 'IDLE');
  });

  test('a run with no agents recorded reports none rather than inventing any', () => {
    const view = buildLiveProgress(stateAt(ProjectStates.NOT_STARTED));
    assert.deepStrictEqual(view.agents, []);
    assert.strictEqual(view.activeAgents, 0);
  });

  test('progress evidence is mirrored into the event log', () => {
    const events = readEvents();
    const recorded = events.filter((e) => e.type === 'EVIDENCE_RECORDED');
    assert.ok(recorded.length >= 6, 'each recorded link must reach the append-only log');
  });

  test('tracked live state is untouched by the progress tests', () => {
    const tracked = join(REPO, '.builder', 'live', 'state.json');
    assert.ok(existsSync(tracked));
    const s = JSON.parse(readFileSync(tracked, 'utf-8'));
    assert.strictEqual(s.projectState, ProjectStates.COMPLETED, 'the verified run must stay verified');
    assert.notStrictEqual(stateDir, join(REPO, '.builder', 'live'));
  });
});

describe('progress stage names', () => {
  test('calcStagePct and the progress view agree on terminal states', () => {
    const done = stateAt(WALK.length);
    assert.strictEqual(buildLiveProgress(done).overallPct, 100);
    assert.strictEqual(isValidTransition(ProjectStates.DOWNLOAD_READY, ProjectStates.COMPLETED), true);
  });
});
describe('live progress loop', () => {
  const stateDir = process.env.BUILDER_STATE_DIR as string;

  function seed(state: LiveState) {
    initStateStore();
    writeState(state, { allowUncheckedTransition: true });
  }

  /**
   * Runs the view in polling mode and returns its output plus exit code. A failed
   * run exits nonzero by design, so the exit code is reported rather than thrown.
   */
  function follow(budgetMs: number): { out: string; code: number } {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', VIEW, '--interval', '25'],
      {
        cwd: REPO,
        encoding: 'utf-8',
        timeout: budgetMs,
        env: { ...process.env, BUILDER_STATE_DIR: stateDir }
      }
    );
    return { out: result.stdout || '', code: result.status ?? -1 };
  }

  test('the view keeps updating on its own and stops once the run completes', () => {
    const live = createInitialState();
    live.projectState = ProjectStates.ANALYZING;
    seed(live);

    // Advance the run while the view is already polling, the way a builder and
    // a user watching it would run at the same time. Startup is slow under
    // type stripping, so every wait is on observed output rather than a guess.
    const child = spawn(process.execPath, ['--experimental-strip-types', VIEW, '--interval', '40'], {
      cwd: REPO,
      env: { ...process.env, BUILDER_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const frames = (o: string) => o.split('\x1b[2J\x1b[H').length;

    /** Waits for a predicate over the accumulated output, or gives up. */
    const until = async (what: (o: string) => boolean, budgetMs = 20000) => {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline) {
        if (what(out)) return;
        await sleep(40);
      }
      assert.fail(`timed out waiting for output; saw:\n${out.slice(0, 400)}`);
    };

    return (async () => {
      await until((o) => o.includes('Current stage:'));
      assert.match(out, /Status: BUILDING/);

      const midway = createInitialState();
      midway.projectState = ProjectStates.ANALYZING;
      for (const link of WALK.slice(0, 4)) link.prove(midway);
      midway.latestActivity = 'scaffolding the project';
      seed(midway);
      // A later frame carries the newer activity: the view refreshed by itself.
      await until((o) => o.includes('scaffolding the project'));
      // And it keeps redrawing afterwards, rather than freezing on that frame.
      await until((o) => frames(o) >= 3);
      assert.ok(frames(out) >= 3, 'the screen must redraw without a manual refresh');

      const done = stateAt(WALK.length);
      done.projectState = ProjectStates.COMPLETED;
      seed(done);

      const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 0)));
      assert.strictEqual(code, 0, 'a completed run must exit cleanly');
      assert.match(out, /100%/);
      assert.match(out, new RegExp(`Download: ${DOWNLOAD_URL.replace(/[/.]/g, '\\$&')}`));
    })().finally(() => { if (!child.killed) child.kill(); });
  });

  test('a failed run exits nonzero and the view does not wait forever', () => {
    const s = createInitialState();
    s.projectState = ProjectStates.ANALYZING;
    recordStage(s, 'IDEA', 'idea captured');
    s.projectState = ProjectStates.BUILDING;
    s.cloudBuild.status = 'failed';
    s.cloudBuild.failedReason = 'gradle: assembleDebug failed';
    s.cloudBuild.failureClass = 'source_code';
    s.failureRepair = { state: FailureRepairStates.DIAGNOSING, rootCause: 'missing icon resource' };
    seed(s);

    const { out, code } = follow(8000);
    assert.strictEqual(code, 1, 'a failed run must exit nonzero');
    assert.match(out, /Status: FAILED/);
    assert.match(out, /FAILED at CLOUD_BUILD: gradle: assembleDebug failed/);
    assert.match(out, /Recovery: diagnosing the failure: missing icon resource/);
    assert.ok(!out.includes('Download:'), 'a failed run must never offer a download');
  });
});
