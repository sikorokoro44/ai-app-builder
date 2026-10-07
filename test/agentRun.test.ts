import './isolate.mjs';
import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { decodePng } from '../scripts/live/png.ts';
import { runCoordinator } from '../scripts/agents/coordinator.ts';
import { AGENTS, executionWaves } from '../scripts/agents/registry.ts';
import { ownsFile } from '../scripts/agents/ownership.ts';
import { readArtifact, readLedger, readManifest, runDir } from '../scripts/agents/artifacts.ts';
import { inspectRun, listRuns, resumeRun, restartRun, invalidateFromStage, nextStage } from '../scripts/agents/recovery.ts';
import { listCheckpoints, loadCheckpoint } from '../scripts/live/checkpointStore.ts';
import type { BuildPlan } from '../scripts/agents/planner.ts';
import { readState, readEvents } from '../scripts/live/stateStore.ts';
import { LifecycleStages } from '../scripts/live/evidenceChain.ts';
import { Events } from '../shared/types.ts';
import { AGENT_IDS } from '../scripts/agents/agentIds.ts';

const GOLDEN_PATH = join(process.cwd(), 'test', 'fixtures', 'generatedProjectGolden.json');
const IDEA = 'Plant watering journal';
const PRE_CLOUD_STOP = ['repo-publisher', 'build-verifier', 'release-publisher', 'integration-supervisor'];
// The generated project is tracked in the repository, so a run in a test writes to
// a throwaway copy and compares it against the golden hashes instead.
const PROJECT_ROOT = mkdtempSync(join(tmpdir(), 'builder-project-'));

let report: Awaited<ReturnType<typeof runCoordinator>>;

function fileHash(file: string): string {
  const buf = readFileSync(file);
  // PNGs must be compared by decoded pixels, not compressed bytes: the launcher
  // icon raster is deterministic, but deflate output depends on the zlib linked
  // into the Node build (this repo runs under Termux as well as GitHub Actions).
  if (file.endsWith('.png')) {
    const decoded = decodePng(buf);
    if (!decoded) return createHash('sha256').update(buf).digest('hex');
    const canonical = `${decoded.width}:${decoded.height}:`;
    return createHash('sha256').update(canonical).update(decoded.rgba).digest('hex');
  }
  return createHash('sha256').update(buf).digest('hex');
}

function hashesOf(dir: string): Record<string, string> {
  const files: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  const out: Record<string, string> = {};
  for (const file of files) out[relative(dir, file)] = fileHash(file);
  return out;
}

before(async () => {
  report = await runCoordinator({
    idea: IDEA,
    projectRoot: PROJECT_ROOT,
    mode: 'pre-cloud',
    maxConcurrency: 4,
    echo: false
  });
});

