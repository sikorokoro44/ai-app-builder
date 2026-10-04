import { test, describe, before } from 'node:test';
import assert from 'node:assert';

// This test exercises createAppFromIdea(), which reads and writes the live state
// store. It must run against its own throwaway directory: pointing it at the
// tracked `.builder/live` made the result depend on whatever state a previous
// run happened to leave behind (an ANALYZING write from TESTING is illegal, so
// the suite failed whenever the tracked state sat at a later stage).
await import('./isolate.mjs');

describe('idea intake', () => {
  let createAppFromIdea: (idea: string) => any;

  before(async () => {
    // Imported after the env vars are set so the modules pick up the temp dirs.
    ({ createAppFromIdea } = await import('../scripts/ideaToApp.ts'));
  });

  test('idea creates analyzing state', () => {
    const s = createAppFromIdea('Build a simple todo app');
    assert.strictEqual(s.projectState, 'ANALYZING');
  });

  test('the transition is actually persisted, not just returned in memory', async () => {
    const { readState } = await import('../scripts/live/stateStore.ts');
    const onDisk = readState();
    assert.strictEqual(onDisk.projectState, 'ANALYZING');
    assert.match(onDisk.latestActivity, /Analyzing idea/);
    assert.match(onDisk.latestActivity, /todo app/,
      'the recorded activity should name the idea being analyzed, for audit');
  });
});
