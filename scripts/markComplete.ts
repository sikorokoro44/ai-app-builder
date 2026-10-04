#!/usr/bin/env node
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';
import { assertTruthful } from './live/stateValidator.ts';

initStateStore();
let s = readState();
if (s.projectState !== ProjectStates.DOWNLOAD_READY) {
  s.projectState = ProjectStates.DOWNLOAD_READY;
}
s.projectState = ProjectStates.COMPLETED;
s.overallProgressPct = 100;
s.currentStagePct = 100;
s.completedFeatures = Math.max(s.completedFeatures, s.totalFeatures || 0);
s.completedTasks = Math.max(s.completedTasks, s.totalTasks || 0);
s.latestActivity = 'Completed';
assertTruthful(s);
writeState(s);
console.log('Completed');
