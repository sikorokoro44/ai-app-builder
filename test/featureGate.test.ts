/**
 * The feature gate proves features, not mentions.
 *
 * A capability only passes when the request asked for it, the generated project
 * contains the real declarations with comments and string literals removed, and
 * the build's real JUnit results contain a test with that name that passed.
 * None of those can be faked by writing a word in the wrong place.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateFeatureGate, identityFailure, matchesGlob, summariseGate } from '../scripts/live/featureGate.ts';
import { parseJUnitXml } from '../scripts/live/junit.ts';
import { specForIdea } from '../scripts/domainModels.ts';

const IDEA = 'Smart Expense Tracker that records income and expenses, lets the user create edit and delete transactions, categorises them, keeps them in a local database, shows daily weekly and monthly summaries and the remaining balance, searches filters and sorts them, tracks monthly budgets by category, shows charts and warnings, exports CSV, supports SZL ZAR USD decimal amounts, locks with a PIN, has light and dark themes, validates input, navigates between sections and works offline with no account';

/** The declarations the catalogue requires, as the generator writes them. */
const FULL_STORE = `
package com.builder.expensetracker

import java.security.MessageDigest

enum class TransactionType { INCOME, EXPENSE }
enum class Period { DAY, WEEK, MONTH }
enum class Currency(val code: String) {
    SZL("SZL", "E"),
    ZAR("ZAR", "R"),
    USD("USD", "$")
}

data class StoredState(val transactions: List<String> = emptyList())

class ExpenseDatabase {
    fun load(): StoredState = StoredState()
    fun save(state: StoredState): Boolean = true
}

class Expense(val id: String, val title: String, val amountCents: Long, val category: String, val type: TransactionType)

class AppNavigator

fun layoutModeFor(width: Int): String = if (width > 600) "wide" else "compact"

class ExpenseStore {
    fun add(title: String, amountCents: Long, category: String): String = title
    fun updateTransaction(id: String, title: String): Boolean = true
    fun remove(id: String): Boolean = true
    fun all(): List<Expense> = emptyList()
    fun search(query: String): List<Expense> = emptyList()
    fun filterByCategory(category: String): List<Expense> = emptyList()
    fun filterByType(type: TransactionType): List<Expense> = emptyList()
    fun sortedByAmount(): List<Expense> = emptyList()
    fun summary(period: Period): Long = 0
    fun totalIncomeCents(): Long = 0
    fun totalExpenseCents(): Long = 0
    fun balanceCents(): Long = 0
    fun setBudget(category: String, amountCents: Long): Boolean = true
    fun budgetStatus(category: String): BudgetStatus = BudgetStatus(false, 0, 0)
    fun toCsv(): String = ""
    fun convert(amountCents: Long, from: Currency, to: Currency): Long = amountCents
    fun parseAmount(text: String): Long = 0
    fun setPin(pin: String): Boolean = true
    fun unlock(pin: String): Boolean = true
    fun hash(pin: String): String = MessageDigest.getInstance("SHA-256").digest(pin.toByteArray()).toString()
    fun incomeKind(): String = TransactionType.INCOME.name
    fun expenseKind(): String = TransactionType.EXPENSE.name
}

data class BudgetStatus(val exceeded: Boolean, val spentCents: Long, val budgetCents: Long)

fun validate(amount: String) { require(amount.isNotBlank()) }
`;

const FULL_ACTIVITY = `
package com.builder.expensetracker

import androidx.activity.ComponentActivity

class MainActivity : ComponentActivity()

fun isSystemInDarkTheme(): Boolean = true
fun BoxWithConstraints(content: () -> Unit) {}
fun NavigationBar() {}
fun PinLockScreen() {}
fun Canvas() {}
fun drawRect() {}
`;

const TEST_NAMES = [
  'addsIncomeAndExpenseTransactions',
  'addsExpenseThroughTheSimpleApi',
  'createsEditsAndDeletesTransactions',
  'removesTransactionById',
  'clearRemovesEveryTransaction',
  'categorisesTransactions',
  'keepsTransactionsAfterRestart',
  'summarisesDailyWeeklyAndMonthlyTotals',
  'computesBalanceFromIncomeAndExpenses',
  'searchesFiltersAndSortsTransactions',
  'tracksMonthlyBudgetsByCategory',
  'warnsWhenBudgetIsExceeded',
  'exportsTransactionsAsCsv',
  'convertsCurrenciesAndParsesDecimalAmounts',
  'locksTheAppWithAPin',
  'switchesBetweenLightAndDarkThemes',
  'rejectsInvalidInput',
  'runsOfflineWithoutNetworkOrAccount',
  'navigatesBetweenAppSections',
  'adaptsLayoutToScreenWidth',
  'showsChartDataForSpendingByCategory'
];

