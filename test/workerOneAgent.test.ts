import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { startRun } from '../scripts/agents/artifacts.ts';
import { newRunId } from '../scripts/agents/coordinator.ts';
import { AGENT_ID_NAMES, executionWaves } from '../scripts/agents/registry.ts';

const REPO = join(import.meta.dirname, '..');

/**
 * Runs `scripts/worker.ts` exactly the way the workers workflow invokes it, in a
 * child process with the isolated env from isolate.mjs, so the script's own
 * argument handling and exit codes are what is being tested.
 */
function runWorker(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/worker.ts', ...args], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, BUILDER_CONFIG_PATH: 'config/builder.json', BUILDER_REPO_ROOT: '.' }
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A genuine store: the real registry computes the waves, startRun writes them. */
function seedRun(): string {
  const idea = 'Workout log with sets and reps';
  const runId = newRunId(idea);
  startRun({
    runId,
    idea,
    createdAt: new Date().toISOString(),
    planner: 'scripts/agents/planner.ts',
    agents: AGENT_ID_NAMES,
    waves: executionWaves()
  });
  return runId;
}

const ideaIntakeDir = (runId: string): string =>
  join(resolve(process.env.BUILDER_AGENT_DIR!), runId, 'idea-intake');

describe('the single-agent worker', () => {
  test('runs one dependency-free agent and publishes its output artifact', () => {
    const runId = seedRun();
    assert.deepStrictEqual(executionWaves()[0], ['idea-intake'], 'wave one is the dependency-free intake');

    const run = runWorker(['--agent', 'idea-intake', '--run', runId, '--pre-cloud']);
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /idea-intake \(Idea Intake Analyst\): completed/);

    const dir = ideaIntakeDir(runId);
    for (const file of ['output.json', 'idea.json', 'status.json']) {
      assert.ok(existsSync(join(dir, file)), `idea-intake produced no ${file}`);
    }
    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf-8'));
    assert.strictEqual(status.status, 'completed');
    const idea = JSON.parse(readFileSync(join(dir, 'idea.json'), 'utf-8'));
    assert.ok(idea.normalized.startsWith('Workout log'));
  });

  test('refuses an agent whose dependencies have not completed', () => {
    const runId = seedRun();
    // requirements-analyst depends on idea-intake, which has not run yet.
    const run = runWorker(['--agent', 'requirements-analyst', '--run', runId, '--pre-cloud']);
    assert.strictEqual(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr + run.stdout, /cannot run yet: idea-intake/);
  });

  test('treats a hostile agent id as data, not as shell code', () => {
    const runId = seedRun();
    // The workflow passes BUILDER_AGENT from the caller-supplied `agents` list.
    // A crafted value survives the env handoff intact; it must be rejected by
    // the worker's registry check and never reach a shell.
    const hostile = 'idea-intake;echo pwned > agent-pwned.txt';
    const run = runWorker(['--agent', hostile, '--run', runId, '--pre-cloud']);
    assert.strictEqual(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr + run.stdout, /Unknown agent/);
    assert.ok(!existsSync(join(REPO, 'agent-pwned.txt')), 'the hostile text was executed as a shell command');
    const store = resolve(process.env.BUILDER_AGENT_DIR!);
    const entries = readdirSync(store);
    assert.ok(entries.every((e) => !e.includes('pwned')), 'the hostile value wrote no run-store entry');
  });
});