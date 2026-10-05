import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import { readState, writeState, initStateStore, atomicWrite, STATE_DIR } from './stateStore.ts';
import type { LiveState } from '../../shared/state.ts';

export const CHECKPOINT_DIR = process.env.BUILDER_CHECKPOINT_DIR || '.builder/checkpoints';
const MAX_CHECKPOINTS = 40;

export interface CheckpointMeta {
  /** The label the checkpoint was written under, as it appears in the file name. */
  name: string;
  file: string;
  createdAt: string;
  projectState: string;
  version: number;
  /** What the state said it was doing when it was captured. */
  activity: string;
}

export function initCheckpoints(): void {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
}

/**
 * Persists the current state as a recoverable checkpoint. Writes are atomic so
 * a kill mid-write cannot corrupt the newest or the previous checkpoint.
 */
export function persistCheckpoint(name = 'checkpoint', state?: LiveState): string {
  initStateStore();
  initCheckpoints();
  const s = state ? state : readState();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = `${CHECKPOINT_DIR}/${safe}--${ts}.json`;
  atomicWrite(file, JSON.stringify(s, null, 2));
  pruneCheckpoints();
  return file;
}

export function listCheckpoints(): CheckpointMeta[] {
  initCheckpoints();
  let files: string[] = [];
  try {
    files = readdirSync(CHECKPOINT_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: CheckpointMeta[] = [];
  for (const f of files) {
    const path = `${CHECKPOINT_DIR}/${f}`;
    try {
      const stat = statSync(path);
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      out.push({
        name: f.replace(/--.*\.json$/, ''),
        file: path,
        createdAt: stat.mtime.toISOString(),
        projectState: raw?.projectState || 'UNKNOWN',
        version: raw?.version || 0,
        activity: String(raw?.latestActivity || '')
      });
    } catch {
      out.push({ name: 'unreadable', file: path, createdAt: '', projectState: 'UNKNOWN', version: 0, activity: '' });
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Returns the newest checkpoint that still parses. Torn or truncated checkpoints
 * are skipped rather than restored, so recovery is deterministic.
 */
export function getLastCheckpoint(): string | null {
  const cps = listCheckpoints();
  for (let i = cps.length - 1; i >= 0; i--) {
    if (loadCheckpoint(cps[i].file)) return cps[i].file;
  }
  return null;
}

export function loadCheckpoint(file: string): LiveState | null {
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.projectState !== 'string') return null;
    return parsed as LiveState;
  } catch {
    return null;
  }
}

/**
 * Restores the newest valid checkpoint.
 *
 * The current state is checkpointed first so a bad restore is itself
 * recoverable, and the write is passed the checkpoint path so stateStore can
 * verify that the state being restored really is the one that file records.
 * That is what makes the backwards move safe: recovery returns to a point that
 * was genuinely persisted and verified, rather than to an invented stage.
 */
export function restoreLastCheckpoint(): LiveState | null {
  const cp = getLastCheckpoint();
  if (!cp) return null;
  const s = loadCheckpoint(cp);
  if (!s) return null;
  initStateStore();
  writeState(s, { restoringCheckpoint: cp, reason: `restoring checkpoint ${cp}` });
  return s;
}

export function pruneCheckpoints(): void {
  try {
    const files = readdirSync(CHECKPOINT_DIR).filter((f) => f.endsWith('.json')).sort();
    if (files.length <= MAX_CHECKPOINTS) return;
    const excess = files.length - MAX_CHECKPOINTS;
    for (let i = 0; i < excess; i++) {
      try { unlinkSync(`${CHECKPOINT_DIR}/${files[i]}`); } catch { }
    }
  } catch { }
}

export function statePaths() {
  return { stateDir: STATE_DIR, checkpointDir: CHECKPOINT_DIR };
}
