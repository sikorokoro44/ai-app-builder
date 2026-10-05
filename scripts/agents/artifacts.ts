/**
 * Durable handoff store for the agent fleet.
 *
 * Agents do not pass data to each other through in-memory variables: every
 * agent publishes typed JSON artifacts into its own directory and downstream
 * agents read them back. That makes a run resumable after a crash, makes every
 * handoff auditable after the fact, and means a coordinator can validate an
 * artifact before it is allowed to count as work done.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWrite } from '../live/stateStore.ts';

export const AGENT_ROOT = process.env.BUILDER_AGENT_DIR || '.builder/agents';

export type AgentRunStatus = 'running' | 'completed' | 'failed';

export interface AgentStatusRecord {
  agentId: string;
  index: number;
  status: 'pending' | 'running' | 'validating' | 'repairing' | 'completed' | 'failed' | 'skipped';
  attempts: number;
  repairs: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Short summary of what the agent actually produced. */
  summary?: string;
  errors?: string[];
}

export interface AgentLedgerEntry extends AgentStatusRecord {
  runId: string;
}

export interface AgentRunManifest {
  runId: string;
  idea: string;
  createdAt: string;
  planner: string;
  agents: string[];
  /** Execution waves, agent ids per wave, computed from the dependency graph. */
  waves?: string[][];
}

export function runDir(runId: string): string {
  return join(AGENT_ROOT, runId);
}

export function agentDir(runId: string, agentId: string): string {
  return join(runDir(runId), agentId);
}

export function artifactPath(runId: string, agentId: string, kind: string): string {
  return join(agentDir(runId, agentId), `${kind}.json`);
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function currentRunId(): string | null {
  const rec = readJson<{ runId?: string }>(join(AGENT_ROOT, 'current-run.json'));
  return rec?.runId ?? null;
}

export function startRun(manifest: AgentRunManifest): string {
  atomicWrite(join(runDir(manifest.runId), 'manifest.json'), JSON.stringify(manifest, null, 2));
  atomicWrite(join(AGENT_ROOT, 'current-run.json'), JSON.stringify({ runId: manifest.runId, idea: manifest.idea, createdAt: manifest.createdAt }, null, 2));
  return manifest.runId;
}

export function readManifest(runId: string): AgentRunManifest | null {
  return readJson<AgentRunManifest>(join(runDir(runId), 'manifest.json'));
}

/** Resolves the run to operate on: the explicit id, or the current one. */
export function resolveRunId(runId?: string): string {
  const id = runId || currentRunId();
  if (!id) throw new Error(`No agent run found in ${AGENT_ROOT}. Run the coordinator first.`);
  return id;
}

export function writeArtifact(runId: string, agentId: string, kind: string, data: unknown): string {
  const file = artifactPath(runId, agentId, kind);
  atomicWrite(file, JSON.stringify(data, null, 2));
  return file;
}

export function readArtifact<T = unknown>(runId: string, agentId: string, kind: string): T | null {
  return readJson<T>(artifactPath(runId, agentId, kind));
}

export function hasArtifact(runId: string, agentId: string, kind: string): boolean {
  return existsSync(artifactPath(runId, agentId, kind));
}

export function writeAgentStatus(runId: string, record: AgentStatusRecord): void {
  atomicWrite(join(agentDir(runId, record.agentId), 'status.json'), JSON.stringify(record, null, 2));
}

export function readAgentStatus(runId: string, agentId: string): AgentStatusRecord | null {
  return readJson<AgentStatusRecord>(join(agentDir(runId, agentId), 'status.json'));
}

/** Every agent directory that has already published something in this run. */
export function agentsWithOutput(runId: string): string[] {
  const dir = runDir(runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(dir, name, 'output.json')))
    .sort();
}

export function readLedger(runId: string): AgentLedgerEntry[] {
  return readJson<AgentLedgerEntry[]>(join(runDir(runId), 'ledger.json')) ?? [];
}

export function appendLedger(runId: string, entry: AgentLedgerEntry): AgentLedgerEntry[] {
  const all = readLedger(runId).filter((e) => e.agentId !== entry.agentId);
  all.push(entry);
  all.sort((a, b) => a.index - b.index);
  atomicWrite(join(runDir(runId), 'ledger.json'), JSON.stringify(all, null, 2));
  return all;
}

/** True when a previous run of this agent already finished with a valid output. */
export function isAgentComplete(runId: string, agentId: string): boolean {
  const status = readAgentStatus(runId, agentId);
  return !!status && status.status === 'completed' && hasArtifact(runId, agentId, 'output');
}