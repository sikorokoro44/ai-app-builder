/**
 * Types for the 20-agent runtime.
 *
 * An agent is only a real agent when three things exist together: a typed
 * contract (inputs/outputs it must consume and produce), an execution function
 * that genuinely performs the work, and a validator that refuses to let the
 * coordinator treat the agent as done until the work is provably real. The
 * types below make that trio explicit so a registry entry cannot quietly ship
 * with an empty contract or a validator that always passes.
 */

export type AgentExecutionMode = 'full' | 'pre-cloud';

export interface AgentArtifactRef {
  /** Artifact kind, matching the filename used in the per-agent artifact store. */
  kind: string;
  description: string;
  /** Producing agent id, when a specific agent owns it. */
  producedBy?: string;
  optional?: boolean;
}

export interface AgentContract {
  /** Artifacts the agent consumes from upstream agents' persisted handoffs. */
  inputs: AgentArtifactRef[];
  /** Artifacts the agent must persist for downstream agents. */
  outputs: AgentArtifactRef[];
  /** Top level fields the output object must contain. */
  requiredOutputFields: string[];
  /** Paths (relative to the project root) that must exist and be non-empty. */
  requiredFiles?: string[];
}

export interface AgentFailurePolicy {
  /** Whether the same agent may simply be tried again after a failure. */
  retryable: boolean;
  maxAttempts: number;
  /** Whether a validator failure can be fed back to this agent as a repair. */
  repairable: boolean;
  maxRepairs: number;
  onExhausted: 'repair' | 'replan' | 'rollback' | 'fail';
}

export interface AgentValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

export interface AgentExecutionContext {
  runId: string;
  repoRoot: string;
  projectRoot: string;
  /** Free-form idea text, normalized by the idea intake agent. */
  idea: string;
  mode: AgentExecutionMode;
  /** Read a persisted handoff artifact from another agent. */
  artifact(agentId: string, kind: string): unknown;
  /** Persist this agent's own handoff artifact for downstream agents. */
  publish(kind: string, data: unknown): void;
  /** Serialized state mutation (single writer, no lost updates). */
  mutate<T>(fn: (state: import('./state.ts').LiveState) => T | Promise<T>): Promise<T>;
  /** Human readable activity line for the live view. */
  /** Records what the agent is doing right now; awaited by the caller. */
  activity(text: string): Promise<unknown>;
  /** Log a line to the run transcript. */
  log(text: string): void;
  /** Record a lifecycle evidence link through the proven evidence chain. */
  evidence(stage: string, text: string): Promise<void>;
  /** Run a proven repository script as a child process. */
  runScript(args: string[], env?: Record<string, string>): { stdout: string; stderr: string; code: number };
  /** Validator diagnostics from a previous failed attempt, for self-repair. */
  repairNotes: string[];
}

export interface AgentSpec<TInput = unknown, TOutput = unknown> {
  id: string;
  /** 1-based position in the fleet, matching the ids shown in the live view. */
  index: number;
  name: string;
  role: string;
  responsibility: string;
  contract: AgentContract;
  tools: string[];
  dependsOn: string[];
  /** Lifecycle stage this agent advances the project to, when it is a gate. */
  lifecycleStage?: string;
  /** Project state the run must be in before this agent starts. */
  entersState?: string;
  /** Project state to move to once this agent has produced and passed its output. */
  nextState?: string;
  /** Evidence stage this agent owns, recorded from its own validated output. */
  evidenceStage?: string;
  /** The truthful evidence line for this agent's output, or null to record nothing. */
  evidence?(output: TOutput): string | null;
  /** One short factual line for the run report. */
  describe?(output: TOutput): string | null;
  /** Agents sharing a group may not run at the same time. */
  exclusiveGroup?: string;
  /** Paths this agent owns; the scheduler keeps concurrent agents disjoint. */
  ownedPaths: string[];
  completionCriteria: string[];
  failurePolicy: AgentFailurePolicy;
  /**
   * `input` is whatever the declared inputs resolve to: when the contract names
   * one artifact, it is that artifact, and when it names several, it is a record
   * keyed by artifact kind.
   */
  execute(ctx: AgentExecutionContext, input: TInput): Promise<TOutput> | TOutput;
  validate(output: TOutput, ctx: AgentExecutionContext): AgentValidationResult | Promise<AgentValidationResult>;
}