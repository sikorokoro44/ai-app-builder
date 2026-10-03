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
const stagePct = s.currentStagePct === null ? 0 : s.currentStagePct;
console.log(bar(s.overallProgressPct) + ' ' + s.overallProgressPct + '%');
console.log(bar(stagePct) + ' ' + s.currentStageName + ': ' + stagePct + '%');
