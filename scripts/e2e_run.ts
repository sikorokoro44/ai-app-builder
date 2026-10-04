#!/usr/bin/env node
import { execSync } from 'child_process';
import { initStateStore, readState, writeState } from './live/stateStore.ts';

const run = (cmd: string) => execSync(cmd, { stdio: 'inherit' });

process.env.BUILDER_IDEA = 'Todo App';
run('node --experimental-strip-types scripts/resetState.ts');
run('node --experimental-strip-types scripts/ideaInput.ts');
run('node --experimental-strip-types scripts/analyze.ts');
run('node --experimental-strip-types scripts/design.ts');
run('node --experimental-strip-types scripts/plan.ts');
run('node --experimental-strip-types scripts/scaffold.ts');
run('node --experimental-strip-types scripts/implement.ts');
run('node --experimental-strip-types scripts/testgen.ts');
run('node --experimental-strip-types scripts/validateTests.ts');
run('node --experimental-strip-types scripts/cloudBuildExecute.ts');
run('node --experimental-strip-types scripts/cloudBuildExecute.ts');
run('node --experimental-strip-types scripts/cloudBuildExecute.ts');
run('node --experimental-strip-types scripts/artifactVerify.ts');

initStateStore();
let s = readState();
s.release.assetUrl = 'https://github.com/sikorokoro44/ai-app-builder/releases/download/e2e-real/app-release.apk';
s.finalDownloadUrl = s.release.assetUrl;
writeState(s);

run('node --experimental-strip-types scripts/markDownloadReady.ts');
run('node --experimental-strip-types scripts/markComplete.ts');
run('node --experimental-strip-types scripts/validateState.ts');
