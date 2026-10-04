#!/usr/bin/env node
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.DESIGNING;
s.latestActivity = 'Designing UI and architecture';
writeState(s);
console.log('Design complete');
