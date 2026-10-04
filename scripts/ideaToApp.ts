#!/usr/bin/env node
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';

export function createAppFromIdea(idea: string) {
  initStateStore();
  const s = readState();
  s.projectState = ProjectStates.ANALYZING;
  s.latestActivity = 'Analyzing idea';
  s.totalFeatures = s.totalFeatures || 0;
  s.totalTasks = s.totalTasks || 0;
  s.latestActivity = `Analyzing idea: ${idea.substring(0, 80)}`;
  writeState(s);
  return s;
}