function xmlFor(names: string[], failing: string[] = [], skipped: string[] = []): string {
  const cases = names.map((n) => {
    if (failing.includes(n)) return `  <testcase name="${n}" classname="ExpenseStoreTest"><failure message="boom"/></testcase>`;
    if (skipped.includes(n)) return `  <testcase name="${n}" classname="ExpenseStoreTest"><skipped/></testcase>`;
    return `  <testcase name="${n}" classname="ExpenseStoreTest"/>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="ExpenseStoreTest" tests="${names.length}">\n${cases}\n</testsuite>`;
}

function makeProject(store: string, activity: string, manifest?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-'));
  const pkg = join(root, 'app/src/main/java/com/builder/expensetracker');
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(root, 'app/src/main/res/values'), { recursive: true });
  writeFileSync(join(pkg, 'ExpenseStore.kt'), store);
  writeFileSync(join(pkg, 'MainActivity.kt'), activity);
  writeFileSync(join(root, 'app/src/main/AndroidManifest.xml'), manifest ?? `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Smart Expense Tracker"></application>
</manifest>`);
  return root;
}

function gate(root: string, names: string[] = TEST_NAMES, opts: { idea?: string; failing?: string[]; skipped?: string[]; identity?: any; build?: any } = {}) {
  const identity = opts.identity ?? { runId: 'run-1', headSha: 'a'.repeat(40), apkSha256: 'b'.repeat(64), packageId: 'com.builder.expensetracker', requestId: 'req-1' };
  return evaluateFeatureGate({
    idea: opts.idea ?? IDEA,
    spec: specForIdea('Smart Expense Tracker'),
    projectRoot: root,
    bundles: [{ report: parseJUnitXml(xmlFor(names, opts.failing, opts.skipped)), identity }],
    build: opts.build ?? { runId: 'run-1', apkSha256: 'b'.repeat(64), requestId: 'req-1' },
    requestId: 'req-1'
  });
}

test('a project that declares everything and passes every test passes the gate', () => {
  const root = makeProject(FULL_STORE, FULL_ACTIVITY);
  const result = gate(root);
  assert.strictEqual(result.passed, true, `reasons: ${result.reasons.join(' | ')}`);
  assert.strictEqual(result.failures.length, 0);
  assert.ok(result.capabilities.every((c) => c.requested && c.passed));
});

test('a missing declaration fails the capability that needs it', () => {
  const root = makeProject(FULL_STORE.replace(/fun toCsv\(\): String = ""/, ''), FULL_ACTIVITY);
  const result = gate(root);
  assert.strictEqual(result.passed, false);
  const csv = result.capabilities.find((c) => c.id === 'csv-export');
  assert.ok(csv);
  assert.strictEqual(csv.passed, false);
  assert.ok(csv.failures.includes('CAPABILITY_NOT_IMPLEMENTED'));
});

test('a declaration mentioned only in a comment is not evidence', () => {
  const root = makeProject(
    FULL_STORE.replace(/fun toCsv\(\): String = ""/, '// fun toCsv(): String = ""'),
    FULL_ACTIVITY
  );
  const result = gate(root);
  const csv = result.capabilities.find((c) => c.id === 'csv-export');
  assert.ok(csv);
  assert.strictEqual(csv.passed, false, 'a comment is not a declaration');
  assert.ok(csv.failures.includes('CAPABILITY_NOT_IMPLEMENTED'));
});

test('a declaration mentioned only inside a string literal is not evidence', () => {
  const root = makeProject(
    FULL_STORE.replace(/fun toCsv\(\): String = ""/, 'val note = "fun toCsv(): String = \\"\\""'),
    FULL_ACTIVITY
  );
  const result = gate(root);
  const csv = result.capabilities.find((c) => c.id === 'csv-export');
  assert.ok(csv);
  assert.strictEqual(csv.passed, false, 'a string literal is not a declaration');
});

test('a capability the request never asked for is not demanded', () => {
  const root = makeProject(FULL_STORE.replace(/fun toCsv\(\): String = ""/, ''), FULL_ACTIVITY);
  const result = gate(root, TEST_NAMES, { idea: 'A smart expense tracker that records income and expenses' });
  const csv = result.capabilities.find((c) => c.id === 'csv-export');
  assert.ok(csv);
  assert.strictEqual(csv.requested, false);
  assert.strictEqual(csv.passed, true, 'a feature nobody asked for cannot fail the run');
});

test('a test that never ran fails the capability that needs it', () => {
  const root = makeProject(FULL_STORE, FULL_ACTIVITY);
  const without = TEST_NAMES.filter((n) => n !== 'exportsTransactionsAsCsv');
  const result = gate(root, without);
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('TEST_NOT_FOUND'));
  const csv = result.capabilities.find((c) => c.id === 'csv-export');
  assert.ok(csv?.failures.includes('TEST_NOT_FOUND'));
});

