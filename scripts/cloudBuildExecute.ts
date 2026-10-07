#!/usr/bin/env node
/**
 * Drives the authoritative Android build in GitHub Actions.
 *
 * Three modes, all of which talk to the real GitHub API through `gh`:
 *   --prepare   validate the generated project before anything is dispatched
 *   --dispatch  trigger workflow_dispatch once and resolve the resulting run id
 *   --watch     poll a run to a terminal conclusion and record the outcome
 *
 * The build is never trusted because a command merely ran: the run must be
 * terminal, must have concluded successfully, and must belong to the commit this
 * workspace is on. A stale successful run from an earlier commit cannot be
 * reported as this build's success, and a queued or in-progress run is never
 * treated as one.
 */
import { execFileSync } from 'child_process';
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { persistCheckpoint } from './live/checkpointStore.ts';
import { isTransientFailure, isPlatformFault, REPAIR_PLAYBOOK } from './live/failureClassifier.ts';
import {
  summarizeFailure,
  decideRetry,
  isSuccessfulRun,
  isTerminal,
  isStillRunning,
  retryBackoffMs,
  classifyRunOutcome,
  chooseRunToAdopt,
  type RunInfo,
  type JobInfo
} from './live/workflowWatcher.ts';
import { recordStage, missingStages } from './live/evidenceChain.ts';
import { validateGeneratedProject } from './live/projectValidator.ts';
import { checkIntentFit } from './live/intentFit.ts';
import { assertRepoSafety, assertNoSecretsInFiles } from './live/repoGuard.ts';
import { ProjectStates, Events } from '../shared/types.ts';

const WORKFLOW = process.env.BUILDER_WORKFLOW || '.github/workflows/builder-android-build.yml';
const MAX_ATTEMPTS = Number(process.env.BUILDER_MAX_ATTEMPTS || '3');
const POLL_INTERVAL_MS = Number(process.env.BUILDER_POLL_INTERVAL_MS || '15000');
const POLL_TIMEOUT_MS = Number(process.env.BUILDER_POLL_TIMEOUT_MS || String(45 * 60 * 1000));
const RETRY_BACKOFF_MS = Number(process.env.BUILDER_RETRY_BACKOFF_MS || String(60 * 1000));
/**
 * How long a run may sit queued before it is treated as abandoned by the
 * platform rather than adopted. A queued run that nothing has started yet and
 * that is older than this will not start on its own; re-dispatching is the only
 * way the build gets built.
 */
const STALE_QUEUED_MS = Number(process.env.BUILDER_STALE_QUEUED_MS || String(20 * 60 * 1000));
/** Tolerance for clock skew between this machine and GitHub when correlating runs. */
const CLOCK_SKEW_MS = 30 * 1000;
const IDEA = process.env.BUILDER_IDEA || '';

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function ghJson<T>(args: string[]): T {
  const raw = gh(args);
  return JSON.parse(raw) as T;
}

/** Current HEAD of the workspace, used to bind a run to this exact code. */
function headSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function sleep(ms: number): void {
  execFileSync('sleep', [String(Math.max(0, Math.floor(ms / 1000)))]);
}

interface RemoteRun {
  databaseId: number;
  status: string;
  conclusion: string | null;
  headSha: string;
  workflowName?: string;
  createdAt?: string;
  url?: string;
}

initStateStore();
const s = readState();

