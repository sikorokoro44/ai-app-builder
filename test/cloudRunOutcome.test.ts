import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  classifyRunOutcome,
  chooseRunToAdopt,
  jobExecutedAnyStep,
  retryBackoffMs,
  runNeverExecuted,
  decideRetry,
  isSuccessfulRun,
  type JobInfo,
  type RunInfo
} from '../scripts/live/workflowWatcher.ts';
import { isPlatformFault, isTransientFailure, REPAIR_PLAYBOOK } from '../scripts/live/failureClassifier.ts';

/*
 * The shapes below are copied from GitHub's own responses during incident
 * 3q1yb5m7ltvb ("delays in assigning GitHub-hosted runners"), which left runs
 * 37368567311 (coordinator) and 37368408479 (android build) queued for minutes
 * with conclusion cancelled, a startedAt stamp, no runner and no steps at all.
 * Nothing in those runs ever executed, so classifying them by logs alone
 * produced "unknown" and sent a run of correct code into a repair loop.
 */
const NEVER_STARTED_RUN: RunInfo = {
  id: 37368567311,
  status: 'completed',
  conclusion: 'cancelled',
  headSha: '51ffaa860a4a581bb5a8405e8ef843d0f8dd82a1',
  createdAt: '2026-10-05T20:15:07Z'
};

const NEVER_STARTED_JOB: JobInfo = {
  name: 'coordinate',
  status: 'completed',
  conclusion: 'cancelled',
  startedAt: '2026-10-05T20:15:11Z',
  completedAt: '2026-10-05T20:30:12Z',
  steps: []
};

const REAL_BUILD_JOB: JobInfo = {
  name: 'Assemble debug APK',
  status: 'completed',
  conclusion: 'success',
  startedAt: '2026-10-05T11:05:36Z',
  completedAt: '2026-10-05T11:06:46Z',
  steps: [
    { name: 'Set up job', status: 'completed', conclusion: 'success' },
    { name: 'Assemble the debug APK', status: 'completed', conclusion: 'success' }
  ]
};

describe('a run that never executed is a platform fault, not a code fault', () => {
  test('the queued-then-cancelled run is recognised as having run nothing', () => {
    assert.strictEqual(runNeverExecuted(NEVER_STARTED_RUN, [NEVER_STARTED_JOB]), true);
    assert.strictEqual(jobExecutedAnyStep(NEVER_STARTED_JOB), false);
  });

  test('a real build is never mistaken for a platform fault', () => {
    const run: RunInfo = { id: 37300693527, status: 'completed', conclusion: 'success' };
    assert.strictEqual(runNeverExecuted(run, [REAL_BUILD_JOB]), false);
    assert.strictEqual(jobExecutedAnyStep(REAL_BUILD_JOB), true);
  });

  test('a build that failed after running steps is a build failure', () => {
    const run: RunInfo = { id: 2, status: 'completed', conclusion: 'failure' };
    const job: JobInfo = {
      name: 'Assemble debug APK',
      status: 'completed',
      conclusion: 'failure',
      startedAt: '2026-10-05T11:05:36Z',
      steps: [
        { name: 'Set up job', status: 'completed', conclusion: 'success' },
        { name: 'Assemble the debug APK', status: 'completed', conclusion: 'failure' }
      ]
    };
    assert.strictEqual(runNeverExecuted(run, [job]), false);
    const outcome = classifyRunOutcome(run, [job], ['e: MainActivity.kt:9:1 Unresolved reference: foo']);
    assert.strictEqual(outcome.klass, 'source_code');
  });

  test('nothing is claimed when there is no job data to inspect', () => {
    assert.strictEqual(runNeverExecuted(NEVER_STARTED_RUN, []), false);
    assert.strictEqual(runNeverExecuted(NEVER_STARTED_RUN, null), false);
    const outcome = classifyRunOutcome(NEVER_STARTED_RUN, [], []);
    assert.strictEqual(outcome.klass, 'unknown');
  });

  test('a run still queued is not yet a failure of any kind', () => {
    const run: RunInfo = { id: 3, status: 'queued', conclusion: null };
    assert.strictEqual(runNeverExecuted(run, [{ ...NEVER_STARTED_JOB, status: 'queued', conclusion: null }]), false);
  });

  test('classification names the platform rather than the code', () => {
    const outcome = classifyRunOutcome(NEVER_STARTED_RUN, [NEVER_STARTED_JOB], []);
    assert.strictEqual(outcome.klass, 'infrastructure_not_started');
    assert.strictEqual(outcome.confidence, 1);
    assert.strictEqual(isPlatformFault(outcome.klass), true);
    assert.match(outcome.basis, /37368567311/);
    assert.match(outcome.basis, /cancelled/);
    assert.ok(outcome.matched.some((m) => /no step of any job ever executed/.test(m)));
  });

  test('the repair playbook tells an agent not to touch the code', () => {
    const playbook = REPAIR_PLAYBOOK.infrastructure_not_started.join(' ');
    assert.match(playbook, /No source change needed/);
    assert.match(playbook, /Do not start a repair pass/);
  });
});

