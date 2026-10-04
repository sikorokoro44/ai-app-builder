import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyFailure, isTransientFailure, FAILURE_CLASSES, REPAIR_PLAYBOOK } from '../scripts/live/failureClassifier.ts';
import {
  isTerminal, isStillRunning, isSuccessfulRun, isFailedRun, describeRunStatus,
  summarizeFailure, decideRetry, isActionableLine
} from '../scripts/live/workflowWatcher.ts';

describe('workflow completion detection', () => {
  test('queued is never success', () => {
    assert.strictEqual(isSuccessfulRun({ id: 1, status: 'queued', conclusion: null }), false);
  });
  test('in_progress is never success', () => {
    assert.strictEqual(isSuccessfulRun({ id: 1, status: 'in_progress', conclusion: null }), false);
  });
  test('running with a stale success conclusion is still not success', () => {
    assert.strictEqual(isSuccessfulRun({ id: 1, status: 'running', conclusion: 'success' }), false);
  });
  test('in_progress with conclusion success is not success', () => {
    assert.strictEqual(isSuccessfulRun({ id: 1, status: 'in_progress', conclusion: 'success' }), false);
  });
  test('requested is not terminal', () => {
    assert.strictEqual(isTerminal('requested'), false);
    assert.strictEqual(isStillRunning('requested'), true);
  });
  test('completed without a conclusion is not success', () => {
    assert.strictEqual(isSuccessfulRun({ id: 1, status: 'completed', conclusion: null }), false);
  });
  test('completed with success is success', () => {
    assert.strictEqual(isSuccessfulRun({ id: 1, status: 'completed', conclusion: 'success' }), true);
  });
  test('completed with failure is a failure, not success', () => {
    assert.strictEqual(isSuccessfulRun({ id: 1, status: 'completed', conclusion: 'failure' }), false);
    assert.strictEqual(isFailedRun({ id: 1, status: 'completed', conclusion: 'failure' }), true);
  });
  test('cancelled and timed_out count as failures', () => {
    for (const c of ['cancelled', 'timed_out', 'action_required', 'stale']) {
      assert.strictEqual(isFailedRun({ id: 1, status: 'completed', conclusion: c }), true, c);
    }
  });
  test('neutral and skipped count as success', () => {
    for (const c of ['neutral', 'skipped']) {
      assert.strictEqual(isSuccessfulRun({ id: 1, status: 'completed', conclusion: c }), true, c);
    }
  });
  test('a missing run is neither success nor failure', () => {
    assert.strictEqual(isSuccessfulRun(null), false);
    assert.strictEqual(isFailedRun(undefined), false);
    assert.strictEqual(describeRunStatus(null), 'no run');
  });
  test('status description is explicit about unfinished runs', () => {
    assert.match(describeRunStatus({ id: 1, status: 'in_progress', conclusion: null }), /not finished/);
    assert.match(describeRunStatus({ id: 1, status: 'completed', conclusion: 'failure' }), /conclusion=failure/);
  });
});

