/**
 * The identity of a request, of one dispatch of it, and of the run that answered.
 *
 * Correlation used to be a guess: pick the newest run that appeared after the
 * dispatch. With two requests for the same idea, or a retry of a request that
 * already has a run, "the newest run" is the wrong run as often as the right
 * one, and the evidence chain then belongs to somebody else's work.
 *
 * So every dispatch now carries two ids:
 *
 *   requestId   one piece of work, from the moment the idea was accepted
 *   dispatchId  one attempt to get that work answered by a run
 *
 * and both are written into the run's name (`run-name`), which is the only
 * thing GitHub keeps about a run that cannot be reassigned afterwards. A run is
 * then only ever matched by its exact title: same request, same dispatch. Two
 * dispatches of one request are two different runs and both are recorded; one
 * dispatch can never be claimed by two runs, and a run is never attributed to a
 * request it does not name.
 */

import { randomBytes } from 'crypto';

/** How a run is titled so that its request and dispatch can be read back. */
export const RUN_TITLE_PREFIX = 'Builder - ';
/** Separator between the subject (the request) and the dispatch id. */
export const RUN_TITLE_SEPARATOR = ' # ';

/** A run as GitHub reports it, with the fields correlation needs. */
export interface TitledRun {
  databaseId: number;
  displayTitle?: string;
  name?: string;
  createdAt: string;
  status?: string;
  conclusion?: string | null;
}

/** A request id as it is written into the title of the run that answers it. */
export function runTitleSubject(requestId: string): string {
  return requestId;
}

/** The exact title a dispatch of this request and dispatch id must produce. */
export function runTitle(requestId: string, dispatchId: string): string {
  return `${RUN_TITLE_PREFIX}${runTitleSubject(requestId)}${RUN_TITLE_SEPARATOR}${dispatchId}`;
}

/**
 * Split a run title into the request it answers and the dispatch that asked.
 *
 * A title without a dispatch id is from before dispatch ids existed: it names a
 * request but not the attempt, so it can only ever match a dispatch id of `none`.
 */
export function parseRunTitle(title: string | undefined | null): { subject: string; dispatchId?: string } | null {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  if (!trimmed.startsWith(RUN_TITLE_PREFIX)) return null;
  const rest = trimmed.slice(RUN_TITLE_PREFIX.length);
  const at = rest.indexOf(RUN_TITLE_SEPARATOR);
  if (at === -1) return { subject: rest.trim() };
  return {
    subject: rest.slice(0, at).trim(),
    dispatchId: rest.slice(at + RUN_TITLE_SEPARATOR.length).trim()
  };
}

/** True when this title names exactly this request and dispatch. */
export function titleMatches(title: string | undefined | null, requestId: string, dispatchId: string): boolean {
  const parsed = parseRunTitle(title);
  if (!parsed) return false;
  if (parsed.subject !== requestId) return false;
  if (!dispatchId) return parsed.dispatchId === undefined;
  return parsed.dispatchId === dispatchId;
}

/** Random entropy for ids that must never collide. */
export function randomSuffix(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}

/** A dispatch id: unique per attempt, safe in a file name and in a run title. */
export function makeDispatchId(): string {
  return randomSuffix(6);
}

export interface RunCorrelation {
  /** The run that answered this dispatch, when exactly one does. */
  runId?: string;
  /** Every run whose title names this request and dispatch. */
  matches: TitledRun[];
  /** Why no run was claimed, when none was. */
  reason?: string;
}

/**
 * Find the run that answered one dispatch.
 *
 * The match is exact: the run's title must name the request and the dispatch.
 * No run is ever claimed by recency, because a newer run for a different
 * request, or a retry of the same request, is not this dispatch's run.
 */
export function correlateRun(runs: TitledRun[], requestId: string, dispatchId: string): RunCorrelation {
  const matches = runs.filter((r) => titleMatches(r.displayTitle, requestId, dispatchId));
  if (matches.length === 1) {
    return { runId: String(matches[0].databaseId), matches };
  }
  if (matches.length > 1) {
    return {
      matches,
      reason: `${matches.length} runs name request ${requestId} dispatch ${dispatchId}; none of them can be claimed`
    };
  }
  const forRequest = runs.filter((r) => {
    const parsed = parseRunTitle(r.displayTitle);
    return parsed?.subject === requestId;
  });
  if (forRequest.length > 1) {
    return {
      matches: forRequest,
      reason: `no run names dispatch ${dispatchId}; ${forRequest.length} other runs name request ${requestId}`
    };
  }
  return { matches: [], reason: `no run names request ${requestId} dispatch ${dispatchId}` };
}
