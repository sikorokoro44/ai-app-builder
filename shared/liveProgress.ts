import type { LiveState, StageEvidence } from './state.ts';
import { LifecycleStages, hasStage } from '../scripts/live/evidenceChain.ts';
import { enrichWithProgress } from './stateWithProgressImpl2.ts';
import { FailureRepairStates, ProjectStates } from './types.ts';

/**
 * The user-facing build progress view.
 *
 * This module is a *projection*, not a state system. It reads the authoritative
 * state (`.builder/live/state.json`) plus its evidence chain and answers two
 * questions: which lifecycle link is proven, and which one is being worked on
 * right now. Nothing here writes anything, and nothing here can mark a stage
 * complete: a stage turns complete only when the evidence chain already proves
 * it, which is the same proof `lifecycleGate` accepts before a download URL or
 * the completion screen is allowed to appear.
 */

/**
 * Stage order shown to the user.
 *
 * This is deliberately *not* `LifecycleStages`: the chain records three
 * download links the user never thinks about individually, and it has no
 * `GITHUB_PUSH` link even though pushing the implementation is a step a human
 * cares about. Both differences are resolved in `stageProof` below, by mapping
 * each displayed stage onto the real evidence that proves it.
 */
export const ProgressStages = [
  'IDEA',
  'ANALYZE',
  'DESIGN',
  'PLAN',
  'SCAFFOLD',
  'IMPLEMENT',
  'TESTGEN',
  'VALIDATE',
  'GITHUB_PUSH',
  'CLOUD_BUILD',
  'BUILD_SUCCESS',
  'REAL_APK',
  'APK_VERIFY',
  'REAL_ICON_VERIFY',
  'RELEASE',
  'RELEASE_ASSET',
  'DOWNLOAD_READY',
  'COMPLETED'
] as const;

export type ProgressStage = typeof ProgressStages[number];

export type ProgressStageStatus = 'completed' | 'running' | 'pending' | 'failed';

export interface ProgressStageView {
  stage: ProgressStage;
  status: ProgressStageStatus;
  /** The recorded evidence text, so a ✓ can be traced to a real proof. */
  evidence?: string;
  at?: string;
  runId?: string;
}

export interface ProgressFailure {
  stage: ProgressStage;
  reason: string;
  recoveryAction: string;
}

export interface ProgressVerification {
  packageId?: string;
  apkSha256?: string;
  apkPath?: string;
  cloudRunId?: string;
  headSha?: string;
  artifactSha256?: string;
  artifactSize?: number;
  iconStatus: string;
  iconManifestIcon?: string;
  iconManifestRoundIcon?: string;
  iconMatchedDensities?: string[];
  iconSimilarity?: number;
  iconByteIdentical?: boolean;
  iconVerifiedAt?: string;
  releaseUrl?: string;
  releaseVerifiedAt?: string;
}

export interface LiveProgressView {
  /** Human-facing status word, e.g. BUILDING while a run is underway. */
  status: string;
  projectState: string;
  /** Overall progress derived from proven evidence, 0-100. */
  overallPct: number;
  /** `overallProgressPct` exactly as the authoritative state stores it. */
  storedOverallPct: number;
  currentStage: ProgressStage | null;
  /** Sub-stage progress for `currentStage` from the existing progress helper. */
  currentStagePct: number | null;
  latestActivity: string;
  elapsedMs: number;
  stages: ProgressStageView[];
  /** True only once every stage, including COMPLETED, is proven. */
  completed: boolean;
  /** True once the download gate passes; `downloadUrl` only exists when true. */
  downloadReady: boolean;
  downloadUrl?: string;
  verification?: ProgressVerification;
  failure?: ProgressFailure;
  /** The fleet's real per-agent state, straight from the authoritative store. */
  agents: ProgressAgentView[];
  /** How many agents are working right now. */
  activeAgents: number;
  lastUpdated: string;
}

/**
 * One agent, as the authoritative state records it.
 *
 * The coordinator writes these while an agent runs, so a progress view can name
 * the work instead of showing a percentage that could have come from anywhere.
 */
export interface ProgressAgentView {
  id: string;
  name: string;
  state: string;
  activity: string;
  updatedAt: string;
}

function evidenceFor(state: LiveState, stage: string): StageEvidence | undefined {
  return (state.evidence?.stages || []).find((s) => s.stage === stage);
}

