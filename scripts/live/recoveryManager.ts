import { readState, writeState, initStateStore, appendEvent, STATE_DIR } from './stateStore.ts';
import { ProjectStates, Events, CloudBuildStages } from '../../shared/types.ts';
import { restoreLastCheckpoint, persistCheckpoint, getLastCheckpoint } from './checkpointStore.ts';
import { assertValidTransition, isValidTransition } from './stateValidator.ts';
import { LifecycleStages, hasStage, missingStages } from './evidenceChain.ts';

export { missingStages as missingStagesMissing };
import type { LiveState } from '../../shared/state.ts';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export type FailureKind =
  | 'cloud_build_failed'
  | 'apk_verification_failed'
  | 'release_failed'
  | 'public_url_unreachable'
  | 'project_validation_failed'
  | 'tests_failed'
  | 'unknown';

export interface FailureSignal {
  kind: FailureKind;
  stage: string;
  reason: string;
  /** Stages that must be re-run to repair this failure. */
  repairFrom: string;
  retryable: boolean;
  evidence: string[];
}

export function detectFailure(s: any): FailureKind | null {
  if (!s) return null;
  if (s.projectState === ProjectStates.FAILED) return 'unknown';
  if (s.cloudBuild?.status === 'failed') return 'cloud_build_failed';
  if (s.apkVerification === 'failed') return 'apk_verification_failed';
  if (s.release?.status === 'failed') return 'release_failed';
  if (s.projectState === ProjectStates.BLOCKED) return 'unknown';
  if ((s.testStats?.failed ?? 0) > 0) return 'tests_failed';
  return null;
}

export function buildFailureSignal(s: LiveState, kind: FailureKind, reason: string, evidence: string[] = []): FailureSignal {
  switch (kind) {
    case 'cloud_build_failed':
      return {
        kind,
        stage: 'CLOUD_BUILD',
        reason: reason || s.cloudBuild.failedReason || 'cloud build failed',
        repairFrom: 'CLOUD_BUILD',
        retryable: !!s.cloudBuild.retryable,
        evidence
      };
    case 'apk_verification_failed':
      return {
        kind,
        stage: 'APK_VERIFY',
        reason: reason || (s.apkVerificationErrors || []).join('; ') || 'APK verification failed',
        repairFrom: 'APK_VERIFY',
        retryable: false,
        evidence
      };
    case 'release_failed':
      return {
        kind,
        stage: 'RELEASE',
        reason: reason || s.release.failedReason || 'release failed',
        repairFrom: 'RELEASE',
        retryable: true,
        evidence
      };
    case 'public_url_unreachable':
      return {
        kind,
        stage: 'PUBLIC_DOWNLOAD',
        reason,
        repairFrom: 'PUBLIC_DOWNLOAD',
        retryable: true,
        evidence
      };
    case 'project_validation_failed':
      return {
        kind,
        stage: 'VALIDATE',
        reason,
        repairFrom: 'VALIDATE',
        retryable: false,
        evidence
      };
    case 'tests_failed':
      return { kind, stage: 'TESTGEN', reason, repairFrom: 'TESTGEN', retryable: false, evidence };
    default:
      return { kind: 'unknown', stage: 'unknown', reason, repairFrom: 'ANALYZE', retryable: false, evidence };
  }
}

/**
 * Maps a failed stage to the earliest lifecycle stage that must be re-run.
 * Everything after the repair point keeps its prior evidence, so completed work
 * is never restarted unnecessarily.
 */
export function repairPointFor(signal: FailureSignal): string {
  return signal.repairFrom;
}