if (process.argv.includes('--prepare')) {
  const guard = assertRepoSafety(process.cwd());
  if (!guard.ok) {
    fail(`Repository safety check failed:\n - ${guard.errors.join('\n - ')}`);
  }
  const secretProblems = assertNoSecretsInFiles(process.cwd(), ['scripts', 'shared', '.github']);
  if (secretProblems.length > 0) {
    fail(`Refusing to build: possible secrets in tracked files\n - ${secretProblems.join('\n - ')}`);
  }
  const projectDir = process.env.BUILDER_PROJECT_DIR || '.builder/generated/android';
  const validation = validateGeneratedProject(projectDir, IDEA);
  if (!validation.valid) {
    s.latestActivity = 'Generated project failed pre-build validation';
    s.failureRepair = { state: 'FAILURE_DETECTED', rootCause: validation.errors.join('; ') };
    s.projectState = ProjectStates.REPAIRING;
    appendEvent({ type: Events.BUILD_FAILED, stage: 'VALIDATE', errors: validation.errors });
    writeState(s);
    fail(`Refusing to build an invalid generated project:\n - ${validation.errors.join('; ')}`);
  }
  recordStage(s, 'VALIDATE', `project validated, packageId=${validation.packageId}`);

  /*
   * The structural check above proves the project is well-formed; this check
   * proves it is the app the idea asked for. Both must pass before anything is
   * dispatched, because a well-formed build of the wrong app is still the wrong
   * app.
   */
  const intentFit = checkIntentFit(projectDir, IDEA);
  if (!intentFit.ok) {
    const fitErrors = intentFit.errors.map((e) => ` - ${e}`);
    s.latestActivity = 'Generated project does not fit the requested idea';
    s.failureRepair = { state: 'FAILURE_DETECTED', rootCause: intentFit.errors.join('; ') };
    s.projectState = ProjectStates.REPAIRING;
    appendEvent({ type: Events.BUILD_FAILED, stage: 'VALIDATE', errors: intentFit.errors });
    writeState(s);
    fail(`Refusing to build a generated project that does not fit "${IDEA}":\n${fitErrors.join('\n')}`);
  }

  /*
   * Record what the generator decided for the launcher icon before anything is
   * built. The compiled check in apkVerify.ts then has an expectation to compare
   * against, and the completion chain can show how the icon was chosen.
   */
  if (!validation.launcherIcon?.valid) {
    const iconErrors = validation.launcherIcon?.errors || ['launcher icon was not validated'];
    s.latestActivity = 'Generated project has no valid launcher icon';
    s.failureRepair = { state: 'FAILURE_DETECTED', rootCause: iconErrors.join('; ') };
    s.projectState = ProjectStates.REPAIRING;
    s.icon = { ...(s.icon || { status: 'idle' }), status: 'failed', errors: iconErrors };
    appendEvent({ type: Events.BUILD_FAILED, stage: 'VALIDATE', errors: iconErrors });
    writeState(s);
    fail(`Refusing to build a project without a real launcher icon:\n - ${iconErrors.join('\n - ')}`);
  }
  s.icon = {
    ...(s.icon || { status: 'idle' }),
    status: 'generated',
    category: validation.launcherIcon.category,
    fingerprint: validation.launcherIcon.fingerprint,
    manifestIcon: validation.launcherIcon.manifestIcon,
    manifestRoundIcon: validation.launcherIcon.manifestRoundIcon,
    errors: undefined
  };

  const buildHead = headSha();
  // A run id belongs to exactly one commit. Carrying the previous attempt's id
  // across a new head lets a later step attribute this commit's artifact to an
  // older run, or re-watch a run that was never built from this tree, so drop
  // it whenever the pinned commit changes.
  if (s.cloudBuild.headSha !== buildHead) s.cloudBuild.runId = undefined;
  s.cloudBuild.stage = 'QUEUED';
  s.cloudBuild.status = 'running';
  s.cloudBuild.state = 'running';
  s.cloudBuild.attempt = (s.cloudBuild.attempt || 0) + 1;
  s.cloudBuild.workflowFile = WORKFLOW;
  s.cloudBuild.headSha = buildHead;
  s.projectState = ProjectStates.CLOUD_BUILDING;
  s.latestActivity = 'Prepared cloud build';
  persistCheckpoint('pre-cloud-build', s);
  writeState(s);
  appendEvent({
    type: Events.BUILD_STARTED,
    stage: 'QUEUED',
    runId: s.cloudBuild.runId,
    headSha: s.cloudBuild.headSha
  });
  console.log(JSON.stringify({
    ok: true,
    prepared: true,
    packageId: validation.packageId,
    workflow: WORKFLOW,
    headSha: s.cloudBuild.headSha,
    attempt: s.cloudBuild.attempt
  }, null, 2));
  process.exit(0);
}

