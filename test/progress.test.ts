import { test, describe } from 'node:test';
import assert from 'node:assert';
import { calcStagePct } from '../shared/progress.ts';
import { ProjectStates, CloudBuildStages } from '../shared/types.ts';
import { enrichWithProgress } from '../shared/stateWithProgressImpl2.ts';
import { createInitialState } from '../shared/state.ts';

describe('Progress truthfulness', () => {
  test('COMPLETED gives 100/100', () => {
    const s = createInitialState();
    s.projectState = ProjectStates.COMPLETED;
    s.overallProgressPct = 100;
    const e = enrichWithProgress(s as any);
    assert.strictEqual(e.overallProgressPct, 100);
    assert.strictEqual(e.currentStagePct, 100);
    assert.strictEqual(e.currentStageName, 'COMPLETE');
  });

  test('DOWNLOAD_READY gives 100/100', () => {
    const s = createInitialState();
    s.projectState = ProjectStates.DOWNLOAD_READY;
    s.overallProgressPct = 100;
    s.apkVerification = 'passed';
    s.icon = { status: 'passed', category: 'notes', purpose: 'notes', fingerprint: 'f'.repeat(64) };
    s.release.status = 'created';
    s.release.assetUrl = 'https://github.com/owner/repo/releases/download/v1/app.apk';
    const e = enrichWithProgress(s as any);
    assert.strictEqual(e.currentStagePct, 100);
    assert.strictEqual(e.currentStageName, 'DOWNLOAD_READY');
  });

  test('BUILDING calculates from tasks', () => {
    const pct = calcStagePct(ProjectStates.BUILDING, CloudBuildStages.COMPILING, 2, 4, {discovered:0,running:0,passed:0,failed:0}, [], 'idle', 'idle');
    assert.strictEqual(pct.pct, 50);
  });
});
