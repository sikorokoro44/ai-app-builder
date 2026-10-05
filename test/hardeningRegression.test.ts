import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { classifyFailure, isTransientFailure } from '../scripts/live/failureClassifier.ts';
import { InvalidTransitionError } from '../scripts/live/stateValidator.ts';
import { ProjectStates } from '../shared/types.ts';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..');
const TMP = mkdtempSync(join(process.env.PREFIX || process.env.HOME, 'tmp', 'builder-hardening-'));
const STATE_DIR = join(TMP, 'live');
const CP_DIR = join(TMP, 'checkpoints');

process.env.BUILDER_STATE_DIR = STATE_DIR;
process.env.BUILDER_CHECKPOINT_DIR = CP_DIR;

function run(script: string, args: string[] = [], env: Record<string, string> = {}): {
  code: number; out: string; err: string;
} {
  try {
    const out = execFileSync('node', ['--experimental-strip-types', join('scripts', script), ...args], {
      cwd: REPO,
      encoding: 'utf-8',
      env: { ...process.env, ...env, BUILDER_STATE_DIR: STATE_DIR, BUILDER_CHECKPOINT_DIR: CP_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (e: any) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: e.stdout || '', err: e.stderr || '' };
  }
}

function stateOnDisk(): any {
  return JSON.parse(readFileSync(join(STATE_DIR, 'state.json'), 'utf-8'));
}

/** Seeds a state that is already legally at `projectState`. */
async function seedAt(projectState: string, extra: Record<string, any> = {}) {
  const store: any = await import('../scripts/live/stateStore.ts');
  store.initStateStore();
  const s: any = store.readState();
  const { VALID_TRANSITIONS } = await import('../scripts/live/stateValidator.ts');
  const seen = new Set<string>([s.projectState]);
  const queue: string[] = [s.projectState];
  let prev = s.projectState;
  const parents: Record<string, string> = { [s.projectState]: '' };
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of VALID_TRANSITIONS[cur] || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      parents[next] = cur;
      if (next === projectState) { prev = next; queue.length = 0; break; }
      queue.push(next);
    }
  }
  const chain: string[] = [];
  for (let at = projectState; at; at = parents[at]) chain.unshift(at);
  for (const step of chain) {
    if (step === s.projectState) continue;
    s.projectState = step;
    store.writeState(s);
  }
  Object.assign(s, extra);
  store.writeState(s);
  return s;
}

/**
 * Seeds CLOUD_BUILDING and records `headSha` the way --prepare does. The state is
 * written first and the commit applied second, because the object literal would
 * otherwise be evaluated before state.json exists.
 */
async function seedCloudBuild(headSha?: string) {
  await seedAt(ProjectStates.CLOUD_BUILDING);
  if (headSha === undefined) return;
  const current = stateOnDisk();
  await seedAt(ProjectStates.CLOUD_BUILDING, { cloudBuild: { ...current.cloudBuild, headSha } });
}

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('erasable TypeScript (npm test must run without a build step)', () => {
  test('no constructor parameter properties or enum/namespace declarations', () => {
    const offenders: string[] = [];
    const paramProp = /constructor\s*\([^)]*\b(public|private|protected|readonly)\s+\w/;
    const decl = /^\s*(export\s+)?(const\s+)?(enum|namespace)\s+\w/;

    const stack = [join(REPO, 'scripts'), join(REPO, 'shared')];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: string[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') stack.push(abs);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        readFileSync(abs, 'utf-8').split('\n').forEach((line, i) => {
          if (paramProp.test(line)) offenders.push(`${abs}:${i + 1} parameter property`);
          if (decl.test(line)) offenders.push(`${abs}:${i + 1} enum/namespace`);
        });
      }
    }
    assert.deepStrictEqual(offenders, [], `non-erasable TypeScript syntax found:\n${offenders.join('\n')}`);
  });

  test('InvalidTransitionError still exposes from/to after the rewrite', () => {
    const e = new InvalidTransitionError('PLANNING', 'BUILDING');
    assert.strictEqual(e.from, 'PLANNING');
    assert.strictEqual(e.to, 'BUILDING');
    assert.ok(e instanceof Error);
    assert.match(e.message, /PLANNING -> BUILDING/);
  });

  test('npm test wires the state-isolation preload', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8'));
    assert.match(pkg.scripts.test, /--import \.\/test\/isolate\.mjs/,
      'the suite must run with --import ./test/isolate.mjs so it cannot touch the tracked live state');
    assert.ok(existsSync(join(REPO, 'test', 'isolate.mjs')));
  });

  test('isolate.mjs is the single isolation mechanism and every store-touching test uses it', () => {
    assert.ok(!existsSync(join(REPO, 'test', 'setup.mjs')),
      'setup.mjs was replaced by isolate.mjs; two isolation modules would drift');

    // Any test that reaches the state store must isolate itself, because ES
    // imports evaluate in order and the store reads these paths at import time.
    const storeTouching = readdirSync(join(REPO, 'test'))
      .filter((f) => f.endsWith('.test.ts'))
      .filter((f) => {
        const src = readFileSync(join(REPO, 'test', f), 'utf-8');
        return /recordStage|appendEvent|initStateStore|readState|writeState|advance\(|createAppFromIdea/.test(src);
      });
    assert.ok(storeTouching.length > 0, 'expected at least one store-touching test');
    for (const f of storeTouching) {
      const src = readFileSync(join(REPO, 'test', f), 'utf-8');
      assert.match(src, /isolate\.mjs/,
        `${f} touches the live state store but does not import ./isolate.mjs; it would write to the tracked .builder/live`);
    }
  });

  test('the tracked live state is a real file the suite must not rewrite', () => {
    // Guards against "fixing" a red suite by simply resetting tracked state.
    const statePath = join(REPO, '.builder', 'live', 'state.json');
    assert.ok(existsSync(statePath), 'the tracked live state should exist');
    const s = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.ok(s.projectState, 'tracked state must record a projectState');
    assert.notStrictEqual(process.env.BUILDER_STATE_DIR, join(REPO, '.builder', 'live'),
      'tests must not run against the tracked live state directory');
  });
});

