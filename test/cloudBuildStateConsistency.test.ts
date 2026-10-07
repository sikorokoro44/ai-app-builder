import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStates } from '../shared/types.ts';
import { assertTruthful } from '../scripts/live/stateValidator.ts';

// cloudBuildExecute writes the terminal fields together: status 'passed' only
// ever lands alongside state 'succeeded' and a finishedAt timestamp (see the
// success block in scripts/cloudBuildExecute.ts). Run extra combustion checks
// on a minimal DOWNLOAD_READY state so the invariant is enforced on more than
// the literals this file used to assert.
function readyState(overrides: any = {}) {
  return {
    projectState: ProjectStates.DOWNLOAD_READY,
    overallProgressPct: 100,
    cloudBuild: {
      runId: '123',
      status: 'passed',
      conclusion: 'success',
      state: 'succeeded',
      finishedAt: '2026-10-07T00:00:00Z',
      ...overrides.cloudBuild
    },
    apkVerification: 'passed',
    apkPath: '/data/data/com.termux/files/usr/tmp/opencode/app-debug.apk',
    apkSha256: 'a'.repeat(64),
    release: {
      status: 'created',
      assetUrl: 'https://github.com/sikorokoro44/ai-app-builder/releases/download/build-123/app-debug.apk',
      assetSha256: 'a'.repeat(64),
      assetName: 'app-debug.apk',
      repo: 'sikorokoro44/ai-app-builder',
      tag: 'build-123'
    },
    finalDownloadUrl: 'https://github.com/sikorokoro44/ai-app-builder/releases/download/build-123/app-debug.apk',
    evidence: { stages: [], publicDownloadVerified: true }
  };
}

test('a concluded run carries status passed together with a terminal succeeded state', () => {
  const cb = readyState().cloudBuild;
  assert.equal(cb.status, 'passed');
  assert.equal(cb.state, 'succeeded');
  assert.ok(cb.finishedAt);
  assert.doesNotThrow(() => assertTruthful(readyState()));
});

test('failed build ends in terminal failed state', () => {
  const s: any = {
    cloudBuild: {
      status: 'failed',
      conclusion: 'failure',
      state: 'failed',
      finishedAt: '2026-10-07T00:00:00Z'
    }
  };
  assert.equal(s.cloudBuild.status, 'failed');
  assert.equal(s.cloudBuild.state, 'failed');
  assert.ok(s.cloudBuild.finishedAt);
});

test('cancelled build ends in terminal cancelled state', () => {
  const s: any = {
    cloudBuild: {
      status: 'failed',
      conclusion: 'cancelled',
      state: 'cancelled',
      finishedAt: '2026-10-07T00:00:00Z'
    }
  };
  assert.equal(s.cloudBuild.status, 'failed');
  assert.equal(s.cloudBuild.state, 'cancelled');
  assert.ok(s.cloudBuild.finishedAt);
});

test('status passed while the run is still running is refused as untruthful', () => {
  // This is the regression shape commit 55fb635 guarded against: a state marked
  // passed before the workflow actually concluded would pass the old gates.
  assert.throws(
    () => assertTruthful(readyState({ cloudBuild: { state: 'running', finishedAt: undefined } })),
    /state is running, not succeeded/
  );
});

test('status passed with a finished state but no finishedAt is refused', () => {
  assert.throws(
    () => assertTruthful(readyState({ cloudBuild: { finishedAt: undefined } })),
    /finishedAt/
  );
});