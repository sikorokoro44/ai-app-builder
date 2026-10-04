/**
 * Backwards-compatible surface for callers that used the old verifier module.
 * The real implementation now lives in failureClassifier.ts + workflowWatcher.ts.
 */
export { classifyFailure, isTransientFailure, FAILURE_CLASSES, REPAIR_PLAYBOOK } from './failureClassifier.ts';
export type { FailureClass } from './failureClassifier.ts';
export {
  isTerminal,
  isStillRunning,
  isSuccessfulRun,
  isFailedRun,
  describeRunStatus,
  summarizeFailure,
  decideRetry
} from './workflowWatcher.ts';
export type { RunInfo, JobInfo, RetryDecision } from './workflowWatcher.ts';
