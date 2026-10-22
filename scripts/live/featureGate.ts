/**
 * The feature gate: what the request asked for, checked against what the app
 * really contains and what the build really ran.
 *
 * The old completeness check looked for words in the generated sources and for
 * test files on disk. Both are easy to satisfy without the feature existing:
 * a comment can mention CSV export, and a test file can sit in the tree
 * without a single test in it ever having run. This gate refuses both.
 *
 * A capability passes only when three things agree:
 *
 * 1. the request asked for it, so a brief that never mentions budgets is not
 *    held to a budget screen,
 * 2. the generated project contains the declarations that implement it, matched
 *    against the code with comments and string literals removed, and contains
 *    none of the declarations it must not contain, and
 * 3. the real JUnit results of the build that produced the APK name a test for
 *    it, and that test passed.
 *
 * The test results have to carry the identity of the build they came from, so
 * results from an older run, from another request or from another APK cannot
 * be used to pass a gate for this one.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import type { EntitySpec } from '../domainModels.ts';
import { capabilitiesFor, isRequested, type Capability, type CapabilityEvidence } from '../project/capabilities.ts';
import { stripStringsAndComments } from './kotlinLint.ts';
import type { JUnitReport } from './junit.ts';

/** The reasons a gate can refuse. They are stable, so a report can be read. */
export type GateFailureCode =
  | 'TEST_RESULTS_MISSING'
  | 'RUN_MISMATCH'
  | 'ARTIFACT_MISMATCH'
  | 'CAPABILITY_NOT_IMPLEMENTED'
  | 'FORBIDDEN_IMPLEMENTATION_PRESENT'
  | 'TEST_NOT_FOUND'
  | 'TEST_FAILED'
  | 'TEST_SKIPPED';

/** The build the test results have to belong to. */
export interface GateBuildIdentity {
  runId?: string;
  headSha?: string;
  apkSha256?: string;
  packageId?: string;
  requestId?: string;
}

/** One set of test results, with the identity of the build that produced it. */
export interface TestEvidenceBundle {
  report: JUnitReport;
  identity?: GateBuildIdentity;
  /** Where the report came from, for the report the gate writes. */
  source?: string;
}

export interface EvidenceVerdict {
  file: string;
  pattern: string;
  reason: string;
  found: boolean;
}

export interface TestVerdict {
  /** The name pattern the catalogue asks for. */
  pattern: string;
  /** The test that was expected to satisfy it, when one was found. */
  testName?: string;
  status: 'passed' | 'failed' | 'error' | 'skipped' | 'missing';
  message?: string;
}

export interface CapabilityVerdict {
  id: string;
  title: string;
  /** False when the request never asked for this capability. */
  requested: boolean;
  implemented: boolean;
  evidence: EvidenceVerdict[];
  tests: TestVerdict[];
  failures: GateFailureCode[];
  passed: boolean;
}

export interface FeatureGateResult {
  requestId?: string;
  runId?: string;
  apkSha256?: string;
  passed: boolean;
  failures: GateFailureCode[];
  capabilities: CapabilityVerdict[];
  /** Every requested capability, with the reason it did not pass. */
  reasons: string[];
  checkedAt: string;
}

export interface FeatureGateInput {
  idea: string;
  spec: EntitySpec;
  /** The root of the generated project. */
  projectRoot: string;
  /** The real test results of the build that produced the APK. */
  bundles: TestEvidenceBundle[];
  /** The build the results have to belong to. */
  build?: GateBuildIdentity;
  requestId?: string;
}

/**
 * Matches a project-relative glob against a path.
 *
 * `**` crosses directories, `*` does not. The patterns are the ones the
 * capability catalogue writes, so they have to mean what they look like.
 */
