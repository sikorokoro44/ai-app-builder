#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from '../live/stateStore.ts';
import { ProjectStates, Events } from '../../shared/types.ts';

export const LIFECYCLE = [
  ProjectStates.NOT_STARTED,
  ProjectStates.QUEUED,
  ProjectStates.ANALYZING,
  ProjectStates.DESIGNING,
  ProjectStates.PLANNING,
  ProjectStates.READY,
  ProjectStates.BUILDING,
  ProjectStates.TESTING,
  ProjectStates.CLOUD_BUILDING,
  ProjectStates.VERIFYING,
  ProjectStates.RELEASING,
  ProjectStates.DOWNLOAD_READY,
  ProjectStates.COMPLETED
];

export function advance(s: any, reason: string) {
  const i = LIFECYCLE.indexOf(s.projectState);
  if (i >= 0 && i < LIFECYCLE.length - 1) {
    s.projectState = LIFECYCLE[i + 1];
    s.latestActivity = reason;
    appendEvent({ type: Events.PROJECT_STATUS_CHANGED, projectState: s.projectState, activity: reason });
  }
}