describe('running the fleet for an idea', () => {
  test('completes every agent that does not need GitHub', () => {
    assert.strictEqual(report.status, 'completed', JSON.stringify(report.failures));
    const completed = report.agents.filter((a) => a.status === 'completed').map((a) => a.id);
    for (const id of AGENT_IDS.map((a) => a.id)) {
      const shouldRun = !PRE_CLOUD_STOP.includes(id);
      assert.strictEqual(completed.includes(id), shouldRun, `${id} should ${shouldRun ? '' : 'not '}have run`);
    }
    assert.strictEqual(completed.length, 16);
  });

  test('reports every agent with a summary of what it produced', () => {
    for (const agent of report.agents) {
      if (agent.status !== 'completed') continue;
      assert.ok(agent.summary && agent.summary.length > 3, `${agent.id} completed without saying what it did`);
      assert.ok(agent.durationMs >= 0, `${agent.id} has no duration`);
    }
  });

  test('records evidence in lifecycle order, with nothing invented', () => {
    const recorded = report.evidenceStages;
    assert.deepStrictEqual(recorded, ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'TESTGEN', 'VALIDATE']);
    assert.deepStrictEqual(recorded, (LifecycleStages as readonly string[]).filter((s) => recorded.includes(s)));
    for (const stage of recorded) {
      const evidence = readState().evidence!.stages!.find((s) => s.stage === stage)!;
      assert.ok(evidence.evidence.length > 10, `${stage} was recorded with nothing in it`);
    }
  });

  test('stops at the last local stage without pretending the app was delivered', () => {
    assert.strictEqual(report.projectState, 'TESTING');
    assert.strictEqual(report.downloadUrl, undefined);
    assert.strictEqual(report.apkSha256, undefined);
    const state = readState();
    assert.strictEqual(state.apkVerification, 'idle', 'no APK may be claimed before one is built');
    assert.strictEqual(state.apkSha256, undefined, 'no checksum may be claimed before a build');
    assert.strictEqual(state.cloudBuild.runId, undefined, 'no cloud run may be claimed before one exists');
    assert.strictEqual(state.release.status, 'idle');
  });

  test('derives the project from the idea, not from a template', () => {
    const plan = readArtifact<BuildPlan>(report.runId, 'feature-planner', 'plan')!;
    assert.strictEqual(plan.packageId, 'com.builder.plantwatering');
    assert.strictEqual(plan.appName, 'Plant watering journal');
    assert.strictEqual(plan.entity.className, 'Note');
    assert.strictEqual(plan.tasks.length, 20, 'every agent should own a task');
    assert.deepStrictEqual(
      plan.tasks.map((t) => t.agentId).sort(),
      AGENT_IDS.map((a) => a.id).sort(),
      'the plan should assign one task to each agent'
    );
  });

  test('writes the same project the proven generator writes', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'))[IDEA];
    const written = hashesOf(PROJECT_ROOT);
    assert.deepStrictEqual(Object.keys(written).sort(), Object.keys(golden.files).sort());
    for (const [file, hash] of Object.entries(golden.files)) {
      assert.strictEqual(written[file], hash, `${file} differs from the generator output`);
    }
  });

  test('gives every file in the project exactly one owner', () => {
    const written = Object.keys(hashesOf(PROJECT_ROOT));
    const owners = new Map<string, string[]>();
    for (const agent of AGENTS) {
      for (const file of written) {
        if (ownsFile(agent.id, file)) owners.set(file, [...(owners.get(file) ?? []), agent.id]);
      }
    }
    assert.strictEqual(owners.size, written.length, `only ${owners.size} of ${written.length} files have an owner`);
    for (const [file, ids] of owners) {
      assert.strictEqual(ids.length, 1, `${file} is claimed by ${ids.join(' and ')}`);
    }
  });

  test('persists a ledger entry and a run manifest for the run', () => {
    const ledger = readLedger(report.runId);
    assert.strictEqual(ledger.length, 16, 'only the agents that ran belong in the ledger');
    for (const entry of ledger) {
      assert.strictEqual(entry.status, 'completed', `${entry.agentId} is ${entry.status}`);
      assert.ok(entry.summary, `${entry.agentId} has no summary`);
      assert.ok(entry.finishedAt, `${entry.agentId} has no finish time`);
      assert.ok(existsSync(join(runDir(report.runId), entry.agentId, 'output.json')), `${entry.agentId} left no output`);
    }
    const manifest = readManifest(report.runId)!;
    assert.strictEqual(manifest.idea, IDEA);
    assert.strictEqual(manifest.agents.length, 20);
    assert.deepStrictEqual(manifest.waves, executionWaves());
  });

  test('leaves no agent in a working state once the run is over', () => {
    const state = readState();
    for (const id of AGENT_IDS.map((a) => a.id)) {
      const agent = state.agents[id];
      assert.ok(agent, `${id} is missing from the live state`);
      assert.notStrictEqual(agent.state, 'WORKING', `${id} is still marked as working`);
      if (PRE_CLOUD_STOP.includes(id)) assert.strictEqual(agent.state, 'IDLE', `${id} ran when it should not have`);
    }
  });
});