describe('planner reaches READY so the next stage is not a skipped state', () => {
  test('plan.ts lands on READY, making READY -> BUILDING legal', async () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    await seedAt(ProjectStates.DESIGNING);

    const res = run('plan.ts');
    assert.strictEqual(res.code, 0, `plan.ts failed: ${res.err}`);
    assert.strictEqual(stateOnDisk().projectState, ProjectStates.READY,
      'a finished plan must leave the project READY; leaving it at PLANNING makes BUILDING an illegal skip');
  });

  test('the whole pre-build pipeline runs in order without an illegal skip', async () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });

    for (const script of ['analyze.ts', 'design.ts', 'plan.ts', 'implement.ts', 'testgen.ts', 'validateTests.ts']) {
      const res = run(script);
      assert.strictEqual(res.code, 0, `${script} failed: ${res.err}`);
    }
    assert.strictEqual(stateOnDisk().projectState, ProjectStates.TESTING);

    const prep = run('cloudBuildExecute.ts', ['--prepare'], { BUILDER_PROJECT_DIR: join(REPO, '.builder/generated/android') });
    assert.strictEqual(prep.code, 0, `--prepare failed: ${prep.err}`);
    assert.strictEqual(stateOnDisk().projectState, ProjectStates.CLOUD_BUILDING);
  });

  test('a new commit does not inherit the previous attempt run id', async () => {
    // A run id names one specific run. If prepare keeps the old id while it
    // repins headSha, the state pairs this commit with a run built from
    // different sources, and the artifact identity it later records is not
    // this commit's.
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    await seedAt(ProjectStates.TESTING);

    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf-8' }).trim();
    const prep = run('cloudBuildExecute.ts', ['--prepare'], {
      BUILDER_PROJECT_DIR: join(REPO, '.builder/generated/android')
    });
    assert.strictEqual(prep.code, 0, `--prepare failed: ${prep.err}`);

    // Simulate an earlier attempt on this commit that recorded its run id.
    const s = stateOnDisk();
    s.cloudBuild.runId = '37268736122';
    writeFileSync(join(STATE_DIR, 'state.json'), JSON.stringify(s, null, 2));

    // The same head keeps the id: that run really is this commit's build.
    const same = run('cloudBuildExecute.ts', ['--prepare'], {
      BUILDER_PROJECT_DIR: join(REPO, '.builder/generated/android')
    });
    assert.strictEqual(same.code, 0, `--prepare failed: ${same.err}`);
    assert.strictEqual(stateOnDisk().cloudBuild.runId, '37268736122',
      're-preparing the same commit must not orphan a live run id');
    assert.strictEqual(stateOnDisk().cloudBuild.headSha, head);

    // A different head must not keep it.
    const other = stateOnDisk();
    other.cloudBuild.headSha = 'f'.repeat(40);
    writeFileSync(join(STATE_DIR, 'state.json'), JSON.stringify(other, null, 2));
    const moved = run('cloudBuildExecute.ts', ['--prepare'], {
      BUILDER_PROJECT_DIR: join(REPO, '.builder/generated/android')
    });
    assert.strictEqual(moved.code, 0, `--prepare failed: ${moved.err}`);
    assert.strictEqual(stateOnDisk().cloudBuild.runId, undefined,
      'a run id from another commit must be dropped, not carried into this build');
    assert.strictEqual(stateOnDisk().cloudBuild.headSha, head);
  });

  test('running a later stage before the earlier ones is refused, not silently accepted', async () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    await seedAt(ProjectStates.ANALYZING);

    const res = run('cloudBuildExecute.ts', ['--prepare']);
    assert.notStrictEqual(res.code, 0, 'ANALYZING -> CLOUD_BUILDING must not be allowed to persist');
    assert.match(res.err, /Refusing to persist/);
    assert.match(res.err, /ANALYZING/, 'the refusal must name the state it refused to leave');
    assert.match(res.err, /CLOUD_BUILDING/, 'the refusal must name the state it refused to enter');
  });
});

/**
 * Installs a fake `gh` on PATH that answers `run view --json ...` with `json`.
 * Returning null makes the stub fail like an unauthenticated or offline CLI.
 */
