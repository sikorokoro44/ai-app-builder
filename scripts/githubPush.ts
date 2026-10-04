#!/usr/bin/env node
import { execSync } from 'child_process';
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.BUILDING;
s.latestActivity = 'Pushing to GitHub';
try {
  execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'ignore' });
} catch (e) {
  // ignore if not git repo
}
writeState(s);
console.log('GitHub push prepared');
