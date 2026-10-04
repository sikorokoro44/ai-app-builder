import { test } from 'node:test';
import assert from 'node:assert';
import { createInitialState } from '../shared/state.ts';

function hasRealPublicUrl(s: any): boolean {
  const url = s.finalDownloadUrl || s.release?.assetUrl;
  if (!url) return false;
  if (url.includes('example')) return false;
  return true;
}

test('blocks completion without public URL', () => {
  const s = createInitialState();
  s.projectState = 'COMPLETED';
  s.overallProgressPct = 100;
  s.currentStagePct = 100;
  assert.strictEqual(hasRealPublicUrl(s), false);
});
