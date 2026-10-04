#!/usr/bin/env node
import { existsSync, statSync } from 'fs';
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { persistCheckpoint } from './live/checkpointStore.ts';
import { verifyApkFile, verifyBuildProvenance, rejectFakeApkUrl } from './live/apkValidator.ts';
import { recordStage } from './live/evidenceChain.ts';
import { assertValidTransition } from './live/stateValidator.ts';
import { ProjectStates, Events } from '../shared/types.ts';

initStateStore();
const s = readState();

const apkPath = process.env.BUILDER_APK_PATH || s.apkPath || '';
const runId = process.env.BUILDER_RUN_ID || s.cloudBuild.runId || '';
const artifactName = process.env.BUILDER_ARTIFACT_NAME || '';

if (!apkPath) {
  console.error('BUILDER_APK_PATH (or a recorded apkPath) is required; refusing to verify nothing');
  s.apkVerification = 'failed';
  s.apkVerificationErrors = ['no APK path provided'];
  s.projectState = ProjectStates.VERIFYING;
  writeState(s);
  process.exit(1);
}

if (s.projectState !== ProjectStates.VERIFYING) {
  try {
    assertValidTransition(s.projectState, ProjectStates.VERIFYING);
  } catch (e: any) {
    console.error(`Refusing out-of-order verification: ${e.message}`);
    process.exit(2);
  }
}
s.projectState = ProjectStates.VERIFYING;
s.apkVerification = 'verifying';
s.latestActivity = `Verifying APK ${apkPath}`;
persistCheckpoint('pre-apk-verify', s);
writeState(s);
appendEvent({ type: Events.BUILD_STAGE_CHANGED, stage: 'APK_VERIFY' });

const expectedPackageId = process.env.BUILDER_EXPECTED_PACKAGE_ID || s.apkPackageId || '';
const result = verifyApkFile(apkPath, expectedPackageId || undefined, {
  expectedSha256: process.env.BUILDER_EXPECTED_SHA256 || undefined,
  requireBuildId: true
});

const provenance = verifyBuildProvenance(
  s,
  apkPath,
  { runId: runId || undefined, headSha: process.env.BUILDER_HEAD_SHA || undefined, artifactName },
  result.sha256
);

const errors = [...result.errors, ...provenance.errors];
const warnings = provenance.warnings || [];

if (result.valid && provenance.valid) {
  s.apkVerification = 'passed';
  s.apkPath = apkPath;
  s.apkSha256 = result.sha256;
  s.apkPackageId = result.packageId || expectedPackageId;
  s.apkVerificationErrors = undefined;
  recordStage(s, 'REAL_APK', `apk=${apkPath} bytes=${result.sizeBytes}`, runId || undefined);
  recordStage(s, 'APK_VERIFY', `sha256=${result.sha256} package=${result.packageId || expectedPackageId}`, runId || undefined);
  s.latestActivity = `APK verified: ${apkPath} (${result.sizeBytes} bytes)`;
  appendEvent({ type: Events.ARTIFACT_VERIFIED, path: apkPath, sha256: result.sha256, packageId: result.packageId });
  writeState(s);
  console.log(JSON.stringify({
    ok: true,
    apk: apkPath,
    sha256: result.sha256,
    packageId: result.packageId || expectedPackageId,
    sizeBytes: result.sizeBytes,
    warnings
  }, null, 2));
  process.exit(0);
}

s.apkVerification = 'failed';
s.apkVerificationErrors = errors;
s.latestActivity = `APK verification failed: ${errors[0]}`;
recordStage(s, 'REAL_APK', `failed: ${errors.join('; ')}`, runId || undefined);
appendEvent({ type: Events.BUILD_FAILED, stage: 'APK_VERIFY', errors });
writeState(s);
console.error(JSON.stringify({ ok: false, errors, warnings }, null, 2));
process.exit(1);
