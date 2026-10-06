import { createInitialState } from '../../shared/state.ts';
import type { LiveState, EvidenceChain, StageEvidence } from '../../shared/state.ts';
import { Events } from '../../shared/types.ts';
import { assertValidTransition } from './stateValidator.ts';
import { LifecycleStages, type LifecycleStage } from './evidenceChain.ts';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, fsyncSync,
  closeSync, appendFileSync, readdirSync, rmSync, statSync
} from 'fs';
import { basename, join, resolve } from 'path';
import { tmpdir } from 'os';
import { createHash, randomBytes } from 'crypto';

export const STATE_DIR = process.env.BUILDER_STATE_DIR || '.builder/live';
const STATE_FILE = join(STATE_DIR, 'state.json');
const STATE_BAK = join(STATE_DIR, 'state.json.bak');
const EVENTS_FILE = join(STATE_DIR, 'events.jsonl');

/** Long enough for a Gradle-backed lifecycle script, short enough to notice a hang. */
const LOCK_TIMEOUT_MS = Number(process.env.BUILDER_LOCK_TIMEOUT_MS || 15 * 60 * 1000);

export function initStateStore() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) {
    atomicWrite(STATE_FILE, JSON.stringify(createInitialState(), null, 2));
  }
  if (!existsSync(EVENTS_FILE)) {
    writeFileSync(EVENTS_FILE, '');
  }
}

/**
 * Serialises every writer of the live state, in this process and in any script
 * it spawns.
 *
 * The state is one file, and it is written from several directions at once:
 * lifecycle scripts run as their own processes, and agents run concurrently
 * with each other. A read-modify-write is therefore not atomic across those
 * writers, and the last one to write wins with whatever it read. That is how
 * run 37391565852 published a run whose evidence chain had every stage except
 * IMPLEMENT: `failure-diagnostician` depends only on `quality-auditor`, so it
 * ran alongside `repo-publisher`, read the state, awaited a project validation
 * for over a second, and wrote back a snapshot taken before `githubPush.ts`
 * recorded the push. The link was not wrong, it was overwritten.
 *
 * Holding an exclusive file for the whole read-modify-write is what makes the
 * snapshot and the write belong together. Scripts that write the state from
 * another process are covered too, because the caller holds the lock for the
 * duration of the child it spawned.
 */
let lockHeld = false;

function sleepSync(ms: number): void {
  // A synchronous wait, because the lock is held across synchronous work: an
  // agent's script runs to completion while this process waits for it.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withStateLock<T>(fn: () => T): T {
  // Re-entrant within one process: a caller already holding the lock owns the
  // state until it returns, so waiting on itself would deadlock.
  if (lockHeld) return fn();

  mkdirSync(STATE_DIR, { recursive: true });
  // Outside the state directory on purpose: `.builder/live` is tracked so a run
  // can be resumed, and `githubPush` stages it with `git add -A` while it holds
  // this very lock, so a lock kept in there would be committed and published.
  const lockPath = join(tmpdir(), `builder-state-${createHash('sha1').update(resolve(STATE_DIR)).digest('hex').slice(0, 12)}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | undefined;

  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      // A lock left behind by a killed process would otherwise block the run
      // forever, so one older than any writer could have held is broken.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_TIMEOUT_MS) rmSync(lockPath, { force: true });
      } catch { /* another writer released it first */ }
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${LOCK_TIMEOUT_MS}ms waiting for the live state lock at ${lockPath}`);
      }
      sleepSync(20);
    }
  }

  lockHeld = true;
  try {
    return fn();
  } finally {
    lockHeld = false;
    try { closeSync(fd as number); } catch { /* already closed */ }
    try { rmSync(lockPath, { force: true }); } catch { }
  }
}

/**
 * Writes a file atomically and durably.
 *
 * Order matters: the data must be written first, then fsync'd, then renamed over
 * the target, then the containing directory fsync'd so the rename itself is
 * durable. Fsyncing an empty file before writing (as an earlier version did)
 * proves nothing and can lose the write entirely on a hard kill.
 *
 * The temp file lives in the target's own directory, not the system temp dir, so
 * the rename cannot cross a filesystem boundary and silently degrade into a
 * non-atomic copy.
 */
