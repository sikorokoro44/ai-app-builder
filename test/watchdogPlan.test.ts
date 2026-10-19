import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planWatchdog, configFromEnv, DEFAULT_WATCHDOG_CONFIG, newestRunId,
  type WatchdogConfig, type WatchdogRequest, type StateSnapshot, type CoordinatorRun
} from '../scripts/live/watchdogPlan.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

function cfg(over: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return { now: NOW, ...DEFAULT_WATCHDOG_CONFIG, ...over };
}

function request(over: Partial<WatchdogRequest> = {}): WatchdogRequest {
  return {
    requestId: '2026-10-19T11-00-00-000Z-watering-reminder',
    idea: 'watering reminder',
    mode: 'full',
    concurrency: 4,
    requestedAt: new Date(NOW - 3_600_000).toISOString(),
    state: 'dispatched',
    dispatches: [],
    ...over
  };
}

function snapshot(over: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    projectState: 'BUILDING',
    idea: 'watering reminder',
    lastUpdated: new Date(NOW - 3_600_000).toISOString(),
    missingStages: ['CLOUD_BUILD', 'BUILD_SUCCESS', 'REAL_APK', 'APK_VERIFY', 'FINAL_VERIFY'],
    decisionKind: 'WAITING',
    ...over
  };
}

function run(over: Partial<CoordinatorRun> = {}): CoordinatorRun {
  return { id: 111, status: 'in_progress', createdAt: new Date(NOW - 600_000).toISOString(), ...over };
}

describe('a delivered app closes the request it covers', () => {
  test('the matching request is closed and nothing is re-driven for it', () => {
    const plan = planWatchdog(
      [
        request(),
        request({ requestId: 'old-other-idea', idea: 'something else', requestedAt: new Date(NOW - 900 * 3_600_000).toISOString() })
      ],
      [],
      snapshot({ projectState: 'COMPLETED', decisionKind: 'COMPLETE', missingStages: [] }),
      [],
      cfg()
    );
    assert.deepStrictEqual(
      plan.closeDelivered.map((c) => c.requestId),
      [request().requestId],
      'exactly the request whose idea was delivered is closed'
    );
    assert.strictEqual(plan.resume, null, 'a completed run has nothing to resume');
    assert.deepStrictEqual(plan.redrive, [], 'nothing is re-dispatched for a delivered idea');
    const stale = plan.skipped.find((s) => s.subject === 'old-other-idea');
    assert.ok(stale && /outside the .* window/.test(stale.reason), 'the ancient request is skipped, not revived');
  });

  test('a claim without its evidence chain does not close anything', () => {
    const plan = planWatchdog(
      [request()],
      [],
      snapshot({ projectState: 'COMPLETED', decisionKind: 'WAITING' }),
      [],
      cfg()
    );
    assert.deepStrictEqual(plan.closeDelivered, [], 'a COMPLETED label without gates closes nothing');
  });
});

