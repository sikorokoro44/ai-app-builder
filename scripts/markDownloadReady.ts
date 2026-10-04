#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { ProjectStates, Events } from '../shared/types.ts';

initStateStore();
let s = readState();
if (!s.release.assetUrl || s.release.assetUrl.includes('example')) {
  console.error('Cannot mark DOWNLOAD_READY without real artifact URL');
  process.exit(1);
}
s.apkVerification = 'passed';
s.release.status = 'created';
s.projectState = ProjectStates.DOWNLOAD_READY;
s.currentStagePct = 100;
s.overallProgressPct = Math.max(s.overallProgressPct, 95);
s.finalDownloadUrl = s.release.assetUrl;
s.latestActivity = 'Download ready';
appendEvent({ type: Events.DOWNLOAD_READY, url: s.release.assetUrl });
writeState(s);
console.log('Download ready');