export function atomicWrite(file: string, data: string) {
  const dir = file.slice(0, Math.max(file.lastIndexOf('/'), 0)) || '.';
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'w');
    writeFileSync(fd, data);
    try { fsyncSync(fd); } catch { /* best effort on filesystems without fsync */ }
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { } }
    try { rmSync(tmp, { force: true }); } catch { }
    throw e;
  }
  syncDir(dir);
}

let dirSyncSupported: boolean | undefined;
/**
 * fsync of a directory is what makes a rename survive a power loss, but some
 * filesystems (and some Android/Termux kernels) reject it. Probed once so the
 * cost is not paid per write, and treated as best effort everywhere.
 */
function syncDir(dir: string): void {
  if (dirSyncSupported === false) return;
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
    dirSyncSupported = true;
  } catch {
    dirSyncSupported = false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { } }
  }
}

function parseState(raw: string): LiveState | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.projectState !== 'string') return null;
    return parsed as LiveState;
  } catch {
    return null;
  }
}

export function readState(): LiveState {
  if (!existsSync(STATE_FILE)) {
    return writeState(createInitialState(), { allowUncheckedTransition: true, reason: 'initialising the state store' });
  }
  let parsed: LiveState | null = null;
  try {
    parsed = parseState(readFileSync(STATE_FILE, 'utf-8'));
  } catch { }
  if (!parsed && existsSync(STATE_BAK)) {
    try {
      parsed = parseState(readFileSync(STATE_BAK, 'utf-8'));
    } catch { }
  }
  if (!parsed) {
    const recovered = recoverFromEventLog();
    if (recovered) {
      writeState(recovered, { allowUncheckedTransition: true, reason: 'rebuilding state from the event log' });
      return recovered;
    }
    const s = createInitialState();
    writeState(s, { allowUncheckedTransition: true, reason: 'resetting an unrecoverable state file' });
    return s;
  }
  return normalizeState(parsed);
}

/**
 * Rebuilds a usable state from the append-only event log when state.json is
 * missing or corrupt, so an interrupted write degrades instead of resetting.
 */
