#!/usr/bin/env node
/**
 * Derive the build plan for an idea.
 *
 * The plan is a pure function of the idea text: the entity model, requirements,
 * screens, architecture, security posture, icon decision, features, tasks and
 * execution waves all come from `scripts/agents/planner.ts`. Nothing here is
 * hard-coded per app, and nothing here writes files into the generated project.
 *
 * `.builder/idea.txt` is tracked and belongs to whoever started the run; this
 * script reads nothing from it and writes nothing to it. The plan is written to
 * `BUILDER_PLAN_PATH` when that is set and to `.builder/plan.json` otherwise,
 * both of which are run artifacts rather than repository content.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { planForIdea } from './agents/planner.ts';
import { validateRegistry } from './agents/registry.ts';

const idea = (process.env.BUILDER_IDEA || process.argv.slice(2).join(' ') || '').trim();
if (!idea) {
  console.error('No idea to plan. Set BUILDER_IDEA or pass the idea as an argument.');
  process.exit(1);
}
const problems = validateRegistry();
if (problems.length) {
  console.error('The agent registry is invalid:');
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}

const plan = planForIdea(idea);
const planPath = process.env.BUILDER_PLAN_PATH || '.builder/plan.json';
mkdirSync(dirname(planPath), { recursive: true });
writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

console.log(`Planned ${plan.features.length} features and ${plan.tasks.length} tasks for "${plan.appName}"`);
console.log(`  package ${plan.packageId}, entity ${plan.entity.className}, ${plan.verification.minimumUnitTests} unit tests, ${plan.verification.unitTestClass}`);
console.log(`  icon ${plan.icon.category}: ${plan.icon.reason}`);
const owners = new Map(plan.tasks.map((t) => [t.id, t.agentId]));
plan.waves.forEach((wave, at) => {
  console.log(`  wave ${String(at + 1).padStart(2)}: ${wave.map((id) => `${owners.get(id) ?? id}`).join(', ')}`);
});
console.log(`Plan written to ${planPath}`);