if (process.argv.includes('--dispatch')) {
  const sha = headSha();
  const expected = s.cloudBuild.headSha || sha;
  if (expected !== sha) {
    fail(`Refusing to dispatch: recorded head ${expected} does not match workspace HEAD ${sha}. Re-run --prepare.`);
  }

  // Duplicate prevention: an unfinished run for this same commit is adopted
  // rather than starting a second identical build.
  const existing = ghJson<RemoteRun[]>([
    'run', 'list', '--workflow', WORKFLOW, '--commit', sha, '--limit', '10', '--json', 'databaseId,status,conclusion,headSha,createdAt'
  ]);

  const abandoned: number[] = [];
  const decision = chooseRunToAdopt(existing, {
    now: Date.now(),
    staleQueuedMs: STALE_QUEUED_MS,
    hasStarted: (candidate) => {
      // Ask GitHub whether anything actually started, because a queued-and-old run
      // that already began building must be adopted rather than duplicated. An
      // unanswered question is treated as "started" for the same reason.
      try {
        const jobs = ghJson<{ jobs: JobInfo[] }>(['run', 'view', String(candidate.databaseId), '--json', 'jobs']).jobs;
        return jobs.some((j) => (j.steps || []).length > 0 || (j.startedAt && j.status !== 'queued'));
      } catch {
        return true;
      }
    }
  });
  abandoned.push(...decision.abandon);

  if (decision.adopt) {
    s.cloudBuild.runId = String(decision.adopt.databaseId);
    writeState(s);
    console.log(JSON.stringify({
      ok: true,
      dispatched: false,
      adopted: true,
      runId: String(decision.adopt.databaseId),
      status: decision.adopt.status,
      supersededRunIds: abandoned
    }, null, 2));
    process.exit(0);
  }

  if (abandoned.length) {
    s.cloudBuild.supersededRunIds = [...new Set([...(s.cloudBuild.supersededRunIds || []), ...abandoned])].map(String);
    appendEvent({ type: Events.BUILD_FAILED, stage: 'QUEUED', abandonedRunIds: abandoned, reason: 'queued too long with no step executed' });
  }

  // Back off before re-dispatching after a platform fault. Firing again into a
  // platform that is refusing to start workflows only produces more runs that
  // never start.
  const attempt = s.cloudBuild.attempt || 1;
  const backoff = retryBackoffMs(attempt, RETRY_BACKOFF_MS);
  if (backoff > 0) {
    const why = s.cloudBuild.failureClass || 'an earlier attempt';
    s.latestActivity = `Waiting ${Math.round(backoff / 1000)}s before re-dispatching after ${why}`;
    writeState(s);
    sleep(backoff);
  }

  const ghArgs = ['workflow', 'run', WORKFLOW];
  if (IDEA) ghArgs.push('-f', `idea=${IDEA}`);
  if (process.env.BUILDER_HEAD_SHA) ghArgs.push('-f', `head_sha=${process.env.BUILDER_HEAD_SHA}`);
  // Stamp the moment the dispatch is requested. Without it the poll below can
  // adopt an older run for the same commit — the previous attempt's run — and
  // attribute its conclusion to this attempt.
  const dispatchedAt = new Date().toISOString();
  s.cloudBuild.dispatchedAt = dispatchedAt;
  writeState(s);

  // A refused dispatch says why on stderr and nothing else, so the reason is
  // written out here rather than left buried in a thrown error object. The
  // usual cause is the token: this job dispatches with its own GITHUB_TOKEN,
  // and a repository whose default workflow permission is `read` refuses with
  // HTTP 403 "Resource not accessible by integration" unless the job asks for
  // `actions: write`.
  try {
    gh(ghArgs);
  } catch (e: any) {
    const detail = (e.stderr?.toString() || e.stderr || e.message || '').toString().trim();
    const refused = /403|not accessible by integration/i.test(detail);
    fail(
      `Could not dispatch ${WORKFLOW} for commit ${sha}: ${detail || 'gh reported no reason'}` +
      (refused ? '\nThis job needs `actions: write` in its permissions to dispatch a workflow with its own token.' : '')
    );
  }

  const floor = Date.parse(dispatchedAt) - CLOCK_SKEW_MS;
  // workflow_dispatch returns before the run appears, so poll for the run that
  // this dispatch created rather than guessing an id or reusing the last one.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let found: RemoteRun | undefined;
  while (Date.now() < deadline) {
    const runs = ghJson<RemoteRun[]>([
      'run', 'list', '--workflow', WORKFLOW, '--commit', sha, '--limit', '10', '--json', 'databaseId,status,conclusion,headSha,createdAt'
    ]);
    found = runs
      .filter((r) => {
        const created = Date.parse(r.createdAt || '');
        return !Number.isNaN(created) && created >= floor;
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
    if (found) break;
    sleep(POLL_INTERVAL_MS);
  }
  if (!found) {
    fail(
      `Dispatched ${WORKFLOW} but no run created after ${dispatchedAt} appeared for commit ${sha} ` +
      `within ${Math.round(POLL_TIMEOUT_MS / 60000)} minutes`
    );
  }

  s.cloudBuild.runId = String(found.databaseId);
  s.cloudBuild.headSha = sha;
  s.cloudBuild.status = 'running';
  s.latestActivity = `Dispatched cloud build run ${found.databaseId}`;
  persistCheckpoint(`dispatched-${found.databaseId}`, s);
  writeState(s);
  console.log(JSON.stringify({
    ok: true,
    dispatched: true,
    runId: String(found.databaseId),
    headSha: sha,
    status: found.status,
    supersededRunIds: abandoned
  }, null, 2));
  process.exit(0);
}

const watching = process.argv.includes('--watch');
const runId = process.env.BUILDER_RUN_ID || s.cloudBuild.runId;

// Offline mode exists so the decision logic can be exercised without a network,
// and it must be requested explicitly and completely. Both fields are required:
// a status without a conclusion, or a run id without either, is not an answer,
// and guessing produced a fabricated result for a real run.
const injectedStatus = process.env.BUILDER_RUN_STATUS;
const injectedConclusion = process.env.BUILDER_RUN_CONCLUSION;
const injected = injectedStatus !== undefined && injectedConclusion !== undefined;

if (!runId && !injected && !watching) {
  fail('No cloud build run id recorded; refusing to report a build result');
}

let run: RunInfo;
let jobs: JobInfo[] = [];
let remote: RemoteRun | undefined;

if (!injected) {
  if (!runId) fail('Nothing to watch: no run id recorded and none supplied');
  remote = ghJson<RemoteRun>([
    'run', 'view', String(runId), '--json', 'databaseId,status,conclusion,headSha,url'
  ]);

  // Poll while the run is still open. A run id handed in through the
  // environment is watched exactly like one discovered from state.
  if (watching && !isTerminal(remote.status)) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      if (isTerminal(remote.status)) break;
      if (Date.now() >= deadline) {
        console.log(JSON.stringify({
          ok: false, terminal: false, runId, status: remote.status,
          note: `still ${remote.status} after ${Math.round(POLL_TIMEOUT_MS / 60000)} minutes; not claiming success`
        }, null, 2));
        process.exit(3);
      }
      s.cloudBuild.status = 'running';
      s.cloudBuild.stage = 'COMPILING';
      s.cloudBuild.runId = runId;
      s.projectState = ProjectStates.CLOUD_BUILDING;
      s.latestActivity = `Cloud build ${remote.status} (not finished; not success)`;
      writeState(s);
      sleep(POLL_INTERVAL_MS);
      remote = ghJson<RemoteRun>([
        'run', 'view', String(runId), '--json', 'databaseId,status,conclusion,headSha,url'
      ]);
    }
  }

  try {
    jobs = ghJson<JobInfo[]>(['run', 'view', String(runId), '--json', 'jobs']).jobs;
  } catch { /* jobs are a diagnostic aid, not a gate */ }
}