function linked(state: LiveState, stage: string): boolean {
  return hasStage(state, stage as any);
}

const SHA = /[0-9a-f]{40}/;

/**
 * A push is proven by the implementation evidence naming a pushed commit, or by
 * the cloud build carrying the head sha it built. `githubPush` records
 * IMPLEMENT only after `git push` succeeds, so both real branches carry a
 * commit; nothing here treats a local commit as pushed.
 */
function pushProven(state: LiveState): boolean {
  const impl = evidenceFor(state, 'IMPLEMENT');
  if (impl && /pushed|already pushed/i.test(impl.evidence)) return true;
  return !!(state.cloudBuild.headSha && SHA.test(state.cloudBuild.headSha));
}

/**
 * The real proof for each displayed stage.
 *
 * `DOWNLOAD_READY` and `COMPLETED` are aggregates: they summarize the
 * `PUBLIC_HTTPS_URL`/`PUBLIC_DOWNLOAD`/`FINAL_VERIFY` links and the terminal
 * project state, so the user sees one download step and one completion step
 * without the underlying gate losing any link.
 */
function stageProof(state: LiveState, stage: ProgressStage): boolean {
  switch (stage) {
    case 'IDEA':
    case 'ANALYZE':
    case 'DESIGN':
    case 'PLAN':
    case 'SCAFFOLD':
    case 'TESTGEN':
    case 'VALIDATE':
    case 'CLOUD_BUILD':
    case 'BUILD_SUCCESS':
    case 'REAL_APK':
    case 'APK_VERIFY':
    case 'REAL_ICON_VERIFY':
    case 'RELEASE':
    case 'RELEASE_ASSET':
      return linked(state, stage);
    case 'IMPLEMENT':
      return linked(state, 'IMPLEMENT');
    case 'GITHUB_PUSH':
      return linked(state, 'IMPLEMENT') && pushProven(state);
    case 'DOWNLOAD_READY':
      return (
        linked(state, 'PUBLIC_HTTPS_URL') &&
        linked(state, 'PUBLIC_DOWNLOAD') &&
        state.evidence?.publicDownloadVerified === true
      );
    case 'COMPLETED':
      return linked(state, 'FINAL_VERIFY') && state.projectState === ProjectStates.COMPLETED;
  }
}

/** The evidence text shown next to a displayed stage, if it has a direct link. */
function stageEvidence(state: LiveState, stage: ProgressStage): StageEvidence | undefined {
  if (stage === 'DOWNLOAD_READY') return evidenceFor(state, 'PUBLIC_DOWNLOAD');
  if (stage === 'COMPLETED') return evidenceFor(state, 'FINAL_VERIFY');
  if (stage === 'GITHUB_PUSH') return evidenceFor(state, 'IMPLEMENT');
  return evidenceFor(state, stage);
}

/** Project states that mean no work is happening. */
const IDLE_STATES = new Set<string>([
  ProjectStates.NOT_STARTED,
  ProjectStates.QUEUED,
  ProjectStates.PAUSED,
  ProjectStates.BLOCKED,
  ProjectStates.COMPLETED,
  ProjectStates.DOWNLOAD_READY
]);

const FAILED_STATES = new Set<string>([ProjectStates.FAILED, ProjectStates.BLOCKED]);

/** Display stages a recorded failure belongs to, in preference order. */
const CLOUD_FAILURE_STAGES: ProgressStage[] = ['CLOUD_BUILD', 'BUILD_SUCCESS'];
const APK_FAILURE_STAGES: ProgressStage[] = ['REAL_APK', 'APK_VERIFY', 'REAL_ICON_VERIFY'];
const RELEASE_FAILURE_STAGES: ProgressStage[] = ['RELEASE', 'RELEASE_ASSET'];

function firstUnproven(stages: ProgressStage[], state: LiveState): ProgressStage | undefined {
  return stages.find((s) => !stageProof(state, s));
}

/**
 * What the repair machinery is doing about a failure, in its own words.
 *
 * The states are the ones `FailureRepairStates` defines, so the line on screen
 * always reflects a real recorded step. A transient cloud failure reports the
 * retry that is already under way; a source failure waits for the repair agent.
 */