describe('resuming a run', () => {
  test('reuses verified work instead of redoing it', async () => {
    const before = hashesOf(PROJECT_ROOT);
    const mtime = statSync(join(PROJECT_ROOT, 'app/build.gradle.kts')).mtimeMs;
    const resumed = await resumeRun(report.runId, { projectRoot: PROJECT_ROOT, mode: 'pre-cloud', echo: false });
    assert.strictEqual(resumed.status, 'completed');
    assert.strictEqual(resumed.runId, report.runId, 'a resume must continue the same run');
    assert.strictEqual(resumed.agents.filter((a) => a.status === 'completed').length, 16);
    assert.deepStrictEqual(hashesOf(PROJECT_ROOT), before, 'a resume must not rewrite the project');
    assert.strictEqual(statSync(join(PROJECT_ROOT, 'app/build.gradle.kts')).mtimeMs, mtime);
    assert.ok(resumed.elapsedMs < 2000, `resuming took ${resumed.elapsedMs}ms, which is work being redone`);
  });

  test('says so in the report rather than pretending the agents ran again', async () => {
    const resumed = await runCoordinator({ runId: report.runId, projectRoot: PROJECT_ROOT, mode: 'pre-cloud', echo: false });
    for (const agent of resumed.agents) {
      if (agent.status !== 'completed') continue;
      assert.ok(agent.summary, `${agent.id} lost its summary on resume`);
    }
    assert.strictEqual(resumed.agents.filter((a) => a.status === 'skipped').length, 4);
  });
});

describe('what a run reports about itself', () => {
  test('lists the agents that finished and the stages they proved', () => {
    const inspection = inspectRun(report.runId);
    assert.strictEqual(inspection.idea, IDEA);
    assert.strictEqual(inspection.completedAgents.length, 16);
    assert.strictEqual(inspection.failedAgents.length, 0);
    assert.ok(inspection.pendingAgents.includes('build-verifier'), 'the cloud agents are still pending');
    assert.deepStrictEqual(inspection.evidence, ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'TESTGEN', 'VALIDATE']);
    assert.ok(inspection.missingEvidence.includes('IMPLEMENT'), 'nothing has been pushed yet');
    assert.strictEqual(inspection.fleetComplete, false, 'the cloud agents have not run');
    assert.strictEqual(inspection.runComplete, false, 'no app has been delivered');
  });

  test('names the stage the run still needs', () => {
    assert.strictEqual(nextStage(report.runId), 'IMPLEMENT');
  });

  test('finds the run on disk', () => {
    const runs = listRuns();
    const mine = runs.find((r) => r.runId === report.runId);
    assert.ok(mine, 'the run should be listed');
    assert.strictEqual(mine.agentsCompleted, 16);
    assert.strictEqual(mine.agentsTotal, 20);
    assert.strictEqual(mine.current, true);
  });

  test('drops evidence from a stage when a run has to be rebuilt from there', () => {
    const dropped = invalidateFromStage('SCAFFOLD', 'the project scaffolding was wrong');
    assert.ok(dropped > 0, 'invalidating from SCAFFOLD should drop the later stages');
    const chain = readState().evidence!.stages!.map((s) => s.stage);
    assert.deepStrictEqual(chain, ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN']);
    assert.strictEqual(nextStage(), 'SCAFFOLD');
    assert.strictEqual(inspectRun(report.runId).fleetComplete, false);
  });

  test('every agent spec is reachable from the registry the coordinator uses', () => {
    const registryIds = new Set(AGENTS.map((a) => a.id));
    for (const id of AGENT_IDS.map((a) => a.id)) {
      assert.ok(registryIds.has(id), `${id} is missing from the registry`);
    }
  });
});

