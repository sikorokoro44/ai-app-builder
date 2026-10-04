#!/usr/bin/env node
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.TESTING;
s.latestActivity = 'Generating and running tests';
s.testStats.discovered = (s.testStats.discovered || 0) + 2;
s.testStats.running = 2;
writeState(s);
console.log('Test generation started');
