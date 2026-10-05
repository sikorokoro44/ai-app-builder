/**
 * The runtime context handed to one agent execution.
 *
 * Every agent gets the same three capabilities: read upstream handoff
 * artifacts, publish its own, and mutate the authoritative live state through a
 * single serialized channel. Serialization matters because agents run
 * concurrently: without it two agents reading, changing and writing
 * `state.json` would silently drop one of the updates.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { readState, writeState, appendEvent } from '../live/stateStore.ts';
import { recordStage, type LifecycleStage } from '../live/evidenceChain.ts';
import { Events, AgentStates } from '../../shared/types.ts';
import type { LiveState } from '../../shared/state.ts';
import type { AgentExecutionContext, AgentExecutionMode } from '../../shared/agentTypes.ts';
import { readArtifact, writeArtifact } from './artifacts.ts';

export interface AgentContextOptions {
  runId: string;
  repoRoot: string;
  projectRoot?: string;
  idea: string;
  mode: AgentExecutionMode;
  /** Agent id this bound context belongs to. */
  agentId: string;
  log?: (line: string) => void;
  /** Mirrors the run transcript to stdout. */
  echo?: boolean;
}

export class AgentExecutionError extends Error {
  readonly agentId: string;
  readonly diagnostics: string[];
  readonly retryable: boolean;
  constructor(agentId: string, message: string, opts: { diagnostics?: string[]; retryable?: boolean } = {}) {
    super(message);
    this.agentId = agentId;
    this.diagnostics = opts.diagnostics ?? [];
    this.retryable = opts.retryable ?? false;
  }
}

export class AgentContext implements AgentExecutionContext {
  readonly runId: string;
  readonly repoRoot: string;
  readonly projectRoot: string;
  readonly idea: string;
  readonly mode: AgentExecutionMode;
  readonly agentId: string;
  /** Diagnostics handed back to the agent when the coordinator repairs it. */
  repairNotes: string[];
  private readonly logSink: (line: string) => void;
  private readonly echo: boolean;
  /** Serializes state mutations so parallel agents cannot lose updates. */
  private static queue: Promise<unknown> = Promise.resolve();

  constructor(opts: AgentContextOptions) {
    this.runId = opts.runId;
    this.repoRoot = resolve(opts.repoRoot);
    this.projectRoot = resolve(opts.projectRoot ?? join(this.repoRoot, '.builder/generated/android'));
    this.idea = opts.idea;
    this.mode = opts.mode;
    this.agentId = opts.agentId;
    this.repairNotes = [];
    this.logSink = opts.log ?? (() => { });
    this.echo = opts.echo ?? true;
  }

  /** A copy of this context bound to another agent id, sharing the run. */
  bind(agentId: string): AgentContext {
    return new AgentContext({
      runId: this.runId,
      repoRoot: this.repoRoot,
      projectRoot: this.projectRoot,
      idea: this.idea,
      mode: this.mode,
      agentId,
      log: this.logSink,
      echo: this.echo
    });
  }

  log(text: string): void {
    this.logSink(`[${this.agentId}] ${text}`);
    if (this.echo) console.log(`  ${this.agentId}: ${text}`);
  }

  activity(text: string): Promise<unknown> {
    const at = new Date().toISOString();
    return this.mutate((s) => {
      const agent = s.agents?.[this.agentId];
      if (agent) {
        agent.activity = text;
        agent.updatedAt = at;
      }
      s.latestActivity = `${this.agentId}: ${text}`;
      appendEvent({ type: Events.AGENT_ACTIVITY, agentId: this.agentId, activity: text, at });
    });
  }

  setAgentState(state: string, extra: { currentTaskId?: string; currentFeatureId?: string; blockingReason?: string } = {}): Promise<unknown> {
    const at = new Date().toISOString();
    return this.mutate((s) => {
      const agent = s.agents?.[this.agentId];
      if (agent) {
        agent.state = state as typeof AgentStates[keyof typeof AgentStates];
        agent.updatedAt = at;
        if (state === 'WORKING' && !agent.startedAt) agent.startedAt = at;
        if (extra.currentTaskId !== undefined) agent.currentTaskId = extra.currentTaskId;
        if (extra.currentFeatureId !== undefined) agent.currentFeatureId = extra.currentFeatureId;
        if (extra.blockingReason !== undefined) agent.blockingReason = extra.blockingReason;
      }
      appendEvent({ type: Events.AGENT_STATUS_CHANGED, agentId: this.agentId, agentState: state, at });
    });
  }

  publish(kind: string, data: unknown): void {
    writeArtifact(this.runId, this.agentId, kind, data);
  }

  /** The same read as `artifact`, but absent is allowed. */
  optionalArtifact<T = unknown>(agentId: string, kind: string): T | null {
    return readArtifact<T>(this.runId, agentId, kind);
  }

  artifact<T = unknown>(agentId: string, kind: string): T {
    const value = readArtifact<T>(this.runId, agentId, kind);
    if (value === null) {
      throw new AgentExecutionError(this.agentId, `missing handoff artifact ${kind} from ${agentId}`, {
        retryable: false
      });
    }
    return value;
  }

  /** Serialized read-modify-write of the authoritative state. */
  async mutate<T>(fn: (state: LiveState) => T | Promise<T>): Promise<T> {
    const run = AgentContext.queue.then(async () => {
      const state = readState();
      const result = await fn(state);
      writeState(state);
      return result;
    });
    AgentContext.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async evidence(stage: string, text: string): Promise<void> {
    await this.mutate((s) => recordStage(s, stage as LifecycleStage, text));
  }

  /**
   * Runs a proven repository script in its own process so it keeps its exact
   * proven behaviour: its own guards, its own evidence recording, its own exit
   * code. The agent's job is to decide when and how it runs, not to reimplement
   * the cloud, verification or release logic.
   */
  runScript(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
    const script = isAbsolute(args[0]) ? args[0] : join(this.repoRoot, args[0]);
    const rest = args.slice(1);
    try {
      const stdout = execFileSync(process.execPath, ['--experimental-strip-types', script, ...rest], {
        cwd: this.repoRoot,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BUILDER_REPO_ROOT: this.repoRoot, BUILDER_AGENT_RUN_ID: this.runId, ...env }
      });
      return { stdout, stderr: '', code: 0 };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '', code: typeof err.status === 'number' ? err.status : 1 };
    }
  }

  /** Like runScript, but a non-zero exit is a failure of this agent. */
  runScriptOrThrow(args: string[], env: Record<string, string> = {}): string {
    const result = this.runScript(args, env);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-12).join('\n');
      throw new AgentExecutionError(this.agentId, `${args[0]} failed with exit ${result.code}`, {
        diagnostics: detail ? [detail] : []
      });
    }
    return result.stdout;
  }

  /** Writes a file inside the generated project, creating parent directories. */
  writeProjectFile(relative: string, contents: string): string {
    const target = join(this.projectRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    return target;
  }

  /** Reads a file from the generated project. */
  readProjectFile(relative: string): string {
    return readFileSync(join(this.projectRoot, relative), 'utf-8');
  }
}