describe('failure classification', () => {
  test('every class is coverable and mapped to a playbook', () => {
    for (const k of FAILURE_CLASSES) {
      assert.ok(Array.isArray(REPAIR_PLAYBOOK[k]) && REPAIR_PLAYBOOK[k].length > 0, `no playbook for ${k}`);
    }
  });

  test('empty logs classify as unknown and are not retried', () => {
    const r = classifyFailure([]);
    assert.strictEqual(r.klass, 'unknown');
    assert.strictEqual(isTransientFailure(r.klass), false);
    assert.strictEqual(decideRetry(r.klass, 1).retry, false);
  });

  test('unrecognised logs classify as unknown', () => {
    const r = classifyFailure(['Build step one', 'Doing something', 'done']);
    assert.strictEqual(r.klass, 'unknown');
  });

  const cases: [string, string[], string][] = [
    ['source_code', [
      'e: file:///src/MainActivity.kt:12:5 Unresolved reference: foo',
      'error: cannot find symbol'
    ], 'source_code'],
    ['kotlin compile error', ['Task :app:compileDebugKotlin FAILED', 'Compilation error: see log above'], 'source_code'],
    ['manifest merger', ['AndroidManifest.xml:5: Error: uses-sdk:minSdkVersion 21 cannot be smaller than 24'], 'source_code'],
    ['type mismatch', ['error: type mismatch: inferred type is String but Int was expected'], 'source_code'],
    ['duplicate class', ['Duplicate class foo.Bar found in modules a.jar and b.jar'], 'source_code'],
    ['dependency', [
      'Could not resolve com.example:lib:1.0.0',
      'Could not find com.example:lib:1.0.0'
    ], 'dependency'],
    ['offline cache miss', ['No cached version of androidx.foo:bar available for offline mode'], 'dependency'],
    ['missing sdk', ['failed to find target with hash string android-34'], 'dependency'],
    ['plugin not found', ['Plugin [id: \'com.android.application\'] was not found'], 'dependency'],
    ['workflow config', ['Error: Invalid workflow file', '.github/workflows/build.yml line 12'], 'workflow_config'],
    ['action resolution', ['Unable to resolve action `actions/checkout@v4`, unable to find version'], 'workflow_config'],
    ['missing secret', ['Error: Input required and not supplied: token'], 'workflow_config'],
    ['permissions', ['Resource not accessible by integration'], 'workflow_config'],
    ['artifact', ['No files were found with the provided path: android-build/app/build/outputs/apk/debug'], 'artifact'],
    ['artifact upload', ['Failed to CreateArtifact: Received non-retryable error'], 'artifact'],
    ['missing apk', ['no apk found in build outputs'], 'artifact'],
    ['duplicate release', ['HTTP 422: Validation Failed (tag already exists)'], 'artifact'],
    ['infrastructure_transient', ['Received response code 503 from https://api.github.com'], 'infrastructure_transient'],
    ['dns blip', ['Temporary failure in name resolution'], 'infrastructure_transient'],
    ['rate limit', ['API rate limit exceeded for user'], 'infrastructure_transient'],
    ['runner lost', ['The job runner has received a shutdown signal'], 'infrastructure_transient']
  ];

  for (const [name, logs, expected] of cases) {
    test(`${name} -> ${expected}`, () => {
      const r = classifyFailure(logs);
      assert.strictEqual(r.klass, expected, `matched: ${JSON.stringify(r.matched)}`);
    });
  }

  test('transient signals outrank generic build noise', () => {
    const r = classifyFailure([
      'error: task failed',
      'Received response code 503 from https://api.github.com'
    ]);
    assert.strictEqual(r.klass, 'infrastructure_transient');
  });

  test('ansi colour codes do not hide diagnostics', () => {
    const r = classifyFailure(['\u001b[31merror: cannot find symbol\u001b[0m']);
    assert.strictEqual(r.klass, 'source_code');
  });

  test('matched lines are captured for actionable reporting', () => {
    const r = classifyFailure(['Could not resolve com.example:lib:1.0.0']);
    assert.ok(r.matched.length > 0);
    assert.ok(r.confidence > 0);
  });
});

describe('retry only for genuinely transient failures', () => {
  test('transient failures are retried up to the limit', () => {
    const d = decideRetry('infrastructure_transient', 1, 3);
    assert.strictEqual(d.retry, true);
    assert.match(d.reason, /attempt 2 of 3/);
  });

  test('transient failures stop retrying at the limit', () => {
    const d = decideRetry('infrastructure_transient', 3, 3);
    assert.strictEqual(d.retry, false);
    assert.match(d.reason, /exhausted/);
  });

  for (const k of ['source_code', 'dependency', 'workflow_config', 'artifact', 'unknown'] as const) {
    test(`${k} is never blindly retried`, () => {
      assert.strictEqual(decideRetry(k, 1, 5).retry, false);
      assert.strictEqual(isTransientFailure(k), false);
    });
  }

  test('transient is the only retryable class', () => {
    const retryable = FAILURE_CLASSES.filter(isTransientFailure);
    assert.deepStrictEqual(retryable, ['infrastructure_transient']);
  });
});

describe('actionable log capture', () => {
  test('error lines are captured and noise is dropped', () => {
    const s = summarizeFailure([], [
      'Downloading dependency',
      'ok line',
      'error: cannot find symbol',
      'Task :app:assembleDebug FAILED'
    ]);
    assert.strictEqual(s.logLines.length, 2);
  });

  test('the failed job and step are identified', () => {
    const s = summarizeFailure([
      { name: 'build', status: 'completed', conclusion: 'failure', steps: [
        { name: 'checkout', status: 'completed', conclusion: 'success' },
        { name: 'assemble', status: 'completed', conclusion: 'failure' }
      ] }
    ], ['error: boom']);
    assert.strictEqual(s.failedJob, 'build');
    assert.strictEqual(s.failedStep, 'assemble');
  });

  test('no failing job yields undefined, not a crash', () => {
    const s = summarizeFailure([{ name: 'build', status: 'completed', conclusion: 'success' }], []);
    assert.strictEqual(s.failedJob, undefined);
    assert.deepStrictEqual(s.logLines, []);
  });

  test('log lines are capped so state stays small', () => {
    const logs = Array.from({ length: 500 }, () => 'error: repeated failure');
    const s = summarizeFailure([], logs, 20);
    assert.strictEqual(s.logLines.length, 20);
  });

  test('actionable line detection', () => {
    assert.strictEqual(isActionableLine('error: x'), true);
    assert.strictEqual(isActionableLine('BUILD SUCCESSFUL in 3s'), false);
  });
});
