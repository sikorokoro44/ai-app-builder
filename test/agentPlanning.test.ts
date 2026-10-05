import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { assemblePlan, deriveSections, planForIdea, PlanAssemblyError } from '../scripts/agents/planner.ts';
import { GENERATED_BUILD } from '../scripts/project/emitters.ts';
import { specForIdea } from '../scripts/domainModels.ts';
import { unitTestCount } from '../scripts/project/emitters.ts';
import { AGENT_IDS, isAgentId } from '../scripts/agents/agentIds.ts';
import { ownsFile, writesProject } from '../scripts/agents/ownership.ts';
import { decideIcon } from '../scripts/iconCatalog.ts';

const IDEAS = [
  'A tiny recipe organiser for what I baked this week',
  'An expense tracker with a monthly budget',
  'A pomodoro focus timer for deep work',
  'A contact phonebook for my small business',
  'A flashcard study app for vocabulary',
  'Plant watering journal for my flat',
  'A budget planner for saving money each month',
  'A reading list of books I want to finish'
];

function handoffsFor(idea: string) {
  const sections = deriveSections(idea);
  const spec = specForIdea(idea);
  return {
    requirements: sections.requirements,
    domain: { spec, actions: spec.actions },
    architecture: sections.architecture,
    ui: { screens: sections.screens },
    security: sections.security
  };
}