function withGhStub(json: Record<string, unknown> | null): { dir: string } {
  const dir = join(TMP, 'ghstub-' + randomBytes(6).toString('hex'));
  mkdirSync(dir, { recursive: true });

  const lines = [
    '#!/bin/sh',
    'if [ "$1" = "run" ] && [ "$2" = "view" ]; then'
  ];
  if (json === null) {
    lines.push('  echo "gh: not authenticated" >&2', '  exit 1');
  } else {
    const payload = JSON.stringify(json);
    lines.push(
      '  case "$*" in',
      "    *jobs*) echo '{\"jobs\":[]}' ;;",
      "    *) echo '" + payload + "' ;;",
      '  esac'
    );
  }
  lines.push('fi', 'exit 0', '');
  writeFileSync(join(dir, 'gh'), lines.join('\n'), { mode: 0o755 });
  return { dir };
}

describe('a cloud build result is never invented', () => {
  // Given only a run id, the old code filled in status "completed" and
  // conclusion null without asking GitHub, so a real green run was reported as
  // ok:false with failureClass "unknown" and exit 1, and the guard that rejects
  // a run belonging to another commit never ran at all.
  test('a run id alone is resolved against the remote, not assumed', async () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf-8' }).trim();
    await seedCloudBuild(head);

    const stub = withGhStub({
      databaseId: 4242, status: 'completed', conclusion: 'success', headSha: head, url: 'https://example.invalid/run'
    });
    const res = run('cloudBuildExecute.ts', ['--watch'], {
      BUILDER_RUN_ID: '4242', PATH: `${stub.dir}:${process.env.PATH}`,
    });
    assert.strictEqual(res.code, 0, `a green run must exit 0. stdout=${res.out} stderr=${res.err}`);
    assert.match(res.out, /"ok": true/);
    assert.match(res.out, /"conclusion": "success"/);
    const s = stateOnDisk();
    assert.strictEqual(s.cloudBuild.status, 'passed');
    assert.strictEqual(s.projectState, ProjectStates.VERIFYING);
  });

  test('a run id from another commit is refused even when it is green', async () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf-8' }).trim();
    await seedCloudBuild(head);

    const stub = withGhStub({
      databaseId: 4242, status: 'completed', conclusion: 'success',
      headSha: '0000000000000000000000000000000000000000', url: 'https://example.invalid/run'
    });
    const res = run('cloudBuildExecute.ts', ['--watch'], {
      BUILDER_RUN_ID: '4242', PATH: `${stub.dir}:${process.env.PATH}`,
    });
    assert.notStrictEqual(res.code, 0, 'a green run for another commit must not pass');
    assert.match(res.err + res.out, /Refusing result for run 4242/);
    const s = stateOnDisk();
    assert.notStrictEqual(s.cloudBuild.status, 'passed');
  });

  test('an unreachable remote is a failure, not a fabricated result', async () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    await seedAt(ProjectStates.CLOUD_BUILDING);

    const stub = withGhStub(null);
    const res = run('cloudBuildExecute.ts', ['--watch'], {
      BUILDER_RUN_ID: '4242', PATH: `${stub.dir}:${process.env.PATH}`,
    });
    assert.notStrictEqual(res.code, 0, 'an unreadable run must not exit 0');
    assert.doesNotMatch(res.out, /"ok": true/);
    const s = stateOnDisk();
    assert.notStrictEqual(s.cloudBuild.status, 'passed');
  });

  test('a status without a conclusion is not accepted as an injected result', async () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    await seedAt(ProjectStates.CLOUD_BUILDING);

    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf-8' }).trim();
    await seedCloudBuild(head);
    const stub = withGhStub({
      databaseId: 4242, status: 'completed', conclusion: 'failure', headSha: head, url: 'https://example.invalid/run'
    });
    // Only the status is injected. The conclusion must come from the remote,
    // which says failure, so the build must not be recorded as passed.
    const res = run('cloudBuildExecute.ts', [], {
      BUILDER_RUN_ID: '4242', BUILDER_RUN_STATUS: 'completed',
      BUILDER_RUN_LOGS: 'e: x.kt:1 Unresolved reference: y',
      PATH: `${stub.dir}:${process.env.PATH}`,
    });
    assert.notStrictEqual(res.code, 0);
    const s = stateOnDisk();
    assert.notStrictEqual(s.cloudBuild.status, 'passed');
  });
});

