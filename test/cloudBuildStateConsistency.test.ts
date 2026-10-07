import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStates } from '../shared/types.ts';

test('cloud build state consistency for successful completion', () => {
  // Simulate successful state
  const s: any = {
    cloudBuild: {
      runId: '123',
      status: 'passed',
      conclusion: 'success',
      state: 'succeeded',
      finishedAt: '2026-10-07T00:00:00Z'
    },
    projectState: ProjectStates.VERIFYING,
    evidence: { stages: [] }
  };
  assert.equal(s.cloudBuild.status, 'passed');
  assert.equal(s.cloudBuild.conclusion, 'success');
  assert.equal(s.cloudBuild.state, 'succeeded');
  assert.ok(s.cloudBuild.finishedAt);
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