export function matchesGlob(glob: string, path: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = escaped
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${source}$`).test(path);
}

/** Every file under a root, as project-relative paths with forward slashes. */
function listProjectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'build' || entry.name === '.gradle' || entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(relative(root, abs).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/** The source of every file matching a glob, with comments and strings removed. */
function strippedSources(root: string, glob: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  for (const rel of listProjectFiles(root)) {
    if (!matchesGlob(glob, rel)) continue;
    try {
      const raw = readFileSync(join(root, rel), 'utf-8');
      out.set(rel, rel.endsWith('.kt') ? stripStringsAndComments(raw) : raw);
    } catch {
      /* a file that cannot be read is a file that cannot prove anything */
    }
  }
  return out;
}

function evidenceVerdict(root: string, evidence: CapabilityEvidence): EvidenceVerdict {
  const sources = strippedSources(root, evidence.file);
  let found = false;
  for (const src of sources.values()) {
    try {
      if (new RegExp(evidence.pattern).test(src)) {
        found = true;
        break;
      }
    } catch {
      /* an invalid pattern proves nothing */
    }
  }
  return { file: evidence.file, pattern: evidence.pattern, reason: evidence.reason, found };
}

/** The test results of every bundle, as one list of cases. */
function allCases(bundles: TestEvidenceBundle[]) {
  return bundles.flatMap((b) => b.report.cases);
}

/**
 * The reason the results cannot be used for this build, if there is one.
 *
 * Results without an identity, results from another run and results from
 * another APK are all refused: they cannot show that *this* APK has the
 * feature.
 */
export function identityFailure(bundles: TestEvidenceBundle[], build?: GateBuildIdentity): GateFailureCode | null {
  if (!bundles.length) return 'TEST_RESULTS_MISSING';
  if (!build) return null;
  for (const bundle of bundles) {
    const identity = bundle.identity;
    // Results without an identity cannot be bound to this build, so they are
    // refused rather than assumed to belong to it.
    if (!identity) return 'RUN_MISMATCH';
    if (build.runId && identity.runId !== build.runId) return 'RUN_MISMATCH';
    if (build.requestId && identity.requestId !== build.requestId) return 'RUN_MISMATCH';
    if (build.apkSha256 && identity.apkSha256 !== build.apkSha256) return 'ARTIFACT_MISMATCH';
    if (build.packageId && identity.packageId && identity.packageId !== build.packageId) return 'ARTIFACT_MISMATCH';
  }
  return null;
}

function testVerdicts(capability: Capability, cases: { name: string; status: string; message?: string }[]): TestVerdict[] {
  return capability.tests.map((pattern) => {
    let rx: RegExp;
    try {
      rx = new RegExp(pattern);
    } catch {
      return { pattern, status: 'missing' };
    }
    const hit = cases.find((c) => rx.test(c.name));
    if (!hit) return { pattern, status: 'missing' };
    return {
      pattern,
      testName: hit.name,
      status: hit.status as TestVerdict['status'],
      ...(hit.message ? { message: hit.message } : {})
    };
  });
}

/**
 * Checks every capability of the archetype against the project and the test
 * results, and says exactly what is missing.
 */
export function evaluateFeatureGate(input: FeatureGateInput): FeatureGateResult {
  const capabilities = capabilitiesFor(input.spec);
  const cases = allCases(input.bundles);
  const globalFailure = identityFailure(input.bundles, input.build);
  const failures: GateFailureCode[] = [];
  const reasons: string[] = [];
  const verdicts: CapabilityVerdict[] = [];

  if (globalFailure) {
    failures.push(globalFailure);
    reasons.push(`the test results ${describeIdentityFailure(globalFailure)}`);
  }

  for (const capability of capabilities) {
    const asked = isRequested(capability, input.idea);
    const evidence = capability.evidence.map((e) => evidenceVerdict(input.projectRoot, e));
    const forbidden = (capability.forbidden ?? []).map((e) => evidenceVerdict(input.projectRoot, e));
    const tests = testVerdicts(capability, cases);
    const capabilityFailures: GateFailureCode[] = [];

    if (asked) {
      const missing = evidence.filter((e) => !e.found);
      if (missing.length) {
        capabilityFailures.push('CAPABILITY_NOT_IMPLEMENTED');
        for (const e of missing) {
          reasons.push(`${capability.id}: ${e.reason} (no match for ${e.pattern} in ${e.file})`);
        }
      }
      const present = forbidden.filter((e) => e.found);
      if (present.length) {
        capabilityFailures.push('FORBIDDEN_IMPLEMENTATION_PRESENT');
        for (const e of present) {
          reasons.push(`${capability.id}: ${e.reason} (${e.pattern} found in ${e.file})`);
        }
      }
      if (globalFailure) {
        capabilityFailures.push(globalFailure);
      } else {
        for (const test of tests) {
          if (test.status === 'missing') {
            capabilityFailures.push('TEST_NOT_FOUND');
            reasons.push(`${capability.id}: no test named ${test.pattern} ran in the build`);
          } else if (test.status === 'failed' || test.status === 'error') {
            capabilityFailures.push('TEST_FAILED');
            reasons.push(`${capability.id}: ${test.testName} failed${test.message ? ` (${test.message})` : ''}`);
          } else if (test.status === 'skipped') {
            capabilityFailures.push('TEST_SKIPPED');
            reasons.push(`${capability.id}: ${test.testName} was skipped`);
          }
        }
      }
    }

    const unique = [...new Set(capabilityFailures)];
    for (const failure of unique) if (!failures.includes(failure)) failures.push(failure);
    verdicts.push({
      id: capability.id,
      title: capability.title,
      requested: asked,
      implemented: evidence.every((e) => e.found) && forbidden.every((e) => !e.found),
      evidence,
      tests,
      failures: unique,
      passed: asked ? unique.length === 0 : true
    });
  }

  return {
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.build?.runId ? { runId: input.build.runId } : {}),
    ...(input.build?.apkSha256 ? { apkSha256: input.build.apkSha256 } : {}),
    passed: failures.length === 0,
    failures,
    capabilities: verdicts,
    reasons,
    checkedAt: new Date().toISOString()
  };
}

function describeIdentityFailure(code: GateFailureCode): string {
  if (code === 'TEST_RESULTS_MISSING') return 'were never uploaded by the build';
  if (code === 'ARTIFACT_MISMATCH') return 'came from a different APK than the one being released';
  return 'came from a different run than the one being released';
}

/** The gate, as a refusal: throws with every reason it found. */
export function assertFeatureGate(input: FeatureGateInput): FeatureGateResult {
  const result = evaluateFeatureGate(input);
  if (!result.passed) {
    throw new Error(
      `The feature gate refused this app:\n - ${result.reasons.join('\n - ')}\n` +
      ` (codes: ${result.failures.join(', ')})`
    );
  }
  return result;
}

/** A short line for the evidence chain. */
export function summariseGate(result: FeatureGateResult): string {
  const asked = result.capabilities.filter((c) => c.requested);
  return `${asked.length} requested feature(s) verified against the built app: ` +
    `${result.capabilities.filter((c) => c.passed).map((c) => c.id).join(', ') || 'none'}`;
}
