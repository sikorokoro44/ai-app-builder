#!/usr/bin/env node
/**
 * The watchdog: keeps a build moving with no phone, laptop or chat in the loop.
 *
 *   node --experimental-strip-types scripts/watchdog.ts --dry-run
 *   node --experimental-strip-types scripts/watchdog.ts
 *
 * Run on a schedule (`.github/workflows/builder-watchdog.yml`), it closes the
 * last gap in the chain from "idea accepted" to "APK delivered": a dispatch the
 * platform dropped, a coordinator killed mid-run, or a queued run that will
 * never start is noticed and answered without anyone asking.
 *
 * It only decides and executes what `watchdogPlan.ts` computed from real
 * inputs: the open requests on record, the live state, the coordinator runs
 * GitHub reports, and the run store on disk. `--dry-run` prints the plan and
 * touches nothing, which is how the rules are tested.
 *
 * `gh` and `git` are optional for a dry run and mandatory otherwise; a missing
 * `gh` is reported as an error rather than silently treated as "no runs".
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { listRequests, closeRequest, recordDispatch, type RunRequest } from './live/runRequests.ts';
import { readState } from './live/stateStore.ts';
import { decideNotification } from './live/emailNotify.ts';
import {
  planWatchdog, configFromEnv,
  type CoordinatorRun, type WatchdogPlan, type StateSnapshot
} from './live/watchdogPlan.ts';

const WORKFLOW = process.env.BUILDER_COORDINATOR_WORKFLOW || '.github/workflows/builder-coordinator.yml';
const BRANCH = process.env.BUILDER_BRANCH || 'main';
const AGENT_DIR = process.env.BUILDER_AGENT_DIR || '.builder/agents';

const argv = process.argv.slice(2);
const hasFlag = (name: string) => argv.includes(`--${name}`);

if (hasFlag('help') || hasFlag('h')) {
  console.log(`usage: watchdog [--dry-run] [--no-email] [--no-push]

Decides whether an accepted idea needs a re-dispatch, a resume or a close, and
does it. --dry-run prints the plan without executing or pushing anything.`);
  process.exit(0);
}

const dryRun = hasFlag('dry-run');
const noEmail = hasFlag('no-email');
const noPush = hasFlag('no-push');

interface ActionResult {
  action: string;
  target: string;
  ok: boolean;
  detail?: string;
}

const actions: ActionResult[] = [];
const errors: string[] = [];

function sh(cmd: string, args: string[], timeoutMs = 60_000): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: process.env
    });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e: any) {
    return {
      ok: false,
      out: String(e.stdout || '').trim(),
      err: String(e.stderr || e.message || e).trim()
    };
  }
}

/** Coordinator runs from GitHub, or from the fixture the tests inject. */
function readRuns(): CoordinatorRun[] {
  const fixture = process.env.BUILDER_WATCHDOG_RUNS_JSON;
  if (fixture) {
    const raw = fixture.trim().startsWith('[') || fixture.trim().startsWith('{')
      ? fixture
      : readFileSync(fixture, 'utf-8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.runs;
    if (!Array.isArray(list)) throw new Error('BUILDER_WATCHDOG_RUNS_JSON must contain an array of runs');
    return list.map((r: any) => ({
      id: r.id ?? r.databaseId,
      status: r.status,
      createdAt: r.createdAt,
      conclusion: r.conclusion ?? null
    }));
  }

  const res = sh('gh', [
    'run', 'list',
    '--workflow', WORKFLOW,
    '--branch', BRANCH,
    '--limit', '30',
    '--json', 'databaseId,status,conclusion,createdAt'
  ]);
  if (!res.ok) {
    // Not an empty list: an unreadable run list must not look like "nothing is
    // running", or every watchdog tick would re-dispatch into an outage.
    throw new Error(`gh run list failed, refusing to guess what is running: ${res.err || res.out}`);
  }
  return JSON.parse(res.out || '[]').map((r: any) => ({
    id: r.databaseId,
    status: r.status,
    createdAt: r.createdAt,
    conclusion: r.conclusion ?? null
  }));
}

/** Run ids that have a store on disk and can actually be resumed. */
function readAvailableRunIds(): string[] {
  try {
    return readdirSync(AGENT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(AGENT_DIR, entry.name, 'manifest.json')))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function currentBranch(): string {
  const res = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], 15_000);
  return res.ok ? res.out : '';
}

