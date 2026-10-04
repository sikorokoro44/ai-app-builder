#!/usr/bin/env node
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates, TaskStates } from '../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.BUILDING;
s.latestActivity = 'Implementing tasks';
Object.values(s.tasks).forEach((t: any) => {
  if (t.state !== TaskStates.COMPLETE && t.state !== TaskStates.VERIFIED) {
    t.state = TaskStates.WORKING;
    t.updatedAt = new Date().toISOString();
  }
});
writeState(s);
console.log('Implementation in progress');
