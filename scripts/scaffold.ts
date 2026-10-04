#!/usr/bin/env node
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';
import { recordStage } from './live/evidenceChain.ts';
import { mkdirSync, writeFileSync, existsSync } from 'fs';

initStateStore();
let s = readState();
s.projectState = ProjectStates.READY;
s.latestActivity = 'Scaffolding project';
const outDir = '.builder/out';
mkdirSync(outDir, { recursive: true });
const written: string[] = [];
if (!existsSync(`${outDir}/build.gradle.kts`)) {
  writeFileSync(`${outDir}/build.gradle.kts`, 'plugins {}\n');
  written.push('build.gradle.kts');
}
if (!existsSync(`${outDir}/settings.gradle.kts`)) {
  writeFileSync(`${outDir}/settings.gradle.kts`, 'rootProject.name = "generated-app"\n');
  written.push('settings.gradle.kts');
}
recordStage(s, 'SCAFFOLD', `scaffold ready in ${outDir} (wrote ${written.length ? written.join(', ') : 'nothing, already present'})`);
writeState(s);
console.log('Scaffold complete');