describe('runs the platform abandoned', () => {
  test('a queued run past its limit is cancelled and its request re-driven', () => {
    const staleRun = run({ id: 9, status: 'queued', createdAt: new Date(NOW - 60 * 60_000).toISOString() });
    const plan = planWatchdog(
      [request({ dispatches: [{ at: new Date(NOW - 60 * 60_000).toISOString(), outcome: 'dispatched', runId: '9' }] })],
      [staleRun],
      snapshot(),
      [],
      cfg()
    );
    assert.deepStrictEqual(plan.cancelRuns.map((c) => c.runId), ['9']);
    assert.match(plan.cancelRuns[0].reason, /without starting/);
    assert.strictEqual(plan.redrive.length, 1, 'the abandoned dispatch is worth one fresh attempt');
    assert.strictEqual(plan.redrive[0].requestId, request().requestId);
  });

  test('a recently queued run still counts as in flight', () => {
    const plan = planWatchdog(
      [request({ dispatches: [{ at: new Date(NOW - 300_000).toISOString(), outcome: 'dispatched', runId: '111' }] })],
      [run({ status: 'queued', createdAt: new Date(NOW - 300_000).toISOString() })],
      snapshot(),
      [],
      cfg()
    );
    assert.deepStrictEqual(plan.cancelRuns, []);
    assert.deepStrictEqual(plan.redrive, []);
    assert.ok(plan.skipped.some((s) => /in flight/.test(s.reason)));
    assert.deepStrictEqual(plan.emailKinds, ['COMPLETE', 'FAILED'], 'WAITING mail waits for a quiet repository');
  });

  test('an in-progress run beyond the coordinator timeout is cancelled', () => {
    const plan = planWatchdog(
      [],
      [run({ id: 5, status: 'in_progress', createdAt: new Date(NOW - 3 * 3_600_000).toISOString() })],
      snapshot(),
      [],
      cfg()
    );
    assert.deepStrictEqual(plan.cancelRuns.map((c) => c.runId), ['5']);
    assert.match(plan.cancelRuns[0].reason, /running for/);
  });

  test('an unknown future status is left alone rather than cancelled', () => {
    const plan = planWatchdog(
      [request({ dispatches: [{ at: new Date(NOW - 600_000).toISOString(), outcome: 'dispatched', runId: '42' }] })],
      [run({ id: 42, status: 'teleported' })],
      snapshot(),
      [],
      cfg()
    );
    assert.deepStrictEqual(plan.cancelRuns, []);
    assert.deepStrictEqual(plan.redrive, [], 'an unrecognised live status blocks a re-dispatch');
  });
});

describe('an interrupted run is resumed, not restarted', () => {
  test('stale incomplete state with a store resumes the newest run', () => {
    const plan = planWatchdog(
      [request()],
      [],
      snapshot(),
      ['37687931599', '37687932000'],
      cfg()
    );
    assert.ok(plan.resume, 'a stale interrupted run must be resumed');
    assert.strictEqual(plan.resume!.runId, '37687932000', 'the newest store is the one to continue');
    assert.strictEqual(plan.resume!.mode, 'full');
    assert.deepStrictEqual(plan.redrive, [], 'the matching request must not start a second run');
    assert.ok(plan.skipped.some((s) => /resumed, not restarted/.test(s.reason)));
  });

  test('a fresh state is left for the run that may still be writing it', () => {
    const plan = planWatchdog(
      [request()],
      [],
      snapshot({ lastUpdated: new Date(NOW - 60_000).toISOString() }),
      ['37687931599'],
      cfg()
    );
    assert.strictEqual(plan.resume, null);
    assert.ok(plan.skipped.some((s) => s.subject === 'resume' && /too recently/.test(s.reason)));
  });

  test('with no run store the request falls back to a re-dispatch', () => {
    const plan = planWatchdog([request()], [], snapshot(), [], cfg());
    assert.strictEqual(plan.resume, null, 'there is nothing to resume from');
    assert.ok(plan.skipped.some((s) => s.subject === 'resume' && /run store/.test(s.reason)));
    assert.strictEqual(plan.redrive.length, 1, 'a lost store must eventually restart the work');
    assert.strictEqual(plan.redrive[0].requestId, request().requestId);
  });

  test('an in-flight run means nobody else may dispatch', () => {
    const plan = planWatchdog(
      [request()],
      [run()],
      snapshot(),
      ['37687931599'],
      cfg()
    );
    assert.strictEqual(plan.resume, null, 'the live run is already continuing the work');
    assert.deepStrictEqual(plan.redrive, []);
  });
});

describe('a failed run needs a person, not a loop', () => {
  test('the request for the failed idea is not re-driven automatically', () => {
    const plan = planWatchdog(
      [request()],
      [],
      snapshot({ projectState: 'FAILED', decisionKind: 'FAILED', missingStages: [] }),
      ['37687931599'],
      cfg()
    );
    assert.strictEqual(plan.resume, null);
    assert.deepStrictEqual(plan.redrive, []);
    assert.ok(plan.skipped.some((s) => /explicit repair/.test(s.reason)));
    assert.deepStrictEqual(plan.emailKinds, ['COMPLETE', 'FAILED', 'WAITING']);
  });
});

