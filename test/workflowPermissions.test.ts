import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const coordinator = readFileSync(join(REPO, '.github/workflows/builder-coordinator.yml'), 'utf-8');
const android = readFileSync(join(REPO, '.github/workflows/builder-android-build.yml'), 'utf-8');
const buildExecute = readFileSync(join(REPO, 'scripts/cloudBuildExecute.ts'), 'utf-8');

/** The `permissions:` block belonging to one job, without a YAML parser. */
function jobPermissions(workflow: string, job: string): Record<string, string> {
  const jobAt = workflow.search(new RegExp(`^  ${job}:`, 'm'));
  assert.ok(jobAt > -1, `no job ${job}`);
  const rest = workflow.slice(jobAt);
  const blockAt = rest.search(/^ {4}permissions:\s*$/m);
  assert.ok(blockAt > -1, `${job} must declare its permissions rather than inherit the repository default`);
  const body = rest.slice(blockAt);
  const permissions: Record<string, string> = {};
  for (const line of body.split('\n').slice(1)) {
    if (/^ {6}#/.test(line)) continue;
    const entry = line.match(/^ {6}(\S+):\s*(\S+)\s*$/);
    if (!entry) break;
    permissions[entry[1]] = entry[2];
  }
  return permissions;
}

describe('the coordinator can dispatch the build it waits for', () => {
  test('the job asks for actions: write, because it dispatches with its own token', () => {
    const permissions = jobPermissions(coordinator, 'coordinate');

    // The repository's default workflow permission is `read`. A job that
    // declares contents: write but not actions: write gets a token that cannot
    // dispatch a workflow, which is what run 37380932123 hit: HTTP 403
    // "Resource not accessible by integration", after the app was pushed and
    // before anything was built.
    assert.strictEqual(permissions.actions, 'write', 'the dispatch needs actions: write on this token');
    assert.strictEqual(permissions.contents, 'write', 'the job pushes the app and the live state');
  });

  test('a refused dispatch reports the reason instead of failing opaquely', () => {
    // The dispatch is the one step the platform can refuse rather than the code
    // failing, and the reason is only on stderr. Run 37380932123 reported
    // "failed with exit 1" and buried the 403 in a thrown object.
    assert.match(buildExecute, /catch \(e: any\) \{[\s\S]{0,800}Could not dispatch/);
    assert.match(buildExecute, /actions: write/, 'the 403 case must name the permission that fixes it');
  });

  test('the build workflow only asks to read the repository, which is all it does', () => {
    // It checks out the commit, regenerates, assembles and uploads an artifact.
    // The release is published by the coordinator, so asking for contents: write
    // here would widen the token for no reason.
    const permissions = jobPermissions(android, 'build');
    assert.strictEqual(permissions.contents, 'read');
    assert.ok(!('actions' in permissions), 'the build dispatches nothing, so it needs no actions permission');
  });
});