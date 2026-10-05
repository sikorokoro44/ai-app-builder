#!/usr/bin/env node
/**
 * Plan for an idea and keep the legacy queue file in step.
 *
 * `scripts/planner.ts` derives the plan; this wrapper also writes the feature
 * queue that the per-feature views read, so the fleet and the old dashboards
 * cannot drift apart. Like the planner it leaves `.builder/idea.txt` alone: that
 * file is tracked and belongs to whoever started the run.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { planForIdea } from './agents/planner.ts';

const idea = (process.env.BUILDER_IDEA || process.argv.slice(2).join(' ') || '').trim();
if (!idea) {
  console.error('No idea to plan. Set BUILDER_IDEA or pass the idea as an argument.');
  process.exit(1);
}

const plan = planForIdea(idea);
const planPath = process.env.BUILDER_PLAN_PATH || '.builder/plan.json';
const queuePath = process.env.BUILDER_QUEUE_PATH || '.builder/queue.json';
mkdirSync(dirname(planPath), { recursive: true });
mkdirSync(dirname(queuePath), { recursive: true });
writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
writeFileSync(queuePath, `${JSON.stringify({
  idea: plan.idea,
  generatedAt: new Date().toISOString(),
  planner: 'scripts/agents/planner.ts',
  features: plan.features.map((f) => ({
    id: f.id,
    title: f.title,
    description: f.description,
    ownerAgent: f.ownerAgent,
    dependsOn: f.dependsOn,
    acceptance: f.acceptance,
    files: f.files,
    tasks: f.tasks
  }))
}, null, 2)}\n`);

console.log(`Planned ${plan.features.length} features for ${plan.packageId}; queue written to ${queuePath}`);
