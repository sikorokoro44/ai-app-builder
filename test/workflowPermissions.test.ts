import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
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

describe('no workflow interpolates an expression into a shell block', () => {
  // GitHub substitutes `${{ ... }}` *before* the step text reaches the shell, so
  // quoting provides no protection: a crafted input or matrix row becomes code.
  // The safe pattern is to bind the value in the job's env and reference $VAR in
  // the run block, which is what these workflows must keep doing.
  function runLines(workflowFile: string): ReturnType<typeof shellLines> {
    const source = readFileSync(join(REPO, '.github/workflows', workflowFile), 'utf-8');
    return shellLines(source);
  }

  function shellLines(source: string): Array<{ line: number; text: string }> {
    const found: Array<{ line: number; text: string }> = [];
    const lines = source.split('\n');
    let indent = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^ {2,}run:\s*$/.test(line)) {
        indent = line.search(/\S/);
        continue;
      }
      const inline = line.match(/^(\s*)run:\s+(.*)$/);
      if (inline) {
        found.push({ line: i + 1, text: inline[2] });
        continue;
      }
      if (indent > -1 && indent + 2 <= (line.match(/^\s*/)![0].length) && line.trim()) {
        found.push({ line: i + 1, text: line });
      } else {
        indent = -1;
      }
    }
    return found.filter((x) => x.text.trim());
  }

  for (const file of readdirSync(join(REPO, '.github/workflows')).filter((f) => f.endsWith('.yml'))) {
    test(`${file} leaves expressions out of its run blocks`, () => {
      const hits = runLines(file).filter(({ text }) => text.includes('${{'));
      assert.deepStrictEqual(
        hits.map(({ line, text }) => `${line}: ${text.trim()}`),
        [],
        `${file} must env-bind inputs/matrix values instead of interpolating them into shell text`
      );
    });
  }
});

describe('the workers workflow can read the coordinator run store across runs', () => {
  // The run store artifact is uploaded by the coordinator's own run, never by the
  // run the workers are executing in. download-artifact defaults to the current
  // run, so every download that points at `coordinatorRunId` must also say which
  // run to read and give it a token, or the workers silently find no store.
  test('every coordinator-store download sets run-id and the token', () => {
    const workers = readFileSync(join(REPO, '.github/workflows', 'builder-workers.yml'), 'utf-8');
    const downloads = [...workers.matchAll(/name:\s*builder-run-state-\${{[^}]+coordinatorRunId[^}]+}}/g)];
    assert.ok(downloads.length >= 2, 'expected one store download per worker job');
    for (const download of downloads) {
      const from = workers.slice(download.index);
      const block = from.slice(0, from.indexOf('\n  \n') === -1 ? 400 : from.indexOf('\n  \n'));
      assert.match(block, /run-id:\s*\${{[^}]+coordinatorRunId/);
      assert.match(block, /github-token:\s*\${{[^}]+GITHUB_TOKEN/);
    }
  });

  // upload-artifact v4-v7 do not keep the leading `path` components: a single
  // directory arrives as its contents, a path list as basename roots. The worker
  // reads `.builder/agents/<runId>`, so every store download has to be followed
  // by a normalization step that moves whichever layout arrived into place, and
  // that step must fail loudly if the manifest never landed.
  test('every store download is followed by a layout normalization step', () => {
    const workers = readFileSync(join(REPO, '.github/workflows', 'builder-workers.yml'), 'utf-8');
    const blocks = workers.split('\n\n');
    for (let i = 0; i < blocks.length; i++) {
      if (!blocks[i].startsWith('        - name: Download the run store')) continue;
      const next = blocks
        .slice(i + 1)
        .find((b) => /^\S/.test(b.trim()) || b.trim().startsWith('- name:'));
      assert.match(
        blocks[i + 1],
        /Normalize the downloaded run store/,
        'store download must be followed by a normalization step'
      );
      assert.match(blocks[i + 1], /workspace\/\.builder\/agents\/\$BUILDER_RUN_ID\/manifest\.json/);
    }
  });
});

describe('no workflow pins a deprecated action major', () => {
  // GitHub drops node20 from the runner on 2026-09-16 and forces node20 actions
  // onto node24, which is why the node20-era majors are deprecated and stop
  // receiving maintenance. Each minimum below is the first major of that action
  // that runs node24 (upload-artifact@v6 / download-artifact@v7 shipped node24
  // on 2025-12-12; v5/v6 of download still ran node20).
  const FIRST_NODE24_MAJOR: Record<string, number> = {
    'actions/checkout': 5,
    'actions/setup-node': 5,
    'actions/setup-java': 5,
    'actions/cache': 5,
    'actions/upload-artifact': 6,
    'actions/download-artifact': 7,
    'android-actions/setup-android': 4,
    'gradle/actions/setup-gradle': 5
  };

  function actionUses(source: string): Array<{ line: number; ref: string }> {
    const found: Array<{ line: number; ref: string }> = [];
    for (const [i, raw] of source.split('\n').entries()) {
      const hit = raw.match(/uses:\s*([\w.-]+\/[\w.-]+)@(\S+)/);
      if (hit) found.push({ line: i + 1, ref: `${hit[1]}@${hit[2]}` });
    }
    return found;
  }

  for (const file of readdirSync(join(REPO, '.github/workflows')).filter((f) => f.endsWith('.yml'))) {
    test(`${file} only uses current, maintained action majors`, () => {
      const source = readFileSync(join(REPO, '.github/workflows', file), 'utf-8');
      const violations = actionUses(source).filter(({ line, ref }) => {
        const at = ref.lastIndexOf('@');
        const ownerAction = ref.slice(0, at);
        const major = Number(ref.slice(at + 1).match(/\d+/)?.[0] ?? '');
        const min = FIRST_NODE24_MAJOR[ownerAction];
        if (min === undefined) return false;
        if (!major) return false;
        return major < min;
      });
      assert.deepStrictEqual(
        violations.map(({ line, ref }) => `${line}: ${ref}`),
        [],
        `${file} reverts to a deprecated action major; pin the current node24 major instead`
      );
    });
  }
});
