/**
 * What the watchdog should do about one state of the repository, decided
 * without side effects.
 *
 * The planner exists to be tested with fixtures: every rule that decides
 * whether a dropped dispatch gets re-sent, an interrupted run gets resumed, or
 * a delivered request gets closed is a pure function of these inputs. The CLI
 * (`scripts/watchdog.ts`) only gathers the inputs, runs this, and executes the
 * plan — so a rule that would re-dispatch a build nobody is waiting for fails
 * as a red assertion here, not as a surprise bill on a runner.
 *
 * The rules, in order of the decisions they guard:
 *
 *   close    a request whose idea the completed, fully-gated delivery covers.
 *   cancel   runs the platform queued but never started, and runs that exceed
 *            the coordinator's own timeout; a queued run holds the coordinator
 *            concurrency slot and would block every later dispatch forever.
 *   resume   an interrupted run that still has a store to resume from, before
 *            any thought of re-dispatching: resuming continues verified work,
 *            re-dispatching wipes it.
 *   redrive  only requests that nothing else is answering: fresh enough to
 *            still be wanted, under the retry cap, past the backoff floor,
 *            with no live run and no resumable work.
 */

/** One coordinator run as GitHub reports it. */
export interface CoordinatorRun {
  id: number | string;
  status: string;
  createdAt: string;
  conclusion?: string | null;
}

/** The open record of a run that was asked for. */
export interface WatchdogRequest {
  requestId: string;
  idea: string;
  mode: string;
  concurrency: number;
  requestedAt: string;
  state: string;
  dispatches: Array<{ at: string; runId?: string; outcome: string; note?: string }>;
}

/** Everything the planner needs to know about the current live state. */
export interface StateSnapshot {
  projectState: string;
  idea?: string;
  lastUpdated: string;
  /** Evidence stages the chain is still missing. */
  missingStages: string[];
  /** What the notification gate says may be declared right now. */
  decisionKind: 'COMPLETE' | 'FAILED' | 'WAITING';
}

export interface WatchdogConfig {
  now: number;
  /** Dispatch attempts allowed per request over its lifetime. */
  maxRedrives: number;
  /** Dispatches this watchdog run may start, newest request first. */
  maxRedrivesPerTick: number;
  /** Minimum age of the last dispatch before another one is allowed. */
  redriveFloorMs: number;
  /** Requests older than this are no longer re-driven automatically. */
  maxRequestAgeMs: number;
  /** A run that never started this long after creation is abandoned. */
  staleQueuedMs: number;
  /** An in-progress coordinator run older than this is stuck. */
  staleInProgressMs: number;
  /** The state must be quiet this long before a resume is dispatched. */
  staleStateMs: number;
}

export const DEFAULT_WATCHDOG_CONFIG: Omit<WatchdogConfig, 'now'> = {
  maxRedrives: 3,
  maxRedrivesPerTick: 1,
  redriveFloorMs: 10 * 60 * 1000,
  maxRequestAgeMs: 72 * 60 * 60 * 1000,
  staleQueuedMs: 45 * 60 * 1000,
  staleInProgressMs: 120 * 60 * 1000,
  staleStateMs: 45 * 60 * 1000
};

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Config from the environment, with the defaults above for anything unset. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env, now = Date.now()): WatchdogConfig {
  const d = DEFAULT_WATCHDOG_CONFIG;
  return {
    now,
    maxRedrives: envNumber(env, 'BUILDER_WATCHDOG_MAX_REDRIVES', d.maxRedrives),
    maxRedrivesPerTick: envNumber(env, 'BUILDER_WATCHDOG_MAX_REDRIVES_PER_TICK', d.maxRedrivesPerTick),
    redriveFloorMs: envNumber(env, 'BUILDER_WATCHDOG_REDRIVE_FLOOR_MS', d.redriveFloorMs),
    maxRequestAgeMs: envNumber(env, 'BUILDER_WATCHDOG_MAX_REQUEST_AGE_MS', d.maxRequestAgeMs),
    staleQueuedMs: envNumber(env, 'BUILDER_WATCHDOG_STALE_QUEUED_MS', d.staleQueuedMs),
    staleInProgressMs: envNumber(env, 'BUILDER_WATCHDOG_STALE_INPROGRESS_MS', d.staleInProgressMs),
    staleStateMs: envNumber(env, 'BUILDER_WATCHDOG_STALE_STATE_MS', d.staleStateMs)
  };
}

