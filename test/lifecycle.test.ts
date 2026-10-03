import { test } from 'node:test';
import assert from 'node:assert';
import { LIFECYCLE } from '../scripts/orchestrator/lifecycle.ts';
import { ProjectStates } from '../shared/types.ts';

test('lifecycle includes all required states', () => {
  assert.ok(LIFECYCLE.includes(ProjectStates.ANALYZING));
  assert.ok(LIFECYCLE.includes(ProjectStates.DESIGNING));
  assert.ok(LIFECYCLE.includes(ProjectStates.PLANNING));
  assert.ok(LIFECYCLE.includes(ProjectStates.TESTING));
  assert.ok(LIFECYCLE.includes(ProjectStates.CLOUD_BUILDING));
  assert.ok(LIFECYCLE.includes(ProjectStates.VERIFYING));
  assert.ok(LIFECYCLE.includes(ProjectStates.RELEASING));
  assert.ok(LIFECYCLE.includes(ProjectStates.DOWNLOAD_READY));
  assert.ok(LIFECYCLE.includes(ProjectStates.COMPLETED));
});