describe('cloud build never reports false success', () => {
  test('a queued or in-progress run exits 3 and is not recorded as passed', async () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'requested']) {
      rmSync(STATE_DIR, { recursive: true, force: true });
      rmSync(CP_DIR, { recursive: true, force: true });
      await seedAt(ProjectStates.CLOUD_BUILDING);

      const res = run('cloudBuildExecute.ts', [], {
        BUILDER_RUN_ID: '4242', BUILDER_RUN_STATUS: status, BUILDER_RUN_CONCLUSION: '',
      });
      assert.strictEqual(res.code, 3, `${status} must exit 3 (not finished)`);
      const s = stateOnDisk();
      assert.notStrictEqual(s.cloudBuild.status, 'passed', `${status} must not be recorded as passed`);
      assert.notStrictEqual(s.projectState, ProjectStates.VERIFYING);
    }
  });

  test('a failed run is recorded as REPAIRING with a root cause, never as passed', async () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    await seedAt(ProjectStates.CLOUD_BUILDING);

    const res = run('cloudBuildExecute.ts', [], {
      BUILDER_RUN_ID: '4242',
      BUILDER_RUN_STATUS: 'completed',
      BUILDER_RUN_CONCLUSION: 'failure',
      BUILDER_RUN_LOGS: 'e: Main.kt:9:3 Unresolved reference: foo\n> Task :app:compileDebugKotlin FAILED',
    });
    assert.notStrictEqual(res.code, 0, 'a failed build must exit non-zero');
    const s = stateOnDisk();
    assert.notStrictEqual(s.cloudBuild.status, 'passed');
    assert.strictEqual(s.projectState, ProjectStates.REPAIRING);
    assert.ok(s.failureRepair?.rootCause, 'a repair must record a root cause');
  });

  test('heap exhaustion is a config fix, not a retryable transient', () => {
    for (const log of [
      'java.lang.OutOfMemoryError: Java heap space',
      'java.lang.OutOfMemoryError: GC overhead limit exceeded',
      'Gradle build daemon disappeared unexpectedly',
    ]) {
      const c = classifyFailure(log.split('\n'));
      if (log.includes('OutOfMemory')) {
        assert.strictEqual(c.klass, 'workflow_config', `"${log}" should be a config problem`);
        assert.strictEqual(isTransientFailure(c.klass), false,
          'retrying an unchanged OOM build fails identically, so it must not be retryable');
      }
    }
  });

  test('genuinely transient infrastructure problems stay retryable', () => {
    const c = classifyFailure([
      'Received status code 503 from https://dl.google.com',
      'connection reset by peer',
    ]);
    assert.strictEqual(c.klass, 'infrastructure_transient');
    assert.strictEqual(isTransientFailure(c.klass), true);
  });

  test('a successful run advances to VERIFYING and records build evidence', async () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    await seedAt(ProjectStates.CLOUD_BUILDING);

    const res = run('cloudBuildExecute.ts', [], {
      BUILDER_RUN_ID: '4242',
      BUILDER_RUN_STATUS: 'completed',
      BUILDER_RUN_CONCLUSION: 'success',
      BUILDER_RUN_LOGS: 'BUILD SUCCESSFUL',
    });
    assert.strictEqual(res.code, 0, `expected success path to exit 0: ${res.err}`);
    const s = stateOnDisk();
    assert.strictEqual(s.cloudBuild.status, 'passed');
    assert.strictEqual(s.projectState, ProjectStates.VERIFYING);
  });
});