function recoveryAction(state: LiveState): string {
  const repair = state.failureRepair || { state: 'idle' };
  switch (repair.state) {
    case FailureRepairStates.REPAIRING:
    case FailureRepairStates.RETESTING:
      return `repairing: ${repair.rootCause || 'failed link'}`;
    case FailureRepairStates.VERIFIED:
      return 'repair verified, resuming the pipeline';
    case FailureRepairStates.FAILURE_DETECTED:
      return `repair scheduled: ${repair.rootCause || 'failed link'}`;
    case FailureRepairStates.DIAGNOSING:
      return `diagnosing the failure${repair.rootCause ? `: ${repair.rootCause}` : ''}`;
    case FailureRepairStates.ROOT_CAUSE_FOUND:
      return `root cause found: ${repair.rootCause || 'pending'}`;
    case FailureRepairStates.REPAIR_TASK_CREATED:
    case FailureRepairStates.AGENT_ASSIGNED:
      return `repair task assigned to ${repair.assignedAgentId || 'an agent'}`;
    default:
      if (state.cloudBuild.status === 'failed' && state.cloudBuild.retryable) {
        return 'retrying the cloud build (transient failure)';
      }
      if (state.currentRepair) {
        return `repairing: ${state.currentRepair.failedWhy || state.currentRepair.failedWhat || 'failed link'}`;
      }
      return 'repair required before the run can continue';
  }
}

/**
 * Attributes a failure to a displayed stage, using only recorded reasons. A
 * stage is marked FAILED because the authoritative state already says so, not
 * because the projection suspects something went wrong.
 */
function detectFailure(state: LiveState, currentStage: ProgressStage): ProgressFailure | undefined {
  if (state.cloudBuild.status === 'failed') {
    const stage = firstUnproven(CLOUD_FAILURE_STAGES, state) || currentStage;
    const reason = state.cloudBuild.failedReason
      || `cloud build failed (${state.cloudBuild.failureClass || 'unknown class'})`;
    return { stage, reason, recoveryAction: recoveryAction(state) };
  }
  if (state.apkVerification === 'failed') {
    const stage = firstUnproven(APK_FAILURE_STAGES, state) || currentStage;
    const errors = state.apkVerificationErrors || [];
    const reason = state.icon.status === 'failed' && state.icon.errors?.length
      ? `icon verification failed: ${state.icon.errors.join('; ')}`
      : errors.length
        ? `APK verification failed: ${errors.join('; ')}`
        : 'APK verification failed';
    return { stage, reason, recoveryAction: recoveryAction(state) };
  }
  if (state.release.status === 'failed') {
    const stage = firstUnproven(RELEASE_FAILURE_STAGES, state) || currentStage;
    const reason = state.release.failedReason || 'release failed';
    return { stage, reason, recoveryAction: recoveryAction(state) };
  }
  if (FAILED_STATES.has(state.projectState)) {
    const stage = firstUnproven(ProgressStages, state) || currentStage;
    return {
      stage,
      reason: state.latestActivity || `run is ${state.projectState}`,
      recoveryAction: recoveryAction(state)
    };
  }
  return undefined;
}

function statusLabel(state: LiveState, failure: ProgressFailure | undefined, completed: boolean): string {
  if (completed) return 'COMPLETED';
  if (failure) return 'FAILED';
  if (state.projectState === ProjectStates.DOWNLOAD_READY) return 'DOWNLOAD_READY';
  if (IDLE_STATES.has(state.projectState)) return 'IDLE';
  // Any live project state with work not yet proven is a build in progress.
  return 'BUILDING';
}

function verification(state: LiveState): ProgressVerification {
  return {
    packageId: state.apkPackageId,
    apkSha256: state.apkSha256,
    apkPath: state.apkPath,
    cloudRunId: state.cloudBuild.runId,
    headSha: state.cloudBuild.headSha,
    artifactSha256: state.cloudBuild.artifactSha256,
    artifactSize: state.cloudBuild.artifactSize,
    iconStatus: state.icon.status,
    iconManifestIcon: state.icon.manifestIcon,
    iconManifestRoundIcon: state.icon.manifestRoundIcon,
    iconMatchedDensities: state.icon.matchedDensities,
    iconSimilarity: state.icon.similarity,
    iconByteIdentical: state.icon.byteIdentical,
    iconVerifiedAt: state.icon.verifiedAt,
    releaseUrl: state.release.releaseUrl,
    releaseVerifiedAt: state.release.verifiedAt
  };
}

