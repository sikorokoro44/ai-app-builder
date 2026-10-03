#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { ProjectStates, Events } from '../shared/types.ts';

export function createAppFromIdea(idea: string) {
  initStateStore();
  const s = readState();
  s.projectState = ProjectStates.ANALYZING;
  s.latestActivity = 'Analyzing idea';
  s.totalFeatures = s.totalFeatures || 0;
  s.totalTasks = s.totalTasks || 0;
  appendEvent({ type: Events.PROJECT_STATUS_CHANGED, projectState: s.projectState, activity: idea.substring(0, 80) });
  writeState(s);
  return s;
}
