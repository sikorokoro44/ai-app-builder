/**
 * Durable records of the runs that have been asked for.
 *
 * A `workflow_dispatch` is fire-and-forget: the platform can accept it and then
 * never start it, as it did to every run during GitHub incident 3q1yb5m7ltvb.
 * The idea itself must not live only in that dispatch, or the work is lost with
 * nothing to retry. So the request is written into the repository — the
 * permanent source of truth — before the dispatch is sent, and the dispatch it
 * produced is recorded afterwards.
 *
 * A request is a record of an intention, never of an outcome. It never contains
 * evidence and cannot mark a run delivered; only the coordinator's own evidence
 * chain can do that.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

export const REQUESTS_DIR = process.env.BUILDER_REQUESTS_DIR || '.builder/requests';

export type RequestState = 'requested' | 'dispatched' | 'delivered' | 'failed';

export interface DispatchAttempt {
  at: string;
  /** The Actions run that answered this dispatch, when GitHub created one. */
  runId?: string;
  outcome: 'dispatched' | 'refused';
  note?: string;
}

export interface RunRequest {
  requestId: string;
  idea: string;
  mode: 'full' | 'pre-cloud';
  concurrency: number;
  requestedAt: string;
  state: RequestState;
  dispatches: DispatchAttempt[];
  note?: string;
}

function slug(idea: string): string {
  const s = idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || 'idea';
}

/** A filesystem-safe, sortable request id. */
export function makeRequestId(idea: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${slug(idea)}`;
}

export function requestsDir(): string {
  return REQUESTS_DIR;
}

export function requestPath(requestId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(requestId)) {
    throw new Error(`Refusing a request id that is not a plain file name: ${requestId}`);
  }
  return join(REQUESTS_DIR, `${requestId}.json`);
}

export function writeRequest(req: RunRequest): string {
  mkdirSync(REQUESTS_DIR, { recursive: true });
  const path = requestPath(req.requestId);
  // Write-then-rename so a kill mid-write cannot leave half a request that later
  // reads as an idea nobody asked for.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(req, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

export function readRequest(requestId: string): RunRequest | null {
  const path = requestPath(requestId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed?.requestId || !parsed?.idea) return null;
    return parsed as RunRequest;
  } catch {
    return null;
  }
}

export function listRequests(): RunRequest[] {
  if (!existsSync(REQUESTS_DIR)) return [];
  const out: RunRequest[] = [];
  for (const file of readdirSync(REQUESTS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const parsed = readRequest(file.replace(/\.json$/, ''));
    if (parsed) out.push(parsed);
  }
  return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** Requests that have not produced a delivered app yet. */
export function openRequests(): RunRequest[] {
  return listRequests().filter((r) => r.state !== 'delivered');
}

/**
 * The open request for this idea and mode, if there is one.
 *
 * Used by `--redrive`: re-sending a dispatch for an idea that already has an
 * unfinished request is a retry, and recording it as a second request would make
 * the repository claim two pieces of work where there is one.
 */
export function findOpenRequest(requests: RunRequest[], idea: string, mode: string): RunRequest | null {
  const wanted = idea.trim().toLowerCase();
  const matches = requests.filter(
    (r) => r.state !== 'delivered' && r.mode === mode && r.idea.trim().toLowerCase() === wanted
  );
  return matches.length ? matches[matches.length - 1] : null;
}

export function recordDispatch(requestId: string, attempt: DispatchAttempt): RunRequest | null {
  const req = readRequest(requestId);
  if (!req) return null;
  req.dispatches.push(attempt);
  if (attempt.outcome === 'dispatched') req.state = 'dispatched';
  if (attempt.note) req.note = attempt.note;
  writeRequest(req);
  return req;
}

export function closeRequest(requestId: string, state: RequestState, note?: string): RunRequest | null {
  const req = readRequest(requestId);
  if (!req) return null;
  req.state = state;
  if (note) req.note = note;
  writeRequest(req);
  return req;
}