test('a test that failed does not pass the gate', () => {
  const root = makeProject(FULL_STORE, FULL_ACTIVITY);
  const result = gate(root, TEST_NAMES, { failing: ['exportsTransactionsAsCsv'] });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('TEST_FAILED'));
});

test('a skipped test does not pass the gate', () => {
  const root = makeProject(FULL_STORE, FULL_ACTIVITY);
  const result = gate(root, TEST_NAMES, { skipped: ['exportsTransactionsAsCsv'] });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('TEST_SKIPPED'));
});

test('an app that asks for internet access fails the offline capability', () => {
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET"/>
    <application android:label="Smart Expense Tracker"></application>
</manifest>`;
  const root = makeProject(FULL_STORE, FULL_ACTIVITY, manifest);
  const result = gate(root);
  assert.strictEqual(result.passed, false);
  const offline = result.capabilities.find((c) => c.id === 'offline-no-account');
  assert.ok(offline?.failures.includes('FORBIDDEN_IMPLEMENTATION_PRESENT'));
});

test('results without an identity cannot pass for a build', () => {
  const root = makeProject(FULL_STORE, FULL_ACTIVITY);
  const result = evaluateFeatureGate({
    idea: IDEA,
    spec: specForIdea('Smart Expense Tracker'),
    projectRoot: root,
    bundles: [{ report: parseJUnitXml(xmlFor(TEST_NAMES)) }],
    build: { runId: 'run-1', apkSha256: 'b'.repeat(64) }
  });
  assert.strictEqual(result.passed, false);
  assert.ok(result.failures.includes('RUN_MISMATCH'));
});

test('results from another run or another APK are refused', () => {
  const bundle = { report: parseJUnitXml(xmlFor(TEST_NAMES)), identity: { runId: 'run-1', apkSha256: 'b'.repeat(64) } };
  assert.strictEqual(identityFailure([bundle], { runId: 'run-9' }), 'RUN_MISMATCH');
  assert.strictEqual(identityFailure([bundle], { apkSha256: 'c'.repeat(64) }), 'ARTIFACT_MISMATCH');
  assert.strictEqual(identityFailure([bundle], { requestId: 'req-9' }), 'RUN_MISMATCH');
  assert.strictEqual(identityFailure([bundle], { runId: 'run-1', apkSha256: 'b'.repeat(64) }), null);
  assert.strictEqual(identityFailure([], { runId: 'run-1' }), 'TEST_RESULTS_MISSING');
});

test('the gate verdict names the request and the APK it belongs to', () => {
  const root = makeProject(FULL_STORE, FULL_ACTIVITY);
  const result = gate(root);
  assert.strictEqual(result.requestId, 'req-1');
  assert.strictEqual(result.runId, 'run-1');
  assert.strictEqual(result.apkSha256, 'b'.repeat(64));
  assert.ok(summariseGate(result).includes('income-and-expense'));
});

test('matchesGlob matches the patterns the catalogue uses', () => {
  assert.strictEqual(matchesGlob('app/src/main/java/**/ExpenseStore.kt', 'app/src/main/java/com/builder/expensetracker/ExpenseStore.kt'), true);
  assert.strictEqual(matchesGlob('app/src/main/AndroidManifest.xml', 'app/src/main/AndroidManifest.xml'), true);
  assert.strictEqual(matchesGlob('app/src/main/java/**/*.kt', 'app/src/main/java/x/y.kt'), true);
  assert.strictEqual(matchesGlob('app/src/main/java/**/*.kt', 'app/src/main/java/x/y.txt'), false);
});
