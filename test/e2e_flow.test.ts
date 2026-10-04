import { test } from 'node:test';
import assert from 'node:assert';
import { createAppFromIdea } from '../scripts/ideaToApp.ts';

test('idea creates analyzing state', () => {
  const s = createAppFromIdea('Build a simple todo app');
  assert.strictEqual(s.projectState, 'ANALYZING');
});
