/**
 * Reading the test evidence a build published.
 *
 * A build uploads its JUnit XML next to a small identity file: the run it
 * belongs to, the commit it built, the APK it produced and the request it
 * answers. The gate needs both halves. The XML says which tests ran and how
 * they ended; the identity says which build those tests belong to.
 *
 * A report without an identity is not evidence about any particular APK, so it
 * is read as such rather than quietly accepted.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { mergeJUnitReports, parseJUnitXml, type JUnitReport } from './junit.ts';
import type { GateBuildIdentity, TestEvidenceBundle } from './featureGate.ts';

/** The identity file a build writes next to its test results. */
export const IDENTITY_FILE = 'test-evidence.json';

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function readIdentity(file: string): GateBuildIdentity | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as GateBuildIdentity;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Reads every JUnit report in a directory, together with the identity of the
 * build that produced it.
 */
export function readTestEvidence(dir: string): TestEvidenceBundle[] {
  const files = walk(dir);
  const identityFile = files.find((f) => f.endsWith(IDENTITY_FILE));
  const identity = identityFile ? readIdentity(identityFile) : undefined;
  const xmlFiles = files.filter((f) => f.toLowerCase().endsWith('.xml'));

  const reports: JUnitReport[] = [];
  for (const file of xmlFiles) {
    try {
      reports.push(parseJUnitXml(readFileSync(file, 'utf-8')));
    } catch {
      /* a report that cannot be read proves nothing, and is simply not there */
    }
  }
  if (!reports.length) return [];

  const merged = mergeJUnitReports(reports);
  return [{
    report: merged,
    identity,
    source: dir
  }];
}

/** How many test cases a set of bundles holds, for the reports. */
export function bundleTotals(bundles: TestEvidenceBundle[]): JUnitReport['totals'] {
  return mergeJUnitReports(bundles.map((b) => b.report)).totals;
}

/** True when the directory holds a build artifact at all. */
export function hasTestEvidence(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  return walk(dir).some((f) => f.toLowerCase().endsWith('.xml'));
}
