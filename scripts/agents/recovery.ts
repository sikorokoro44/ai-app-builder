/**
 * What to do with a run that stopped.
 *
 * A run can stop for reasons that have nothing to do with the code: the process
 * was killed, the machine rebooted, a workflow ran out of minutes, or an agent
 * refused to produce output it could not validate. Recovery reads what really
 * happened from the run's own ledger and evidence chain and then either resumes
 * the run where it stopped or starts a new one from the same idea. It never
 * rewrites history to make a run look further along than it was.
 */

import { readdirSync } from 'fs';
import { readState, writeState, appendEvent } from '../live/stateStore.ts';
import { hasStage, missingStages, type LifecycleStage } from '../live/evidenceChain.ts';
import { LifecycleStages } from '../live/evidenceChain.ts';
import { invalidateFrom as invalidateEvidenceFrom } from '../live/recoveryManager.ts';
import { Events } from '../../shared/types.ts';
import { AGENT_IDS } from './agentIds.ts';
import { agentIds } from './registry.ts';
import {
  AGENT_ROOT,
  currentRunId,
  isAgentComplete,
  readLedger,
  readManifest,
  resolveRunId,
  runDir,
  type AgentLedgerEntry
} from './artifacts.ts';
import { runCoordinator, type CoordinatorOptions, type CoordinatorReport } from './coordinator.ts';

export interface RunInspection {
  runId: string;
  idea: string;
  createdAt: string;
  /** The run this directory belongs to, for display. */
  dir: string;
  completedAgents: string[];
  pendingAgents: string[];
  failedAgents: { agentId: string; errors: string[] }[];
  repairedAgents: string[];
  projectState: string;
  evidence: string[];
  missingEvidence: string[];
  /** True when every agent recorded a completed status with a valid output. */
  fleetComplete: boolean;
  /** True when the evidence chain reaches the end and the state says COMPLETED. */
  runComplete: boolean;
}

export function inspectRun(runId?: string): RunInspection {
  const id = resolveRunId(runId);
  const manifest = readManifest(id);
  if (!manifest) throw new Error(`no run manifest for ${id} in ${runDir(id)}`);
  const ledger = readLedger(id);
  const byAgent = new Map(ledger.map((e) => [e.agentId, e]));
  const completed = agentIds().filter((a) => isAgentComplete(id, a));
  const failed = ledger.filter((e) => e.status === 'failed');
  const state = readState();
  const evidence = (state.evidence?.stages ?? []).map((s) => s.stage);
  return {
    runId: id,
    idea: manifest.idea,
    createdAt: manifest.createdAt,
    dir: runDir(id),
    completedAgents: completed,
    pendingAgents: agentIds().filter((a) => !completed.includes(a) && !failed.some((f) => f.agentId === a)),
    failedAgents: failed.map((e) => ({ agentId: e.agentId, errors: e.errors ?? [] })),
    repairedAgents: ledger.filter((e) => (e.repairs ?? 0) > 0).map((e) => e.agentId),
    projectState: state.projectState,
    evidence,
    missingEvidence: missingStages(state),
    fleetComplete: completed.length === agentIds().length,
    runComplete: state.projectState === 'COMPLETED' && missingStages(state).length === 0
  };
}

/** Continue a stopped run: completed agents keep their verified output. */
export async function resumeRun(runId?: string, opts: Omit<CoordinatorOptions, 'runId' | 'idea'> = {}): Promise<CoordinatorReport> {
  const id = resolveRunId(runId);
  const inspection = inspectRun(id);
  const report = await runCoordinator({ ...opts, runId: id, idea: inspection.idea });
  return report;
}

/** Start a fresh run for the same idea, leaving the old run on disk untouched. */
export async function restartRun(idea: string, opts: Omit<CoordinatorOptions, 'runId' | 'idea'> = {}): Promise<CoordinatorReport> {
  return runCoordinator({ ...opts, idea });
}

/**
 * Drop the evidence from a stage onwards.
 *
 * Used when a human decides that everything after a stage has to be rebuilt: the
 * chain is truncated rather than edited, so what remains recorded is exactly what
 * still stands.
 */
export function invalidateFromStage(stage: LifecycleStage, reason: string): number {
  const state = readState();
  const before = (state.evidence?.stages ?? []).length;
  invalidateEvidenceFrom(state, stage);
  state.latestActivity = `evidence invalidated from ${stage}: ${reason}`;
  appendEvent({ type: Events.REPAIR_STARTED, stage, errors: [reason] });
  writeState(state);
  return before - (state.evidence?.stages ?? []).length;
}

/** The first stage of the chain that has no evidence yet. */
export function nextStage(runId?: string): LifecycleStage | null {
  const state = readState();
  const missing = missingStages(state);
  if (!missing.length) return null;
  void runId;
  return missing[0];
}

/** Has this stage been proven for the current run? */
export function stageProven(stage: LifecycleStage): boolean {
  return hasStage(readState(), stage);
}

export interface RunSummary {
  runId: string;
  idea: string;
  agentsCompleted: number;
  agentsTotal: number;
  projectState: string;
  evidenceThrough: string;
  current: boolean;
}

/** Every run on disk, newest first. */
export function listRuns(): RunSummary[] {
  const state = readState();
  const current = currentRunId();
  const ids = new Set<string>();
  try {
    for (const entry of readdirSync(AGENT_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory() && readManifest(entry.name)) ids.add(entry.name);
    }
  } catch {
    // No runs on disk yet.
  }
  return [...ids]
    .sort()
    .reverse()
    .map((runId) => {
      const manifest = readManifest(runId)!;
      const completed = AGENT_IDS.filter((id) => isAgentComplete(runId, id.id)).length;
      const stages = state.evidence?.stages ?? [];
      return {
        runId,
        idea: manifest.idea,
        agentsCompleted: completed,
        agentsTotal: AGENT_IDS.length,
        projectState: state.projectState,
        evidenceThrough: stages.length ? String(stages[stages.length - 1].stage) : 'none',
        current: runId === current
      };
    });
}

export { LifecycleStages, inspectRun as inspect };
