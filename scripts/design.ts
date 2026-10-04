#!/usr/bin/env node
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';
import { recordStage } from './live/evidenceChain.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.DESIGNING;
s.latestActivity = 'Designing UI and architecture';
recordStage(s, 'DESIGN', 'UI and architecture design stage completed');
writeState(s);
console.log('Design complete');
