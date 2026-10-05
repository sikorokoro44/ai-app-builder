import { classifyFailure, isPlatformFault, type Classification, type FailureClass } from './failureClassifier.ts';

export interface RunInfo {
  id: number;
  status: string;
  conclusion: string | null;
  workflowFile?: string;
  headSha?: string;
  event?: string;
  createdAt?: string;
}

export interface JobInfo {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  steps?: { name: string; status: string; conclusion: string | null }[];
}

export const TERMINAL_STATUSES = ['completed'];
export const RUNNING_STATUSES = ['queued', 'in_progress', 'running', 'waiting', 'requested', 'pending'];
export const SUCCESS_CONCLUSIONS = ['success', 'neutral', 'skipped'];

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes((status || '').toLowerCase());
}

export function isStillRunning(status: string): boolean {
  return RUNNING_STATUSES.includes((status || '').toLowerCase());
}

/**
 * A run only counts as successful when it is completed AND concluded success.
 * queued/in_progress/empty conclusions are never success.
 */
export function isSuccessfulRun(run: RunInfo | null | undefined): boolean {
  if (!run) return false;
  if (!isTerminal(run.status)) return false;
  return SUCCESS_CONCLUSIONS.includes((run.conclusion || '').toLowerCase());
}

export function isFailedRun(run: RunInfo | null | undefined): boolean {
  if (!run) return false;
  if (!isTerminal(run.status)) return false;
  const c = (run.conclusion || '').toLowerCase();
  return c === 'failure' || c === 'cancelled' || c === 'timed_out' || c === 'action_required' || c === 'stale';
}

/**
 * Did any step of this run ever execute?
 *
 * A job that GitHub queued and then cancelled without handing to a runner has a
 * `startedAt` stamp but no steps at all, because the stamp records when the job
 * was accepted, not when a machine began work. The steps are the only honest
 * evidence that code ran.
 */
export function jobExecutedAnyStep(job: JobInfo): boolean {
  const steps = job.steps || [];
  return steps.some((s) => s.status === 'completed' || s.status === 'in_progress' || (s.conclusion && s.conclusion !== 'skipped'));
}

/**
 * True when the run finished without a single step ever running, which is what a
 * platform that never assigns a runner looks like from the outside.
 *
 * It deliberately requires job data. With no jobs to inspect nothing is known,
 * and claiming "the platform never ran it" from a missing run alone would be a
 * guess dressed up as a finding.
 */
export function runNeverExecuted(run: RunInfo | null | undefined, jobs: JobInfo[] | null | undefined): boolean {
  if (!run || !isTerminal(run.status)) return false;
  if (isSuccessfulRun(run)) return false;
  if (!Array.isArray(jobs) || jobs.length === 0) return false;
  return jobs.every((job) => !jobExecutedAnyStep(job));
}

export interface RunOutcome extends Classification {
  /** Why the class was chosen, in words that name the evidence. */
  basis: string;
}

/**
 * Classifies why a *run* ended, not just what its logs said.
 *
 * Log-based classification cannot see the most common infrastructure failure of
 * all: a workflow the platform never started has no logs, so log scoring returns
 * "unknown" and a run of correct code gets sent to a repair agent. The shape of
 * the run settles that case first, and only then do the logs get a say.
 */
export function classifyRunOutcome(
  run: RunInfo | null | undefined,
  jobs: JobInfo[] | null | undefined,
  logs: string[]
): RunOutcome {
  if (runNeverExecuted(run, jobs)) {
    const runId = run?.id ?? '(unknown)';
    const conclusion = run?.conclusion || 'unknown';
    return {
      klass: 'infrastructure_not_started',
      confidence: 1,
      matched: [
        `run ${runId} concluded ${conclusion} with ${jobs?.length} job(s) and no step of any job ever executed`,
        'no build step ran, so no source, dependency or workflow content in this repository produced this outcome'
      ],
      basis: `no step of run ${runId} ever ran (conclusion=${conclusion})`
    };
  }
  const fromLogs = classifyFailure(logs || []);
  return {
    ...fromLogs,
    basis: fromLogs.matched.length
      ? `log evidence: ${fromLogs.matched[0]}`
      : isPlatformFault(fromLogs.klass)
        ? 'platform fault'
        : 'no log evidence and no platform fault found'
  };
}

