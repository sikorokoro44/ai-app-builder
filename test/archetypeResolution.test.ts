import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { specForIdea, isCalculatorIdea } from '../scripts/domainModels.ts';
import { generateAndroidApp, derivePackageId, deriveAppName } from '../scripts/generateAndroidApp.ts';
import { decideIcon } from '../scripts/iconCatalog.ts';

/**
 * The real brief this builder was asked to build. It is quoted verbatim: it
 * mentions "calculations" and "arithmetic" in its testing requirements, which
 * used to drag the whole idea into the calculator archetype and shipped a
 * calculator under com.builder.calculator instead of an expense tracker.
 */
const EXPENSE_IDEA = `Build a complete native Android application called Smart Expense Tracker.

Package name: com.sikorokoro44.expensetracker

Create a polished, production-quality personal finance tracker that works completely offline.

Features:
1. Record income and expenses.
2. Create, edit and delete transactions.
3. Categorize transactions.
4. Save data persistently in a local database.
5. Show daily, weekly and monthly summaries.
6. Display income, expenses and remaining balance.
7. Support search, filtering and sorting.
8. Allow users to set monthly budgets by category.
9. Show spending charts and budget warnings.
10. Export transactions to CSV.
11. Support decimal amounts and multiple currencies, including SZL, ZAR and USD.
12. Include PIN-based app locking.
13. Provide a responsive interface with light and dark themes.
14. Validate all inputs and handle errors safely.
15. Never lose saved transactions when the app restarts.
16. Require no account, subscription or internet access for core functionality.

Testing requirements:
- Test transaction creation, editing and deletion.
- Test income and expense calculations.
- Test decimal arithmetic and balance accuracy.
- Test budget calculations and spending warnings.
- Test database persistence after restarting the app.
- Test CSV export and invalid input handling.
- Test offline operation and application navigation.
- Test the generated launcher icon and Android package.

Use the AI App Builder's 20-agent system with dynamic task allocation and dependency management.

Run all relevant automated tests. Repair failures before release.

Build the APK using GitHub Actions in the cloud.
Verify the APK, package name, integrity and public download URL.

Publish a release only after all required verification checks pass.

Return the verified public APK download link and a summary of the actual test results. Never fabricate successful tests or release evidence.`;

const TMP = mkdtempSync(join(tmpdir(), 'builder-archetype-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

describe('a finance brief is never mistaken for a calculator', () => {
  test('the full expense brief resolves to the expense model', () => {
    assert.strictEqual(specForIdea(EXPENSE_IDEA).className, 'Expense');
    assert.strictEqual(isCalculatorIdea(EXPENSE_IDEA), false);
  });

  test('calculation vocabulary in a finance idea does not select the calculator', () => {
    for (const word of ['calculations', 'calculate', 'arithmetic', 'maths']) {
      const idea = `An expense tracker that shows ${word} of what I spend`;
      assert.strictEqual(specForIdea(idea).className, 'Expense', idea);
      assert.strictEqual(isCalculatorIdea(idea), false, idea);
    }
  });

  test('a calculator brief still selects the calculator', () => {
    assert.strictEqual(specForIdea('A genuine modern calculator').className, 'Calculator');
    assert.strictEqual(isCalculatorIdea('A genuine modern calculator'), true);
    assert.strictEqual(derivePackageId('A genuine modern calculator'), 'com.builder.calculator');
    assert.strictEqual(deriveAppName('A genuine modern calculator'), 'Calculator');
  });
});

describe('the archetype is decided by what the app keeps', () => {
  test('the deciding word separates sibling archetypes', () => {
    const cases: [string, string][] = [
      ['Plant watering journal', 'Note'],
      ['A plant watering schedule', 'Entry'],
      ['Contact notes', 'Note'],
      ['A contact phonebook', 'Contact'],
      ['A book reading list', 'Book'],
      ['A gift wishlist', 'Item'],
      ['A movie watchlist', 'Item'],
      ['A calculator for my budget', 'Calculator'],
      ['An expense tracker with budget', 'Expense'],
      ['A note taking journal', 'Note'],
      ['A todo list app', 'Task'],
      ['A vocabulary deck for exams', 'Card'],
      ['A recipe organiser', 'Recipe'],
      ['A pomodoro focus timer', 'Session'],
      ['A habit tracker with daily streaks', 'Entry'],
      ['A water intake tracker', 'Entry'],
      ['A parking timer', 'Session'],
      ['Keep track of my groceries', 'Task'],
      ['A bug report tracker', 'Task'],
      ['something completely unrecognised zzz', 'Record']
    ];
    for (const [idea, cls] of cases) {
      assert.strictEqual(specForIdea(idea).className, cls, idea);
    }
  });
});

describe('an idea that states its identity is honoured', () => {
  test('the package and app name come from the brief', () => {
    assert.strictEqual(derivePackageId(EXPENSE_IDEA), 'com.sikorokoro44.expensetracker');
    assert.strictEqual(deriveAppName(EXPENSE_IDEA), 'Smart Expense Tracker');
  });

  test('the launcher icon follows the purpose, not a stray calculation', () => {
    assert.strictEqual(decideIcon(EXPENSE_IDEA, deriveAppName(EXPENSE_IDEA)).definition.category, 'finance');
  });

  test('the generated project is the expense app under the requested package', () => {
    const root = join(TMP, 'expense');
    generateAndroidApp({ idea: EXPENSE_IDEA, outDir: root });
    const pkgDir = join(root, 'app/src/main/java/com/sikorokoro44/expensetracker');
    assert.ok(existsSync(join(pkgDir, 'ExpenseStore.kt')), 'the expense store must be generated');
    assert.ok(!existsSync(join(pkgDir, 'CalculatorStore.kt')), 'no calculator store may be generated');
    const strings = readFileSync(join(root, 'app/src/main/res/values/strings.xml'), 'utf-8');
    assert.ok(strings.includes('<string name="app_name">Smart Expense Tracker</string>'), 'the label must be the requested one');
    const gradle = readFileSync(join(root, 'app/build.gradle.kts'), 'utf-8');
    assert.ok(gradle.includes('namespace = "com.sikorokoro44.expensetracker"'), 'the namespace must be the requested package');
    assert.ok(gradle.includes('applicationId = "com.sikorokoro44.expensetracker"'), 'the application id must be the requested one');
    const manifest = readFileSync(join(root, 'app/src/main/AndroidManifest.xml'), 'utf-8');
    assert.ok(manifest.includes('android:name=".MainActivity"'), 'the launcher activity must be the generated one');
    const store = readFileSync(join(pkgDir, 'ExpenseStore.kt'), 'utf-8');
    assert.ok(store.includes('package com.sikorokoro44.expensetracker'), 'the store must live in the requested package');
  });
});