describe('the completion gate can actually be satisfied, not just always refuse', () => {
  const SHA = 'a'.repeat(64);
  const REPO_NAME = 'sikorokoro44/ai-app-builder';
  const ASSET_URL = `https://github.com/${REPO_NAME}/releases/download/build-9001/app-debug.apk`;

  /** Seeds a state that genuinely satisfies every completion requirement. */
  async function seedFullyEvidenced(): Promise<void> {
    const { initStateStore, readState, writeState } = await import('../scripts/live/stateStore.ts');
    const { LifecycleStages } = await import('../scripts/live/evidenceChain.ts');
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    initStateStore();
    const s: any = readState();

    // Walk legally up to DOWNLOAD_READY.
    const { VALID_TRANSITIONS } = await import('../scripts/live/stateValidator.ts');
    const parents: Record<string, string> = { [s.projectState]: '' };
    const seen = new Set<string>([s.projectState]);
    const queue: string[] = [s.projectState];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of VALID_TRANSITIONS[cur] || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        parents[next] = cur;
        queue.push(next);
      }
    }
    const chain: string[] = [];
    for (let at = ProjectStates.DOWNLOAD_READY; at; at = parents[at]) chain.unshift(at);
    for (const step of chain) {
      if (step === s.projectState) continue;
      s.projectState = step;
      writeState(s);
    }

    s.overallProgressPct = 100;
    s.totalFeatures = 1;
    s.completedFeatures = 1;
    s.totalTasks = 2;
    s.completedTasks = 2;
    s.testStats = { discovered: 2, running: 0, passed: 2, failed: 0 };
    s.cloudBuild = {
      state: 'passed', stage: 'RELEASE', status: 'passed', output: [],
      runId: '9001', headSha: 'b'.repeat(40), artifactSha256: SHA
    };
    s.apkVerification = 'passed';
    s.icon = { status: 'passed', category: 'notes', purpose: 'notes', fingerprint: 'f'.repeat(64) };
    s.apkPath = '/data/data/com.termux/files/usr/tmp/opencode/app-debug.apk';
    s.apkSha256 = SHA;
    s.apkPackageId = 'com.builder.todo';
    s.release = {
      status: 'created', assetUrl: ASSET_URL, assetName: 'app-debug.apk',
      assetSha256: SHA, repo: REPO_NAME, tag: 'build-9001'
    };
    s.finalDownloadUrl = ASSET_URL;
    s.evidence = {
      stages: LifecycleStages.map((stage) => ({ stage, evidence: `verified ${stage}`, at: new Date().toISOString() })),
      publicDownloadVerified: true
    };
    writeState(s);
  }

  test('a genuinely evidenced project completes', async () => {
    await seedFullyEvidenced();
    const res = run('markComplete.ts');
    assert.strictEqual(res.code, 0,
      `markComplete should accept fully evidenced state; got:\n${res.err}`);
    assert.strictEqual(stateOnDisk().projectState, ProjectStates.COMPLETED);
    assert.strictEqual(stateOnDisk().overallProgressPct, 100);
  });

  test('the same project is refused if the public download was never verified', async () => {
    await seedFullyEvidenced();
    const { readState, writeState } = await import('../scripts/live/stateStore.ts');
    const s: any = readState();
    s.evidence.publicDownloadVerified = false;
    writeState(s);

    const res = run('markComplete.ts');
    assert.notStrictEqual(res.code, 0, 'an unverified public download must not complete');
    assert.notStrictEqual(stateOnDisk().projectState, ProjectStates.COMPLETED);
  });

  test('the same project is refused if the release asset checksum is unknown', async () => {
    await seedFullyEvidenced();
    const { readState, writeState } = await import('../scripts/live/stateStore.ts');
    const s: any = readState();
    s.release.assetSha256 = undefined;
    writeState(s);

    const res = run('markComplete.ts');
    assert.notStrictEqual(res.code, 0, 'a release without a verified checksum must not complete');
  });

  test('DOWNLOAD_READY refuses short evidence and accepts the full ordered chain', async () => {
    // Refuses an empty project outright.
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    const early = run('markDownloadReady.ts');
    assert.notStrictEqual(early.code, 0, 'an empty project must not reach DOWNLOAD_READY');

    // The same fully evidenced project used by the completion gate, stopped one
    // stage earlier at RELEASING, with FINAL_VERIFY withheld (markDownloadReady
    // records that stage itself).
    await seedFullyEvidenced();
    const { readState, writeState } = await import('../scripts/live/stateStore.ts');
    const s: any = readState();
    s.projectState = ProjectStates.RELEASING;
    s.evidence.stages = s.evidence.stages.filter((st: any) => st.stage !== 'FINAL_VERIFY');
    writeState(s);

    const ok = run('markDownloadReady.ts');
    assert.strictEqual(ok.code, 0, `full chain should reach DOWNLOAD_READY:\n${ok.err}`);
    assert.strictEqual(stateOnDisk().projectState, ProjectStates.DOWNLOAD_READY);
    const recorded = stateOnDisk().evidence.stages.map((st: any) => st.stage);
    assert.ok(recorded.includes('FINAL_VERIFY'), 'markDownloadReady should record FINAL_VERIFY');
  });

  test('DOWNLOAD_READY is refused when a public-download evidence stage is missing', async () => {
    await seedFullyEvidenced();
    const { readState, writeState } = await import('../scripts/live/stateStore.ts');
    const s: any = readState();
    s.projectState = ProjectStates.RELEASING;
    s.evidence.stages = s.evidence.stages.filter((st: any) => st.stage !== 'PUBLIC_DOWNLOAD');
    writeState(s);

    const res = run('markDownloadReady.ts');
    assert.notStrictEqual(res.code, 0,
      'a verified flag without the PUBLIC_DOWNLOAD stage is not enough to claim download readiness');
    assert.match(res.err, /PUBLIC_DOWNLOAD/);
  });

  test('the same project is refused if one evidence stage is missing', async () => {
    await seedFullyEvidenced();
    const { readState, writeState } = await import('../scripts/live/stateStore.ts');
    const s: any = readState();
    s.evidence.stages = s.evidence.stages.filter((st: any) => st.stage !== 'RELEASE');
    writeState(s);

    const res = run('markComplete.ts');
    assert.notStrictEqual(res.code, 0, 'a missing evidence stage must not complete');
  });

  test('completion does not persist the derived currentStagePct as if it were evidence', async () => {
    await seedFullyEvidenced();
    assert.strictEqual(run('markComplete.ts').code, 0);
    const onDisk = stateOnDisk();
    assert.ok(!('currentStagePct' in onDisk),
      'currentStagePct is derived per-read; persisting a literal 100 would be dead data that looks like evidence');
  });
});

