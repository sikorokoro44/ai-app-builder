/**
 * The coordinator.
 *
 * It owns scheduling, nothing else: which agent may run now, in what order, with
 * how much concurrency, what to do when an agent fails, and what the run did. All
 * of the work belongs to the agents, all of the truth belongs to the state store
 * and the evidence chain. Three rules shape it:
 *
 *  - An agent that depends on another may only start once that agent's output
 *    artifact exists and has passed its validator. Handoffs are files.
 *  - Two agents may only run together when their owned paths cannot overlap and
 *    they do not hold the same exclusive resource.
 *  - Nothing is marked done on the strength of an exit code. Every agent's output
 *    is validated, and the run's own report is only as good as the ledger.
 */

import { appendEvent, readState } from '../live/stateStore.ts';
import type { LifecycleStage } from '../live/evidenceChain.ts';
import { VALID_TRANSITIONS } from '../live/stateValidator.ts';
import { invalidateFrom } from '../live/recoveryManager.ts';
import { Events } from '../../shared/types.ts';
import type { AgentSpec } from '../../shared/agentTypes.ts';
import {
  AGENTS,
  anyPathConflict,
  agentById,
  agentIds,
  executionWaves,
  validateRegistry
} from './registry.ts';
import { AGENT_ID_NAMES } from './agentIds.ts';
import {
  AGENT_ROOT,
  appendLedger,
  isAgentComplete,
  readLedger,
  readManifest,
  resolveRunId,
  runDir,
  startRun,
  writeAgentStatus,
  type AgentLedgerEntry
} from './artifacts.ts';
import { AgentContext } from './context.ts';

export interface CoordinatorOptions {
  idea?: string;
  repoRoot?: string;
  projectRoot?: string;
  runId?: string;
  maxConcurrency?: number;
  mode?: 'full' | 'pre-cloud';
  echo?: boolean;
  /** Stop cleanly after the agents in this list have completed. */
  stopAfter?: string[];
  /** Run only these agents; everything else is reported as skipped. */
  only?: string[];
}

export interface AgentRunReport {
  id: string;
  index: number;
  name: string;
  status: 'completed' | 'failed' | 'skipped' | 'pending';
  attempts: number;
  repairs: number;
  durationMs: number;
  summary?: string;
  errors?: string[];
}

export interface CoordinatorReport {
  runId: string;
  idea: string;
  status: 'completed' | 'failed';
  agents: AgentRunReport[];
  projectState: string;
  evidenceStages: string[];
  downloadUrl?: string;
  apkSha256?: string;
  elapsedMs: number;
  failures: { agent: string; error: string; diagnostics: string[] }[];
}

class AgentFailed extends Error {
  readonly agentId: string;
  readonly diagnostics: string[];
  readonly retryable: boolean;
  constructor(agentId: string, message: string, diagnostics: string[] = [], retryable = false) {
    super(message);
    this.name = 'AgentFailed';
    this.agentId = agentId;
    this.diagnostics = diagnostics;
    this.retryable = retryable;
  }
}

/** Every lifecycle path from `from` to `to` through the proven transition table. */
export function pathBetween(from: string, to: string): string[] | null {
  if (from === to) return [];
  const queue: { state: string; path: string[] }[] = [{ state: from, path: [from] }];
  const seen = new Set([from]);
  while (queue.length) {
    const { state, path } = queue.shift()!;
    for (const next of VALID_TRANSITIONS[state] ?? []) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath.slice(1);
      seen.add(next);
      queue.push({ state: next, path: nextPath });
    }
  }
  return null;
}

export function newRunId(idea: string): string {
  const slug = idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'run';
  return `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${slug}`;
}

