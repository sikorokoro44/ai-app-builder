#!/usr/bin/env node
/**
 * Run a single agent inside a run.
 *
 * The coordinator normally schedules the fleet itself. This entry point exists
 * for the case where one agent has to be executed on its own — a workflow step
 * that runs after a crash, an operator re-running one stage, or a test that wants
 * to exercise one spec without the scheduler around it. It waits for the agent's
 * dependencies to be satisfied first, and refuses to run an agent whose handoffs
 * are not on disk.
 */
import { agentById } from './agents/registry.ts';
import { AGENT_ID_NAMES } from './agents/agentIds.ts';
import { isAgentComplete, readArtifact, resolveRunId, artifactPath } from './agents/artifacts.ts';
import { runCoordinator } from './agents/coordinator.ts';
import { inspectRun } from './agents/recovery.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? '' : argv[at + 1] ?? '';
};
const agentId = value('agent') || argv.filter((a) => !a.startsWith('--'))[0] || process.env.BUILDER_AGENT_ID || '';

if (flag('help') || !agentId) {
  console.log(`Usage: scripts/worker.ts --agent <id> [--run <runId>]
Agents: ${AGENT_ID_NAMES.join(', ')}`);
  process.exit(agentId ? 0 : 1);
}
if (!AGENT_ID_NAMES.includes(agentId)) {
  console.error(`Unknown agent ${agentId}. The fleet is: ${AGENT_ID_NAMES.join(', ')}`);
  process.exit(1);
}

const runId = resolveRunId(value('run') || undefined);
const idea = inspectRun(runId).idea;
const spec = agentById(agentId);
const mode = flag('pre-cloud') ? ('pre-cloud' as const) : ('full' as const);

// The scheduler is still the thing that knows when an agent is allowed to run:
// hand the single-agent request back to it, with everything else held back. The
// agent's dependencies have to be on disk already; if they are not, the
// coordinator will not run it and this script says so.
const inspection = inspectRun(runId);
const unmet = spec.dependsOn.filter((id) => !inspection.completedAgents.includes(id));
if (unmet.length) {
  console.error(
    `${agentId} cannot run yet: ${unmet.join(', ')} ${unmet.length === 1 ? 'has' : 'have'} not completed in ${runId}. ` +
    `Run them first, or run the whole fleet with scripts/coordinator.ts.`
  );
  process.exit(1);
}

const report = await runCoordinator({
  runId,
  idea,
  mode,
  maxConcurrency: Number(value('concurrency') || 4),
  only: [agentId],
  echo: true
});

const entry = report.agents.find((a) => a.id === agentId);
const status = entry?.status ?? 'skipped';
console.log(`${agentId} (${spec.name}): ${status}${entry?.summary ? ` — ${entry.summary}` : ''}`);
if (status === 'completed' && !isAgentComplete(runId, agentId)) {
  console.error(`${agentId} reported success but ${artifactPath(runId, agentId, 'output')} is not on disk`);
  process.exit(1);
}
for (const kind of spec.contract.outputs.map((o) => o.kind)) {
  if (!readArtifact(runId, agentId, kind)) console.error(`warning: ${agentId} published no ${kind} artifact`);
}
process.exit(status === 'completed' ? 0 : 1);
