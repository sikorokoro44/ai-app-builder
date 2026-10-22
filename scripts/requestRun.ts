#!/usr/bin/env node
/**
 * Ask GitHub to build an idea, and keep the request in the repository first.
 *
 *   node --experimental-strip-types scripts/requestRun.ts --idea "Book tracker for reading"
 *   node --experimental-strip-types scripts/requestRun.ts --idea "Book tracker for reading" --redrive
 *   node --experimental-strip-types scripts/requestRun.ts --redrive --request-id 2026-10-05T20-15-07-000Z-book-tracker-1a2b3c4d
 *   node --experimental-strip-types scripts/requestRun.ts --list
 *
 * The order matters. The request is committed and pushed before the dispatch is
 * sent, so a dispatch the platform drops — the normal failure mode during a
 * runner-assignment outage — leaves a durable record of what was asked for and
 * the exact command to send it again. Nothing here claims a run happened: the
 * request only records the dispatch, and only the coordinator's evidence chain
 * can say the app was delivered.
 *
 * The run that answers the dispatch is found by its title, which names the
 * request and this attempt, and by nothing else. "The newest run" is not a
 * correlation: with two requests for one idea in flight, it is the wrong run
 * as often as the right one.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import {
  listRequests,
  makeRequestId,
  findOpenRequests,
  readRequest,
  recordDispatch,
  writeRequest,
  openRequests,
  type RunRequest
} from './live/runRequests.ts';
import { correlateRun, makeDispatchId, type TitledRun } from './live/runIdentity.ts';

const WORKFLOW = process.env.BUILDER_COORDINATOR_WORKFLOW || '.github/workflows/builder-coordinator.yml';
const BRANCH = process.env.BUILDER_BRANCH || 'main';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string, fallback = '') => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1] ?? '';
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(args: string[]): boolean {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pushes a commit onto a branch that the fleet is writing to at the same time.
 * A run that publishes its live state, or records a request of its own, moves
 * `origin/main` underneath this process, so a bare push is rejected more often
 * than not. The commit being pushed only ever touches `.builder/requests`,
 * which nothing else writes, so replaying it on top of whatever arrived is
 * safe; a rebase that cannot be completed is abandoned and retried rather than
 * left half-applied.
 */
function pushWithRebase(message: string, attempts = 4): string {
  git(['add', '-A', '.builder/requests']);
  if (!git(['status', '--porcelain', '.builder/requests'])) {
    return 'nothing to push';
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // A replay that succeeded has already carried the commit with it, so the
    // commit is made only when something is actually staged for it.
    const staged = git(['diff', '--cached', '--name-only', '--', '.builder/requests']);
    if (staged) {
      git(['commit', '-m', message, '--only', '--', '.builder/requests']);
    }

    try {
      git(['push', 'origin', `HEAD:${BRANCH}`]);
      return 'pushed';
    } catch (e: any) {
      const detail = e.stderr?.toString() || e.message || '';
      const behind = /cannot lock ref|fetch first|non-fast-forward|rejected|stale info/i.test(detail);
      if (!behind || attempt === attempts) {
        console.error(`Could not push the run request to ${BRANCH}:\n${detail.trim()}`);
        process.exit(1);
      }
      console.log(`${BRANCH} moved while the request was being recorded; replaying on top of it (${attempt}/${attempts - 1}).`);
      if (!tryGit(['fetch', 'origin', BRANCH])) {
        console.error(`Could not fetch ${BRANCH} to replay the request on top of it.`);
        process.exit(1);
      }
      if (!tryGit(['rebase', `origin/${BRANCH}`])) {
        tryGit(['rebase', '--abort']);
        console.log('The replay conflicted and was abandoned; starting it again from the current branch.');
      }
    }
  }
  return 'pushed';
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

if (flag('list')) {
  const requests = listRequests();
  if (!requests.length) {
    console.log('No run requests recorded.');
    process.exit(0);
  }
  for (const r of requests) {
    const runs = r.dispatches.map((d) => d.runId || d.outcome).join(', ') || 'none';
    console.log(`${r.state === 'delivered' ? ' ' : '*'} ${r.requestId}  ${r.state}  ${r.mode}  runs: ${runs}  ${r.idea}`);
  }
  console.log(`\n${openRequests().length} request(s) still open.`);
  process.exit(0);
}

const idea = value('idea') || process.env.BUILDER_IDEA || '';
if (!idea.trim()) fail('An idea is required: --idea "one plain sentence describing the app"');

const mode = (value('mode', 'full') === 'pre-cloud' ? 'pre-cloud' : 'full') as RunRequest['mode'];
const concurrency = Math.max(1, Number(value('concurrency', '4')) || 4);

if (!flag('no-push')) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== BRANCH) fail(`Refusing to record a request from ${branch}; expected ${BRANCH}`);
  if (!existsSync('.git')) fail('Refusing to record a request outside a git repository');
}