export async function runCoordinator(opts: CoordinatorOptions = {}): Promise<CoordinatorReport> {
  const started = Date.now();
  const registryProblems = validateRegistry();
  if (registryProblems.length) {
    throw new Error(`the agent registry is invalid:\n - ${registryProblems.join('\n - ')}`);
  }

  const repoRoot = opts.repoRoot || process.env.BUILDER_REPO_ROOT || process.cwd();
  const projectRoot = opts.projectRoot || process.env.BUILDER_PROJECT_DIR || `${repoRoot}/.builder/generated/android`;
  const mode = opts.mode || 'full';
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? Number(process.env.BUILDER_AGENT_CONCURRENCY ?? 4));
  const echo = opts.echo ?? true;
  // `pre-cloud` is the honest stopping point for a local run: everything up to
  // and including validation, and nothing that needs GitHub or a network.
  const PRE_CLOUD_STOP = ['repo-publisher', 'build-verifier', 'release-publisher', 'integration-supervisor'];
  // `only` is a request to run one agent on its own: everything the scheduler
  // would run besides it is held back, which is what makes a single-agent worker
  // safe. `stopAfter` means the opposite, so the two must never be confused.
  const only = opts.only?.length ? new Set(opts.only) : null;
  const stopAfter = new Set(
    only ? agentIds().filter((id) => !only.has(id)) : (opts.stopAfter ?? (mode === 'pre-cloud' ? PRE_CLOUD_STOP : []))
  );
  for (const id of opts.only ?? []) {
    if (!agentIds().includes(id)) throw new Error(`unknown agent "${id}" cannot be run on its own`);
  }

  const resumedRunId = opts.runId || process.env.BUILDER_AGENT_RUN_ID || undefined;
  const existing = resumedRunId && readManifest(resumedRunId) ? resumedRunId : undefined;
  const idea = opts.idea
    || (existing ? readManifest(existing)!.idea : undefined)
    || process.env.BUILDER_IDEA
    || '';
  if (!idea.trim()) throw new Error('no idea to build: pass idea, set BUILDER_IDEA, or resume a run');

  const waves = executionWaves();
  const runId = existing || newRunId(idea);
  startRun({
    runId,
    idea,
    createdAt: new Date().toISOString(),
    planner: 'scripts/agents/planner.ts',
    agents: agentIds(),
    waves
  });
  const manifest = readManifest(runId)!;
  manifest.waves = waves;

  const log = (line: string) => { if (echo) console.log(line); };

  /** Register the whole fleet in the live state so progress views can see it. */
  const seedFleet = async (): Promise<void> => {
    const ctx = new AgentContext({ runId, repoRoot, projectRoot, idea, mode, agentId: 'coordinator', echo: false });
    await ctx.mutate((s) => {
      s.agents = { ...(s.agents || {}) };
      for (const agent of AGENTS) {
        const existing = s.agents[agent.id];
        s.agents[agent.id] = {
          id: agent.id,
          index: agent.index,
          name: agent.name,
          state: existing?.state || 'IDLE',
          activity: existing?.activity || 'waiting for dependencies',
          updatedAt: existing?.updatedAt || new Date().toISOString()
        };
      }
    });
  };
  log(`run ${runId}`);
  log(`idea: ${idea}`);
  log(`fleet: ${AGENT_ID_NAMES.length} agents in ${waves.length} waves, concurrency ${maxConcurrency}, mode ${mode}`);
  log(`artifacts: ${runDir(runId)}`);

  await seedFleet();

  const done = new Map<string, AgentLedgerEntry>();
  for (const entry of readLedger(runId)) done.set(entry.agentId, entry);

  const reports = new Map<string, AgentRunReport>();
  const failures: CoordinatorReport['failures'] = [];
  const inFlight = new Map<string, AgentSpec<never, unknown>>();
  const repairing = new Set<string>();
  let stopped = false;

  const writeReport = (id: string, patch: Partial<AgentRunReport>): AgentRunReport => {
    const current = reports.get(id) ?? {
      id,
      index: agentById(id).index,
      name: agentById(id).name,
      status: 'pending' as const,
      attempts: 0,
      repairs: 0,
      durationMs: 0
    };
    const next = { ...current, ...patch };
    reports.set(id, next);
    return next;
  };

  const ensureState = async (ctx: AgentContext, target?: string): Promise<void> => {
    if (!target) return;
    const current = await ctx.mutate((s) => s.projectState);
    if (current === target) return;
    const path = pathBetween(current, target);
    if (!path) throw new AgentFailed(ctx.agentId, `no legal lifecycle path from ${current} to ${target}`);
    await ctx.mutate((s) => {
      for (const step of path) s.projectState = step as typeof s.projectState;
      s.latestActivity = `${ctx.agentId}: advancing to ${target}`;
      appendEvent({ type: Events.PROJECT_STATUS_CHANGED, projectState: target, agentId: ctx.agentId });
    });
  };

  /**
   * Inputs come from the artifacts the upstream agents persisted, never from the
   * live state: an agent sees exactly what its declared producer published. A
   * contract with one input hands that value over directly; a contract with
   * several hands over a record keyed by artifact kind.
   */
  const gatherInputs = (agent: AgentSpec<never, unknown>, ctx: AgentContext): unknown => {
    const input: Record<string, unknown> = {};
    for (const ref of agent.contract.inputs) {
      if (!ref.producedBy) continue;
      const value = ctx.optionalArtifact(ref.producedBy, ref.kind);
      if (value === null && !ref.optional) ctx.artifact(ref.producedBy, ref.kind);
      if (value !== null) input[ref.kind] = value;
    }
    return agent.contract.inputs.length === 1 ? input[agent.contract.inputs[0].kind] : input;
  };

  const writeEntry = (agent: AgentSpec<never, unknown>, entry: AgentLedgerEntry) => {
    appendLedger(runId, entry);
    done.set(agent.id, entry);
    writeAgentStatus(runId, {
      agentId: agent.id,
      index: agent.index,
      status: entry.status,
      attempts: entry.attempts,
      repairs: entry.repairs,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      durationMs: entry.durationMs,
      summary: entry.summary,
      errors: entry.errors
    });
  };

  /** Who should fix a validator complaint? The agent that owns the file it names. */
  const ownerFor = (errors: string[], exclude: string): AgentSpec<never, unknown> | null => {
    for (const agent of AGENTS) {
      if (agent.id === exclude) continue;
      const named = agent.ownedPaths.filter((p) => !p.includes('*'));
      const hit = named.some((p) => errors.some((e) => e.includes(p) || e.includes(p.split('/').pop()!)));
      if (hit) return agent;
      if (errors.some((e) => e.includes(agent.id))) return agent;
    }
    return null;
  };

  const runAgent = async (agent: AgentSpec<never, unknown>): Promise<void> => {
    const ctx = new AgentContext({
      runId,
      repoRoot,
      projectRoot,
      idea,
      mode,
      agentId: agent.id,
      echo
    });
    const t0 = Date.now();
    let attempts = 0;
    let repairs = 0;
    const statusBase = { agentId: agent.id, index: agent.index, runId };

    await ensureState(ctx, agent.entersState);
    await ctx.setAgentState('WORKING');
    await ctx.activity('started');
    writeEntry(agent, { ...statusBase, status: 'running', attempts, repairs, startedAt: new Date().toISOString() });

    const maxAttempts = Math.max(1, agent.failurePolicy.maxAttempts);
    const maxRepairs = agent.failurePolicy.repairable ? agent.failurePolicy.maxRepairs : 0;
    let lastErrors: string[] = [];

    while (attempts < maxAttempts) {
      attempts += 1;
      let output: unknown;
      try {
        const input = gatherInputs(agent, ctx);
        output = await agent.execute(ctx as never, input as never);
      } catch (e) {
        const err = e as { message?: string; diagnostics?: string[]; retryable?: boolean };
        lastErrors = [err.message || String(e), ...(err.diagnostics ?? [])];
        const transient = err.retryable === true;
        if (transient && attempts < maxAttempts) {
          ctx.log(`attempt ${attempts} failed transiently (${lastErrors[0]}); retrying`);
          continue;
        }
        throw new AgentFailed(agent.id, lastErrors[0], lastErrors.slice(1), transient);
      }

      await ctx.setAgentState('REVIEWING');
      const validation = await agent.validate(output as never, ctx as never);
      if (validation.valid) {
        const durationMs = Date.now() - t0;
        const summary = summarise(agent, output);
        ctx.publish('output', { agent: agent.id, index: agent.index, summary, output });
        if (agent.evidenceStage && agent.evidence) {
          const line = agent.evidence(output as never);
          if (line) await ctx.evidence(agent.evidenceStage, line);
        }
        if (agent.nextState) await ensureState(ctx, agent.nextState);
        await ctx.setAgentState('COMPLETED');
        await ctx.activity(`completed: ${summary}`);
        writeEntry(agent, {
          ...statusBase,
          status: 'completed',
          attempts,
          repairs,
          startedAt: new Date(t0).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs,
          summary
        });
        writeReport(agent.id, { status: 'completed', attempts, repairs, durationMs, summary });
        log(`  ✓ ${String(agent.index).padStart(2, '0')} ${agent.id} (${durationMs}ms) — ${summary}`);
        return;
      }

      lastErrors = validation.errors;
      ctx.log(`validation failed: ${lastErrors[0]}`);
      const owner = repairs < maxRepairs ? ownerFor(lastErrors, agent.id) : null;
      if (!owner) {
        if (repairs < maxRepairs) {
          repairs += 1;
          ctx.repairNotes = [...lastErrors];
          ctx.log(`retrying with validator diagnostics (repair ${repairs}/${maxRepairs})`);
          continue;
        }
        throw new AgentFailed(agent.id, lastErrors[0], lastErrors.slice(1));
      }

      repairs += 1;
      repairing.add(owner.id);
      ctx.log(`handing the validator diagnostics to ${owner.id} (repair ${repairs}/${maxRepairs})`);
      await repairOwner(owner, lastErrors);
      repairing.delete(owner.id);
      ctx.repairNotes = [...lastErrors];
    }

    throw new AgentFailed(agent.id, lastErrors[0] || `${agent.id} exhausted its attempts`, lastErrors.slice(1));
  };

  /**
   * Re-run an upstream agent with the failing diagnostics and drop the evidence
   * its work had earned, so a repaired pipeline never keeps a stale proof.
   */
  const repairOwner = async (owner: AgentSpec<never, unknown>, errors: string[]): Promise<void> => {
    await ctxInvalidateFrom(owner, errors);
    await runAgent(owner);
  };

  const ctxInvalidateFrom = async (owner: AgentSpec<never, unknown>, errors: string[]): Promise<void> => {
    const stage = owner.evidenceStage;
    const repairCtx = new AgentContext({ runId, repoRoot, projectRoot, idea, mode, agentId: owner.id, echo });
    repairCtx.repairNotes = errors;
    if (stage) {
      await repairCtx.mutate((s) => {
        invalidateFrom(s, stage as LifecycleStage);
        appendEvent({ type: Events.REPAIR_STARTED, agentId: owner.id, stage, errors: errors.slice(0, 5) });
        s.latestActivity = `repairing ${owner.id} after a validator failure`;
      });
    }
    // A repaired agent must earn its completion again, from a clean ledger entry.
    const entry: AgentLedgerEntry = {
      agentId: owner.id,
      index: owner.index,
      runId,
      status: 'pending',
      attempts: 0,
      repairs: 0
    };
    writeEntry(owner, entry);
    appendEvent({ type: Events.REPAIR_COMPLETED, agentId: owner.id, stage: stage || 'none' });
  };

  const isComplete = (id: string): boolean => {
    const entry = done.get(id);
    return !!entry && entry.status === 'completed' && isAgentComplete(runId, id);
  };

  const readyNow = (agent: AgentSpec<never, unknown>): boolean => {
    if (stopped || reports.get(agent.id)?.status === 'skipped') return false;
    if (isComplete(agent.id)) return false;
    if (inFlight.has(agent.id)) return false;
    if (!agent.dependsOn.every(isComplete)) return false;
    for (const other of inFlight.values()) {
      if (other.id === agent.id) continue;
      if (agent.exclusiveGroup && other.exclusiveGroup === agent.exclusiveGroup) return false;
      if (anyPathConflict(agent.ownedPaths, other.ownedPaths)) return false;
    }
    return true;
  };

  const launch = (agent: AgentSpec<never, unknown>): Promise<void> => {
    inFlight.set(agent.id, agent);
    return runAgent(agent)
      .catch((e: unknown) => {
        const err = e as AgentFailed;
        const durationMs = Date.now();
        stopped = true;
        failures.push({ agent: agent.id, error: err.message, diagnostics: err.diagnostics ?? [] });
        writeReport(agent.id, {
          status: 'failed',
          durationMs,
          errors: [err.message, ...(err.diagnostics ?? [])]
        });
        writeEntry(agent, {
          agentId: agent.id,
          index: agent.index,
          runId,
          status: 'failed',
          attempts: 1,
          repairs: 0,
          finishedAt: new Date().toISOString(),
          errors: [err.message, ...(err.diagnostics ?? [])]
        });
        log(`  ✗ ${String(agent.index).padStart(2, '0')} ${agent.id} — ${err.message}`);
        const ctx = new AgentContext({ runId, repoRoot, projectRoot, idea, mode, agentId: agent.id, echo: false });
        void ctx.mutate((s) => {
          s.latestActivity = `${agent.id} failed: ${err.message}`;
          appendEvent({ type: Events.AGENT_FINISHED, agentId: agent.id, ok: false, error: err.message });
        });
      })
      .finally(() => {
        inFlight.delete(agent.id);
      });
  };

  // Resume: anything already completed in this run is reported, not re-run.
  for (const id of agentIds()) {
    if (isComplete(id)) {
      const entry = done.get(id)!;
      writeReport(id, {
        status: 'completed',
        attempts: entry.attempts,
        repairs: entry.repairs,
        durationMs: entry.durationMs ?? 0,
        summary: entry.summary
      });
      log(`  = ${String(agentById(id).index).padStart(2, '0')} ${id} — already completed (${entry.summary ?? 'resumed'})`);
    }
  }

  const remaining = agentIds().filter((id) => !isComplete(id) && !stopAfter.has(id));
  for (const id of remaining) {
    if (stopAfter.has(id)) writeReport(id, { status: 'skipped' });
  }
  if (only) {
    log(`Single-agent run: ${[...only].join(', ')}; ${remaining.length} other agent(s) held back.`);
  }

  let running = Promise.resolve();
  while (!stopped) {
    const ready = AGENTS.filter((agent) => !isComplete(agent.id) && !stopAfter.has(agent.id) && readyNow(agent));
    if (ready.length === 0) {
      if (inFlight.size === 0) break;
      await running;
      continue;
    }
    const batch = ready.slice(0, Math.max(0, maxConcurrency - inFlight.size));
    for (const agent of batch) {
      running = Promise.all([running, launch(agent)]);
    }
    if (batch.length === 0) {
      await running;
      continue;
    }
    await Promise.race([running, Promise.resolve()]);
  }
  await running;

  const state = readState();
  const agents: AgentRunReport[] = agentIds().map((id) => reports.get(id) ?? {
    id,
    index: agentById(id).index,
    name: agentById(id).name,
    status: 'skipped' as const,
    attempts: 0,
    repairs: 0,
    durationMs: 0
  });

  const report: CoordinatorReport = {
    runId,
    idea,
    status: failures.length ? 'failed' : 'completed',
    agents,
    projectState: state.projectState,
    evidenceStages: (state.evidence?.stages ?? []).map((s) => s.stage),
    downloadUrl: state.finalDownloadUrl,
    apkSha256: state.apkSha256,
    elapsedMs: Date.now() - started,
    failures
  };
  log('');
  log(`run ${runId} ${report.status} in ${Math.round(report.elapsedMs / 1000)}s — project state ${report.projectState}`);
  for (const agent of agents) {
    log(`  ${agent.status === 'completed' ? '✓' : agent.status === 'failed' ? '✗' : '-'} ${agent.id}: ${agent.summary ?? agent.errors?.join('; ') ?? agent.status}`);
  }
  if (report.downloadUrl) log(`download: ${report.downloadUrl}`);
  return report;
}

/** A short, factual line describing what the agent produced. */
function summarise(agent: AgentSpec<never, unknown>, output: unknown): string {
  const described = agent.describe?.(output as never);
  if (described) return described;
  const out = output as Record<string, unknown> | null;
  if (!out || typeof out !== 'object') return `${agent.id} finished`;
  for (const key of ['summary', 'normalized', 'count', 'path', 'headSha', 'runId', 'tag', 'healthy', 'packageId']) {
    const value = out[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value).slice(0, 80);
    }
  }
  if (Array.isArray(out.methods)) return `${out.methods.length} methods`;
  if (Array.isArray(out.checks)) return `${(out.checks as unknown[]).length} checks`;
  return `${agent.id} finished`;
}

/** Entry point for `node scripts/coordinator.ts`. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<CoordinatorReport> {
  const idea = argv.filter((a) => !a.startsWith('--')).join(' ') || process.env.BUILDER_IDEA || '';
  const report = await runCoordinator({
    idea,
    mode: argv.includes('--pre-cloud') ? 'pre-cloud' : 'full'
  });
  if (report.status !== 'completed') process.exitCode = 1;
  return report;
}

export { AGENT_ROOT, runDir };