/**
 * Projects authoritative state into the ordered progress view.
 *
 * The current stage is the first link the evidence chain has not proven yet,
 * which is the same criterion the completion gate uses, so the UI can never run
 * ahead of the gate. Overall progress counts proven links and blends in the
 * existing sub-stage percentage for the link in flight; it reaches 100 only
 * when COMPLETED itself is proven.
 */
export function buildLiveProgress(state: LiveState): LiveProgressView {
  const enriched = enrichWithProgress(state);
  const proven = new Set<ProgressStage>(
    ProgressStages.filter((stage) => stageProof(state, stage))
  );
  const completedCount = proven.size;
  const currentStage = ProgressStages.find((s) => !proven.has(s)) || null;

  const failure = currentStage ? detectFailure(state, currentStage) : undefined;
  const failedStage = failure?.stage;
  const completed = completedCount === ProgressStages.length;

  const stages: ProgressStageView[] = ProgressStages.map((stage) => {
    let status: ProgressStageStatus;
    if (proven.has(stage)) {
      status = 'completed';
    } else if (stage === failedStage) {
      status = 'failed';
    } else if (stage === currentStage) {
      // The run is live and this is the first unproven link, so work is on it.
      // Everything after it is still pending, which is what makes the run honest.
      status = IDLE_STATES.has(state.projectState) ? 'pending' : 'running';
    } else {
      status = 'pending';
    }
    const ev = stageEvidence(state, stage);
    return {
      stage,
      status,
      evidence: ev?.evidence,
      at: ev?.at,
      runId: ev?.runId
    };
  });

  const perStage = 100 / ProgressStages.length;
  let overallPct = Math.floor(completedCount * perStage);
  if (!completed && currentStage && enriched.currentStagePct !== null) {
    // Sub-stage progress from the existing helper, never persisted.
    overallPct += Math.round((Math.max(0, Math.min(100, enriched.currentStagePct)) / 100) * perStage);
  }
  // 100% means every link is proven. A state that claims COMPLETED while the
  // chain still lacks a link must not be allowed to read as finished, so the
  // cap is applied before the completed case and only lifted by real proof.
  overallPct = Math.max(0, Math.min(99, overallPct));
  if (completed) overallPct = 100;

  const downloadReady = stageProof(state, 'DOWNLOAD_READY');

  return {
    status: statusLabel(state, failure, completed),
    projectState: state.projectState,
    overallPct,
    storedOverallPct: state.overallProgressPct,
    currentStage,
    currentStagePct: completed ? null : enriched.currentStagePct,
    latestActivity: state.latestActivity,
    elapsedMs: state.elapsedMs,
    stages,
    completed,
    downloadReady,
    downloadUrl: downloadReady ? state.finalDownloadUrl || state.release.assetUrl : undefined,
    verification: completed || downloadReady ? verification(state) : undefined,
    failure,
    agents: agentViews(state),
    activeAgents: Object.values(state.agents || {}).filter((a) => a.state === 'WORKING').length,
    lastUpdated: state.lastUpdated
  };
}

/**
 * The fleet as the state records it, in agent order.
 *
 * Nothing is invented: an agent that has never started is IDLE with whatever the
 * store says about it, and an agent that is working carries its real activity.
 */
function agentViews(state: LiveState): ProgressAgentView[] {
  const agents = state.agents || {};
  return Object.keys(agents)
    .map((id) => agents[id])
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((a) => ({
      id: a.id,
      name: a.name,
      state: a.state,
      activity: a.activity,
      updatedAt: a.updatedAt
    }));
}

/** Human label for a stage status, used by every renderer and the API. */
export function statusGlyph(status: ProgressStageStatus): string {
  switch (status) {
    case 'completed': return '✓';
    case 'running': return '🔄';
    case 'failed': return '✗';
    default: return '○';
  }
}

export function statusWord(status: ProgressStageStatus): string {
  switch (status) {
    case 'completed': return 'completed';
    case 'running': return 'running';
    case 'failed': return 'failed';
    default: return 'pending';
  }
}

/** The displayed stage names, in order, without depending on the display. */
export function progressStageNames(): readonly string[] {
  return ProgressStages;
}

/** Evidence links the completion gate still needs; exposed for diagnostics. */
export function unprovenLinks(state: LiveState): string[] {
  return LifecycleStages.filter((stage) => !hasStage(state, stage));
}