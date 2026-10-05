/**
 * The fleet registry.
 *
 * Twenty agents, their contracts, their dependency graph and the exclusive
 * resources they contend for. The coordinator schedules from this and nothing
 * else, so "which agent may run now" has exactly one answer in the repository.
 */

import type { AgentSpec } from '../../shared/agentTypes.ts';
import { AGENT_IDS, AGENT_ID_NAMES, agentIndex } from './agentIds.ts';
import { wavesFromDependencies } from './planner.ts';
import { EXCLUSIVE_GROUPS, OWNED_PATHS } from './ownership.ts';
import { ideaIntakeAgent, requirementsAnalystAgent, domainModelerAgent } from './agents/analysis.ts';
import { architectAgent, uiDesignerAgent, securityAnalystAgent, featurePlannerAgent } from './agents/design.ts';
import {
  projectScaffolderAgent,
  manifestEngineerAgent,
  dataEngineerAgent,
  uiEngineerAgent,
  resourceEngineerAgent,
  brandEngineerAgent
} from './agents/build.ts';
import { testEngineerAgent, qualityAuditorAgent } from './agents/quality.ts';
import { repoPublisherAgent, buildVerifierAgent, releasePublisherAgent } from './agents/shipping.ts';
import { failureDiagnosticianAgent, integrationSupervisorAgent } from './agents/oversight.ts';

export const AGENTS: AgentSpec<never, unknown>[] = [
  ideaIntakeAgent,
  requirementsAnalystAgent,
  domainModelerAgent,
  architectAgent,
  uiDesignerAgent,
  securityAnalystAgent,
  featurePlannerAgent,
  projectScaffolderAgent,
  manifestEngineerAgent,
  dataEngineerAgent,
  uiEngineerAgent,
  resourceEngineerAgent,
  brandEngineerAgent,
  testEngineerAgent,
  qualityAuditorAgent,
  repoPublisherAgent,
  buildVerifierAgent,
  releasePublisherAgent,
  failureDiagnosticianAgent,
  integrationSupervisorAgent
] as unknown as AgentSpec<never, unknown>[];

export function agentById(id: string): AgentSpec<never, unknown> {
  const found = AGENTS.find((a) => a.id === id);
  if (!found) throw new Error(`unknown agent: ${id}`);
  return found;
}

export function agentIds(): string[] {
  return AGENTS.map((a) => a.id);
}

/** The dependency graph, resolved and acyclic by construction. */
export function executionWaves(): string[][] {
  return wavesFromDependencies(agentIds(), (id) => agentById(id).dependsOn);
}

/** Every problem in the registry itself: cycles, unknown deps, empty contracts. */
export function validateRegistry(agents: AgentSpec<never, unknown>[] = AGENTS): string[] {
  const problems: string[] = [];
  const ids = new Set(agents.map((a) => a.id));
  if (agents.length !== 20) problems.push(`the fleet has ${agents.length} agents, not 20`);
  if (ids.size !== agents.length) problems.push('duplicate agent ids');
  for (const expected of AGENT_IDS) {
    if (!ids.has(expected.id)) problems.push(`the fleet is missing ${expected.id}`);
  }
  for (const agent of agents) {
    if (agent.index !== agentIndex(agent.id)) problems.push(`${agent.id} has index ${agent.index}, expected ${agentIndex(agent.id)}`);
    if (!agent.name) problems.push(`${agent.id} has no name`);
    if (!agent.role) problems.push(`${agent.id} has no role`);
    if (!agent.responsibility || agent.responsibility.length < 20) problems.push(`${agent.id} has no real responsibility`);
    if (!agent.tools.length) problems.push(`${agent.id} declares no tools`);
    // Path ownership has one home; a spec that disagrees with the table would let
    // two agents believe they own the same file, so the registry refuses to load.
    const owned = OWNED_PATHS[agent.id] ?? [];
    const declared = [...agent.ownedPaths].sort();
    if (declared.join('|') !== [...owned].sort().join('|')) {
      problems.push(`${agent.id} declares owned paths ${declared.join(', ') || 'none'}, the ownership table says ${owned.join(', ') || 'none'}`);
    }
    const group = EXCLUSIVE_GROUPS[agent.id];
    if ((agent.exclusiveGroup || undefined) !== (group || undefined)) {
      problems.push(`${agent.id} declares exclusive group ${agent.exclusiveGroup || 'none'}, the ownership table says ${group || 'none'}`);
    }
    if (!agent.completionCriteria.length) problems.push(`${agent.id} declares no completion criteria`);
    if (!agent.contract.outputs.length) problems.push(`${agent.id} produces no output artifact`);
    if (!agent.contract.requiredOutputFields.length) problems.push(`${agent.id} declares no required output fields`);
    if (typeof agent.execute !== 'function') problems.push(`${agent.id} has no execute function`);
    if (typeof agent.validate !== 'function') problems.push(`${agent.id} has no validate function`);
    if (!agent.failurePolicy || typeof agent.failurePolicy.maxAttempts !== 'number') {
      problems.push(`${agent.id} has no failure policy`);
    }
    for (const dep of agent.dependsOn) {
      if (!ids.has(dep)) problems.push(`${agent.id} depends on unknown agent ${dep}`);
    }
    for (const input of agent.contract.inputs) {
      if (input.producedBy && !ids.has(input.producedBy)) {
        problems.push(`${agent.id} expects an artifact from unknown agent ${input.producedBy}`);
        continue;
      }
      // A handoff is only guaranteed when the producer is in this agent's
      // dependency closure. Optional inputs are exempt: the producer may not have
      // run yet, which is exactly what "optional" means.
      if (input.producedBy && !input.optional && !dependencyClosure(agents, agent.id).has(input.producedBy)) {
        problems.push(`${agent.id} reads ${input.kind} from ${input.producedBy} without depending on it`);
      }
    }
  }
  try {
    executionWaves();
  } catch (e) {
    problems.push((e as Error).message);
  }
  return problems;
}

/** Every agent reachable from `id` through declared dependencies. */
export function dependencyClosure(agents: AgentSpec<never, unknown>[], id: string): Set<string> {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const current = stack.pop()!;
    for (const dep of byId.get(current)?.dependsOn ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      stack.push(dep);
    }
  }
  return seen;
}

/** Every agent that transitively depends on `id`. */
export function dependents(agents: AgentSpec<never, unknown>[], id: string): Set<string> {
  const seen = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const agent of agents) {
      if (seen.has(agent.id)) continue;
      if (agent.dependsOn.some((dep) => dep === id || seen.has(dep))) {
        seen.add(agent.id);
        grew = true;
      }
    }
  }
  return seen;
}

/**
 * Do two owned-path patterns overlap?
 *
 * Used by the scheduler to keep concurrently running agents from writing the
 * same file. `*` and `**` match a path segment, and a directory pattern covers
 * everything beneath it.
 */
export function pathsConflict(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = a.split('/');
  const pb = b.split('/');
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const sa = pa[i];
    const sb = pb[i];
    if (sa === sb) continue;
    if (sa === '*' || sa === '**' || sb === '*' || sb === '**') return true;
    return false;
  }
  // One pattern is a prefix of the other. A directory owns everything beneath
  // it, and a trailing `**` likewise covers every remaining segment.
  return true;
}

export function anyPathConflict(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => pathsConflict(x, y)));
}

export { AGENT_IDS, AGENT_ID_NAMES, agentIndex };
