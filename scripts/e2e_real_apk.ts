#!/usr/bin/env node
import { execSync } from 'child_process';
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { createWriteStream, readFileSync } from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';
import https from 'https';

const run = (cmd: string) => execSync(cmd, { stdio: 'inherit' });

process.env.BUILDER_IDEA = 'Todo App';
run('node --experimental-strip-types scripts/resetState.ts');
run('node --experimental-strip-types scripts/ideaInput.ts');
run('node --experimental-strip-types scripts/analyze.ts');
run('node --experimental-strip-types scripts/design.ts');
run('node --experimental-strip-types scripts/plan.ts');
run('node --experimental-strip-types scripts/scaffold.ts');
run('node --experimental-strip-types scripts/generateAndroidApp.ts');
run('node --experimental-strip-types scripts/implement.ts');
run('node --experimental-strip-types scripts/testgen.ts');
run('node --experimental-strip-types scripts/validateTests.ts');