describe('the event log can never claim a state the state file never reached', () => {
  test('a refused transition leaves no fabricated PROJECT_STATUS_CHANGED event', async () => {
    const { initStateStore, readState, writeState, readEvents } = await import('../scripts/live/stateStore.ts');
    const { VALID_TRANSITIONS } = await import('../scripts/live/stateValidator.ts');
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    initStateStore();

    // Walk legally to a build stage.
    const s: any = readState();
    const seen = new Set<string>([s.projectState]);
    const parents: Record<string, string> = { [s.projectState]: '' };
    const queue: string[] = [s.projectState];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of VALID_TRANSITIONS[cur] || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        parents[next] = cur;
        queue.push(next);
      }
    }
    const chain: string[] = [];
    for (let at = ProjectStates.TESTING; at; at = parents[at]) chain.unshift(at);
    for (const step of chain) {
      if (step === s.projectState) continue;
      s.projectState = step;
      writeState(s);
    }
    assert.strictEqual(readState().projectState, ProjectStates.TESTING);

    const before = readEvents().filter((e) => e.type === 'PROJECT_STATUS_CHANGED').length;

    // Now attempt the illegal backwards move the orchestrator used to force.
    const bad: any = readState();
    bad.projectState = ProjectStates.READY;
    bad.latestActivity = 'Orchestrator ready';
    assert.throws(() => writeState(bad), /Refusing to persist/);

    const after = readEvents().filter((e) => e.type === 'PROJECT_STATUS_CHANGED');
    assert.strictEqual(after.length, before,
      'a refused transition must not add a PROJECT_STATUS_CHANGED event');
    assert.strictEqual(readState().projectState, ProjectStates.TESTING,
      'the state file must be unchanged after a refused transition');

    // The decisive check: replaying the log must not invent the refused state.
    const replayed = readEvents()
      .filter((e) => e.type === 'PROJECT_STATUS_CHANGED' && typeof e.projectState === 'string')
      .map((e) => e.projectState);
    assert.ok(!replayed.includes(ProjectStates.READY),
      'the event log claims READY, which recovery would replay as a real lifecycle state');
    assert.strictEqual(replayed[replayed.length - 1], ProjectStates.TESTING);
  });

  test('the orchestrator registers agents without resetting progress or forcing a state', async () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });
    const { initStateStore, readState, writeState } = await import('../scripts/live/stateStore.ts');
    const { VALID_TRANSITIONS } = await import('../scripts/live/stateValidator.ts');
    initStateStore();
    const s: any = readState();
    const parents: Record<string, string> = { [s.projectState]: '' };
    const seen = new Set<string>([s.projectState]);
    const queue: string[] = [s.projectState];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of VALID_TRANSITIONS[cur] || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        parents[next] = cur;
        queue.push(next);
      }
    }
    const chain: string[] = [];
    for (let at = ProjectStates.TESTING; at; at = parents[at]) chain.unshift(at);
    for (const step of chain) {
      if (step === s.projectState) continue;
      s.projectState = step;
      writeState(s);
    }
    s.totalTasks = 7;
    s.overallProgressPct = 42;
    writeState(s);

    const res = run('live/orchestrator.ts');
    assert.strictEqual(res.code, 0, `orchestrator failed: ${res.err}`);

    const after: any = readState();
    assert.strictEqual(after.projectState, ProjectStates.TESTING, 'orchestrator must not move the lifecycle');
    assert.strictEqual(after.totalTasks, 7, 'orchestrator must not reset task counts');
    assert.strictEqual(after.overallProgressPct, 42, 'orchestrator must not reset progress');
    assert.strictEqual(Object.keys(after.agents).length, 20, 'orchestrator should still register its agents');
  });
});

/** Splits a workflow into steps, keeping each step's raw text and display name. */
function splitSteps(wf: string): { name: string; text: string }[] {
  return wf.split(/^ {6}- (?:name|uses|id|run): /m).slice(1).map((chunk) => {
    const nl = chunk.indexOf('\n');
    return { name: chunk.slice(0, nl === -1 ? chunk.length : nl).trim(), text: chunk };
  });
}

/**
 * Extracts a step's `run: |` script and removes the YAML block indentation.
 * splitSteps has already cut the step out of the workflow, so the script runs to
 * the end of the chunk; trailing blank lines are dropped.
 */
function dedentRun(stepText: string): string {
  const body = /run: \|\n([\s\S]*)$/.exec(stepText)?.[1];
  if (!body) return '';
  const lines = body.replace(/\s+$/, '').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length);
  const n = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(n)).join('\n');
}

