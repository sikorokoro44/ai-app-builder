/**
 * Agents 14-15: the quality wave.
 *
 * The test engineer generates JVM unit tests from the same model the store was
 * built from. The quality auditor then runs every pre-publish check that
 * already exists in this repository: structural validation (which includes the
 * Kotlin lint and the launcher icon check), a credential scan, and a check that
 * the project still matches the plan it was built from.
 */

import { writeFileSync } from 'fs';
import { testFile } from '../../project/emitters.ts';
import { validateGeneratedProject } from '../../live/projectValidator.ts';
import { assertNoSecretsInFiles } from '../../live/repoGuard.ts';
import { validateLauncherIcon } from '../../live/launcherIcon.ts';
import type { AgentSpec } from '../../../shared/agentTypes.ts';
import {
  fail,
  layoutForPlan,
  ok,
  invalid,
  planFrom,
  plannedStringKeys,
  readProject
} from './common.ts';

export const testEngineerAgent: AgentSpec<void, { path: string; className: string; count: number; names: string[] }> = {
  id: 'test-engineer',
  index: 14,
  name: 'Test Engineer',
  role: 'Generated unit tests',
  responsibility: 'Generate JVM unit tests for the store from the same entity model the generator used, so every derived action has a test that would fail if it regressed.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'data', description: 'Emitted store', producedBy: 'data-engineer' },
      { kind: 'ui-source', description: 'Emitted activity', producedBy: 'ui-engineer' }
    ],
    outputs: [{ kind: 'tests', description: 'The generated test file and the tests it contains' }],
    requiredOutputFields: ['path', 'className', 'count', 'names']
  },
  tools: ['emitTests', 'file write'],
  dependsOn: ['data-engineer', 'ui-engineer'],
  entersState: 'BUILDING',
  nextState: 'TESTING',
  evidenceStage: 'TESTGEN',
  evidence: (out) => out ? `registered ${out.count} generated tests in ${out.className}` : null,
  describe: (out) => (out ? `wrote ${out.count} unit tests in ${out.className} covering every planned action` : null),
  ownedPaths: ['app/src/test'],
  completionCriteria: [
    'The test file exists and declares the planned package.',
    'The number of tests is at least the number the plan requires.',
    'Every derived action has a test named after it.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: true, maxRepairs: 2, onExhausted: 'replan' },
  execute(ctx) {
    const plan = planFrom(ctx);
    const layout = layoutForPlan(ctx, plan);
    const file = testFile(layout);
    const rel = file.path.replace(`${ctx.projectRoot}/`, '');
    writeFileSync(file.path, file.contents);
    const names = [...file.contents.matchAll(/fun ([a-zA-Z0-9_]+)\(\)\s*\{/g)].map((m) => m[1]);
    const out = {
      path: rel,
      className: plan.verification.unitTestClass,
      count: (file.contents.match(/@Test/g) || []).length,
      names
    };
    if (out.count < plan.verification.minimumUnitTests) {
      fail('test-engineer', `generated ${out.count} tests but the plan requires ${plan.verification.minimumUnitTests}`, [
        `tests: ${names.join(', ')}`
      ]);
    }
    ctx.publish('tests', out);
    ctx.activity(`generated ${out.count} unit tests for ${out.className}`);
    ctx.log(`emitted ${rel} with ${out.count} tests: ${names.join(', ')}`);
    return out;
  },
  validate(out, ctx) {
    const errors: string[] = [];
    const plan = planFrom(ctx);
    const src = out?.path ? readProject(ctx, out.path) ?? '' : '';
    if (!src) return invalid([`the test file ${out?.path ?? '(none)'} was not written`]);
    if (!src.startsWith(`package ${plan.packageId}`)) errors.push(`the tests do not declare package ${plan.packageId}`);
    if (!src.includes(`class ${plan.verification.unitTestClass}`)) {
      errors.push(`the tests do not define ${plan.verification.unitTestClass}`);
    }
    const count = (src.match(/@Test/g) || []).length;
    if (count < plan.verification.minimumUnitTests) {
      errors.push(`only ${count} tests, the plan requires ${plan.verification.minimumUnitTests}`);
    }
    if (count !== out?.count) errors.push(`the audit counted ${out?.count} tests but the file holds ${count}`);
    for (const action of plan.entity.actions) {
      const named = (out?.names ?? []).some((n) => n.toLowerCase().includes(action.toLowerCase()));
      if (!named) errors.push(`no generated test covers the ${action} action`);
    }
    for (const must of ['add', 'remove', 'clear']) {
      const named = (out?.names ?? []).some((n) => n.toLowerCase().includes(must));
      if (!named) errors.push(`no generated test covers ${must}()`);
    }
    if (!src.includes('import org.junit.Assert')) errors.push('the tests do not import JUnit assertions');
    return errors.length ? invalid(errors) : ok();
  }
};

export interface ValidationArtifact {
  projectValid: boolean;
  packageId: string;
  iconValid: boolean;
  iconFingerprint?: string;
  secretProblems: string[];
  testCount: number;
  requiredTests: number;
  resourceKeysChecked: number;
  errors: string[];
  warnings: string[];
}

export const qualityAuditorAgent: AgentSpec<void, ValidationArtifact> = {
  id: 'quality-auditor',
  index: 15,
  name: 'Quality Auditor',
  role: 'Pre-publish validation',
  responsibility: 'Run every pre-publish check on the generated project and refuse to pass a project that drifts from the plan.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'tests', description: 'Generated tests', producedBy: 'test-engineer' }
    ],
    outputs: [{ kind: 'validation', description: 'Every validator result for the generated project' }],
    requiredOutputFields: ['projectValid', 'packageId', 'iconValid', 'secretProblems', 'testCount', 'requiredTests', 'errors']
  },
  tools: ['validateGeneratedProject', 'assertNoSecretsInFiles', 'validateLauncherIcon'],
  dependsOn: ['test-engineer', 'resource-engineer', 'brand-engineer'],
  entersState: 'TESTING',
  evidenceStage: 'VALIDATE',
  evidence: (out) => out ? `project validated, packageId=${out.packageId}, ${out.testCount} tests, 0 credential findings` : null,
  describe: (out) =>
    out
      ? out.projectValid && out.iconValid
        ? `validated ${out.packageId}: ${out.testCount} tests, icon valid, ${out.resourceKeysChecked} resource keys, no credential findings`
        : `the project did not validate: ${(out.errors[0] ?? 'unknown fault').slice(0, 60)}`
      : null,
  ownedPaths: [],
  completionCriteria: [
    'The structural validator passes with no errors.',
    'The credential scan finds nothing.',
    'The project still matches the plan it was built from.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: true, maxRepairs: 3, onExhausted: 'replan' },
  execute(ctx) {
    const plan = planFrom(ctx);
    const validation = validateGeneratedProject(ctx.projectRoot, plan.idea);
    const icon = validateLauncherIcon(ctx.projectRoot, plan.idea);
    const secretProblems = assertNoSecretsInFiles(ctx.projectRoot, ['.']);
    const tests = ctx.artifact<{ count: number }>('test-engineer', 'tests');
    const strings = readProject(ctx, 'app/src/main/res/values/strings.xml') ?? '';
    const definedKeys = new Set([...strings.matchAll(/<string name="([^"]+)">/g)].map((m) => m[1]));
    const requiredKeys = plannedStringKeys(plan);
    const missingKeys = requiredKeys.filter((k) => !definedKeys.has(k));
    const errors = [
      ...validation.errors,
      ...icon.errors,
      ...missingKeys.map((k) => `strings.xml does not define ${k}`)
    ];
    if (secretProblems.length) errors.push(...secretProblems);
    const out: ValidationArtifact = {
      projectValid: validation.valid,
      packageId: validation.packageId || plan.packageId,
      iconValid: icon.valid,
      iconFingerprint: validation.launcherIcon?.fingerprint,
      secretProblems,
      testCount: tests?.count ?? 0,
      requiredTests: plan.verification.minimumUnitTests,
      resourceKeysChecked: requiredKeys.length,
      errors,
      warnings: validation.warnings ?? []
    };
    if (!validation.valid || !icon.valid || errors.length > 0) {
      fail('quality-auditor', `the generated project failed validation: ${errors[0]}`, errors);
    }
    ctx.publish('validation', out);
    ctx.activity(`validated ${requiredKeys.length} resource keys, ${out.testCount} tests, 0 credential findings`);
    ctx.log(`validation passed: packageId=${out.packageId}, icon=${icon.valid}, tests=${out.testCount}`);
    return out;
  },
  validate(out, ctx) {
    const errors: string[] = [];
    const plan = planFrom(ctx);
    if (!out) return invalid(['the auditor produced no result']);
    if (!out.projectValid) errors.push('the structural validator did not pass');
    if (!out.iconValid) errors.push('the launcher icon did not validate');
    if (out.packageId !== plan.packageId) errors.push(`the built package id ${out.packageId} is not the planned ${plan.packageId}`);
    if (out.secretProblems.length) errors.push(`credential findings: ${out.secretProblems.join(', ')}`);
    if (out.errors.length) errors.push(`unresolved validator errors: ${out.errors.join(' | ')}`);
    if (out.testCount < out.requiredTests) errors.push(`only ${out.testCount} tests for a required ${out.requiredTests}`);
    if (out.resourceKeysChecked < 1) errors.push('no resource keys were checked');
    return errors.length ? invalid(errors) : ok();
  }
};
