import type { LiveState, EvidenceChain, StageEvidence } from '../../shared/state.ts';
import { Events } from '../../shared/types.ts';
import { appendEvent } from './stateStore.ts';

export const LifecycleStages = [
  'IDEA',
  'ANALYZE',
  'DESIGN',
  'PLAN',
  'SCAFFOLD',
  'IMPLEMENT',
  'TESTGEN',
  'VALIDATE',
  'CLOUD_BUILD',
  'BUILD_SUCCESS',
  'REAL_APK',
  'APK_VERIFY',
  'RELEASE',
  'RELEASE_ASSET',
  'PUBLIC_HTTPS_URL',
  'PUBLIC_DOWNLOAD',
  'FINAL_VERIFY'
] as const;

export type LifecycleStage = typeof LifecycleStages[number];

export function recordStage(state: LiveState, stage: LifecycleStage, evidence: string, runId?: string): void {
  const chain: EvidenceChain = state.evidence || { stages: [] };
  const at = new Date().toISOString();
  const stages = chain.stages.filter((s) => s.stage !== stage);
  stages.push({ stage, evidence, at, runId });
  const ordered: StageEvidence[] = LifecycleStages
    .map((name) => stages.find((s) => s.stage === name))
    .filter((s): s is StageEvidence => !!s);
  state.evidence = { ...chain, stages: ordered };
  appendEvidenceEvent(stage, evidence, runId, at);
}

/**
 * Mirrors every evidence link into the append-only event log.
 *
 * state.json is a single file that a kill can corrupt; the event log is the
 * recovery path. Without this mirror a rebuilt state would carry the right
 * download URL but an empty evidence chain, and the completion gate would
 * correctly refuse it with no way to tell real work from a fabrication.
 */
function appendEvidenceEvent(stage: LifecycleStage, evidence: string, runId: string | undefined, at: string): void {
  try {
    appendEvent({ type: Events.EVIDENCE_RECORDED, stage, evidence, runId, at });
  } catch { /* evidence still lands in state.json; the log mirror is best effort */ }
}

export function hasStage(state: LiveState, stage: LifecycleStage): boolean {
  return !!(state.evidence?.stages || []).some((s) => s.stage === stage);
}

export function missingStages(state: LiveState): LifecycleStage[] {
  return LifecycleStages.filter((s) => !hasStage(state, s));
}

export interface ChainGateInput {
  projectState: string;
  overallProgressPct: number;
  currentStagePct: number | null | undefined;
  cloudBuild: { status: string; runId?: string; artifactSha256?: string };
  apkVerification: string;
  apkPath?: string;
  apkSha256?: string;
  apkPackageId?: string;
  release: { status: string; assetUrl?: string; assetName?: string; assetSha256?: string; repo?: string; tag?: string };
  finalDownloadUrl?: string;
  evidence?: EvidenceChain;
  publicDownloadVerified?: boolean;
}

export function assertLifecycleEvidence(g: ChainGateInput): void {
  const problems: string[] = [];

  if (g.projectState !== 'COMPLETED') problems.push(`projectState=${g.projectState} (want COMPLETED)`);
  if (g.overallProgressPct !== 100) problems.push(`overallProgressPct=${g.overallProgressPct} (want 100)`);
  if (g.currentStagePct !== 100) problems.push(`currentStagePct=${g.currentStagePct} (want 100)`);

  if (g.cloudBuild.status !== 'passed') problems.push(`cloudBuild.status=${g.cloudBuild.status} (want passed)`);
  if (!g.cloudBuild.runId) problems.push('cloud build has no run id (build success not proven)');

  if (g.apkVerification !== 'passed') problems.push(`apkVerification=${g.apkVerification} (want passed)`);
  if (!g.apkPath) problems.push('no APK path recorded');
  if (!g.apkSha256) problems.push('no APK checksum recorded');
  if (!g.apkPackageId) problems.push('no APK package/application id recorded');

  if (g.release.status !== 'created') problems.push(`release.status=${g.release.status} (want created)`);
  if (!g.release.assetName) problems.push('release asset name missing');
  if (!g.release.assetUrl) problems.push('release asset URL missing');
  if (!g.release.assetSha256) problems.push('release asset checksum missing');
  if (g.release.assetSha256 && g.apkSha256 && g.release.assetSha256 !== g.apkSha256) {
    problems.push('release asset checksum does not match the verified APK');
  }
  if (!g.release.repo) problems.push('release repo not recorded');
  if (!g.release.tag) problems.push('release tag not recorded');

  const url = g.finalDownloadUrl || g.release.assetUrl;
  if (!url) problems.push('no public download URL');
  else {
    if (!url.startsWith('https://')) problems.push('public URL is not HTTPS');
    if (/example|placeholder|fake|localhost/i.test(url)) problems.push(`public URL looks fabricated: ${url}`);
  }
  if (!g.publicDownloadVerified) problems.push('public download was never verified as reachable');

  for (const stage of LifecycleStages) {
    if (!hasStage(g as any, stage)) problems.push(`missing evidence stage: ${stage}`);
  }

  if (problems.length > 0) {
    throw new Error(`Lifecycle evidence incomplete:\n - ${problems.join('\n - ')}`);
  }
}

export function lifecycleSummary(state: LiveState) {
  const present = new Set((state.evidence?.stages || []).map((s) => s.stage));
  return LifecycleStages.map((s) => ({ stage: s, done: present.has(s) }));
}
