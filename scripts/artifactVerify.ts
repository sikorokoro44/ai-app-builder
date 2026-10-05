#!/usr/bin/env node
/**
 * Report what verification actually proved.
 *
 * This script used to be a placeholder that flipped the project to VERIFYING and
 * printed a reassuring line, which is exactly the kind of success the pipeline
 * exists to prevent. It now only ever reports facts that some other step really
 * recorded and really proved: the cloud run, the APK bytes on disk, their
 * checksum, and the launcher icon that was matched against the compiled artifact.
 *
 * If any of that is missing it says so and exits non-zero. It never repairs the
 * state, never re-runs verification, and never invents a value.
 */
import { existsSync, statSync } from 'fs';
import { initStateStore, readState } from './live/stateStore.ts';
import { hasStage } from './live/evidenceChain.ts';

initStateStore();
const s = readState();

const missing: string[] = [];

const runId = s.cloudBuild.runId || '';
const conclusion = s.cloudBuild.conclusion || '';
const headSha = s.cloudBuild.headSha || '';
const apkPath = s.apkPath || '';
const sha256 = s.apkSha256 || '';
const packageId = s.apkPackageId || '';

if (!runId) missing.push('no cloud build run id was recorded');
if (conclusion !== 'success') missing.push(`the recorded build conclusion is "${conclusion || 'missing'}", not success`);
if (!/^[0-9a-f]{40}$/.test(headSha)) missing.push(`no real head sha was recorded (${headSha || 'missing'})`);
if (!apkPath || !existsSync(apkPath)) missing.push(`the verified APK is not on disk (${apkPath || 'missing'})`);
if (!/^[0-9a-f]{64}$/.test(sha256)) missing.push(`no real APK checksum was recorded (${sha256 || 'missing'})`);
if (!packageId) missing.push('no package id was recorded for the APK');
if (s.apkVerification !== 'passed') missing.push(`apkVerification is "${s.apkVerification}", not passed`);
if (s.icon?.status !== 'passed') missing.push(`launcher icon verification is "${s.icon?.status || 'missing'}", not passed`);
if (!s.icon?.matchedPath) missing.push('no compiled launcher icon was matched against the APK');
for (const stage of ['REAL_APK', 'APK_VERIFY', 'REAL_ICON_VERIFY'] as const) {
  if (!hasStage(s, stage)) missing.push(`the evidence chain has no ${stage} stage`);
}

if (missing.length) {
  console.error(JSON.stringify({
    ok: false,
    verified: false,
    missing,
    projectState: s.projectState
  }, null, 2));
  process.exit(1);
}

const onDisk = statSync(apkPath);
const report = {
  ok: true,
  verified: true,
  runId,
  conclusion,
  headSha,
  workflowFile: s.cloudBuild.workflowFile,
  apkPath,
  sha256,
  packageId,
  sizeBytes: onDisk.size,
  recordedSizeBytes: s.cloudBuild.artifactSize,
  buildArtifactSha256: s.cloudBuild.artifactSha256,
  icon: {
    status: s.icon?.status,
    category: s.icon?.category,
    purpose: s.icon?.purpose,
    fingerprint: s.icon?.fingerprint,
    manifestIcon: s.icon?.manifestIcon,
    compiledPath: s.icon?.matchedPath,
    compiledResourceId: s.icon?.manifestIconResourceId,
    densities: s.icon?.matchedDensities,
    similarity: s.icon?.similarity,
    byteIdentical: s.icon?.byteIdentical,
    verifiedAt: s.icon?.verifiedAt
  },
  evidence: (s.evidence?.stages || []).map((stage) => stage.stage),
  projectState: s.projectState
};

console.log(JSON.stringify(report, null, 2));
