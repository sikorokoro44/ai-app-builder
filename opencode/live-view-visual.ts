#!/usr/bin/env node
import { enrichWithProgress } from '../shared/stateWithProgressImpl2.ts';
import { readState } from '../scripts/live/stateStore.ts';

function bar(pct: number) {
  const w = 10;
  const filled = Math.max(0, Math.min(100, pct));
  const f = Math.round((filled / 100) * w);
  return '[' + '█'.repeat(f) + '░'.repeat(w - f) + ']';
}

function main() {
  const s = enrichWithProgress(readState());
  const stagePct = s.currentStagePct === null ? 0 : s.currentStagePct;
  const overall = Math.max(0, Math.min(100, s.overallProgressPct));
  console.log(bar(overall) + ' ' + overall + '%');
  console.log(bar(stagePct) + ' ' + s.currentStageName + ': ' + stagePct + '%');
}

main();