export function invalidateFrom(state: LiveState, stage: string): void {
  const idx = (LifecycleStages as readonly string[]).indexOf(stage);
  const chain = state.evidence || { stages: [] };
  if (idx < 0) {
    state.evidence = { ...chain, stages: [], publicDownloadVerified: false };
    return;
  }
  const keep = (LifecycleStages as readonly string[]).slice(0, idx).filter((s) => hasStage(state, s as any));
  state.evidence = {
    ...chain,
    stages: (state.evidence?.stages || []).filter((s) => keep.includes(s.stage)),
    publicDownloadVerified: false,
    publicDownloadUrl: undefined
  };
  const order = LifecycleStages as readonly string[];
  const idxBuild = order.indexOf('BUILD_SUCCESS');
  const idxApk = order.indexOf('APK_VERIFY');
  const idxRelease = order.indexOf('RELEASE');

  // A repair at or before BUILD_SUCCESS invalidates the build and everything after it.
  if (idx <= idxBuild) {
    state.cloudBuild.status = 'failed';
    state.cloudBuild.artifactSha256 = undefined;
    state.apkVerification = 'failed';
    state.apkPath = undefined;
    state.apkSha256 = undefined;
  }
  // A repair at or before APK_VERIFY invalidates the APK and release claims,
  // but keeps the successful build result.
  if (idx <= idxApk) {
    state.apkVerification = 'failed';
    state.apkSha256 = undefined;
    state.apkVerificationErrors = undefined;
  }
  // A repair at or before RELEASE drops the release, keeping the verified APK.
  if (idx <= idxRelease) {
    state.release.status = 'idle';
    state.release.assetUrl = undefined;
    state.release.assetSha256 = undefined;
    state.release.failedReason = undefined;
  }
  state.finalDownloadUrl = undefined;
}

export interface RecoveryPlan {
  interrupted: boolean;
  resumeFrom: string | null;
  missing: string[];
  failed: FailureKind | null;
  needsRepair: boolean;
}

/**
 * Inspects persisted state after an interruption and reports where to continue.
 * A run whose cloudBuild.status is still "running" is treated as interrupted.
 */
export function planRecovery(): RecoveryPlan {
  initStateStore();
  const s = readState();
  const missing = missingStages(s) as string[];
  const failed = detectFailure(s);
  const interrupted = s.cloudBuild?.status === 'running' || s.release?.status === 'releasing';
  let resumeFrom: string | null = null;
  if (failed) {
    resumeFrom = buildFailureSignal(s, failed, '').repairFrom;
  } else if (missing.length > 0) {
    resumeFrom = missing[0];
  } else {
    resumeFrom = null;
  }
  return {
    interrupted,
    resumeFrom,
    missing,
    failed,
    needsRepair: !!failed || interrupted
  };
}

/** Lifecycle state each evidence stage implies the run had reached. */
export const STAGE_TO_PROJECT_STATE: Record<string, string> = {
  IDEA: ProjectStates.NOT_STARTED,
  ANALYZE: ProjectStates.ANALYZING,
  DESIGN: ProjectStates.DESIGNING,
  PLAN: ProjectStates.PLANNING,
  SCAFFOLD: ProjectStates.READY,
  IMPLEMENT: ProjectStates.BUILDING,
  TESTGEN: ProjectStates.TESTING,
  VALIDATE: ProjectStates.TESTING,
  CLOUD_BUILD: ProjectStates.CLOUD_BUILDING,
  BUILD_SUCCESS: ProjectStates.CLOUD_BUILDING,
  REAL_APK: ProjectStates.VERIFYING,
  APK_VERIFY: ProjectStates.VERIFYING,
  RELEASE: ProjectStates.RELEASING,
  RELEASE_ASSET: ProjectStates.RELEASING,
  PUBLIC_HTTPS_URL: ProjectStates.DOWNLOAD_READY,
  PUBLIC_DOWNLOAD: ProjectStates.DOWNLOAD_READY,
  FINAL_VERIFY: ProjectStates.DOWNLOAD_READY
};

/**
 * Repairs always originate from the stage that failed. If the persisted
 * projectState is stale relative to the evidence chain, the evidence wins:
 * a run proven to have reached CLOUD_BUILD can legitimately enter REPAIRING.
 */
export function enterRepair(s: LiveState, signal: FailureSignal): void {
  const implied = STAGE_TO_PROJECT_STATE[signal.stage] || signal.stage;
  if (s.projectState !== ProjectStates.REPAIRING && !isValidTransition(s.projectState, ProjectStates.REPAIRING)) {
    if (isValidTransition(implied, ProjectStates.REPAIRING)) {
      s.projectState = implied as any;
    } else {
      assertValidTransition(s.projectState, ProjectStates.REPAIRING);
    }
  }
  s.projectState = ProjectStates.REPAIRING;
  s.failureRepair = {
    state: 'FAILURE_DETECTED',
    failureDetectedAt: new Date().toISOString(),
    rootCause: signal.reason,
    changes: signal.evidence
  };
  s.latestActivity = `Failure detected at ${signal.stage}: ${signal.reason}`;
  persistCheckpoint(`pre-repair-${signal.stage}`, s);
  invalidateFrom(s, signal.repairFrom);
  appendEvent({ type: Events.REPAIR_STARTED, stage: signal.stage, reason: signal.reason, repairFrom: signal.repairFrom });
}