/**
 * Publishes the state and request changes this tick produced, replaying the
 * commit on top of anything that arrived first. Only those two paths are ever
 * staged: the generated app belongs to repo-publisher, the run store is a
 * scratch directory.
 */
function pushWithRebase(message: string, attempts = 4): { ok: boolean; detail: string } {
  const paths = ['.builder/live', '.builder/requests'].filter((p) => existsSync(p));
  if (paths.length === 0) return { ok: true, detail: 'nothing to push' };
  const branch = currentBranch();
  if (branch !== BRANCH) {
    return { ok: false, detail: `not on ${BRANCH} (HEAD is ${branch || 'detached'}); nothing pushed` };
  }
  const staged = sh('git', ['add', '-A', ...paths], 30_000);
  if (!staged.ok) return { ok: false, detail: staged.err };
  const status = sh('git', ['status', '--porcelain', ...paths], 30_000);
  if (!status.ok || !status.out) return { ok: true, detail: 'nothing to push' };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const pending = sh('git', ['diff', '--cached', '--name-only', '--', ...paths], 30_000);
    if (pending.ok && pending.out) {
      const commit = sh('git', ['commit', '-m', message, '--only', '--', ...paths], 60_000);
      if (!commit.ok) return { ok: false, detail: `commit failed: ${commit.err}` };
    }
    const push = sh('git', ['push', 'origin', `HEAD:${BRANCH}`], 90_000);
    if (push.ok) return { ok: true, detail: 'pushed' };
    const behind = /cannot lock ref|fetch first|non-fast-forward|rejected|stale info/i.test(push.err);
    if (!behind || attempt === attempts) return { ok: false, detail: push.err };
    sh('git', ['fetch', 'origin', BRANCH], 60_000);
    const rebase = sh('git', ['rebase', `origin/${BRANCH}`], 60_000);
    if (!rebase.ok) sh('git', ['rebase', '--abort'], 30_000);
  }
  return { ok: false, detail: 'not pushed after every attempt' };
}

/** Best-effort discovery of the run a just-sent dispatch created. */
function discoverRunId(floor: number): string {
  for (let waited = 0; waited < 5; waited++) {
    sh('sleep', ['4'], 10_000);
    const res = sh('gh', [
      'run', 'list', '--workflow', WORKFLOW, '--branch', BRANCH, '--limit', '10',
      '--json', 'databaseId,createdAt'
    ]);
    if (!res.ok) continue;
    try {
      const runs = JSON.parse(res.out || '[]') as { databaseId: number; createdAt: string }[];
      const fresh = runs
        .filter((r) => Date.parse(r.createdAt) >= floor)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      if (fresh) return String(fresh.databaseId);
    } catch { /* try again */ }
  }
  return '';
}

function redrive(request: WatchdogPlan['redrive'][number]): void {
  const res = sh('node', [
    '--experimental-strip-types', 'scripts/requestRun.ts',
    '--idea', request.idea,
    '--mode', request.mode,
    '--redrive'
  ], 120_000);
  if (res.ok) {
    let runId = '';
    try { runId = String(JSON.parse(res.out).runId || ''); } catch { /* output not JSON */ }
    actions.push({ action: 'redrive', target: request.requestId, ok: true, detail: runId ? `run ${runId}` : 'dispatch accepted' });
  } else {
    actions.push({ action: 'redrive', target: request.requestId, ok: false, detail: res.err || res.out });
    errors.push(`re-dispatch of ${request.requestId} failed: ${res.err || res.out}`);
  }
}

function resume(plan: WatchdogPlan['resume']): void {
  if (!plan) return;
  const floor = Date.now() - 60_000;
  const res = sh('gh', [
    'workflow', 'run', WORKFLOW,
    '-f', `idea=${plan.idea}`,
    '-f', `runId=${plan.runId}`,
    '-f', `mode=${plan.mode}`,
    '-f', `concurrency=${plan.concurrency}`
  ], 60_000);
  if (!res.ok) {
    actions.push({ action: 'resume', target: plan.runId, ok: false, detail: res.err || res.out });
    errors.push(`resume dispatch for ${plan.runId} failed: ${res.err || res.out}`);
    return;
  }

  const runId = discoverRunId(floor);
  // Record the resume against the open request for this idea when one exists,
  // so the request ledger shows the attempt that is answering it.
  const requests = listRequests();
  const matching = requests
    .filter((r: RunRequest) => r.state !== 'delivered' && r.idea.trim().toLowerCase() === plan.idea.trim().toLowerCase())
    .pop();
  if (matching) {
    recordDispatch(matching.requestId, {
      at: new Date().toISOString(),
      outcome: 'dispatched',
      runId: runId || undefined,
      note: `watchdog resumed run ${plan.runId}`
    });
  }
  actions.push({ action: 'resume', target: plan.runId, ok: true, detail: runId ? `new run ${runId}` : 'dispatch accepted, no run id observed yet' });
}

