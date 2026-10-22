/**
 * The JUnit reader has to say exactly what the runner said.
 *
 * The feature gate trusts this file: if a failed test could be read as a passed
 * one, or a test that never ran could be read as one that did, the gate would
 * pass apps whose features are not real. So the parser is checked against the
 * shapes Gradle actually writes, and against the ways a report can lie.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  failingTestNames,
  mergeJUnitReports,
  parseJUnitXml,
  passingTestNames
} from '../scripts/live/junit.ts';

const GRADLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.builder.expensetracker.ExpenseStoreTest" tests="3" skipped="0" failures="1" errors="0" timestamp="2026-10-22T10:00:00" hostname="runner">
  <testcase name="addsIncomeAndExpenseTransactions" classname="com.builder.expensetracker.ExpenseStoreTest" time="0.12"/>
  <testcase name="keepsTransactionsAfterRestart" classname="com.builder.expensetracker.ExpenseStoreTest" time="0.04">
    <failure message="expected &quot;2&quot; but was &quot;1&quot;" type="java.lang.AssertionError">stack</failure>
  </testcase>
  <testcase name="exportsTransactionsAsCsv" classname="com.builder.expensetracker.ExpenseStoreTest" time="0.01">
    <skipped message="ignored"/>
  </testcase>
</testsuite>`;

test('a Gradle report is read as the runner reported it', () => {
  const report = parseJUnitXml(GRADLE_XML);
  assert.strictEqual(report.cases.length, 3);
  assert.deepStrictEqual(report.totals, { tests: 3, passed: 1, failures: 1, errors: 0, skipped: 1 });
  assert.deepStrictEqual(passingTestNames(report), ['addsIncomeAndExpenseTransactions']);
  assert.ok(failingTestNames(report).some((n) => n.startsWith('keepsTransactionsAfterRestart')));
  assert.ok(failingTestNames(report).some((n) => n.startsWith('exportsTransactionsAsCsv')));
});

test('a failure message is unescaped so the reason can be read', () => {
  const report = parseJUnitXml(GRADLE_XML);
  const failed = report.cases.find((c) => c.name === 'keepsTransactionsAfterRestart');
  assert.ok(failed);
  assert.strictEqual(failed.status, 'failed');
  assert.ok(failed.message?.includes('expected "2" but was "1"'), `message was ${failed.message}`);
});

test('the testsuites layout Gradle also writes is accepted', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Gradle Tests" tests="2" failures="0" errors="0" skipped="0">
  <testsuite name="A" tests="2" failures="0" errors="0" skipped="0">
    <testcase name="one" classname="A" time="0.1"/>
    <testcase name="two" classname="A" time="0.1"/>
  </testsuite>
</testsuites>`;
  const report = parseJUnitXml(xml);
  assert.strictEqual(report.cases.length, 2);
  assert.strictEqual(report.totals.passed, 2);
  assert.ok(report.suites.includes('A'));
});

test('a test name containing a greater-than sign is not truncated', () => {
  const xml = `<testsuite name="A" tests="1">
    <testcase name="adds &gt; 100 and &lt; 200" classname="A" time="0.1"/>
  </testsuite>`;
  const report = parseJUnitXml(xml);
  assert.strictEqual(report.cases.length, 1);
  assert.strictEqual(report.cases[0].name, 'adds &gt; 100 and &lt; 200');
});

test('an error is not read as a pass', () => {
  const xml = `<testsuite name="A" tests="1">
    <testcase name="boom" classname="A" time="0.1"><error message="OutOfMemoryError"/></testcase>
  </testsuite>`;
  const report = parseJUnitXml(xml);
  assert.strictEqual(report.cases[0].status, 'error');
  assert.strictEqual(report.totals.passed, 0);
  assert.strictEqual(report.totals.errors, 1);
});

test('a report with no test cases is empty, not passing', () => {
  const report = parseJUnitXml('<testsuite name="A" tests="0"/>');
  assert.strictEqual(report.cases.length, 0);
  assert.strictEqual(report.totals.tests, 0);
  assert.strictEqual(report.totals.passed, 0);
});

test('a report that is not XML at all yields no cases', () => {
  const report = parseJUnitXml('this is not xml');
  assert.deepStrictEqual(report.cases, []);
  assert.strictEqual(report.totals.passed, 0);
});

test('merging reports keeps every case from every report', () => {
  const one = parseJUnitXml('<testsuite name="A"><testcase name="one" classname="A"/></testsuite>');
  const two = parseJUnitXml('<testsuite name="B"><testcase name="two" classname="B"/></testsuite>');
  const merged = mergeJUnitReports([one, two]);
  assert.strictEqual(merged.cases.length, 2);
  assert.strictEqual(merged.totals.passed, 2);
  assert.deepStrictEqual(passingTestNames(merged).sort(), ['one', 'two']);
});