describe('planning an arbitrary idea', () => {
  test('produces a plan for every idea without asking what the app is', () => {
    for (const idea of IDEAS) {
      const plan = planForIdea(idea);
      assert.strictEqual(plan.idea, idea.trim());
      assert.ok(plan.appName.length > 0, `${idea} produced no app name`);
      assert.ok(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(plan.packageId), `${idea} produced package id ${plan.packageId}`);
      assert.ok(plan.entity.className.length > 1, `${idea} produced no entity`);
      assert.ok(plan.requirements.length >= 8, `${idea} produced only ${plan.requirements.length} requirements`);
      assert.strictEqual(plan.tasks.length, AGENT_IDS.length, `${idea} did not plan one task per agent`);
    }
  });

  test('derives different plans for different ideas', () => {
    const plans = IDEAS.map((idea) => planForIdea(idea));
    const packageIds = new Set(plans.map((p) => p.packageId));
    const entities = new Set(plans.map((p) => p.entity.className));
    const models = new Set(plans.map((p) => `${p.entity.fields.map((f) => f.type).join()}|${p.entity.actions.join()}`));
    assert.ok(packageIds.size >= 5, `only ${packageIds.size} distinct package ids across ${IDEAS.length} ideas`);
    assert.ok(entities.size >= 5, `only ${entities.size} distinct entities across ${IDEAS.length} ideas`);
    assert.ok(models.size >= 4, `only ${models.size} distinct data models across ${IDEAS.length} ideas`);
  });

  test('plans the same thing twice for the same idea', () => {
    const a = planForIdea('A todo list for my week');
    const b = planForIdea('A todo list for my week');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  });

  test('carries the pinned build configuration into the architecture', () => {
    for (const idea of IDEAS) {
      const architecture = planForIdea(idea).architecture;
      assert.strictEqual(architecture.language, 'Kotlin');
      assert.ok(architecture.uiToolkit.includes('Compose'), `${idea} planned ${architecture.uiToolkit}`);
      assert.strictEqual(architecture.minSdk, GENERATED_BUILD.minSdk);
      assert.strictEqual(architecture.targetSdk, GENERATED_BUILD.targetSdk);
      assert.strictEqual(architecture.compileSdk, GENERATED_BUILD.compileSdk);
      assert.ok(architecture.rationale.length >= 3, `${idea} recorded no rationale`);
      assert.ok(architecture.entrypoint.endsWith('MainActivity'), `${idea} planned the entrypoint ${architecture.entrypoint}`);
    }
  });

  test('requires exactly the tests the generator really writes', () => {
    for (const idea of IDEAS) {
      const plan = planForIdea(idea);
      const real = unitTestCount(plan.entity);
      assert.strictEqual(plan.verification.minimumUnitTests, real, `${idea} plans ${plan.verification.minimumUnitTests} tests, the generator writes ${real}`);
      assert.strictEqual(plan.verification.unitTestClass, `${plan.entity.className}StoreTest`);
    }
  });

  test('designs the empty, populated and rejected states for every screen', () => {
    for (const idea of IDEAS) {
      const plan = planForIdea(idea);
      for (const screen of plan.screens) {
        for (const state of ['populated', 'empty', 'input-rejected']) {
          assert.ok(screen.states.includes(state), `${idea}: screen ${screen.id} does not design ${state}`);
        }
        assert.ok(screen.copyKeys.length > 0, `${idea}: screen ${screen.id} designs no copy`);
        assert.ok(screen.elements.length > 0, `${idea}: screen ${screen.id} designs no elements`);
      }
    }
  });

  test('gives every requirement a rationale and acceptance criteria', () => {
    for (const idea of IDEAS) {
      for (const requirement of planForIdea(idea).requirements) {
        assert.ok(requirement.statement.length > 8, `${idea}: ${requirement.id} has no statement`);
        assert.ok(requirement.rationale.length > 5, `${idea}: ${requirement.id} has no rationale`);
        assert.ok(requirement.acceptance.length > 0, `${idea}: ${requirement.id} has no acceptance criteria`);
      }
    }
  });

  test('takes the icon decision from the idea, and the fingerprint from the bytes', () => {
    for (const idea of IDEAS) {
      const plan = planForIdea(idea);
      const decision = decideIcon(idea, plan.appName);
      assert.strictEqual(plan.icon.category, decision.definition.category);
      assert.ok(plan.icon.reason.length > 5, `${idea} recorded no reason for its icon`);
      // The plan describes the decision; the fingerprint belongs to the pixels
      // that the brand engineer actually writes, so it must not be invented here.
      assert.ok(!plan.icon.fingerprint, 'the plan must not claim an icon fingerprint it has not produced');
    }
  });

  test('asks for no permission the app does not need', () => {
    for (const idea of IDEAS) {
      const security = planForIdea(idea).security;
      assert.deepStrictEqual(security.permissions, ['android.permission.INTERNET']);
      assert.ok(security.secretPolicy.length >= 2, `${idea} has no credential policy`);
      assert.ok(security.mitigations.length > 0, `${idea} has no mitigations`);
    }
  });
});

describe('the task graph', () => {
  test('gives every task a known owner and a completion condition', () => {
    for (const idea of IDEAS) {
      const plan = planForIdea(idea);
      const ids = new Set<string>();
      for (const task of plan.tasks) {
        assert.ok(isAgentId(task.agentId), `${idea}: task ${task.id} names ${task.agentId}`);
        assert.ok(task.completion.length > 8, `${idea}: task ${task.id} has no completion condition`);
        assert.ok(!ids.has(task.id), `${idea}: task ${task.id} appears twice`);
        ids.add(task.id);
      }
      for (const id of AGENT_IDS.map((a) => a.id)) {
        assert.ok(plan.tasks.some((t) => t.agentId === id), `${idea}: no task belongs to ${id}`);
      }
    }
  });

  test('depends only on tasks that exist, and resolves into waves', () => {
    for (const idea of IDEAS) {
      const plan = planForIdea(idea);
      const byId = new Map(plan.tasks.map((t) => [t.id, t]));
      const waveOf = new Map<string, number>();
      plan.waves.forEach((wave, at) => wave.forEach((id) => waveOf.set(id, at)));
      for (const task of plan.tasks) {
        assert.ok(waveOf.has(task.id), `${idea}: task ${task.id} is in no wave`);
        for (const dep of task.dependsOn) {
          assert.ok(byId.has(dep), `${idea}: task ${task.id} depends on the unknown ${dep}`);
          assert.ok(waveOf.get(dep)! < waveOf.get(task.id)!, `${idea}: ${task.id} is scheduled before ${dep}`);
        }
      }
    }
  });

  test('matches the files each task claims to the ownership of its agent', () => {
    for (const idea of IDEAS) {
      for (const task of planForIdea(idea).tasks) {
        if (writesProject(task.agentId)) {
          assert.ok(task.files.length > 0, `${idea}: ${task.agentId} writes into the project but ${task.id} lists no files`);
          for (const file of task.files) {
            assert.ok(ownsFile(task.agentId, file), `${idea}: ${task.id} claims ${file}, which ${task.agentId} does not own`);
          }
        } else {
          assert.deepStrictEqual(task.files, [], `${idea}: ${task.id} claims files although ${task.agentId} writes none`);
        }
      }
    }
  });
});

