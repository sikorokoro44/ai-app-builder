import { ProjectStates, AgentStates, TaskStates, CloudBuildStages } from './types.ts';

export interface Agent {
  id: string;
  /** Position in the fleet, so a view can list the agents in run order. */
  index?: number;
  name: string;
  state: typeof AgentStates[keyof typeof AgentStates];
  activity: string;
  currentTaskId?: string;
  currentFeatureId?: string;
  waitingReason?: string;
  blockingReason?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface Task {
  id: string;
  featureId: string;
  title: string;
  state: typeof TaskStates[keyof typeof TaskStates];
  assignedAgentId?: string;
  waitingReason?: string;
  blockingReason?: string;
  filesAffected?: string[];
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

export interface Feature {
  id: string;
  title: string;
  description: string;
  state: string;
  tasks: string[];
  paths?: string[];
  dependencies?: string[];
  buildAssetUrl?: string;
  buildAssetName?: string;
  failedReason?: string;
}

export interface TestStats {
  discovered: number;
  running: number;
  passed: number;
  failed: number;
}

export interface Repair {
  id: string;
  state: string;
  failedWhat?: string;
  failedWhy?: string;
  affectedFiles?: string[];
  affectedFeatures?: string[];
  repairingAgentId?: string;
  changes?: string[];
  passed?: boolean;
  startedAt?: string;
  completedAt?: string;
}

export interface BuildOutput {
  timestamp: string;
  stage: string;
  line: string;
}

export interface CloudBuild {
  state: string;
  stage: typeof CloudBuildStages[keyof typeof CloudBuildStages];
  status: 'idle' | 'running' | 'passed' | 'failed';
  output: BuildOutput[];
  failedReason?: string;
  startedAt?: string;
  finishedAt?: string;
  runId?: string;
  headSha?: string;
  workflowFile?: string;
  attempt?: number;
  failureClass?: string;
  retryable?: boolean;
  artifactSha256?: string;
  artifactSize?: number;
  conclusion?: string;
  logsFetched?: boolean;
  /** When the dispatch for this attempt was requested, used to correlate the run that answers it. */
  dispatchedAt?: string;
  /** Runs GitHub queued but never started, replaced by a later dispatch of the same commit. */
  supersededRunIds?: string[];
}

export interface Release {
  status: 'idle' | 'releasing' | 'created' | 'failed';
  assetUrl?: string;
  assetName?: string;
  failedReason?: string;
  repo?: string;
  tag?: string;
  releaseUrl?: string;
  assetSha256?: string;
  runId?: string;
  verifiedAt?: string;
}

export interface StageEvidence {
  stage: string;
  evidence: string;
  at: string;
  runId?: string;
}

export interface EvidenceChain {
  stages: StageEvidence[];
  publicDownloadVerified?: boolean;
  publicDownloadUrl?: string;
  finalVerifyAt?: string;
}

/**
 * Evidence that the app's launcher icon was generated from the idea and really
 * shipped inside the built APK.
 *
 * The two halves are deliberately separate. `decision`/`fingerprint` describe
 * what the generator produced, which the pre-build validation checks. The
 * remaining fields are only filled in by inspecting the compiled artifact, and
 * `status` only becomes `passed` there - a source tree that merely contains a
 * PNG proves nothing about what the APK ships.
 */
export interface IconVerificationState {
  status: 'idle' | 'generated' | 'verifying' | 'passed' | 'failed';
  /** Category the idea was mapped to, e.g. `tasks`. */
  category?: string;
  /** What that category is for, in words. */
  purpose?: string;
  /** Why this category was chosen. */
  reason?: string;
  /** Stable identity of the generated icon resource set. */
  fingerprint?: string;
  /** Project-relative resource paths that were generated. */
  files?: string[];
  /** Manifest values the generated project declares. */
  manifestIcon?: string;
  manifestRoundIcon?: string;
  /** Resource id the compiled manifest points the launcher icon at. */
  manifestIconResourceId?: string;
  manifestIconType?: string;
  /** Densities whose compiled pixels matched the generated icon. */
  matchedDensities?: string[];
  /** Compiled resource path used for the pixel comparison. */
  matchedPath?: string;
  /** Mean per-channel signature distance; 0 means identical. */
  similarity?: number;
  byteIdentical?: boolean;
  iconSignatureSha256?: string;
  /** Cloud build the verified APK came from, so stale evidence cannot pass. */
  runId?: string;
  /** SHA-256 of the APK the icon was verified inside. */
  apkSha256?: string;
  verifiedAt?: string;
  errors?: string[];
}

export interface FailureRepairView {
  state: string;
  failureDetectedAt?: string;
  rootCause?: string;
  repairTaskId?: string;
  assignedAgentId?: string;
  changes?: string[];
  passed?: boolean;
}

export interface LiveState {
  version: number;
  projectState: typeof ProjectStates[keyof typeof ProjectStates];
  overallProgressPct: number;
  startedAt?: string;
  elapsedMs: number;
  latestActivity: string;
  completedFeatures: number;
  totalFeatures: number;
  completedTasks: number;
  totalTasks: number;
  activeAgents: number;
  waitingAgents: number;
  blockedAgents: number;
  agents: Record<string, Agent>;
  tasks: Record<string, Task>;
  features: Record<string, Feature>;
  testStats: TestStats;
  repairs: Repair[];
  currentRepair?: Repair;
  githubStatus: 'unknown' | 'ok' | 'degraded' | 'error';
  cloudBuild: CloudBuild;
  apkVerification: 'idle' | 'verifying' | 'passed' | 'failed';
  apkVerificationErrors?: string[];
  apkPath?: string;
  apkSha256?: string;
  apkPackageId?: string;
  icon: IconVerificationState;
  release: Release;
  failureRepair: FailureRepairView;
  buildLogs: BuildOutput[];
  lastUpdated: string;
  finalDownloadUrl?: string;
  evidence?: EvidenceChain;
  idea?: string;
  attempt?: number;
}

export function createInitialState(): LiveState {
  return {
    version: 1,
    projectState: ProjectStates.NOT_STARTED,
    overallProgressPct: 0,
    elapsedMs: 0,
    latestActivity: 'Project initialized',
    completedFeatures: 0,
    totalFeatures: 0,
    completedTasks: 0,
    totalTasks: 0,
    activeAgents: 0,
    waitingAgents: 0,
    blockedAgents: 0,
    agents: {},
    tasks: {},
    features: {},
    testStats: { discovered: 0, running: 0, passed: 0, failed: 0 },
    repairs: [],
    githubStatus: 'unknown',
    cloudBuild: { state: 'idle', stage: CloudBuildStages.QUEUED, status: 'idle', output: [] },
    apkVerification: 'idle',
    icon: { status: 'idle' },
    release: { status: 'idle' },
    failureRepair: { state: 'idle' },
    buildLogs: [],
    evidence: { stages: [] },
    lastUpdated: new Date().toISOString()
  };
}
