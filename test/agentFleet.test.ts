import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  AGENTS,
  agentById,
  agentIds,
  anyPathConflict,
  dependencyClosure,
  dependents,
  executionWaves,
  pathsConflict,
  validateRegistry
} from '../scripts/agents/registry.ts';
import { AGENT_IDS, AGENT_ID_NAMES, agentIndex } from '../scripts/agents/agentIds.ts';
import { EXCLUSIVE_GROUPS, OWNED_PATHS, ownsFile, writesProject } from '../scripts/agents/ownership.ts';
import { runCoordinator, pathBetween } from '../scripts/agents/coordinator.ts';
import { VALID_TRANSITIONS } from '../scripts/live/stateValidator.ts';

describe('the fleet', () => {
  test('holds exactly the twenty registered agents, in order', () => {
    assert.strictEqual(AGENTS.length, 20);
    assert.deepStrictEqual(agentIds(), AGENT_IDS.map((a) => a.id));
    assert.strictEqual(AGENT_ID_NAMES.length, 20);
    for (const agent of AGENTS) {
      assert.strictEqual(agent.index, agentIndex(agent.id), `${agent.id} is out of order`);
      assert.ok(agentIndex(agent.id) >= 1 && agentIndex(agent.id) <= 20, `${agent.id} has no position in the fleet`);
    }
  });

  test('is internally consistent', () => {
    const problems = validateRegistry();
    assert.deepStrictEqual(problems, [], problems.join('\n'));
  });

  test('declares a responsibility, tools, criteria and a failure policy for every agent', () => {
    for (const agent of AGENTS) {
      assert.ok(agent.responsibility.length > 40, `${agent.id} does not say what it is for`);
      assert.ok(agent.tools.length > 0, `${agent.id} declares no tools`);
      assert.ok(agent.completionCriteria.length > 0, `${agent.id} declares no completion criteria`);
      assert.ok(agent.failurePolicy.maxAttempts >= 1, `${agent.id} cannot attempt anything`);
      assert.ok(
        ['fail', 'replan', 'rollback'].includes(agent.failurePolicy.onExhausted),
        `${agent.id} has no meaningful exhausted policy`
      );
      assert.ok(agent.contract.outputs.length > 0, `${agent.id} produces nothing`);
    }
  });

  test('starts with an agent that has no dependencies', () => {
    const roots = AGENTS.filter((a) => a.dependsOn.length === 0).map((a) => a.id);
    assert.deepStrictEqual(roots, ['idea-intake']);
  });

  test('depends only on agents that come earlier in the fleet', () => {
    for (const agent of AGENTS) {
      for (const dep of agent.dependsOn) {
        assert.ok(agentIndex(dep) < agent.index, `${agent.id} (${agent.index}) depends on the later ${dep}`);
      }
    }
  });

  test('resolves into waves where every dependency is in an earlier wave', () => {
    const waves = executionWaves();
    assert.ok(waves.length >= 10, `the fleet only resolved into ${waves.length} waves`);
    const waveOf = new Map<string, number>();
    waves.forEach((wave, at) => wave.forEach((id) => waveOf.set(id, at)));
    assert.strictEqual(waveOf.size, 20, 'every agent must appear in exactly one wave');
    for (const agent of AGENTS) {
      for (const dep of agent.dependsOn) {
        assert.ok(waveOf.get(dep)! < waveOf.get(agent.id)!, `${agent.id} may start before ${dep} finishes`);
      }
    }
    assert.strictEqual(waves[0].length, 1, 'the first wave should be the single intake agent');
  });

  test('runs the four independent file owners in one wave, after the manifest', () => {
    const waves = executionWaves();
    const wave = waves.find((w) => w.includes('data-engineer'))!;
    for (const id of ['data-engineer', 'ui-engineer', 'resource-engineer', 'brand-engineer']) {
      assert.ok(wave.includes(id), `${id} should share the wave with the other file owners`);
    }
    const manifestWave = waves.indexOf(waves.find((w) => w.includes('manifest-engineer'))!);
    assert.ok(manifestWave < waves.indexOf(wave), 'the file owners need the manifest first');
  });

  test('closes with the oversight agents last', () => {
    const waves = executionWaves();
    assert.ok(waves[waves.length - 1].includes('integration-supervisor'));
    const last = waves[waves.length - 1];
    for (const id of ['failure-diagnostician', 'repo-publisher', 'build-verifier', 'release-publisher']) {
      assert.ok(waves.some((w) => w.includes(id)), `${id} must run somewhere in the pipeline`);
      assert.ok(!last.includes(id) || id === 'integration-supervisor');
    }
  });

  test('every agent depends, directly or not, on the intake agent', () => {
    const reachable = dependents(AGENTS, 'idea-intake');
    assert.strictEqual(reachable.size, 19, `the graph is not connected: ${AGENT_IDS.map((a) => a.id).filter((id) => !reachable.has(id)).join(', ')} wait for nobody`);
    assert.deepStrictEqual(dependencyClosure(AGENTS, 'integration-supervisor').size, 19);
  });

  test('reads only from agents it can actually wait for', () => {
    for (const agent of AGENTS) {
      const closure = dependencyClosure(AGENTS, agent.id);
      for (const input of agent.contract.inputs) {
        if (!input.producedBy || input.optional) continue;
        assert.ok(closure.has(input.producedBy), `${agent.id} reads ${input.kind} but cannot wait for ${input.producedBy}`);
      }
    }
  });

  test('publishes what its contract promises', () => {
    const producers = new Map<string, Set<string>>();
    for (const agent of AGENTS) {
      for (const output of agent.contract.outputs) {
        if (!producers.has(output.kind)) producers.set(output.kind, new Set());
        producers.get(output.kind)!.add(agent.id);
      }
    }
    for (const [kind, ids] of producers) {
      assert.strictEqual(ids.size, 1, `${kind} is produced by more than one agent: ${[...ids].join(', ')}`);
    }
    for (const agent of AGENTS) {
      for (const input of agent.contract.inputs) {
        assert.ok(producers.has(input.kind), `nobody produces ${input.kind}, which ${agent.id} reads`);
        const producer = [...producers.get(input.kind)!][0];
        assert.strictEqual(producer, input.producedBy, `${input.kind} comes from ${producer}, not ${input.producedBy}`);
      }
    }
  });
});