describe('re-dispatch is bounded on every side', () => {
  test('the lifetime cap stops a repeatedly failing request', () => {
    const req = request({
      dispatches: [
        { at: new Date(NOW - 5 * 3_600_000).toISOString(), outcome: 'dispatched', runId: '1' },
        { at: new Date(NOW - 4 * 3_600_000).toISOString(), outcome: 'dispatched', runId: '2' },
        { at: new Date(NOW - 3 * 3_600_000).toISOString(), outcome: 'dispatched', runId: '3' }
      ]
    });
    const plan = planWatchdog([req], [], snapshot(), [], cfg());
    assert.deepStrictEqual(plan.redrive, []);
    assert.ok(plan.skipped.some((s) => s.subject === req.requestId && /cap 3/.test(s.reason)));
  });

  test('the backoff floor keeps a just-dispatched request quiet', () => {
    const req = request({ dispatches: [{ at: new Date(NOW - 120_000).toISOString(), outcome: 'dispatched', runId: '1' }] });
    const plan = planWatchdog([req], [], snapshot(), [], cfg());
    assert.deepStrictEqual(plan.redrive, []);
    assert.ok(plan.skipped.some((s) => /inside the 10 minute floor/.test(s.reason)));
  });

  test('the age window refuses ideas nobody has asked for recently', () => {
    const req = request({ requestedAt: new Date(NOW - 100 * 3_600_000).toISOString() });
    const plan = planWatchdog([req], [], snapshot(), [], cfg());
    assert.deepStrictEqual(plan.redrive, []);
    assert.ok(plan.skipped.some((s) => /auto-redrive window/.test(s.reason)));
  });

  test('one tick dispatches at most one idea, the newest', () => {
    const older = request({
      requestId: 'older',
      idea: 'an older idea',
      requestedAt: new Date(NOW - 7_200_000).toISOString()
    });
    const newer = request({
      requestId: 'newer',
      idea: 'a newer idea',
      requestedAt: new Date(NOW - 3_600_000).toISOString()
    });
    const plan = planWatchdog([older, newer], [], snapshot({ idea: 'something unrelated' }), [], cfg());
    assert.deepStrictEqual(plan.redrive.map((r) => r.requestId), ['newer']);
    assert.ok(plan.skipped.some((s) => s.subject === 'older' && /per-tick limit/.test(s.reason)));
  });

  test('a request that was never dispatched is re-driven once it is stale enough', () => {
    const req = request({
      state: 'requested',
      requestedAt: new Date(NOW - 5 * 60_000).toISOString()
    });
    const plan = planWatchdog([req], [], snapshot(), [], cfg());
    assert.strictEqual(plan.redrive.length, 1);
    assert.strictEqual(plan.redrive[0].reason, 'the request was never dispatched');
  });
});

describe('configuration and helpers', () => {
  test('the environment overrides are read by name', () => {
    const conf = configFromEnv({
      BUILDER_WATCHDOG_MAX_REDRIVES: '7',
      BUILDER_WATCHDOG_STALE_STATE_MS: '1000',
      BUILDER_WATCHDOG_NOW: String(NOW)
    }, NOW);
    assert.strictEqual(conf.maxRedrives, 7);
    assert.strictEqual(conf.staleStateMs, 1000);
    assert.strictEqual(conf.redriveFloorMs, DEFAULT_WATCHDOG_CONFIG.redriveFloorMs, 'unset values keep their defaults');
  });

  test('a nonsense override falls back to the default instead of zeroing a rule', () => {
    const conf = configFromEnv({ BUILDER_WATCHDOG_MAX_REDRIVES: 'soon' }, NOW);
    assert.strictEqual(conf.maxRedrives, DEFAULT_WATCHDOG_CONFIG.maxRedrives);
  });

  test('the newest run id is chosen numerically', () => {
    assert.strictEqual(newestRunId(['9999999999', '10000000000', '111']), '10000000000');
  });
});

