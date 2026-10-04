#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { ProjectStates, Events } from '../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.VERIFYING;
s.apkVerification = 'verifying';
s.latestActivity = 'Verifying APK artifact';
appendEvent({ type: Events.BUILD_STAGE_CHANGED });
writeState(s);
// Simulate verification passing only if we had real artifact - but we mark after ensuring
console.log('Artifact verification ready');
