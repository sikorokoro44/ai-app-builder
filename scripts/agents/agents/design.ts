/**
 * Agents 4-7: the design and planning wave.
 *
 * The architect, UI designer and security analyst each publish one section of
 * the plan. The feature planner is the only agent that assembles them, and it
 * refuses to produce a plan that disagrees with what those sections must contain.
 */

import { AGENT_ID_NAMES } from '../agentIds.ts';
import { GENERATED_BUILD } from '../../project/emitters.ts';
import { scanForSecrets } from '../../live/repoGuard.ts';
import type { AgentSpec } from '../../../shared/agentTypes.ts';
import type {
  BuildPlan,
  PlannedArchitecture,
  PlannedScreen,
  PlannedSecurity,
  PlanHandoffs
} from '../planner.ts';
import { assemblePlan, deriveSections, PlanAssemblyError } from '../planner.ts';
import type { DomainArtifact, IdeaArtifact } from './analysis.ts';
import { handoffsFor, ok, invalid, fail } from './common.ts';
import { ownsFile, writesProject } from '../ownership.ts';

export const architectAgent: AgentSpec<
  { requirements: unknown; domain: DomainArtifact },
  PlannedArchitecture
> = {
  id: 'architect',
  index: 4,
  name: 'Software Architect',
  role: 'Architecture and toolchain',
  responsibility: 'Choose the toolchain, module layout, entrypoint and data pattern, and record why each choice fits this idea.',
  contract: {
    inputs: [
      { kind: 'requirements', description: 'Requirement list', producedBy: 'requirements-analyst' },
      { kind: 'domain', description: 'Entity model', producedBy: 'domain-modeler' }
    ],
    outputs: [{ kind: 'architecture', description: 'Toolchain, layout, entrypoint and rationale' }],
    requiredOutputFields: ['language', 'uiToolkit', 'persistence', 'minSdk', 'targetSdk', 'entrypoint', 'files', 'rationale']
  },
  tools: ['deriveSections', 'build configuration'],
  dependsOn: ['requirements-analyst', 'domain-modeler'],
  entersState: 'ANALYZING',
  nextState: 'DESIGNING',
  evidenceStage: 'DESIGN',
  evidence: (out) => out ? `${out.language} + ${out.uiToolkit}, min ${out.minSdk}/target ${out.targetSdk}, ${out.files.length} files` : null,
  describe: (out) => out ? `pinned the build to ${out.language} + ${out.uiToolkit}, min ${out.minSdk}/target ${out.targetSdk}` : null,
  describe: (out) => (out ? `${out.language} + ${out.uiToolkit}, ${out.files.length} files` : 'no architecture'),
  ownedPaths: [],
  completionCriteria: [
    'The toolchain matches the pinned build configuration.',
    'The entrypoint is a file the UI engineer will actually write.',
    'Every architectural choice has a recorded reason.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: false, maxRepairs: 0, onExhausted: 'fail' },
  execute(ctx, input) {
    const domain = input.domain;
    const architecture = deriveSections(ctx.idea).architecture;
    if (architecture.entrypoint !== `${domain.spec.className}Screen` && !architecture.entrypoint.endsWith('MainActivity')) {
      fail('architect', `entrypoint ${architecture.entrypoint} is not something the UI engineer can emit`);
    }
    ctx.publish('architecture', { ...architecture, summary: `${architecture.language} on ${architecture.uiToolkit}, ${architecture.files.length} files` });
    ctx.log(`${architecture.language} + ${architecture.uiToolkit}, min ${architecture.minSdk}/target ${architecture.targetSdk}, ${architecture.files.length} files`);
    return architecture;
  },
  validate(architecture, ctx) {
    const expected = deriveSections(ctx.idea).architecture;
    const errors: string[] = [];
    if (!architecture) return invalid(['no architecture produced']);
    if (architecture.language !== expected.language) errors.push(`language ${architecture.language} is not the pinned Kotlin toolchain`);
    if (architecture.minSdk !== GENERATED_BUILD.minSdk) errors.push(`minSdk ${architecture.minSdk} disagrees with ${GENERATED_BUILD.minSdk}`);
    if (architecture.targetSdk !== GENERATED_BUILD.targetSdk) errors.push(`targetSdk ${architecture.targetSdk} disagrees with ${GENERATED_BUILD.targetSdk}`);
    if (architecture.compileSdk !== GENERATED_BUILD.compileSdk) errors.push(`compileSdk ${architecture.compileSdk} disagrees with ${GENERATED_BUILD.compileSdk}`);
    if (!architecture.persistence) errors.push('no persistence decision');
    if (!Array.isArray(architecture.files) || architecture.files.length < 4) errors.push('architecture lists too few files to build');
    if (!Array.isArray(architecture.rationale) || architecture.rationale.length === 0) errors.push('no rationale recorded');
    return errors.length ? invalid(errors) : ok();
  }
};

export const uiDesignerAgent: AgentSpec<DomainArtifact, { screens: PlannedScreen[] }> = {
  id: 'ui-designer',
  index: 5,
  name: 'UI/UX Designer',
  role: 'Screens, states and copy',
  responsibility: 'Design the screens the app needs, the states each one must handle, and the exact resource keys that carry every visible string.',
  contract: {
    inputs: [{ kind: 'domain', description: 'Entity model', producedBy: 'domain-modeler' }],
    outputs: [{ kind: 'ui', description: 'Screen inventory with states and copy keys' }],
    requiredOutputFields: ['screens']
  },
  tools: ['deriveSections'],
  dependsOn: ['domain-modeler'],
  entersState: 'ANALYZING',
  ownedPaths: [],
  completionCriteria: [
    'Every screen designs the empty and input-rejected states.',
    'Every visible string has a resource key the resource engineer can ship.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: false, maxRepairs: 0, onExhausted: 'fail' },
  describe: (out) =>
    out && out.screens.length
      ? `designed ${out.screens.length} screen(s): ${out.screens.map((s) => `${s.name} (${s.copyKeys.length} copy keys)`).join(', ')}`
      : null,
  execute(ctx, domain) {
    const screens = deriveSections(ctx.idea).screens;
    const out = { screens };
    ctx.publish('ui', out);
    ctx.log(`designed ${screens.length} screen(s) with ${screens[0]?.copyKeys.length ?? 0} copy keys: ${screens[0]?.name}`);
    return out;
  },
  validate(out, ctx) {
    const expected = deriveSections(ctx.idea).screens;
    const errors: string[] = [];
    if (!out || !Array.isArray(out.screens) || out.screens.length === 0) return invalid(['no screens designed']);
    if (out.screens.length !== expected.length) errors.push(`designed ${out.screens.length} screens, the app needs ${expected.length}`);
    for (const want of expected) {
      const got = out.screens.find((s) => s.id === want.id);
      if (!got) {
        errors.push(`no design for screen ${want.id}`);
        continue;
      }
      for (const key of want.copyKeys) {
        if (!got.copyKeys.includes(key)) errors.push(`screen ${got.id} has no copy key for "${key}"`);
      }
      for (const state of ['populated', 'empty', 'input-rejected']) {
        if (!got.states.includes(state)) errors.push(`screen ${got.id} does not design the "${state}" state`);
      }
      if (!got.purpose) errors.push(`screen ${got.id} has no purpose`);
      if (!got.elements.length) errors.push(`screen ${got.id} designs no elements`);
    }
    const extra = out.screens.flatMap((s) => s.copyKeys).filter((k) => !expected.flatMap((s) => s.copyKeys).includes(k));
    if (extra.length) errors.push(`design invents copy keys with no source: ${[...new Set(extra)].join(', ')}`);
    return errors.length ? invalid(errors) : ok();
  }
};

export const securityAnalystAgent: AgentSpec<PlannedArchitecture, PlannedSecurity> = {
  id: 'security-analyst',
  index: 6,
  name: 'Security Analyst',
  role: 'Permissions, data and secrets',
  responsibility: 'State the permissions the app needs, where its data lives, and the credential policy that must hold for every generated file.',
  contract: {
    inputs: [{ kind: 'architecture', description: 'Architecture', producedBy: 'architect' }],
    outputs: [{ kind: 'security', description: 'Permissions, data at rest, secret policy, risks and mitigations' }],
    requiredOutputFields: ['permissions', 'network', 'dataAtRest', 'secretPolicy', 'risks', 'mitigations']
  },
  tools: ['deriveSections', 'secret scanner'],
  dependsOn: ['architect'],
  entersState: 'DESIGNING',
  ownedPaths: [],
  completionCriteria: [
    'Every requested permission is justified by the architecture.',
    'A credential policy exists that the publisher can enforce.',
    'The idea itself carries nothing that looks like a credential.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: false, maxRepairs: 0, onExhausted: 'fail' },
  describe: (out) =>
    out
      ? `declared ${out.permissions.length} permission(s), data ${out.dataAtRest}, ${out.secretPolicy.length} secret rule(s)`
      : null,
  execute(ctx) {
    const security = deriveSections(ctx.idea).security;
    const secrets = scanForSecrets(ctx.idea);
    if (secrets.length) fail('security-analyst', `the idea looks like it carries a credential: ${secrets.join(', ')}`);
    ctx.publish('security', security);
    ctx.log(`permissions [${security.permissions.join(', ')}], data at rest: ${security.dataAtRest}`);
    return security;
  },
  validate(security, ctx) {
    const expected = deriveSections(ctx.idea).security;
    const errors: string[] = [];
    if (!security) return invalid(['no security posture produced']);
    if (security.permissions.join(',') !== expected.permissions.join(',')) {
      errors.push(`permissions [${security.permissions.join(', ')}] do not match the manifest the app will ship [${expected.permissions.join(', ')}]`);
    }
    if (security.network !== 'none') errors.push('the generated app must not need a network');
    if (!security.dataAtRest) errors.push('no data-at-rest decision');
    if (!security.secretPolicy?.length) errors.push('no credential policy');
    if (!security.risks?.length) errors.push('no risk analysis');
    if (!security.mitigations?.length) errors.push('no mitigations');
    return errors.length ? invalid(errors) : ok();
  }
};

export const featurePlannerAgent: AgentSpec<
  { requirements: unknown; domain: unknown; architecture: unknown; ui: unknown; security: unknown },
  BuildPlan
> = {
  id: 'feature-planner',
  index: 7,
  name: 'Feature Planner',
  role: 'Features, tasks and dependencies',
  responsibility: 'Assemble the upstream sections into a feature and task graph, assign every task to an agent, and compute the execution waves.',
  contract: {
    inputs: [
      { kind: 'requirements', description: 'Requirement list', producedBy: 'requirements-analyst' },
      { kind: 'domain', description: 'Entity model', producedBy: 'domain-modeler' },
      { kind: 'architecture', description: 'Architecture', producedBy: 'architect' },
      { kind: 'ui', description: 'Screen design', producedBy: 'ui-designer' },
      { kind: 'security', description: 'Security posture', producedBy: 'security-analyst' }
    ],
    outputs: [{ kind: 'plan', description: 'The build plan: features, tasks, dependencies and waves' }],
    requiredOutputFields: ['packageId', 'appName', 'features', 'tasks', 'waves', 'verification']
  },
  tools: ['assemblePlan', 'topological sort'],
  dependsOn: ['ui-designer', 'security-analyst'],
  entersState: 'DESIGNING',
  nextState: 'PLANNING',
  evidenceStage: 'PLAN',
  evidence: (out) => out ? `planned ${out.features.length} features, ${out.tasks.length} tasks, ${out.waves.length} waves` : null,
  describe: (out) =>
    out
      ? `planned ${out.features.length} features and ${out.tasks.length} tasks for ${out.packageId} in ${out.waves.length} waves`
      : null,
  ownedPaths: [],
  completionCriteria: [
    'Every task is owned by a registered agent.',
    'The dependency graph is acyclic and resolves into waves.',
    'Every section of the plan matches the handoff it came from.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: false, maxRepairs: 1, onExhausted: 'replan' },
  execute(ctx) {
    const handoffs: PlanHandoffs = {
      requirements: ctx.artifact<PlanHandoffs['requirements']>('requirements-analyst', 'requirements').requirements,
      domain: ctx.artifact<PlanHandoffs['domain']>('domain-modeler', 'domain'),
      architecture: ctx.artifact<PlannedArchitecture>('architect', 'architecture'),
      ui: ctx.artifact<PlanHandoffs['ui']>('ui-designer', 'ui'),
      security: ctx.artifact<PlannedSecurity>('security-analyst', 'security')
    };
    let plan: BuildPlan;
    try {
      plan = assemblePlan(ctx.idea, handoffs);
    } catch (e) {
      if (e instanceof PlanAssemblyError) {
        fail('feature-planner', `the upstream sections do not assemble into a plan: ${e.problems[0]}`, e.problems);
      }
      throw e;
    }
    ctx.publish('plan', plan);
    ctx.log(`planned ${plan.features.length} features and ${plan.tasks.length} tasks in ${plan.waves.length} waves`);
    return plan;
  },
  validate(plan, ctx) {
    const errors: string[] = [];
    if (!plan) return invalid(['no plan produced']);
    if (!plan.packageId || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(plan.packageId)) errors.push(`invalid package id ${plan.packageId}`);
    if (!plan.features?.length) errors.push('the plan has no features');
    if (!plan.tasks?.length) errors.push('the plan has no tasks');
    if (!plan.waves?.length) errors.push('the plan has no execution waves');
    if (!plan.verification?.minimumUnitTests) errors.push('the plan does not require any unit tests');
    for (const task of plan.tasks ?? []) {
      if (!AGENT_ID_NAMES.includes(task.agentId)) errors.push(`task ${task.id} names unknown agent ${task.agentId}`);
      if (!task.completion || task.completion.length < 8) errors.push(`task ${task.id} has no completion condition`);
      // A task either owns real files inside its agent's ownership, or it owns
      // none at all: an agent that writes nothing into the project must not be
      // given a file, and one that does must say which.
      if (writesProject(task.agentId)) {
        if (!task.files.length) {
          errors.push(`task ${task.id} is owned by ${task.agentId}, which writes into the project, but lists no files`);
        }
        for (const file of task.files) {
          if (!ownsFile(task.agentId, file)) {
            errors.push(`task ${task.id} claims ${file}, which ${task.agentId} does not own`);
          }
        }
      } else if (task.files.length) {
        errors.push(`task ${task.id} claims files (${task.files.join(', ')}) but ${task.agentId} writes nothing into the project`);
      }
    }
    const covered = new Set((plan.tasks ?? []).map((t) => t.agentId));
    for (const id of AGENT_ID_NAMES) {
      if (!covered.has(id)) errors.push(`no task is owned by ${id}`);
    }
    const expectedHandoffs = handoffsFor(ctx.idea);
    if (plan.requirements.length !== expectedHandoffs.requirements.length) {
      errors.push('the plan requirements do not match the requirements handoff');
    }
    return errors.length ? invalid(errors) : ok();
  }
};
