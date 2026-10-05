/**
 * Agents 1-3: the analysis wave.
 *
 * Each of these produces a persisted artifact that the rest of the fleet reads.
 * None of them touches the generated project: they decide what will be built.
 */

import { ARCHETYPES, numericRoles, specForIdea, type EntitySpec } from '../../domainModels.ts';
import { scanForSecrets } from '../../live/repoGuard.ts';
import type { AgentSpec } from '../../../shared/agentTypes.ts';
import type { PlannedRequirement } from '../planner.ts';
import { sectionsFor, ok, invalid } from './common.ts';

export interface IdeaArtifact {
  raw: string;
  normalized: string;
  purpose: string;
  keywords: string[];
  archetype: string;
  lengthWords: number;
  /** Fields the intake agent refuses to carry forward. */
  rejected: string[];
}

const FILLER = /^(a|an|the|my|our|your|please|i|want|need|would|like|to|make|build|create|simple|small|basic|app|application|that|which|for|of|with|and|me|can|you|help|using|use)$/i;

export const ideaIntakeAgent: AgentSpec<void, IdeaArtifact> = {
  id: 'idea-intake',
  index: 1,
  name: 'Idea Intake Analyst',
  role: 'Idea normalization and scope',
  responsibility: 'Turn a raw, possibly rambling idea into one normalized statement, a stated purpose and the keywords the rest of the fleet plans from.',
  contract: {
    inputs: [],
    outputs: [{ kind: 'idea', description: 'Normalized idea, purpose, keywords and rejected noise' }],
    requiredOutputFields: ['normalized', 'purpose', 'keywords', 'archetype']
  },
  tools: ['text analysis'],
  dependsOn: [],
  entersState: 'NOT_STARTED',
  nextState: 'QUEUED',
  evidenceStage: 'IDEA',
  evidence: (out) => out ? `idea "${out.normalized.slice(0, 60)}" normalised for ${out.archetype}` : null,
  describe: (out) => (out ? `${out.archetype} from ${out.lengthWords} words, ${out.keywords.length} keywords` : 'no idea'),
  ownedPaths: [],
  completionCriteria: [
    'The normalized idea is non-empty and a single statement.',
    'A one-line purpose names what the app does.',
    'The archetype that will be modelled is named.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: false, maxRepairs: 0, onExhausted: 'fail' },
  execute(ctx) {
    const raw = (ctx.idea || '').replace(/\s+/g, ' ').trim();
    if (!raw) throw new Error('idea-intake received an empty idea');
    const normalized = raw.replace(/[.\s]+$/, '').trim();
    const words = normalized.toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean);
    const keywords = [...new Set(words.filter((w) => w.length > 2 && !FILLER.test(w)))].slice(0, 12);
    const archetype = ARCHETYPES.find((a) => a.match.test(normalized));
    const spec = specForIdea(normalized);
    const rejected = keywords.filter((w) => scanForSecrets(w).length > 0);
    const purpose = `capture and organise ${spec.plural}`;
    const out: IdeaArtifact = {
      raw,
      normalized,
      purpose,
      keywords: keywords.length ? keywords : [spec.noun, spec.plural],
      archetype: archetype ? spec.plural : 'generic record',
      lengthWords: words.length,
      rejected
    };
    ctx.publish('idea', out);
    ctx.log(`normalized "${truncate(normalized)}" into ${archetype ? archetype.spec.plural : 'a generic record'} with ${out.keywords.length} keywords`);
    return out;
  },
  validate(out) {
    const errors: string[] = [];
    if (!out || typeof out.normalized !== 'string' || out.normalized.length < 3) errors.push('no usable normalized idea');
    if (!out.purpose || out.purpose.trim().length < 5) errors.push('no purpose statement');
    if (!Array.isArray(out.keywords) || out.keywords.length === 0) errors.push('no keywords');
    if (!out.archetype) errors.push('no archetype');
    if (out.rejected?.length) errors.push(`rejected credential-like input: ${out.rejected.join(', ')}`);
    return errors.length ? invalid(errors) : ok();
  }
};

