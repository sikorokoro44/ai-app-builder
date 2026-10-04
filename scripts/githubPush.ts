#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { persistCheckpoint } from './live/checkpointStore.ts';
import { assertRepoSafety, assertNoSecretsInFiles, REQUIRED_REPO } from './live/repoGuard.ts';
import { recordStage } from './live/evidenceChain.ts';
import { assertValidTransition } from './live/stateValidator.ts';
import { ProjectStates, Events } from '../shared/types.ts';

/**
 * The builder only ever operates on sikorokoro44/ai-app-builder, on the
 * expected branch, with no secrets in the committed tree. Any deviation aborts
 * before a single byte is pushed.
 */
initStateStore();
const s = readState();

const guard = assertRepoSafety(process.cwd());
if (!guard.ok) {
  console.error(`Repository safety check failed:\n - ${guard.errors.join('\n - ')}`);
  process.exit(1);
}
if (guard.repo !== REQUIRED_REPO) {
  console.error(`Refusing to operate on ${guard.repo}; required repository is ${REQUIRED_REPO}`);
  process.exit(1);
}

const expectedBranch = process.env.BUILDER_BRANCH || 'main';
if (guard.branch !== expectedBranch) {
  console.error(`Unexpected branch ${guard.branch}; expected ${expectedBranch}`);
  process.exit(1);
}

const secrets = assertNoSecretsInFiles(process.cwd(), ['scripts', 'shared', 'config', 'test', '.github']);
if (secrets.length > 0) {
  console.error(`Refusing to push: possible secrets detected:\n - ${secrets.join('\n - ')}`);
  process.exit(1);
}

try {
  assertValidTransition(s.projectState, ProjectStates.BUILDING);
} catch (e: any) {
  console.error(`Refusing out-of-order push: ${e.message}`);
  process.exit(2);
}

const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trim();

// A clean tree is not the same thing as a pushed branch. Counting the commits
// that never reached the remote keeps "nothing to commit" from reporting success
// while the branch is still ahead of origin.
let unpushed = 1;
try {
  unpushed = Number(execFileSync('git', ['rev-list', '--count', `origin/${guard.branch}..HEAD`], { encoding: 'utf-8' }).trim()) || 0;
} catch {
  // No usable upstream ref: assume work is unpushed so we go round the push path.
  unpushed = 1;
}

if (!dirty && unpushed === 0) {
  // The implementation is already on the remote, which is exactly the fact the
  // IMPLEMENT link asserts. Recording it here is what makes the completion gate
  // reachable for a resumed run; skipping it left the gate permanently open.
  s.cloudBuild.headSha = guard.headSha;
  recordStage(s, 'IMPLEMENT', `implementation already pushed at ${guard.headSha.slice(0, 7)} (clean tree, branch in sync with origin)`);
  appendEvent({ type: Events.BUILD_STAGE_CHANGED, stage: 'PUSH', headSha: guard.headSha });
  writeState(s);
  console.log(JSON.stringify({ ok: true, pushed: false, reason: 'working tree clean and branch in sync with origin', headSha: guard.headSha }, null, 2));
  process.exit(0);
}

s.projectState = ProjectStates.BUILDING;
s.latestActivity = 'Pushing generated sources to GitHub';
persistCheckpoint('pre-push', s);
writeState(s);

execFileSync('git', ['add', '-A'], { stdio: 'inherit' });
execFileSync('git', ['commit', '-m', process.env.BUILDER_COMMIT_MESSAGE || 'builder: generated app sources'], { stdio: 'inherit' });
execFileSync('git', ['push', 'origin', guard.branch], { stdio: 'inherit' });

const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
s.cloudBuild.headSha = headSha;
recordStage(s, 'IMPLEMENT', `pushed commit ${headSha.slice(0, 7)}`);
appendEvent({ type: Events.BUILD_STAGE_CHANGED, stage: 'PUSH', headSha });
writeState(s);
console.log(JSON.stringify({ ok: true, pushed: true, headSha, branch: guard.branch }, null, 2));