export interface PlannedCancel {
  runId: string;
  reason: string;
}

export interface PlannedRedrive {
  requestId: string;
  idea: string;
  mode: string;
  concurrency: number;
  reason: string;
}

export interface PlannedResume {
  runId: string;
  idea: string;
  mode: string;
  concurrency: number;
  reason: string;
}

export interface WatchdogPlan {
  closeDelivered: Array<{ requestId: string; idea: string }>;
  cancelRuns: PlannedCancel[];
  redrive: PlannedRedrive[];
  resume: PlannedResume | null;
  /** Kinds the caller should attempt to email; dedupe decides what sends. */
  emailKinds: Array<'COMPLETE' | 'FAILED' | 'WAITING'>;
  /** Every rule that refused to act, so a quiet tick explains itself. */
  skipped: Array<{ subject: string; reason: string }>;
}

const ACTIVE_STATUSES = new Set(['queued', 'waiting', 'requested', 'pending']);

function ageOf(createdAt: string, now: number): number {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, now - t);
}

function ideaMatch(a: string, b: string | undefined): boolean {
  if (!b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Newest run id, numerically when both parse as numbers. */
export function newestRunId(ids: string[]): string {
  return [...ids].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
    return b.localeCompare(a);
  })[0];
}

/**
 * The whole decision, from fixtures.
 *
 * Order matters: cancellation happens before redrive is considered (a stale
 * queued run no longer counts as in flight, so its request becomes eligible in
 * the same tick), and resume is decided before redrive so interrupted work
 * continues instead of restarting.
 */