function recoverFromEventLog(): LiveState | null {
  if (!existsSync(EVENTS_FILE)) return null;
  let events: any[] = [];
  try {
    events = readFileSync(EVENTS_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return null; }
  if (events.length === 0) return null;
  const s = createInitialState();
  const evidenceStages = new Map<LifecycleStage, StageEvidence>();
  let sawProgress = false;

  // Events are replayed in order so the last writer of each field wins, exactly
  // as it would have with state.json intact.
  for (const e of events) {
    if (e.type === Events.PROJECT_STATUS_CHANGED && typeof e.projectState === 'string') {
      s.projectState = e.projectState as any;
      s.latestActivity = e.activity || s.latestActivity;
      sawProgress = true;
    }
    if (e.type === Events.BUILD_STARTED) {
      s.cloudBuild.status = 'running';
      s.cloudBuild.startedAt = e.ts || s.cloudBuild.startedAt;
      if (typeof e.runId === 'string') s.cloudBuild.runId = e.runId;
      if (typeof e.headSha === 'string') s.cloudBuild.headSha = e.headSha;
      sawProgress = true;
    }
    if (e.type === Events.BUILD_STAGE_CHANGED && typeof e.stage === 'string') {
      s.cloudBuild.currentStage = e.stage;
      if (typeof e.runId === 'string') s.cloudBuild.runId = e.runId;
      sawProgress = true;
    }
    if (e.type === Events.BUILD_PASSED) {
      s.cloudBuild.status = 'passed';
      if (typeof e.runId === 'string') s.cloudBuild.runId = e.runId;
      if (typeof e.headSha === 'string') s.cloudBuild.headSha = e.headSha;
      if (typeof e.sha256 === 'string') s.cloudBuild.artifactSha256 = e.sha256;
      sawProgress = true;
    }
    if (e.type === Events.BUILD_FAILED) { s.cloudBuild.status = 'failed'; sawProgress = true; }
    if (e.type === Events.ARTIFACT_CREATED) {
      if (typeof e.path === 'string') s.apkPath = e.path;
      if (typeof e.sha256 === 'string') s.apkSha256 = e.sha256;
      if (typeof e.packageId === 'string') s.apkPackageId = e.packageId;
      sawProgress = true;
    }
    if (e.type === Events.ARTIFACT_VERIFIED) {
      s.apkVerification = 'passed';
      // The verified artifact is the one worth rebuilding from, so its identity
      // is read here as well as from ARTIFACT_CREATED: the stage script that
      // verifies an APK emits this event, not the one that creates it.
      if (typeof e.path === 'string') s.apkPath = e.path;
      if (typeof e.sha256 === 'string') s.apkSha256 = e.sha256;
      if (typeof e.packageId === 'string') s.apkPackageId = e.packageId;
      sawProgress = true;
    }
    if (e.type === Events.RELEASE_CREATED) {
      s.release.status = 'created';
      if (typeof e.tag === 'string') s.release.tag = e.tag;
      if (typeof e.url === 'string') s.release.assetUrl = e.url;
      // finalDownloadUrl is deliberately NOT set here. A published release is
      // not the same claim as a verified public download, so recovery must not
      // manufacture that evidence from an asset URL alone.
      if (typeof e.sha256 === 'string') s.release.assetSha256 = e.sha256;
      if (typeof e.repo === 'string') s.release.repo = e.repo;
      if (typeof e.assetName === 'string') s.release.assetName = e.assetName;
      s.release.verifiedAt = e.ts || s.release.verifiedAt;
      sawProgress = true;
    }
    if (e.type === Events.DOWNLOAD_READY && typeof e.url === 'string') {
      s.release.assetUrl = e.url;
      s.finalDownloadUrl = e.url;
      sawProgress = true;
    }
    if (e.type === Events.PUBLIC_DOWNLOAD_VERIFIED && e.verified === true) {
      s.evidence = { ...(s.evidence || { stages: [] }), publicDownloadVerified: true };
      sawProgress = true;
    }
    if (e.type === Events.EVIDENCE_RECORDED && typeof e.stage === 'string') {
      const stage = e.stage as LifecycleStage;
      if ((LifecycleStages as readonly string[]).includes(stage)) {
        evidenceStages.set(stage, {
          stage,
          evidence: typeof e.evidence === 'string' ? e.evidence : '',
          at: typeof e.at === 'string' ? e.at : (e.ts || new Date().toISOString()),
          runId: typeof e.runId === 'string' ? e.runId : undefined
        });
        sawProgress = true;
      }
    }
  }

  if (!sawProgress) return null;

  if (evidenceStages.size > 0) {
    const ordered: StageEvidence[] = LifecycleStages
      .map((name) => evidenceStages.get(name))
      .filter((x): x is StageEvidence => !!x);
    const chain: EvidenceChain = { ...(s.evidence || { stages: [] }), stages: ordered };
    s.evidence = chain;
  }

  s.latestActivity = `${s.latestActivity} (recovered from event log)`;
  return s;
}

export function normalizeState(state: LiveState): LiveState {
  const base = createInitialState();
  const merged: any = { ...base, ...state };
  merged.cloudBuild = { ...base.cloudBuild, ...(state.cloudBuild || {}) };
  merged.release = { ...base.release, ...(state.release || {}) };
  merged.failureRepair = { ...base.failureRepair, ...(state.failureRepair || {}) };
  merged.testStats = { ...base.testStats, ...(state.testStats || {}) };
  merged.agents = state.agents || {};
  merged.tasks = state.tasks || {};
  merged.features = state.features || {};
  merged.repairs = Array.isArray(state.repairs) ? state.repairs : [];
  merged.buildLogs = Array.isArray(state.buildLogs) ? state.buildLogs : [];
  merged.evidence = { ...base.evidence, ...(state.evidence || {}) };
  if (typeof merged.overallProgressPct !== 'number' || merged.overallProgressPct < 0 || merged.overallProgressPct > 100) {
    merged.overallProgressPct = 0;
  }
  return merged as LiveState;
}

export interface WriteStateOptions {
  /**
   * Skips the central transition check. Only for bootstrap paths, where the
   * state is being established rather than advanced. Anything a lifecycle stage
   * script writes is validated.
   */
  allowUncheckedTransition?: boolean;
  reason?: string;
  /**
   * Path of the checkpoint file being restored.
   *
   * Recovery legitimately rolls the state *backwards* to a point that was
   * previously verified, which a forward-only transition rule must not forbid.
   * This is not a blanket bypass: the named checkpoint is re-read and the state
   * being written must match the state recorded inside it, so a caller cannot use
   * this option to jump to an arbitrary stage. The rollback is also written to
   * the event log so it stays auditable.
   */
  restoringCheckpoint?: string;
}

/**
 * Persists state, enforcing the legal lifecycle transition centrally.
 *
 * Every stage script used to validate its own transition, which meant a script
 * that forgot to (or drifted from) could write any state it liked. Comparing the
 * incoming state against what is already on disk makes the rule impossible to
 * bypass by omission, so a silent skip-ahead fails loudly instead of producing a
 * state file that claims work that never happened.
 */
export function writeState(state: LiveState, opts: WriteStateOptions = {}): LiveState {
  const next = normalizeState(state);

  let prev: LiveState | null = null;
  if (existsSync(STATE_FILE)) {
    try {
      prev = parseState(readFileSync(STATE_FILE, 'utf-8'));
    } catch { }
  }

  if (opts.restoringCheckpoint) {
    const recorded = parseState(readFileSync(opts.restoringCheckpoint, 'utf-8'));
    if (!recorded) {
      throw new Error(`Refusing checkpoint restore: ${opts.restoringCheckpoint} is unreadable or not a state`);
    }
    if (recorded.projectState !== next.projectState) {
      throw new Error(
        `Refusing checkpoint restore: ${opts.restoringCheckpoint} records ${recorded.projectState} ` +
        `but ${next.projectState} was offered`
      );
    }
    // Describe the rollback on the state itself so the audit event emitted after
    // the durable write below says what happened and from where. Emitting it here
    // rather than straight to the log is what keeps a refused restore from
    // leaving a fabricated transition behind.
    if (prev && prev.projectState !== next.projectState) {
      next.latestActivity =
        `rolled back from ${prev.projectState} to ${next.projectState} ` +
        `via checkpoint ${opts.restoringCheckpoint}`;
    }
  } else if (!opts.allowUncheckedTransition && prev && prev.projectState !== next.projectState) {
    try {
      assertValidTransition(prev.projectState, next.projectState);
    } catch (e: any) {
      const detail = opts.reason ? ` while ${opts.reason}` : '';
      throw new Error(
        `Refusing to persist ${prev.projectState} -> ${next.projectState}${detail}: ${e.message}\n` +
        `State was left at ${prev.projectState}. Use an explicit repair path rather than skipping a stage.`
      );
    }
  }

  next.lastUpdated = new Date().toISOString();
  next.version = (next.version || 0) + 1;
  const serialized = JSON.stringify(next, null, 2);
  if (existsSync(STATE_FILE)) {
    try {
      const prev = readFileSync(STATE_FILE, 'utf-8');
      if (parseState(prev)) atomicWrite(STATE_BAK, prev);
    } catch { }
  }
  atomicWrite(STATE_FILE, serialized);

  // Emitted here, after the durable write, rather than by the caller beforehand.
  // A caller that appends the event first and then hits a refused transition
  // leaves the log claiming a state the state file never reached; recovery
  // replays the log, so that disagreement becomes a fabricated lifecycle state.
  if (prev && prev.projectState !== next.projectState) {
    appendEvent({
      type: Events.PROJECT_STATUS_CHANGED,
      projectState: next.projectState,
      activity: next.latestActivity || `entered ${next.projectState}`
    });
  }

  // Handed back so a caller that holds this object writes the version that is
  // actually on disk. Without it the first write after a fresh store looks like
  // a stale snapshot of a state this same call was the writer of.
  return next;
}

export function appendEvent(event: any) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(EVENTS_FILE, line);
}

export function readEvents(sinceTs?: string): any[] {
  if (!existsSync(EVENTS_FILE)) return [];
  const raw = readFileSync(EVENTS_FILE, 'utf-8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e): e is any => !!e)
    .filter((e) => !sinceTs || e.ts > sinceTs);
}

export function listStateBackups(): string[] {
  try {
    return readdirSync(STATE_DIR).filter((f) => f.startsWith('state.json')).sort();
  } catch {
    return [];
  }
}
