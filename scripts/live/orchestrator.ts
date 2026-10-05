#!/usr/bin/env node
/**
 * Register the fleet and show where a run would start.
 *
 * Starting the orchestrator is safe at any point in a run: it seeds the twenty
 * real agents in the live state so progress views can name them, and it touches
 * nothing else. It used to force the project back to READY and zero every
 * progress counter, which destroyed real work in progress and attempted an
 * illegal transition whenever the build was already running.
 */
import { initStateStore, readState, writeState, appendEvent } from './stateStore.ts';
import { AgentStates, Events } from '../../shared/types.ts';
import { AGENT_IDS } from '../agents/agentIds.ts';
import { executionWaves, validateRegistry } from '../agents/registry.ts';

initStateStore();
const problems = validateRegistry();
if (problems.length) {
  console.error('The agent registry is invalid:');
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}

const state = readState();
const at = new Date().toISOString();
state.agents = { ...(state.agents || {}) };
for (const agent of AGENT_IDS) {
  const existing = state.agents[agent.id];
  state.agents[agent.id] = {
    id: agent.id,
    index: agent.index,
    name: agent.name,
    state: existing?.state || AgentStates.IDLE,
    activity: existing?.activity || 'waiting for dependencies',
    updatedAt: existing?.updatedAt || at
  };
  if (!existing) appendEvent({ type: Events.AGENT_STARTED, agentId: agent.id, name: agent.name });
}
writeState(state);

const waves = executionWaves();
console.log(`Orchestrator ready: ${AGENT_IDS.length} agents in ${waves.length} waves, project state ${state.projectState}`);
for (const wave of waves) console.log(`  ${String(waves.indexOf(wave) + 1).padStart(2)}. ${wave.join(', ')}`);
