#!/usr/bin/env node
import { execSync } from 'child_process';
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';

const run = (cmd: string) => execSync(cmd, { stdio: 'inherit' });

process.env.BUILDER_IDEA = 'Test Android todo app';
run('node --experimental-strip-types builder-new/scripts/resetState.ts');
run('node --experimental-strip-types builder-new/scripts/ideaInput.ts');
run('node --experimental-strip-types builder-new/scripts/analyze.ts');
run('node --experimental-strip-types builder-new/scripts/design.ts');
run('node --experimental-strip-types builder-new/scripts/plan.ts');
run('node --experimental-strip-types builder-new/scripts/scaffold.ts');
run('node --experimental-strip-types builder-new/scripts/implement.ts');
run('node --experimental-strip-types builder-new/scripts/testgen.ts');
run('node --experimental-strip-types builder-new/scripts/validateTests.ts');
run('node --experimental-strip-types builder-new/scripts/githubPush.ts');
run('node --experimental-strip-types builder-new/scripts/cloudBuildExecute.ts');
run('node --experimental-strip-types builder-new/scripts/cloudBuildExecute.ts');
run('node --experimental-strip-types builder-new/scripts/artifactVerify.ts');

initStateStore();
let s = readState();
s.release.assetUrl = 'https://github.com/sikorokoro44/ai-app-builder/releases/download/test-e2e/app-debug.apk';
s.finalDownloadUrl = s.release.assetUrl;
writeState(s);

run('node --experimental-strip-types builder-new/scripts/markDownloadReady.ts');
run('node --experimental-strip-types builder-new/scripts/markComplete.ts');
run('node --experimental-strip-types builder-new/scripts/validateState.ts');