describe('the watchdog CLI decides from disk fixtures, not from guesswork', () => {
  test('--dry-run prints the plan and executes nothing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'builder-watchdog-'));
    const stateDir = join(tmp, 'live');
    const requestsDir = join(tmp, 'requests');
    const agentsDir = join(tmp, 'agents');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(requestsDir, { recursive: true });
    mkdirSync(join(agentsDir, '37687932000'), { recursive: true });

    const state = {
      version: 1,
      projectState: 'BUILDING',
      overallProgressPct: 40,
      elapsedMs: 0,
      latestActivity: 'implementation in progress',
      completedFeatures: 1,
      totalFeatures: 3,
      completedTasks: 4,
      totalTasks: 12,
      activeAgents: 2,
      waitingAgents: 0,
      blockedAgents: 0,
      agents: {},
      tasks: {},
      features: {},
      testStats: { discovered: 0, running: 0, passed: 0, failed: 0 },
      repairs: [],
      githubStatus: 'unknown',
      cloudBuild: { state: 'idle', stage: 'QUEUED', status: 'idle', output: [] },
      apkVerification: 'idle',
      icon: { status: 'idle' },
      release: { status: 'idle' },
      failureRepair: { state: 'idle' },
      buildLogs: [],
      lastUpdated: new Date(NOW - 3_600_000).toISOString(),
      idea: 'watering reminder',
      evidence: { stages: [{ stage: 'IDEA', evidence: 'accepted', at: new Date(NOW - 7_200_000).toISOString() }] }
    };
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state, null, 2));

    const requestId = '2026-10-19T11-00-00-000Z-watering-reminder';
    writeFileSync(join(requestsDir, `${requestId}.json`), JSON.stringify({
      requestId,
      idea: 'watering reminder',
      mode: 'full',
      concurrency: 4,
      requestedAt: new Date(NOW - 7_200_000).toISOString(),
      state: 'dispatched',
      dispatches: [{ at: new Date(NOW - 7_200_000).toISOString(), outcome: 'dispatched', runId: '9' }]
    }, null, 2));

    writeFileSync(join(agentsDir, '37687932000', 'manifest.json'), JSON.stringify({ runId: '37687932000', idea: 'watering reminder' }));

    const runsFile = join(tmp, 'runs.json');
    writeFileSync(runsFile, JSON.stringify([
      { id: 9, status: 'queued', createdAt: new Date(NOW - 60 * 60_000).toISOString() }
    ]));

    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, ['--experimental-strip-types', join('scripts', 'watchdog.ts'), '--dry-run'], {
        cwd: REPO,
        encoding: 'utf-8',
        env: {
          ...process.env,
          BUILDER_STATE_DIR: stateDir,
          BUILDER_REQUESTS_DIR: requestsDir,
          BUILDER_AGENT_DIR: agentsDir,
          BUILDER_WATCHDOG_RUNS_JSON: runsFile,
          BUILDER_WATCHDOG_NOW: String(NOW)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e: any) {
      code = typeof e.status === 'number' ? e.status : 1;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }

    assert.strictEqual(code, 0, `dry-run failed: ${out}`);
    const report = JSON.parse(out);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.dryRun, true);
    assert.deepStrictEqual(report.plan.cancelRuns.map((c: any) => c.runId), ['9'], 'the abandoned queued run is to be cancelled');
    assert.ok(report.plan.resume, 'the interrupted run is to be resumed');
    assert.strictEqual(report.plan.resume.runId, '37687932000');
    assert.deepStrictEqual(report.plan.redrive, [], 'the matching request is resumed, not re-driven');
    assert.ok(report.plan.emailKinds.includes('WAITING'), 'a quiet tick still owns the waiting notice');
    assert.ok(report.availableRunIds.includes('37687932000'));
  });
});
