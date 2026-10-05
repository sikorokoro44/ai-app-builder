/**
 * Helpers shared by the agent implementations.
 *
 * An agent's work is only real if it can be re-derived from the files it wrote,
 * so most validators here re-read the file the agent claims to have written and
 * check its content instead of trusting the agent's own return value.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { AgentExecutionError } from '../context.ts';
import type { AgentContext } from '../context.ts';
import type { AgentValidationResult } from '../../../shared/agentTypes.ts';
import { specForIdea, numericRoles } from '../../domainModels.ts';
import { layoutFor, plannedStrings, type ProjectLayout } from '../../project/emitters.ts';
import { deriveSections, type BuildPlan, type DerivedSections, type PlanHandoffs } from '../planner.ts';

export function ok(errors: string[] = [], warnings: string[] = []): AgentValidationResult {
  return { valid: errors.length === 0, errors, warnings };
}

export function invalid(errors: string[]): AgentValidationResult {
  return { valid: false, errors };
}

export function fail(agentId: string, message: string, diagnostics: string[] = [], retryable = false): never {
  throw new AgentExecutionError(agentId, message, { diagnostics, retryable });
}

/** The plan every downstream agent works from. */
export function planFrom(ctx: AgentContext): BuildPlan {
  return ctx.artifact<BuildPlan>('feature-planner', 'plan');
}

/** The derivations for this idea, used to cross-check agent output. */
export function sectionsFor(idea: string): DerivedSections {
  return deriveSections(idea);
}

export function handoffsFor(idea: string): PlanHandoffs {
  const sections = deriveSections(idea);
  const spec = specForIdea(idea);
  const roles = numericRoles(spec);
  return {
    requirements: sections.requirements,
    domain: {
      spec,
      archetype: spec.plural,
      numericRoles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v?.name ?? 'none'])),
      actions: spec.actions
    },
    architecture: sections.architecture,
    ui: { screens: sections.screens },
    security: sections.security
  };
}

export function layoutForPlan(ctx: AgentContext, plan: BuildPlan): ProjectLayout {
  return layoutFor(ctx.projectRoot, plan.packageId, plan.appName, specForIdea(plan.idea));
}

export function projectPath(ctx: AgentContext, relative: string): string {
  return join(ctx.projectRoot, relative);
}

export function projectFileExists(ctx: AgentContext, relative: string): boolean {
  const abs = projectPath(ctx, relative);
  try {
    return existsSync(abs) && statSync(abs).isFile() && statSync(abs).size > 0;
  } catch {
    return false;
  }
}

export function readProject(ctx: AgentContext, relative: string): string | null {
  try {
    return readFileSync(projectPath(ctx, relative), 'utf-8');
  } catch {
    return null;
  }
}

/** Every string key the resource engineer must ship, for this plan. */
export function plannedStringKeys(plan: BuildPlan): string[] {
  const spec = specForIdea(plan.idea);
  return plannedStrings(spec, plan.appName)
    .map((line) => line.match(/name="([^"]+)"/)?.[1])
    .filter((k): k is string => !!k);
}

/** Required project-relative files from a contract, checked for real. */
export function missingRequiredFiles(ctx: AgentContext, files: string[]): string[] {
  return files.filter((f) => !projectFileExists(ctx, f)).map((f) => `missing or empty: ${f}`);
}
