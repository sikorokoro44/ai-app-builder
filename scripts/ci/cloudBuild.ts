#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from '../live/stateStore.ts';
import { ProjectStates, CloudBuildStages, Events } from '../../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.CLOUD_BUILDING;
s.cloudBuild.state = 'running';
s.cloudBuild.status = 'running';
s.cloudBuild.stage = CloudBuildStages.CHECKOUT;
appendEvent({ type: Events.BUILD_STARTED, stage: s.cloudBuild.stage });
writeState(s);
