import type { FailureClass } from './failureClassifier.ts';

export interface RunInfo {
  id: number;
  status: string;
  conclusion: string | null;
  workflowFile?: string;
  headSha?: string;
  event?: string;
}

export interface JobInfo {
  name: string;
  status: string;
  conclusion: string | null;
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
  const retryable: FailureClass[] = ['infrastructure_transient'];
  if (!retryable.includes(failureClass)) {
    return { retry: false, reason: `failure class ${failureClass} is deterministic; fix the cause instead of retrying`, maxAttempts };
  }
  if (attempt >= maxAttempts) {
    return { retry: false, reason: `transient failure exhausted ${maxAttempts} attempts`, maxAttempts };
  }
  return { retry: true, reason: `transient infrastructure failure; attempt ${attempt + 1} of ${maxAttempts}`, maxAttempts };
}