describe('refusing to assemble a plan that does not add up', () => {
  test('rejects a missing requirement', () => {
    const idea = 'A recipe organiser';
    const handoffs = handoffsFor(idea);
    assert.throws(
      () => assemblePlan(idea, { ...handoffs, requirements: handoffs.requirements.slice(1) }),
      (e: unknown) => e instanceof PlanAssemblyError && /requirement/i.test(e.problems.join()),
      'a dropped requirement must stop the planner'
    );
  });

  test('rejects a screen whose copy key was never designed', () => {
    const idea = 'A recipe organiser';
    const handoffs = handoffsFor(idea);
    const screens = JSON.parse(JSON.stringify(handoffs.ui.screens));
    screens[0].copyKeys.push('unplanned_string');
    assert.throws(
      () => assemblePlan(idea, { ...handoffs, ui: { screens } }),
      (e: unknown) => e instanceof PlanAssemblyError,
      'an invented copy key must stop the planner'
    );
  });

  test('rejects a build configuration that is not the pinned one', () => {
    const idea = 'A recipe organiser';
    const handoffs = handoffsFor(idea);
    const architecture = { ...handoffs.architecture, minSdk: 21 };
    assert.throws(
      () => assemblePlan(idea, { ...handoffs, architecture }),
      (e: unknown) => e instanceof PlanAssemblyError && /minSdk|SDK/i.test(e.problems.join()),
      'an SDK the workflow cannot build must stop the planner'
    );
  });

  test('rejects a security section with no credential policy', () => {
    const idea = 'A recipe organiser';
    const handoffs = handoffsFor(idea);
    assert.throws(
      () => assemblePlan(idea, { ...handoffs, security: { ...handoffs.security, secretPolicy: [] } }),
      (e: unknown) => e instanceof PlanAssemblyError && /secret|credential/i.test(e.problems.join()),
      'an app with no credential policy must not be planned'
    );
  });

  test('rejects a domain model the generator cannot emit', () => {
    const idea = 'A recipe organiser';
    const handoffs = handoffsFor(idea);
    assert.throws(
      () => assemblePlan(idea, { ...handoffs, domain: { spec: handoffs.domain.spec, actions: ['levitate'] } }),
      (e: unknown) => e instanceof PlanAssemblyError,
      'an action with no generator support must stop the planner'
    );
  });

  test('reports every problem it found, not just the first', () => {
    const idea = 'A recipe organiser';
    const handoffs = handoffsFor(idea);
    try {
      assemblePlan(idea, {
        ...handoffs,
        requirements: handoffs.requirements.slice(0, 2),
        security: { ...handoffs.security, secretPolicy: [] }
      });
      assert.fail('the planner assembled an inconsistent set of sections');
    } catch (e) {
      assert.ok(e instanceof PlanAssemblyError);
      assert.ok(e.problems.length > 1, 'the planner should report more than one problem at a time');
    }
  });
});