export function describeRunStatus(run: RunInfo | null | undefined): string {
  if (!run) return 'no run';
  if (!isTerminal(run.status)) return `not finished (status=${run.status})`;
  return `conclusion=${run.conclusion}`;
}

export interface JobFailureSummary {
  failedJob?: string;
  failedStep?: string;
  logLines: string[];
}

/**
 * Extracts the failing job/step and the tail of the actionable log lines so a
 * repair pass has something concrete to work from.
 */
export function summarizeFailure(jobs: JobInfo[], logs: string[], maxLines = 80): JobFailureSummary {
  const failedJob = jobs.find((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out');
  const failedStep = failedJob?.steps?.find((s) => s.conclusion === 'failure' || s.conclusion === 'timed_out');
  const actionable = logs
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trimEnd())
    .filter((l) => l.trim().length > 0)
    .filter((l) => isActionableLine(l));
  return {
    failedJob: failedJob?.name,
    failedStep: failedStep?.name,
    logLines: actionable.slice(-maxLines)
  };
}

const ACTIONABLE = /(error|failed|failure|exception|caused by|cannot|could not|unable|warning: |denied|not found|unresolved|no such|conflict|fatal|\bE\/|FAILURE:)/i;

export function isActionableLine(line: string): boolean {
  return ACTIONABLE.test(line);
}

export interface RetryDecision {
  retry: boolean;
  reason: string;
  maxAttempts: number;
}

export function decideRetry(failureClass: FailureClass, attempt: number, maxAttempts = 3): RetryDecision {
  const retryable: FailureClass[] = ['infrastructure_transient', 'infrastructure_not_started'];
  if (!retryable.includes(failureClass)) {
    return { retry: false, reason: `failure class ${failureClass} is deterministic; fix the cause instead of retrying`, maxAttempts };
  }
  if (attempt >= maxAttempts) {
    return {
      retry: false,
      reason: `transient failure exhausted ${maxAttempts} attempts${isPlatformFault(failureClass) ? '; the platform never started the workflow' : ''}`,
      maxAttempts
    };
  }
  return { retry: true, reason: `transient infrastructure failure; attempt ${attempt + 1} of ${maxAttempts}`, maxAttempts };
}

export interface AdoptionDecision<T> {
  /** The run to watch: either a build that is already under way, or nothing. */
  adopt: T | null;
  /** Queued runs old enough to have been abandoned by the platform. */
  abandon: number[];
}

export interface AdoptionOptions<T> {
  /** Current time in epoch milliseconds. */
  now: number;
  /** A queued run older than this that never started is treated as abandoned. */
  staleQueuedMs: number;
  /** Whether a given run has already begun executing any step. */
  hasStarted: (run: T) => boolean;
}

/**
 * Decides whether to adopt an unfinished run for this commit or dispatch a new one.
 *
 * Two different situations look alike from the outside: a build that is genuinely
 * running, and a run GitHub queued during an outage and will never start. Adopting
 * the second one means watching a run that cannot finish until its own timeout, so
 * an old run that nothing has started is abandoned and re-dispatched instead. A run
 * that has started is always adopted, however old, because building it twice would
 * be worse than waiting.
 */
export function chooseRunToAdopt<T extends { databaseId: number; status: string; createdAt?: string }>(
  runs: T[],
  opts: AdoptionOptions<T>
): AdoptionDecision<T> {
  const inFlight = runs.filter((r) => isStillRunning(r.status));
  const abandon: number[] = [];
  for (const candidate of inFlight) {
    const createdAt = Date.parse(candidate.createdAt || '');
    const age = Number.isNaN(createdAt) ? 0 : opts.now - createdAt;
    if (age <= opts.staleQueuedMs || opts.hasStarted(candidate)) {
      return { adopt: candidate, abandon };
    }
    abandon.push(candidate.databaseId);
  }
  return { adopt: null, abandon };
}

/**
 * How long to wait before dispatching the next attempt.
 *
 * Retrying immediately against a platform that is refusing to start workflows
 * only produces more queued runs that never start. The wait grows with the
 * attempt number and is capped so a run still finishes inside its budget.
 */
export function retryBackoffMs(attempt: number, baseMs = 60_000, capMs = 8 * 60_000): number {
  if (attempt <= 1) return 0;
  return Math.min(capMs, baseMs * 2 ** (attempt - 2));
}