function cancel(runId: string, reason: string): void {
  const res = sh('gh', ['run', 'cancel', runId], 60_000);
  if (res.ok) {
    actions.push({ action: 'cancel', target: runId, ok: true, detail: reason });
    return;
  }
  // A run that completed or was already cancelled on its own is a no-op, not a
  // failure worth a red tick.
  if (/not found|cannot|completed|already/i.test(res.err)) {
    actions.push({ action: 'cancel', target: runId, ok: true, detail: `already gone: ${res.err}` });
  } else {
    actions.push({ action: 'cancel', target: runId, ok: false, detail: res.err });
    errors.push(`could not cancel run ${runId}: ${res.err}`);
  }
}

function email(kinds: string[]): void {
  const res = sh('node', [
    '--experimental-strip-types', 'scripts/notifyEmail.ts',
    '--kinds', kinds.join(',')
  ], 120_000);
  const line = (res.out || '').split('\n').filter(Boolean).pop() || res.err || 'no output';
  const status = /status=([a-z_]+)/.exec(line)?.[1] || (res.ok ? 'unknown' : 'failed');
  actions.push({ action: 'email', target: kinds.join(','), ok: status !== 'failed', detail: `${status}${status === 'failed' ? `: ${line}` : ''}` });
  if (status === 'failed') {
    // A failed email is reported but does not stop the delivery machinery.
    errors.push(`notification email failed: ${line}`);
  }
}

async function main(): Promise<void> {
  // A fixed clock makes the age rules testable; production leaves it unset.
  const now = Number(process.env.BUILDER_WATCHDOG_NOW) || Date.now();
  const cfg = configFromEnv(process.env, now);
  const requests = listRequests();
  const state = readState();
  const decision = decideNotification(state);
  const snapshot: StateSnapshot = {
    projectState: state.projectState,
    idea: state.idea,
    lastUpdated: state.lastUpdated,
    missingStages: decision.missing,
    decisionKind: decision.kind
  };
  const availableRunIds = readAvailableRunIds();

  let runs: CoordinatorRun[];
  try {
    runs = readRuns();
  } catch (e) {
    console.log(JSON.stringify({ ok: false, dryRun, error: e instanceof Error ? e.message : String(e) }, null, 2));
    process.exit(1);
  }

  const plan = planWatchdog(requests, runs, snapshot, availableRunIds, cfg);

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      now: new Date(cfg.now).toISOString(),
      state: { projectState: snapshot.projectState, idea: snapshot.idea, decisionKind: snapshot.decisionKind, missingStages: snapshot.missingStages },
      availableRunIds,
      runs: runs.map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt })),
      plan
    }, null, 2));
    process.exit(0);
  }

  for (const c of plan.cancelRuns) cancel(c.runId, c.reason);

  for (const closed of plan.closeDelivered) {
    const updated = closeRequest(closed.requestId, 'delivered', 'the coordinator delivered and verified this app; closed by the watchdog');
    if (updated) actions.push({ action: 'close', target: closed.requestId, ok: true, detail: closed.idea });
    else errors.push(`could not close request ${closed.requestId}`);
  }

  if (plan.resume) resume(plan.resume);
  for (const r of plan.redrive) redrive(r);

  if (!noEmail && plan.emailKinds.length > 0) email(plan.emailKinds);

  let pushed: { ok: boolean; detail: string } = { ok: true, detail: 'skipped' };
  if (!noPush && actions.some((a) => a.ok && (a.action === 'close' || a.action === 'resume' || a.action === 'redrive' || a.action === 'email'))) {
    pushed = pushWithRebase(`builder: watchdog after run ${process.env.GITHUB_RUN_ID || 'local'}`);
    if (!pushed.ok) errors.push(`publishing the watchdog's changes failed: ${pushed.detail}`);
  }

  const report = {
    ok: errors.length === 0,
    dryRun: false,
    plan,
    actions,
    pushed,
    errors
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(errors.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2));
  process.exit(1);
});