describe('path ownership', () => {
  test('agrees with the ownership table', () => {
    for (const agent of AGENTS) {
      assert.deepStrictEqual(
        [...agent.ownedPaths].sort(),
        [...(OWNED_PATHS[agent.id] ?? [])].sort(),
        `${agent.id} declares different owned paths than the ownership table`
      );
    }
  });

  test('never lets two agents claim the same file', () => {
    const writers = AGENTS.filter((a) => writesProject(a.id));
    assert.strictEqual(writers.length, 7, 'seven agents write into the generated project');
    for (let i = 0; i < writers.length; i++) {
      for (let j = i + 1; j < writers.length; j++) {
        for (const a of writers[i].ownedPaths) {
          for (const b of writers[j].ownedPaths) {
            assert.notStrictEqual(a, b, `${writers[i].id} and ${writers[j].id} both claim ${a}`);
          }
        }
      }
    }
  });

  test('leaves no file of the generated project with two writers', () => {
    const writers = AGENTS.filter((a) => writesProject(a.id));
    const overlapping: string[] = [];
    for (let i = 0; i < writers.length; i++) {
      for (let j = i + 1; j < writers.length; j++) {
        if (anyPathConflict(writers[i].ownedPaths, writers[j].ownedPaths)) {
          overlapping.push(`${writers[i].id}/${writers[j].id}`);
        }
      }
    }
    assert.deepStrictEqual(overlapping, [], 'two agents claim the same part of the project');
  });

  test('separates the resource values from the icon values', () => {
    // The icon colours live in `res/values` next to the theme, so ownership has to
    // be per file. The scheduler still catches the mistake if that ever slips.
    assert.ok(!pathsConflict('app/src/main/res/values/strings.xml', 'app/src/main/res/values/ic_launcher_colors.xml'));
    assert.ok(ownsFile('resource-engineer', 'app/src/main/res/values/strings.xml'));
    assert.ok(!ownsFile('resource-engineer', 'app/src/main/res/values/ic_launcher_colors.xml'));
    assert.ok(ownsFile('brand-engineer', 'app/src/main/res/values/ic_launcher_colors.xml'));
    assert.ok(pathsConflict('app/src/main/res/values', 'app/src/main/res/values/ic_launcher_colors.xml'));
    assert.ok(!pathsConflict('app/src/main/java/**/*Store.kt', 'app/src/main/java/**/MainActivity.kt'));
  });

  test('resolves wildcards and directories to real files', () => {
    assert.ok(ownsFile('data-engineer', 'app/src/main/java/com/x/y/RecipeStore.kt'));
    assert.ok(ownsFile('data-engineer', 'app/src/main/java/RecipeStore.kt'));
    assert.ok(!ownsFile('data-engineer', 'app/src/main/java/com/x/y/MainActivity.kt'));
    assert.ok(ownsFile('resource-engineer', 'app/src/main/res/values/strings.xml'));
    assert.ok(!ownsFile('resource-engineer', 'app/src/main/res/mipmap-mdpi/ic_launcher.png'));
    assert.ok(ownsFile('brand-engineer', 'app/src/main/res/values/ic_launcher_colors.xml'));
    assert.ok(ownsFile('test-engineer', 'app/src/test/java/com/x/RecipeStoreTest.kt'));
    assert.ok(!ownsFile('ui-engineer', 'app/src/test/java/com/x/RecipeStoreTest.kt'));
  });

  test('gives the cloud, the workspace and the release to one agent at a time', () => {
    assert.strictEqual(EXCLUSIVE_GROUPS['repo-publisher'], 'git-workspace');
    assert.strictEqual(EXCLUSIVE_GROUPS['build-verifier'], 'cloud');
    assert.strictEqual(EXCLUSIVE_GROUPS['release-publisher'], 'release');
    for (const agent of AGENTS) {
      const group = EXCLUSIVE_GROUPS[agent.id];
      if (!group) continue;
      const rivals = AGENTS.filter((a) => a.exclusiveGroup === group);
      assert.strictEqual(rivals.length, 1, `more than one agent claims ${group}`);
    }
  });
});

describe('lifecycle paths', () => {
  test('walks every declared transition legally', () => {
    const path = pathBetween('NOT_STARTED', 'READY');
    assert.ok(path && path.length > 0, 'there must be a legal path from NOT_STARTED to READY');
    let at = 'NOT_STARTED';
    for (const step of path) {
      assert.ok(
        (VALID_TRANSITIONS[at] ?? []).includes(step as never),
        `${at} -> ${step} is not a legal transition`
      );
      at = step;
    }
    assert.strictEqual(at, 'READY');
  });

  test('reports no path where the transition table has none', () => {
    assert.strictEqual(pathBetween('COMPLETED', 'NOT_STARTED'), null);
    assert.deepStrictEqual(pathBetween('PLANNING', 'PLANNING'), []);
  });
});

describe('the scheduler entry point', () => {
  test('refuses to start without an idea', async () => {
    await assert.rejects(
      () => runCoordinator({ idea: '   ', echo: false }),
      /no idea to build/,
      'an empty idea must not produce a run'
    );
  });

  test('names every agent it reports on', () => {
    for (const id of agentIds()) {
      assert.ok(agentById(id).name.length > 3, `${id} has no display name`);
    }
  });
});