export function resumeFromLastValidCheckpoint(): LiveState | null {
  initStateStore();
  const s = restoreLastCheckpoint();
  if (s) {
    s.latestActivity = `Resumed from checkpoint: ${s.projectState}`;
    writeState(s);
    appendEvent({ type: Events.PROJECT_STATUS_CHANGED, projectState: s.projectState, activity: 'resumed from checkpoint' });
  }
  return s;
}

export interface RecoveryReport {
  ok: boolean;
  actions: string[];
  state: string;
}

/** Of two lifecycle stages, the earlier one along the pipeline. */
export function earliestStage(a: string | undefined, b: string): string {
  const order = LifecycleStages as readonly string[];
  const ia = a ? order.indexOf(a) : -1;
  const ib = order.indexOf(b);
  if (ia < 0) return b;
  if (ib < 0) return a as string;
  return ia <= ib ? (a as string) : b;
}

/** Stage an in-flight run must restart from when no checkpoint survives. */
export function interruptedStageFor(s: LiveState): string {
  if (s.release?.status === 'releasing') return 'RELEASE';
  if (s.cloudBuild?.status === 'running') return 'CLOUD_BUILD';
  const missing = missingStages(s);
  return missing[0] || 'IDEA';
}

export function recover(): RecoveryReport {
  initStateStore();
  const actions: string[] = [];
  const plan = planRecovery();

  if (plan.failed) {
    const s = readState();
    const signal = buildFailureSignal(s, plan.failed, '', readTailLogs());
    if (s.projectState !== ProjectStates.COMPLETED) {
      enterRepair(s, signal);
      writeState(s);
      actions.push(`entered repair for ${signal.stage}`);
    }
  } else if (plan.interrupted) {
    const current = readState();
    current.cloudBuild.failedReason = 'run interrupted before completion was recorded';
    current.release.failedReason = 'interrupted before release finished';
    writeState(current);
    // Recorded in the append-only log only: checkpointing here would create a
    // checkpoint newer than the last good one and defeat resume.
    appendEvent({ type: Events.BUILD_FAILED, reason: 'run interrupted before completion was recorded' });

    const interruptedStage = interruptedStageFor(current);
    const restored = resumeFromLastValidCheckpoint();

    if (restored) {
      // The interrupted snapshot proves how far the run actually got, so it is
      // the authoritative floor: nothing before the in-flight stage may be
      // replayed. The checkpoint then supplies everything after that point.
      const st = readState();
      const order = LifecycleStages as readonly string[];
      const floor = Math.max(
        order.indexOf(interruptedStage),
        order.indexOf(STAGE_TO_PROJECT_STATE[restored.projectState] || '')
      );
      const candidates = missingStages(st).filter((m) => order.indexOf(m) >= floor);
      const resumePoint = candidates.length > 0 ? candidates[0] : interruptedStage;
      invalidateFrom(st, resumePoint);
      st.latestActivity = `Resumed after interruption; continuing at ${resumePoint}`;
      persistCheckpoint(`resumed-at-${resumePoint}`, st);
      writeState(st);
      actions.push(`interrupted run detected; restored checkpoint at ${restored.projectState}; continuing at ${resumePoint}`);
    } else {
      const st = readState();
      invalidateFrom(st, interruptedStage);
      persistCheckpoint(`restart-at-${interruptedStage}`, st);
      writeState(st);
      actions.push(`interrupted run detected; no checkpoint available, re-running from ${interruptedStage}`);
    }
  } else {
    actions.push('no recovery needed');
  }

  const finalState = readState();
  return {
    ok: true,
    actions,
    state: finalState.projectState
  };
}

function readTailLogs(max = 120): string[] {
  const file = join(STATE_DIR, 'events.jsonl');
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean).slice(-max);
  } catch {
    return [];
  }
}

export { CloudBuildStages };