run = {
  id: Number(runId),
  status: injected ? injectedStatus! : remote!.status,
  conclusion: injected ? injectedConclusion! : remote!.conclusion,
  workflowFile: WORKFLOW
};

// A run belongs to one commit. Accepting a successful run for a different commit
// would let an old green build stand in for the code actually on disk.
const remoteHead = remote?.headSha;
if (remoteHead) {
  if (!s.cloudBuild.headSha) {
    // The remote was consulted, so this run really is a GitHub run, and the
    // workspace has no recorded commit to compare it against. Correlation is
    // impossible rather than merely unproven, so the run is not accepted. This
    // also means a hand-supplied run id can no longer skip the check.
    fail(
      `Refusing result for run ${runId}: it ran commit ${remoteHead} but no commit was recorded ` +
      `for this build. Re-run --prepare and --dispatch for the current commit.`
    );
  }
  if (remoteHead !== s.cloudBuild.headSha) {
    fail(
      `Refusing result for run ${runId}: it ran commit ${remoteHead} but this workspace is at ` +
      `${s.cloudBuild.headSha}. Re-run --prepare and --dispatch for the current commit.`
    );
  }
}

let logs: string[] = (process.env.BUILDER_RUN_LOGS || '')
  .split('\n')
  .map((l) => l.trimEnd())
  .filter(Boolean);

if (!isSuccessfulRun(run) && isTerminal(run.status) && logs.length === 0 && process.env.BUILDER_RUN_LOGS === undefined) {
  try {
    const raw = gh(['run', 'view', String(runId), '--log-failed']);
    logs = raw.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  } catch { /* fall through to the actionable-logs warning below */ }
}

if (!isTerminal(run.status)) {
  s.cloudBuild.status = 'running';
  s.cloudBuild.stage = 'COMPILING';
  s.cloudBuild.runId = runId;
  s.projectState = ProjectStates.CLOUD_BUILDING;
  s.latestActivity = `Cloud build ${run.status} (not finished; not success)`;
  persistCheckpoint(`running-${runId}`, s);
  writeState(s);
  console.log(JSON.stringify({ ok: false, terminal: false, status: run.status, note: 'queued/running is never success' }, null, 2));
  process.exit(3);
}

