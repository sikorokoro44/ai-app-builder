#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { ProjectStates, Events } from '../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.ANALYZING;
s.latestActivity = 'Analyzing requirements';
s.testStats.discovered = 0;
appendEvent({ type: Events.PROJECT_STATUS_CHANGED, projectState: s.projectState, activity: s.latestActivity });
writeState(s);
console.log('Analysis complete');
