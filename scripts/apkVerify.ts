#!/usr/bin/env node
import { existsSync, statSync, readFileSync } from 'fs';
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { ProjectStates, Events } from '../shared/types.ts';

function isValidApk(path: string): boolean {
  if (!existsSync(path)) return false;
  const s = statSync(path);
  if (s.size < 100) return false;
  const buf = readFileSync(path, { start: 0, end: 4 });
  if (buf[0] !== 0x50 || buf[1] !== 0x4B) return false;
  return true;
}

initStateStore();
let st = readState();
st.projectState = ProjectStates.VERIFYING;
st.apkVerification = 'verifying';
st.latestActivity = 'Verifying APK artifact';
writeState(st);

const apkPath = process.env.BUILDER_APK_PATH || '';
if (!apkPath) {
  console.error('BUILDER_APK_PATH required');
  st.apkVerification = 'failed';
  st.projectState = ProjectStates.FAILED;
  writeState(st);
  process.exit(1);
}
if (!isValidApk(apkPath)) {
  console.error('Invalid APK');
  st.apkVerification = 'failed';
  st.projectState = ProjectStates.FAILED;
  writeState(st);
  process.exit(1);
}
st.apkVerification = 'passed';
st.latestActivity = 'APK verified';
writeState(st);
console.log('APK verified');
