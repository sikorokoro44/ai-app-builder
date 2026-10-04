#!/usr/bin/env node
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';
import { mkdirSync, writeFileSync, existsSync } from 'fs';

initStateStore();
let s = readState();
s.projectState = ProjectStates.READY;
s.latestActivity = 'Scaffolding project';
const outDir = '.builder/out';
mkdirSync(outDir, { recursive: true });
if (!existsSync(`${outDir}/build.gradle.kts`)) {
  writeFileSync(`${outDir}/build.gradle.kts`, 'plugins {}\n');
}
if (!existsSync(`${outDir}/settings.gradle.kts`)) {
  writeFileSync(`${outDir}/settings.gradle.kts`, 'rootProject.name = "generated-app"\n');
}
writeState(s);
console.log('Scaffold complete');