describe('retrying a platform fault', () => {
  test('a build the platform never started is worth retrying', () => {
    const decision = decideRetry('infrastructure_not_started', 1, 3);
    assert.strictEqual(decision.retry, true);
    assert.strictEqual(isTransientFailure('infrastructure_not_started'), true);
  });

  test('the attempts are bounded and the reason says why', () => {
    const decision = decideRetry('infrastructure_not_started', 3, 3);
    assert.strictEqual(decision.retry, false);
    assert.match(decision.reason, /never started the workflow/);
  });

  test('retries back off so an outage is not hammered', () => {
    assert.strictEqual(retryBackoffMs(1, 1000), 0, 'the first attempt does not wait');
    assert.strictEqual(retryBackoffMs(2, 1000), 1000);
    assert.strictEqual(retryBackoffMs(3, 1000), 2000);
    assert.strictEqual(retryBackoffMs(4, 1000), 4000);
    assert.strictEqual(retryBackoffMs(9, 1000, 8000), 8000, 'the wait is capped');
    assert.strictEqual(retryBackoffMs(9, 60_000), 8 * 60_000, 'a long outage stops growing the wait');
  });

  test('a deterministic failure is still never retried', () => {
    for (const k of ['source_code', 'dependency', 'workflow_config', 'artifact', 'unknown'] as const) {
      assert.strictEqual(decideRetry(k, 1, 3).retry, false, k);
      assert.strictEqual(isPlatformFault(k), false, k);
    }
  });
});

describe('choosing which run to adopt for a commit', () => {
  const now = Date.parse('2026-10-05T21:00:00Z');
  const stale = 20 * 60 * 1000;

  test('a recent queued run is adopted rather than duplicated', () => {
    const runs = [{ databaseId: 1, status: 'queued', createdAt: '2026-10-05T20:55:00Z' }];
    const d = chooseRunToAdopt(runs, { now, staleQueuedMs: stale, hasStarted: () => false });
    assert.strictEqual(d.adopt?.databaseId, 1);
    assert.deepStrictEqual(d.abandon, []);
  });

  test('a run queued too long with nothing started is abandoned and replaced', () => {
    const runs = [{ databaseId: 37368408479, status: 'queued', createdAt: '2026-10-05T20:13:36Z' }];
    const d = chooseRunToAdopt(runs, { now, staleQueuedMs: stale, hasStarted: () => false });
    assert.strictEqual(d.adopt, null);
    assert.deepStrictEqual(d.abandon, [37368408479]);
  });

  test('an old run that already began building is adopted, never duplicated', () => {
    const runs = [{ databaseId: 5, status: 'in_progress', createdAt: '2026-10-05T20:00:00Z' }];
    const d = chooseRunToAdopt(runs, { now, staleQueuedMs: stale, hasStarted: () => true });
    assert.strictEqual(d.adopt?.databaseId, 5);
    assert.deepStrictEqual(d.abandon, []);
  });

  test('finished runs are never adopted', () => {
    const runs = [
      { databaseId: 6, status: 'completed', createdAt: '2026-10-05T19:00:00Z' },
      { databaseId: 7, status: 'completed', createdAt: '2026-10-05T20:00:00Z' }
    ];
    const d = chooseRunToAdopt(runs, { now, staleQueuedMs: stale, hasStarted: () => false });
    assert.strictEqual(d.adopt, null);
  });

  test('an abandoned old run is reported even when a later run is adopted', () => {
    const runs = [
      { databaseId: 8, status: 'queued', createdAt: '2026-10-05T20:00:00Z' },
      { databaseId: 9, status: 'queued', createdAt: '2026-10-05T20:59:00Z' }
    ];
    const d = chooseRunToAdopt(runs, { now, staleQueuedMs: stale, hasStarted: () => false });
    assert.strictEqual(d.adopt?.databaseId, 9);
    assert.deepStrictEqual(d.abandon, [8]);
  });

  test('a run with no creation time is adopted rather than abandoned', () => {
    const runs = [{ databaseId: 10, status: 'queued', createdAt: undefined }];
    const d = chooseRunToAdopt(runs, { now, staleQueuedMs: stale, hasStarted: () => false });
    assert.strictEqual(d.adopt?.databaseId, 10);
  });
});

describe('a successful run still needs every part of its evidence', () => {
  test('the reference build that really ran stays a success', () => {
    const run: RunInfo = { id: 37300693527, status: 'completed', conclusion: 'success' };
    assert.strictEqual(isSuccessfulRun(run), true);
    const outcome = classifyRunOutcome(run, [REAL_BUILD_JOB], ['BUILD SUCCESSFUL in 3s']);
    assert.notStrictEqual(outcome.klass, 'infrastructure_not_started');
  });
});