if (logs.length === 0 && !isSuccessfulRun(run)) {
  console.error('No run logs captured; a failure without logs is not actionable');
}

s.cloudBuild.runId = runId;
s.cloudBuild.workflowFile = WORKFLOW;
s.cloudBuild.logsFetched = logs.length > 0;

if (!isSuccessfulRun(run)) {
  const classification = classifyRunOutcome(run, jobs, logs);
  const summary = summarizeFailure(jobs, logs);
  const attempt = s.cloudBuild.attempt || 1;
  const decision = decideRetry(classification.klass, attempt, MAX_ATTEMPTS);
  const platformFault = isPlatformFault(classification.klass);

  s.cloudBuild.status = 'failed';
  s.cloudBuild.conclusion = run.conclusion || 'failure';
  s.cloudBuild.state = run.conclusion === 'cancelled' ? 'cancelled' : (run.conclusion === 'skipped' ? 'cancelled' : 'failed');
  s.cloudBuild.failureClass = classification.klass;
  s.cloudBuild.failedReason = `${classification.klass}: ${summary.failedStep || summary.failedJob || 'no step ran'} — ${classification.matched[0] || 'no diagnostic captured'}`.slice(0, 800);
  s.cloudBuild.retryable = decision.retry;
  s.cloudBuild.finishedAt = new Date().toISOString();
  s.buildLogs = logs.slice(-200);

  if (platformFault) {
    /*
     * Nothing in this repository ran, so nothing in it is broken. The state stays
     * where it truthfully is — a build is outstanding and has not finished — and
     * the repair machinery is left alone: a repair agent asked to fix a build
     * that never started would edit correct code until the run timed out.
     */
    s.projectState = ProjectStates.CLOUD_BUILDING;
    s.failureRepair = { state: 'idle' };
    s.latestActivity = `Cloud build run ${runId} never started (${classification.basis}); not a code failure`;
  } else {
    s.projectState = ProjectStates.REPAIRING;
    s.failureRepair = {
      state: 'FAILURE_DETECTED',
      failureDetectedAt: new Date().toISOString(),
      rootCause: classification.klass,
      changes: REPAIR_PLAYBOOK[classification.klass]
    };
    s.latestActivity = `Cloud build failed (${classification.klass})`;
  }
  persistCheckpoint(`failed-${runId}`, s);
  appendEvent({
    type: Events.BUILD_FAILED,
    runId,
    failureClass: classification.klass,
    retry: decision.retry,
    failedStep: summary.failedStep,
    basis: classification.basis
  });
  writeState(s);

  console.error(JSON.stringify({
    ok: false,
    terminal: true,
    runId,
    conclusion: run.conclusion,
    failureClass: classification.klass,
    basis: classification.basis,
    platformFault,
    transient: isTransientFailure(classification.klass),
    retry: decision,
    retryInMs: decision.retry ? retryBackoffMs(attempt, RETRY_BACKOFF_MS) : 0,
    failedStep: summary.failedStep,
    actionableLines: summary.logLines.slice(-15),
    playbook: REPAIR_PLAYBOOK[classification.klass]
  }, null, 2));
  process.exit(decision.retry ? 75 : 1);
}

s.cloudBuild.status = 'passed';
s.cloudBuild.conclusion = run.conclusion;
s.cloudBuild.state = 'succeeded';
s.cloudBuild.finishedAt = new Date().toISOString();
s.cloudBuild.failedReason = undefined;
s.cloudBuild.buildLogs = logs.slice(-200);
s.projectState = ProjectStates.VERIFYING;
s.latestActivity = `Cloud build succeeded (run ${runId})`;
recordStage(s, 'CLOUD_BUILD', `run ${runId} completed successfully`, runId);
recordStage(s, 'BUILD_SUCCESS', `run ${runId} conclusion=${run.conclusion}`, runId);
persistCheckpoint(`passed-${runId}`, s);
appendEvent({
  type: Events.BUILD_PASSED,
  runId,
  conclusion: run.conclusion,
  headSha: s.cloudBuild.headSha,
  sha256: s.cloudBuild.artifactSha256
});
writeState(s);

console.log(JSON.stringify({
  ok: true,
  terminal: true,
  runId,
  conclusion: run.conclusion,
  headSha: s.cloudBuild.headSha,
  nextStages: missingStages(s)
}, null, 2));