export const requirementsAnalystAgent: AgentSpec<IdeaArtifact, { requirements: PlannedRequirement[]; count: number }> = {
  id: 'requirements-analyst',
  index: 2,
  name: 'Requirements Analyst',
  role: 'Requirements and acceptance criteria',
  responsibility: 'Derive every requirement the app must satisfy, each with a rationale and criteria that a validator or a test can actually check.',
  contract: {
    inputs: [{ kind: 'idea', description: 'Normalized idea', producedBy: 'idea-intake' }],
    outputs: [{ kind: 'requirements', description: 'Requirement list with acceptance criteria' }],
    requiredOutputFields: ['requirements', 'count']
  },
  tools: ['deriveSections', 'text analysis'],
  dependsOn: ['idea-intake'],
  entersState: 'QUEUED',
  nextState: 'ANALYZING',
  evidenceStage: 'ANALYZE',
  evidence: (out) => out ? `derived ${out.count} requirements with acceptance criteria` : null,
  describe: (out) => (out ? `${out.count} requirements with acceptance criteria` : 'no requirements'),
  ownedPaths: [],
  completionCriteria: [
    'Every requirement carries a rationale and at least one acceptance criterion.',
    'The requirement set covers capture, review, actions, offline operation, testing and delivery.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: false, maxRepairs: 0, onExhausted: 'fail' },
  execute(ctx, input) {
    const sections = sectionsFor(input.normalized);
    const out = { requirements: sections.requirements, count: sections.requirements.length };
    ctx.publish('requirements', out);
    ctx.log(`derived ${out.count} requirements, the first is "${sections.requirements[0].statement}"`);
    return out;
  },
  validate(out) {
    const errors: string[] = [];
    if (!out || !Array.isArray(out.requirements) || out.requirements.length === 0) {
      return invalid(['no requirements produced']);
    }
    for (const req of out.requirements) {
      if (!req.id) errors.push('a requirement has no id');
      if (!req.statement || req.statement.length < 8) errors.push(`requirement ${req.id} has no statement`);
      if (!req.rationale || req.rationale.trim().length < 5) errors.push(`requirement ${req.id} has no rationale`);
      if (!req.acceptance || req.acceptance.length === 0) errors.push(`requirement ${req.id} has no acceptance criteria`);
    }
    const ids = new Set(out.requirements.map((r) => r.id));
    if (ids.size !== out.requirements.length) errors.push('duplicate requirement ids');
    // The four areas every derivation must speak to: the primary capture flow,
    // the generated test coverage, the icon, and public delivery of the APK.
    const coverage = ['capture', 'tests', 'icon', 'release'];
    for (const word of coverage) {
      if (!out.requirements.some((r) => r.statement.toLowerCase().includes(word))) {
        errors.push(`no requirement mentions ${word}`);
      }
    }
    return errors.length ? invalid(errors) : ok();
  }
};

export interface DomainArtifact {
  spec: EntitySpec;
  archetype: string;
  numericRoles: Record<string, string>;
  actions: string[];
  openItems: string[];
}

export const domainModelerAgent: AgentSpec<IdeaArtifact, DomainArtifact> = {
  id: 'domain-modeler',
  index: 3,
  name: 'Domain Modeler',
  role: 'Entity, fields and actions',
  responsibility: 'Decide the single entity the app manages, its fields, its numeric roles and the actions the UI can perform on it.',
  contract: {
    inputs: [{ kind: 'idea', description: 'Normalized idea', producedBy: 'idea-intake' }],
    outputs: [{ kind: 'domain', description: 'Entity spec, archetype, numeric roles and actions' }],
    requiredOutputFields: ['spec', 'archetype', 'numericRoles', 'actions']
  },
  tools: ['deriveSections', 'domain model catalogue'],
  dependsOn: ['idea-intake'],
  entersState: 'QUEUED',
  describe: (out) => (out ? `${out.spec.className}: ${out.spec.fields.length} fields, actions [${out.actions.join(', ') || 'none'}]` : 'no domain model'),
  ownedPaths: [],
  completionCriteria: [
    'The entity has at least one text field, because capture is the primary flow.',
    'The action list is exactly what the generator can implement.',
    'Numeric roles are resolved, so tests and UI agree on which field means progress.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: false, maxRepairs: 0, onExhausted: 'fail' },
  execute(ctx, input) {
    const sections = sectionsFor(input.normalized);
    const spec = specForIdea(input.normalized);
    const roles = numericRoles(spec);
    const out: DomainArtifact = {
      spec,
      archetype: ARCHETYPES.find((a) => a.match.test(input.normalized)) ? spec.plural : 'generic record',
      numericRoles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v?.name ?? 'none'])),
      actions: spec.actions,
      openItems: spec.fields.length < 2 ? ['the idea implies only one field; the model adds a completion flag'] : []
    };
    ctx.publish('domain', out);
    ctx.log(`modelled ${spec.className} with ${spec.fields.length} fields (${spec.fields.map((f) => f.type).join(', ')}) and actions [${spec.actions.join(', ') || 'none'}]`);
    return out;
  },
  validate(out, ctx) {
    const errors: string[] = [];
    if (!out?.spec) return invalid(['no entity spec']);
    if (!out.spec.className) errors.push('no entity class name');
    if (!out.spec.fields.length) errors.push('the entity has no fields');
    if (!out.spec.fields.some((f) => f.type === 'text')) errors.push('the entity has no text field, so nothing can be captured');
    if (!Array.isArray(out.actions)) errors.push('no action list');
    const expected = specForIdea(ctx.idea);
    if (out.spec.className !== expected.className) errors.push(`entity ${out.spec.className} does not match the idea archetype ${expected.className}`);
    if (out.spec.actions.join(',') !== expected.actions.join(',')) {
      errors.push(`actions ${out.actions.join(',')} do not match what the generator supports (${expected.actions.join(',') || 'none'})`);
    }
    for (const key of ['progress', 'target', 'streak', 'primary']) {
      if (!(key in out.numericRoles)) errors.push(`numeric role ${key} was not resolved`);
    }
    return errors.length ? invalid(errors) : ok();
  }
};

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
