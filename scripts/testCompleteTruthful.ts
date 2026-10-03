#!/usr/bin/env node
import { initStateStore, writeState, readState } from './live/stateStore.ts';
import { ProjectStates, CloudBuildStages } from '../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.COMPLETED;
s.overallProgressPct = 100;
s.completedFeatures = 3;
s.totalFeatures = 3;
s.completedTasks = 6;
s.totalTasks = 6;
s.cloudBuild.stage = CloudBuildStages.RELEASE;
s.cloudBuild.status = 'passed';
s.apkVerification = 'passed';
s.release.status = 'created';
s.release.assetUrl = 'https://github.com/owner/repo/releases/download/builder-feat-001-v1/app-debug.apk';
s.finalDownloadUrl = s.release.assetUrl;
writeState(s);