describe('the CI build can actually run Gradle', () => {
  test('the workflow provisions Gradle at the version the generator pins', () => {
    const wf = readFileSync(join(REPO, '.github/workflows/builder-android-build.yml'), 'utf-8');
    const props = readFileSync(join(REPO, '.builder/generated/android/gradle/wrapper/gradle-wrapper.properties'), 'utf-8');

    // The generated gradlew is a shim that execs a system `gradle`; without this
    // action the runner has Java but no Gradle and the build cannot start.
    assert.match(wf, /gradle\/actions\/setup-gradle@v\d+/,
      'the workflow must set up Gradle: the generated gradlew only execs a system gradle');

    const pinned = props.match(/gradle-([\d.]+)-bin\.zip/);
    assert.ok(pinned, 'could not read the pinned Gradle version from gradle-wrapper.properties');
    assert.ok(wf.includes(`gradle-version: '${pinned[1]}'`),
      `workflow Gradle version must match the pinned ${pinned[1]} from gradle-wrapper.properties`);
  });

  test('the generated gradlew really is a shim, so the workflow cannot rely on a wrapper jar', () => {
    const gradlew = readFileSync(join(REPO, '.builder/generated/android/gradlew'), 'utf-8');
    assert.match(gradlew, /exec gradle "\$@"/);
    assert.ok(!existsSync(join(REPO, '.builder/generated/android/gradle/wrapper/gradle-wrapper.jar')),
      'if a wrapper jar is ever committed, the setup-gradle step must be revisited');
  });

  test('the workflow makes gradlew executable before invoking it', () => {
    const wf = readFileSync(join(REPO, '.github/workflows/builder-android-build.yml'), 'utf-8');
    assert.match(wf, /chmod \+x gradlew/);
  });

  test('the workflow fails the build if no APK is produced', () => {
    const wf = readFileSync(join(REPO, '.github/workflows/builder-android-build.yml'), 'utf-8');
    assert.match(wf, /produced no APK/);
    assert.match(wf, /if-no-files-found: error/);
  });

  test('the workflow records the artifact checksum rather than only uploading it', () => {
    const wf = readFileSync(join(REPO, '.github/workflows/builder-android-build.yml'), 'utf-8');
    assert.match(wf, /sha256sum/);
    assert.match(wf, /apk_sha256/);
  });

  test('the identity step refuses to report success without a package id', () => {
    // verifyApkFile reported valid=true with packageId undefined because the
    // extractor could not read a compiled manifest, so the step recorded an
    // empty package_id and still passed. The run must fail instead.
    const wf = readFileSync(join(REPO, '.github/workflows/builder-android-build.yml'), 'utf-8');
    assert.match(wf, /requirePackageId: true/,
      'the identity step must require a readable package id');
    assert.match(wf, /produced no package id/,
      'the identity step must fail when the package id comes back empty');
  });

  test('every variable used in a run step is bound in that step', () => {
    // `set -u` turns an unset variable into a fatal error. The identity step
    // referenced $head, which only existed as a step output in an earlier step,
    // so the step died with "head: unbound variable" after the APK had already
    // been built and checksummed. Each run: script is checked independently, and
    // only names the runner itself provides are treated as bound.
    const wf = readFileSync(join(REPO, '.github/workflows/builder-android-build.yml'), 'utf-8');
    const provided = new Set([
      'BASH', 'PATH', 'HOME', 'PWD', 'USER', 'SHELL', 'TMPDIR', 'RANDOM', 'IFS',
      'GITHUB_WORKSPACE', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_ENV',
      'GITHUB_PATH', 'GITHUB_STEP_NAME', 'GITHUB_RUN_ID', 'GITHUB_SHA',
      'RUNNER_OS', 'RUNNER_TEMP', 'CI', 'JAVA_HOME', 'GRADLE_USER_HOME'
    ]);

    const problems: string[] = [];
    let checked = 0;
    for (const step of splitSteps(wf)) {
      if (!/run: \|\n/.test(step.text)) continue;
      const code = dedentRun(step.text);
      if (!/set -[a-z]*u/.test(code)) continue;
      checked++;

      const bound = new Set(provided);
      for (const m of code.matchAll(/(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=/g)) bound.add(m[1]);
      for (const m of code.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\)/gm)) bound.add(m[1]);
      for (const m of code.matchAll(/\b(?:while\s+)?read\s+(?:-r\s+)?([A-Za-z_][A-Za-z0-9_]*)/g)) bound.add(m[1]);
      const envBlock = /\n {8}env:\n((?: {10}.*\n)+)/.exec(step.text)?.[1] || '';
      for (const m of envBlock.matchAll(/^ {10}([A-Za-z_][A-Za-z0-9_]*):/gm)) bound.add(m[1]);
      // Assignments inside a pipeline segment or a for-list are bound too.
      for (const m of code.matchAll(/\bfor\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s+([^;\n]+)/g)) {
        for (const w of m[1].split(/\s+/)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w)) bound.add(w);
      }
      for (const m of code.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
        if (!bound.has(m[1])) problems.push(`step "${step.name}" uses unbound $${m[1]}`);
      }
    }
    assert.ok(checked >= 5, `expected several strict-mode steps, checked ${checked}`);
    assert.deepStrictEqual(problems, [], problems.join('\n'));
  });

  test('every step output the workflow consumes is produced by that same step', () => {
    // `head_sha` was declared as a workflow output reading
    // steps.identity.outputs.head_sha, but the identity step never wrote it, so
    // the commit sha recorded by the orchestrator was silently empty. Checking
    // only that some step emits the name is not enough: a different step did.
    const wf = readFileSync(join(REPO, '.github/workflows/builder-android-build.yml'), 'utf-8');

    const byId = new Map<string, Set<string>>();
    for (const step of splitSteps(wf)) {
      const id = /^ {8}id:\s*([A-Za-z0-9_-]+)/m.exec(step.text)?.[1];
      if (!id) continue;
      const outputs = new Set<string>();
      for (const m of step.text.matchAll(/echo "([A-Za-z0-9_]+)=[^"]*" >> "\$GITHUB_OUTPUT"/g)) outputs.add(m[1]);
      byId.set(id, outputs);
    }

    const problems: string[] = [];
    let checked = 0;
    for (const m of wf.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_]+)/g)) {
      checked++;
      const [, id, name] = m;
      if (!byId.has(id)) problems.push(`steps.${id} is referenced but no step has id: ${id}`);
      else if (!byId.get(id)!.has(name)) {
        problems.push(`steps.${id}.outputs.${name} is consumed but step ${id} never writes ${name}`);
      }
    }
    assert.ok(checked > 0, 'expected the workflow to consume step outputs');
    assert.deepStrictEqual(problems, [], problems.join('\n'));

    // The verified commit sha must reach the runner's outputs, since the
    // orchestrator records it as the provenance of the built artifact.
    assert.ok(byId.get('commit')?.has('head_sha'), 'the commit step must publish head_sha');
    assert.ok(byId.get('identity')?.has('head_sha'), 'the identity step must publish head_sha');
    assert.match(wf, /head_sha: \$\{\{ steps\.identity\.outputs\.head_sha \}\}/);
  });
});