export function planWatchdog(
  requests: WatchdogRequest[],
  runs: CoordinatorRun[],
  state: StateSnapshot,
  availableRunIds: string[],
  cfg: WatchdogConfig
): WatchdogPlan {
  const plan: WatchdogPlan = {
    closeDelivered: [],
    cancelRuns: [],
    redrive: [],
    resume: null,
    emailKinds: [],
    skipped: []
  };

  const inFlight: CoordinatorRun[] = [];
  for (const run of runs) {
    if (run.status === 'completed') continue;
    const age = ageOf(run.createdAt, cfg.now);
    if (ACTIVE_STATUSES.has(run.status)) {
      if (age > cfg.staleQueuedMs) {
        plan.cancelRuns.push({
          runId: String(run.id),
          reason: `queued for ${Math.round(age / 60000)} minutes without starting (limit ${Math.round(cfg.staleQueuedMs / 60000)})`
        });
      } else {
        inFlight.push(run);
      }
    } else if (run.status === 'in_progress') {
      if (age > cfg.staleInProgressMs) {
        plan.cancelRuns.push({
          runId: String(run.id),
          reason: `running for ${Math.round(age / 60000)} minutes (limit ${Math.round(cfg.staleInProgressMs / 60000)})`
        });
      } else {
        inFlight.push(run);
      }
    } else {
      // An unknown future status: treat it as alive rather than cancelling
      // something the planner does not understand.
      inFlight.push(run);
    }
  }
  const inFlightIds = new Set(inFlight.map((r) => String(r.id)));

  const open = requests.filter((r) => r.state !== 'delivered' && r.state !== 'failed');

  if (state.decisionKind === 'COMPLETE' && state.missingStages.length === 0 && state.idea) {
    for (const r of requests) {
      if (r.state === 'delivered') continue;
      if (ideaMatch(r.idea, state.idea)) {
        plan.closeDelivered.push({ requestId: r.requestId, idea: r.idea });
      }
    }
  }

  const resumeEligible =
    state.decisionKind === 'WAITING' &&
    state.missingStages.length > 0 &&
    state.idea !== undefined &&
    state.idea !== '' &&
    inFlight.length === 0 &&
    availableRunIds.length > 0 &&
    Number.isFinite(Date.parse(state.lastUpdated)) &&
    cfg.now - Date.parse(state.lastUpdated) >= cfg.staleStateMs;

  if (resumeEligible) {
    const matching = open.filter((r) => ideaMatch(r.idea, state.idea)).pop();
    plan.resume = {
      runId: newestRunId(availableRunIds),
      idea: state.idea!,
      mode: matching?.mode || 'full',
      concurrency: matching?.concurrency || 4,
      reason: `evidence is incomplete, nothing is running, and the state has been quiet for ${Math.round((cfg.now - Date.parse(state.lastUpdated)) / 60000)} minutes`
    };
  } else if (state.decisionKind === 'WAITING' && state.missingStages.length > 0 && inFlight.length === 0) {
    plan.skipped.push({
      subject: 'resume',
      reason: availableRunIds.length === 0
        ? 'work is interrupted but the run store has nothing to resume'
        : state.idea
          ? 'the state is still moving or was updated too recently to resume'
          : 'the state records no idea to resume for'
    });
  }

  const candidates: WatchdogRequest[] = [];
  for (const r of open) {
    const dispatched = r.dispatches.filter((d) => d.outcome === 'dispatched');
    const last = dispatched[dispatched.length - 1];
    const skip = (reason: string) => plan.skipped.push({ subject: r.requestId, reason });

    if (state.decisionKind === 'COMPLETE' && ideaMatch(r.idea, state.idea)) {
      skip('its idea has a completed, fully-gated delivery');
      continue;
    }
    if (
      state.decisionKind === 'WAITING' &&
      ideaMatch(r.idea, state.idea) &&
      state.missingStages.length > 0 &&
      availableRunIds.length > 0
    ) {
      skip('the run for this idea is interrupted and will be resumed, not restarted');
      continue;
    }
    if (state.decisionKind === 'FAILED' && ideaMatch(r.idea, state.idea)) {
      skip('the run for this idea failed and needs an explicit repair, not an automatic rebuild');
      continue;
    }
    const requestedAge = cfg.now - Date.parse(r.requestedAt);
    if (!Number.isFinite(Date.parse(r.requestedAt)) || requestedAge > cfg.maxRequestAgeMs) {
      skip(`requested ${Math.round(requestedAge / 3600000)}h ago, outside the ${Math.round(cfg.maxRequestAgeMs / 3600000)}h auto-redrive window`);
      continue;
    }
    if (dispatched.length >= cfg.maxRedrives) {
      skip(`already dispatched ${dispatched.length} times (cap ${cfg.maxRedrives})`);
      continue;
    }
    if (dispatched.some((d) => d.runId && inFlightIds.has(d.runId))) {
      skip('a run dispatched for it is still in flight');
      continue;
    }
    if (last) {
      const since = cfg.now - Date.parse(last.at);
      if (Number.isFinite(since) && since < cfg.redriveFloorMs) {
        skip(`last dispatch was ${Math.round(since / 60000)} minutes ago, inside the ${Math.round(cfg.redriveFloorMs / 60000)} minute floor`);
        continue;
      }
    }
    candidates.push(r);
  }

  candidates.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  candidates.forEach((r, i) => {
    if (i >= cfg.maxRedrivesPerTick) {
      plan.skipped.push({ subject: r.requestId, reason: `per-tick limit of ${cfg.maxRedrivesPerTick} re-dispatch(es)` });
      return;
    }
    plan.redrive.push({
      requestId: r.requestId,
      idea: r.idea,
      mode: r.mode,
      concurrency: r.concurrency,
      reason: r.dispatches.filter((d) => d.outcome === 'dispatched').length === 0
        ? 'the request was never dispatched'
        : 'no live run is answering this request'
    });
  });

  plan.emailKinds = inFlight.length > 0 ? ['COMPLETE', 'FAILED'] : ['COMPLETE', 'FAILED', 'WAITING'];
  return plan;
}
