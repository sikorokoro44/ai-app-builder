/**
 * The agent system, in one import.
 *
 * Everything the fleet is made of and everything a caller can ask of it: the
 * twenty specs, the registry that checks them, the planner that derives work from
 * an idea, the coordinator that schedules it, and the recovery helpers that pick
 * a stopped run back up.
 */

export { AGENT_IDS, AGENT_ID_NAMES, agentIndex } from './agentIds.ts';
export {
  AGENTS,
  agentById,
  agentIds,
  anyPathConflict,
  dependencyClosure,
  executionWaves,
  pathsConflict,
  validateRegistry
} from './registry.ts';
export { EXCLUSIVE_GROUPS, OWNED_PATHS, ownsFile, ownedPathsOf, writesProject } from './ownership.ts';
export { assemblePlan, deriveSections, PlanAssemblyError, planForIdea } from './planner.ts';
export { runCoordinator, newRunId, pathBetween, type CoordinatorOptions, type CoordinatorReport } from './coordinator.ts';
export {
  inspectRun,
  invalidateFromStage,
  listRuns,
  nextStage,
  restartRun,
  resumeRun,
  stageProven,
  type RunInspection,
  type RunSummary
} from './recovery.ts';
export {
  AGENT_ROOT,
  artifactPath,
  currentRunId,
  isAgentComplete,
  readArtifact,
  readLedger,
  readManifest,
  runDir,
  startRun
} from './artifacts.ts';
export { AgentContext, AgentExecutionError } from './context.ts';
export type {
  AgentContract,
  AgentExecutionContext,
  AgentFailurePolicy,
  AgentSpec,
  AgentValidationResult
} from '../../shared/agentTypes.ts';
