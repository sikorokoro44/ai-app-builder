import { test } from 'node:test';
import assert from 'node:assert';
import { createInitialState } from '../shared/state.ts';
import { ProjectStates } from '../shared/types.ts';

function assertTruthful(s: any) {
  if (s.projectState === 'COMPLETED' && s.overallProgressPct !== 100) throw new Error();
  if (s.projectState === 'COMPLETED' && s.currentStagePct !== 100) throw new Error();
  if (s.projectState === 'DOWNLOAD_READY' && s.currentStagePct !== 100) throw new Error();
  if (s.release?.assetUrl?.includes('example/repo')) throw new Error();
  if (s.finalDownloadUrl?.includes('example/repo')) throw new Error();
}

test('rejects fake URLs', () => {
  const s = createInitialState();
  s.release.assetUrl = 'https://github.com/example/repo/file.apk';
  assert.throws(() => assertTruthful(s));
});

test('accepts real URLs', () => {
  const s = createInitialState();
  s.release.assetUrl = 'https://github.com/owner/repo/releases/download/tag/file.apk';
  assert.doesNotThrow(() => assertTruthful(s));
});
