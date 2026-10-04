#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { ProjectStates, Events } from '../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.RELEASING;
s.release.status = 'releasing';
s.latestActivity = 'Creating public release';
appendEvent({ type: Events.RELEASE_CREATED, public: true });
writeState(s);
console.log('Public release initiated');
