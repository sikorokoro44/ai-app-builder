#!/usr/bin/env node
import { enrichWithProgress } from '../../shared/stateWithProgressImpl.ts';
import { readState } from './stateStore.ts';

function bar(pct: number) {
  const w = 10;
  const filled = Math.max(0, Math.min(100, pct));
  const f = Math.round((filled / 100) * w);
  return '[' + '█'.repeat(f) + '░'.repeat(w - f) + ']';
}

const s = enrichWithProgress(readState());
// Derived value; treat a missing/undefined stage pct as 0 rather than
// rendering a NaN bar.
const stagePct = Number(s.currentStagePct ?? 0);
console.log(bar(s.overallProgressPct) + ' ' + s.overallProgressPct + '%');
console.log(bar(stagePct) + ' ' + s.currentStageName + ': ' + stagePct + '%');
