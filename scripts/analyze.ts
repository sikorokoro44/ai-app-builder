#!/usr/bin/env node
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';
import { recordStage } from './live/evidenceChain.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.ANALYZING;
s.latestActivity = 'Analyzing requirements';
s.testStats.discovered = 0;
recordStage(s, 'ANALYZE', `requirements analyzed; test discovery reset to ${s.testStats.discovered}`);
// writeState emits the PROJECT_STATUS_CHANGED event after the durable write, so
// a refused transition cannot leave a fabricated state change in the log.
writeState(s);
console.log('Analysis complete');