describe('generated project is valid and buildable inputs only', () => {
  test('the committed generated project passes structural validation', async () => {
    const { validateGeneratedProject } = await import('../scripts/live/projectValidator.ts');
    const r = validateGeneratedProject(join(REPO, '.builder/generated/android'));
    assert.ok(r.valid, `committed generated project is invalid:\n${r.errors.join('\n')}`);
    assert.ok(r.packageId && !/example|placeholder|fake|dummy|sample/i.test(r.packageId));
  });

  test('an incomplete project is rejected before any build is attempted', async () => {
    const { validateGeneratedProject } = await import('../scripts/live/projectValidator.ts');
    const broken = join(TMP, 'broken');
    mkdirSync(join(broken, 'app'), { recursive: true });
    writeFileSync(join(broken, 'app', 'build.gradle.kts'), '// nothing useful\n');
    const r = validateGeneratedProject(broken);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.length > 0);
  });
});

describe('a real pipeline run produces the evidence the completion gate demands', () => {
  // seedFullyEvidenced() hand-writes the entire chain, so it passes no matter how
  // little the production scripts actually record. It hid the fact that nothing
  // ever recorded IDEA, ANALYZE, DESIGN, PLAN, SCAFFOLD or TESTGEN, which left
  // DOWNLOAD_READY unreachable for any genuine run. This block runs the scripts.
  function runStage(script: string, env: Record<string, string> = {}) {
    try {
      const out = execFileSync('node', ['--experimental-strip-types', join(REPO, 'scripts', script)], {
        // Run from the temp dir so ideaInput/scaffold write their byproducts
        // outside the repository instead of overwriting tracked files.
        cwd: TMP,
        encoding: 'utf-8',
        env: { ...process.env, ...env, BUILDER_STATE_DIR: STATE_DIR, BUILDER_CHECKPOINT_DIR: CP_DIR },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, err: '' };
    } catch (e: any) {
      return { code: typeof e.status === 'number' ? e.status : 1, out: e.stdout || '', err: e.stderr || '' };
    }
  }

  test('each design stage records its own evidence link', async () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(CP_DIR, { recursive: true, force: true });

    // The order matters: each script also advances projectState, so running them
    // out of order would be refused as an illegal transition.
    const chain: Array<[string, Record<string, string>?]> = [
      ['ideaInput.ts', { BUILDER_IDEA: 'Todo App' }],
      ['analyze.ts', undefined],
      ['design.ts', undefined],
      ['plan.ts', undefined],
      ['scaffold.ts', undefined],
      ['implement.ts', undefined],
      ['testgen.ts', undefined],
    ];
    for (const [script, env] of chain) {
      const res = runStage(script, env);
      assert.strictEqual(res.code, 0, `${script} did not run cleanly:\n${res.err}`);
    }

    const { LifecycleStages } = await import('../scripts/live/evidenceChain.ts');
    const recorded = stateOnDisk().evidence.stages.map((st: any) => st.stage);
    for (const stage of ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'TESTGEN']) {
      assert.ok(recorded.includes(stage),
        `${stage} was never recorded by the pipeline; recorded: ${recorded.join(', ') || '(nothing)'}`);
    }
    // recordStage inserts by canonical position, so the chain must stay in
    // lifecycle order no matter which order the scripts were run in. IMPLEMENT is
    // absent here on purpose: it is asserted when the sources are actually pushed.
    assert.deepStrictEqual(recorded, (LifecycleStages as string[]).filter((s) => recorded.includes(s)),
      'the pipeline must record evidence in canonical lifecycle order');
  });

  test('running the pipeline does not write to tracked repository files', () => {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.builder/idea.txt', '.builder/out'],
      { cwd: REPO, encoding: 'utf-8' }).trim();
    assert.strictEqual(dirty, '',
      `the pipeline leaked byproducts into tracked files:\n${dirty}`);
  });

  test('the push step records IMPLEMENT even when there is nothing left to push', () => {
    const src = readFileSync(join(REPO, 'scripts', 'githubPush.ts'), 'utf-8');
    const alreadyPushed = src.slice(src.indexOf('if (!dirty && unpushed === 0) {'));
    assert.ok(alreadyPushed.includes("recordStage(s, 'IMPLEMENT'"),
      'a resumed run has nothing to commit, so the already-pushed path must record IMPLEMENT itself; '
      + 'otherwise the gate can never be satisfied');
  });
});