describe('starting a new run', () => {
  test('does not inherit what the previous run proved', async () => {
    const previous = report.runId;
    const before = readState();
    assert.ok((before.evidence?.stages ?? []).length > 0, 'the run under test should have proved something');

    const restarted = await restartRun('Book tracker for reading', { projectRoot: PROJECT_ROOT, mode: 'pre-cloud', echo: false });

    assert.strictEqual(restarted.status, 'completed', JSON.stringify(restarted.failures));
    assert.notStrictEqual(restarted.runId, previous, 'a restart must be a new run');
    assert.strictEqual(readManifest(restarted.runId)!.idea, 'Book tracker for reading');

    const chain = readState().evidence!.stages!;
    assert.deepStrictEqual(chain.map((s) => s.stage), ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'TESTGEN', 'VALIDATE']);
    for (const stage of chain) {
      assert.ok(!stage.notes?.includes(previous), `${stage.stage} quotes the run that came before it`);
    }
    assert.ok(inspectRun(restarted.runId).evidence.includes('IDEA'), 'the new run must prove its own idea');
  });

  test('records the abandonment in the log rather than hiding it', () => {
    const events = readEvents();
    const abandoned = events.find((e: any) => typeof e.activity === 'string' && e.activity.includes('abandoned'));
    assert.ok(abandoned, 'the state change should say which run was given up');
    assert.ok(String(abandoned.activity).includes('Book tracker for reading'), `the reason should name the new idea: ${abandoned.activity}`);
    assert.ok(
      events.some((e: any) => e.type === Events.REPAIR_STARTED && String(e.errors?.[0] ?? '').includes('before-restart')),
      'the repair event should point at the checkpoint that kept the old evidence'
    );
    assert.strictEqual(readLedger(report.runId).length, 16, 'the run that was abandoned must stay on disk');
  });

  test('keeps what the previous run recorded readable', () => {
    const names = listCheckpoints().map((c) => c.name);
    assert.ok(names.includes('before-restart'), `expected a before-restart checkpoint, found ${names.join(', ') || 'none'}`);
    const restored = loadCheckpoint(listCheckpoints().find((c) => c.name === 'before-restart')!.file);
    assert.ok(restored, 'the checkpoint should load');
    assert.ok((restored.evidence?.stages ?? []).length > 0, 'the checkpoint should still hold the old evidence');
  });
});

describe('a new idea on a checkout that still holds the last run', () => {
  // A workflow checkout of main carries .builder/live/state.json from whatever ran
  // last, including a delivered run whose evidence chain is complete. A new idea
  // that inherited it would report another app's proof as its own, and the state
  // validator would accept it because every individual link is real. This runs the
  // command line the workflow runs, not the function behind it.
  test('the CLI starts the new idea from an empty chain', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'builder-stale-state-'));
    const agentDir = join(stateDir, 'agents');
    // The generated project is tracked, so the child process writes to a copy.
    const projectRoot = mkdtempSync(join(tmpdir(), 'builder-stale-project-'));
    const stale = readState();
    assert.ok((stale.evidence?.stages ?? []).length > 0, 'the finished run should have proved something');

    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/coordinator.ts', 'Book tracker for reading', '--pre-cloud', '--concurrency', '4'],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          BUILDER_STATE_DIR: stateDir,
          BUILDER_CHECKPOINT_DIR: join(stateDir, 'checkpoints'),
          BUILDER_REQUESTS_DIR: join(stateDir, 'requests'),
          BUILDER_AGENT_DIR: agentDir,
          BUILDER_PROJECT_DIR: projectRoot
        }
      }
    );
    assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const fresh = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
    const chain = fresh.evidence.stages.map((s: { stage: string }) => s.stage);
    assert.deepStrictEqual(
      chain,
      ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD', 'TESTGEN', 'VALIDATE'],
      'the new run must prove only its own stages'
    );
    assert.ok(!JSON.stringify(fresh.evidence).includes(report.runId), 'no stage may quote the earlier run');
    assert.ok(existsSync(join(projectRoot, 'app/build.gradle.kts')), 'the run wrote its own project');
    const pointer = JSON.parse(readFileSync(join(agentDir, 'current-run.json'), 'utf-8'));
    assert.strictEqual(pointer.idea, 'Book tracker for reading', 'the run store belongs to the new idea');
    assert.notStrictEqual(pointer.runId, report.runId, 'the new idea must be a new run');
    assert.ok(!JSON.stringify(fresh).includes('Plant watering journal'), 'nothing in the state still describes the last idea');
  });

  test('the abandoned run is still readable afterwards', () => {
    const checkpoints = readdirSync(join(process.env.BUILDER_CHECKPOINT_DIR!, '.')).filter((f) => f.startsWith('before-restart--'));
    assert.ok(checkpoints.length > 0, 'the state it replaced must be checkpointed');
    const saved = JSON.parse(readFileSync(join(process.env.BUILDER_CHECKPOINT_DIR!, checkpoints[0]), 'utf-8'));
    assert.ok((saved.evidence?.stages ?? []).length > 0, 'and the checkpoint holds the evidence it had');
  });
});
