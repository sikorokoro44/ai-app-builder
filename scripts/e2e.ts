#!/usr/bin/env node
import { execSync } from 'child_process';
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';

const run = (cmd: string) => execSync(`node --experimental-strip-types ${cmd}`, { stdio: 'inherit' });

run('builder-new/scripts/resetState.ts');
run('builder-new/scripts/ideaInput.ts');
run('builder-new/scripts/analyze.ts');
run('builder-new/scripts/design.ts');
run('builder-new/scripts/plan.ts');
run('builder-new/scripts/scaffold.ts');
run('builder-new/scripts/implement.ts');
run('builder-new/scripts/testgen.ts');
run('builder-new/scripts/validateTests.ts');
run('builder-new/scripts/githubPush.ts');
run('builder-new/scripts/cloudBuildExecute.ts');
run('builder-new/scripts/cloudBuildExecute.ts');
run('builder-new/scripts/artifactVerify.ts');

// Set real artifact URL for final stages
initStateStore();
let s = readState();
s.release.assetUrl = 'https://github.com/sikorokoro44/ai-app-builder/releases/download/test-e2e/app-debug.apk';
s.finalDownloadUrl = s.release.assetUrl;
writeState(s);

run('builder-new/scripts/markDownloadReady.ts');
run('builder-new/scripts/markComplete.ts');
run('builder-new/scripts/validateState.ts');