let request: RunRequest | null = null;
const namedRequestId = value('request-id');
if (namedRequestId) {
  // The request was named outright: that is the only unambiguous way to say
  // which piece of work is being retried.
  request = readRequest(namedRequestId);
  if (!request) fail(`No request on record with the id ${namedRequestId}`);
  if (request.state === 'delivered') {
    fail(`Request ${namedRequestId} was already delivered; nothing to re-drive.`);
  }
  if (!flag('redrive')) {
    fail(`--request-id names an existing request (${namedRequestId}); pass --redrive to dispatch it again`);
  }
  console.log(`Re-driving request ${request.requestId}`);
} else if (flag('redrive')) {
  const matches = findOpenRequests(listRequests(), idea, mode);
  if (!matches.length) fail(`No open request for "${idea}" in ${mode} mode; run without --redrive to create one`);
  if (matches.length > 1) {
    // Two open requests for one idea are two pieces of work, and the idea does
    // not say which one is being retried. Guessing here is how one request ends
    // up carrying another one's evidence.
    fail(
      `${matches.length} open requests for "${idea}" in ${mode} mode; name the one to re-drive with --request-id:\n` +
      matches.map((r) => `  ${r.requestId}  (${r.state}, requested ${r.requestedAt})`).join('\n')
    );
  }
  request = matches[0];
  console.log(`Re-driving open request ${request.requestId}`);
} else {
  request = {
    requestId: makeRequestId(idea),
    idea: idea.trim(),
    mode,
    concurrency,
    requestedAt: new Date().toISOString(),
    state: 'requested',
    dispatches: []
  };
  writeRequest(request);
}

const redriveCmd =
  `node --experimental-strip-types scripts/requestRun.ts --idea "${request.idea}" --redrive --request-id ${request.requestId}` +
  (request.mode === 'pre-cloud' ? ' --mode pre-cloud' : '');

// Durability first: the record has to be on the remote before the dispatch, or a
// dropped dispatch takes the idea with it.
if (!flag('no-push')) {
  const outcome = pushWithRebase(`builder: record run request ${request.requestId}`);
  console.log(outcome === 'pushed'
    ? `Request ${request.requestId} is on ${BRANCH}`
    : `Request ${request.requestId} was already on ${BRANCH}`);
}

/** Every run of the coordinator workflow, with the title correlation needs. */
function listCoordinatorRuns(): TitledRun[] {
  try {
    return JSON.parse(
      gh(['run', 'list', '--workflow', WORKFLOW, '--branch', BRANCH, '--limit', '40', '--json', 'databaseId,status,createdAt,event,headSha,displayTitle,name'])
    ) as TitledRun[];
  } catch {
    return [];
  }
}

let runId = '';
const dispatchId = makeDispatchId();
let correlationNote = '';
try {
  gh([
    'workflow', 'run', WORKFLOW,
    '-f', `idea=${request.idea}`,
    '-f', `mode=${request.mode}`,
    '-f', `concurrency=${request.concurrency}`,
    '-f', `requestId=${request.requestId}`,
    '-f', `dispatchId=${dispatchId}`
  ]);
  // The run that answers this dispatch is the one whose title names this
  // request and this attempt. Anything else is somebody else's work.
  for (let waited = 0; waited < 15; waited++) {
    execFileSync('sleep', ['6']);
    const correlation = correlateRun(listCoordinatorRuns(), request.requestId, dispatchId);
    if (correlation.runId) {
      runId = correlation.runId;
      break;
    }
    correlationNote = correlation.reason || '';
  }
} catch (e) {
  recordDispatch(request.requestId, {
    at: new Date().toISOString(),
    dispatchId,
    outcome: 'refused',
    note: String((e as { stderr?: string })?.stderr || e).slice(0, 300)
  });
  fail(`The dispatch was refused. The request ${request.requestId} is recorded on ${BRANCH}; re-drive it with:\n  ${redriveCmd}`);
}

if (!runId) {
  recordDispatch(request.requestId, {
    at: new Date().toISOString(),
    dispatchId,
    outcome: 'dispatched',
    note: `GitHub accepted the dispatch but no run carrying this request and dispatch was seen${correlationNote ? ` (${correlationNote})` : ''}`
  });
  console.log(JSON.stringify({
    ok: true,
    requestId: request.requestId,
    dispatchId,
    dispatched: true,
    runId: null,
    note: 'no run carrying this request appeared yet; the request stays open until a run proves it delivered',
    redrive: redriveCmd
  }, null, 2));
  process.exit(0);
}

const saved = recordDispatch(request.requestId, {
  at: new Date().toISOString(),
  dispatchId,
  outcome: 'dispatched',
  runId
})!;

if (!flag('no-push')) {
  const outcome = pushWithRebase(`builder: run ${runId} dispatched for ${saved.requestId}`);
  if (outcome === 'pushed') console.log(`Run ${runId} is recorded for ${saved.requestId}`);
}

console.log(JSON.stringify({
  ok: true,
  requestId: saved.requestId,
  dispatchId,
  dispatched: true,
  runId,
  mode: saved.mode,
  idea: saved.idea,
  watch: `gh run watch ${runId} --exit-status`,
  resume: `node --experimental-strip-types scripts/coordinator.ts --resume <runId> --request-id ${saved.requestId}`,
  redrive: redriveCmd
}, null, 2));
