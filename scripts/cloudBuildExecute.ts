#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { ProjectStates, CloudBuildStages, Events } from '../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.CLOUD_BUILDING;
s.cloudBuild.state = 'running';
s.cloudBuild.status = 'running';
const stages = Object.values(CloudBuildStages);
let idx = stages.indexOf(s.cloudBuild.stage as any);
if (idx < 0) idx = 0;
if (idx < stages.length - 1) {
  s.cloudBuild.stage = stages[idx + 1] as any;
} else {
  s.cloudBuild.stage = CloudBuildStages.RELEASE;
}
s.latestActivity = `Cloud build: ${s.cloudBuild.stage}`;
appendEvent({ type: Events.BUILD_STAGE_CHANGED, stage: s.cloudBuild.stage });
writeState(s);
console.log('Cloud build stage advanced');
