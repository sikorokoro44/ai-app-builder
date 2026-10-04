#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { persistCheckpoint } from './live/checkpointStore.ts';
import { assertDownloadReadyGate } from './live/lifecycleGate.ts';
import { recordStage, hasStage } from './live/evidenceChain.ts';
import { assertValidTransition } from './live/stateValidator.ts';
import { isValidHttpsUrl, rejectFakeReleaseUrl } from './live/releaseVerifier.ts';
import { ProjectStates, Events } from '../shared/types.ts';
import { enrichWithProgress } from '../shared/stateWithProgressImpl2.ts';

initStateStore();
const s = readState();
// currentStagePct is derived per-read, so the gate must be given the enriched
// view rather than the raw persisted state, where the field does not exist.
const view = enrichWithProgress(s as any);

/**
 * DOWNLOAD_READY is gated on the whole chain, in order:
 * cloud build passed -> real APK -> APK verified -> release exists ->
 * release APK asset -> genuine HTTPS URL -> public download verified.
 */
try {
  assertDownloadReadyGate({
    projectState: s.projectState,
    overallProgressPct: s.overallProgressPct,
    currentStagePct: Number(view.currentStagePct ?? 0),
    apkVerification: s.apkVerification,
    releaseStatus: s.release.status,
    releaseAssetUrl: s.release.assetUrl,
    finalDownloadUrl: s.finalDownloadUrl,
    cloudBuildStatus: s.cloudBuild.status
  });
} catch (e: any) {
  console.error(`DOWNLOAD_READY gate rejected:\n${e.message}`);
  process.exit(1);
}

const problems: string[] = [];
if (!s.apkPath || !s.apkSha256) problems.push('no verified APK path/checksum');
if (s.release.assetSha256 !== s.apkSha256) problems.push('release asset checksum != verified APK checksum');
if (!s.release.assetName) problems.push('no release asset name');
if (!s.evidence?.publicDownloadVerified) problems.push('public download not verified');
// Every stage the run must have earned, in order, including the two that
// validatePublicUrl records. FINAL_VERIFY is deliberately absent: it is recorded
// by this script as the last step.
const REQUIRED_STAGES = [
  'IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'IMPLEMENT', 'TESTGEN', 'VALIDATE',
  'CLOUD_BUILD', 'BUILD_SUCCESS', 'REAL_APK', 'APK_VERIFY', 'RELEASE', 'RELEASE_ASSET',
  'PUBLIC_HTTPS_URL', 'PUBLIC_DOWNLOAD'
] as const;
for (const stage of REQUIRED_STAGES) {
  if (!hasStage(s, stage)) problems.push(`missing evidence stage: ${stage}`);
}
const url = s.finalDownloadUrl || s.release.assetUrl || '';
if (!isValidHttpsUrl(url) || rejectFakeReleaseUrl(url)) problems.push(`public URL not genuine HTTPS: ${url || '(none)'}`);

if (problems.length > 0) {
  console.error(`DOWNLOAD_READY blocked:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}

assertValidTransition(s.projectState, ProjectStates.DOWNLOAD_READY);
persistCheckpoint('pre-download-ready', s);
s.projectState = ProjectStates.DOWNLOAD_READY;
s.overallProgressPct = 100;
s.latestActivity = 'Verified public APK download ready';
recordStage(s, 'FINAL_VERIFY', `download_ready url=${url}`, s.cloudBuild.runId);
appendEvent({ type: Events.DOWNLOAD_READY, url });
writeState(s);
console.log(JSON.stringify({ ok: true, state: s.projectState, url }, null, 2));
