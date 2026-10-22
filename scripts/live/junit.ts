/**
 * A small JUnit XML reader.
 *
 * The build workflow runs the generated project's JVM unit tests with Gradle and
 * uploads the XML reports it writes. This module reads those reports so the
 * feature gate can be bound to tests that really ran, really passed and really
 * came from the build that produced the APK.
 *
 * Nothing here trusts the file name or the directory it came from: only the
 * test case names and their outcomes, as Gradle reported them.
 */

export type JUnitStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface JUnitCase {
  /** The test method name, exactly as the runner reported it. */
  name: string;
  /** The class the test belongs to. */
  classname: string;
  status: JUnitStatus;
  /** Seconds the test took, when the runner reported it. */
  time?: number;
  /** The failure message, when the test did not pass. */
  message?: string;
}

export interface JUnitReport {
  /** The suite names the runner reported. */
  suites: string[];
  cases: JUnitCase[];
  totals: {
    tests: number;
    passed: number;
    failures: number;
    errors: number;
    skipped: number;
  };
}

const ATTRIBUTE = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parses the attributes of one XML tag body. */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(tag)) !== null) {
    out[match[1]] = match[2] !== undefined ? match[2] : (match[3] ?? '');
  }
  return out;
}

/**
 * A tag matcher that tolerates `>` inside a quoted attribute value, so a test
 * name like "a > b" cannot truncate the tag and produce a phantom test.
 */
const TESTCASE_TAG = /<testcase\b((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const SUITE_TAG = /<testsuite\b((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

function statusOf(body: string): JUnitStatus {
  if (/<failure\b/.test(body)) return 'failed';
  if (/<error\b/.test(body)) return 'error';
  if (/<skipped\b/.test(body)) return 'skipped';
  return 'passed';
}

function messageOf(body: string): string | undefined {
  const match = /<(?:failure|error)\b[^>]*\bmessage="([^"]*)"/.exec(body);
  if (!match) return undefined;
  return match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Reads one JUnit XML document.
 *
 * Both the `<testsuite>` and the `<testsuites>` layouts Gradle produces are
 * accepted; only the `<testcase>` elements carry the outcome.
 */
export function parseJUnitXml(xml: string): JUnitReport {
  const cases: JUnitCase[] = [];
  const suites: string[] = [];

  SUITE_TAG.lastIndex = 0;
  let suiteMatch: RegExpExecArray | null;
  while ((suiteMatch = SUITE_TAG.exec(xml)) !== null) {
    const name = attributes(suiteMatch[1] ?? '').name;
    if (name && !suites.includes(name)) suites.push(name);
  }

  TESTCASE_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TESTCASE_TAG.exec(xml)) !== null) {
    const attrs = attributes(match[1] ?? '');
    let body = '';
    if (match[2] !== '/') {
      const end = xml.indexOf('</testcase>', TESTCASE_TAG.lastIndex);
      if (end !== -1) {
        body = xml.slice(TESTCASE_TAG.lastIndex, end);
        TESTCASE_TAG.lastIndex = end + '</testcase>'.length;
      }
    }
    const time = attrs.time !== undefined ? Number(attrs.time) : undefined;
    cases.push({
      name: attrs.name ?? '',
      classname: attrs.classname ?? '',
      status: statusOf(body),
      ...(time !== undefined && Number.isFinite(time) ? { time } : {}),
      ...(messageOf(body) ? { message: messageOf(body) } : {})
    });
  }

  return { suites, cases, totals: totalsOf(cases) };
}

function totalsOf(cases: JUnitCase[]): JUnitReport['totals'] {
  const totals = { tests: cases.length, passed: 0, failures: 0, errors: 0, skipped: 0 };
  for (const testCase of cases) {
    if (testCase.status === 'passed') totals.passed += 1;
    else if (testCase.status === 'failed') totals.failures += 1;
    else if (testCase.status === 'error') totals.errors += 1;
    else totals.skipped += 1;
  }
  return totals;
}

/** Combines several reports into one, keeping every case. */
export function mergeJUnitReports(reports: JUnitReport[]): JUnitReport {
  const cases: JUnitCase[] = [];
  const suites: string[] = [];
  for (const report of reports) {
    cases.push(...report.cases);
    for (const suite of report.suites) if (!suites.includes(suite)) suites.push(suite);
  }
  return { suites, cases, totals: totalsOf(cases) };
}

/** The names of the tests that passed. */
export function passingTestNames(report: JUnitReport): string[] {
  return report.cases.filter((c) => c.status === 'passed').map((c) => c.name);
}

/** The names of the tests that did not pass, with the reason. */
export function failingTestNames(report: JUnitReport): string[] {
  return report.cases
    .filter((c) => c.status !== 'passed')
    .map((c) => c.name + (c.message ? ' (' + c.message.slice(0, 120) + ')' : ''));
}
