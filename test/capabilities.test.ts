/**
 * The catalogue and the generator have to agree.
 *
 * The catalogue says what proves each capability: the declarations that have to
 * exist and the names of the tests that have to have run. The generator writes
 * the app. If the two drift apart, the gate refuses apps that are perfectly
 * good, or worse, passes apps that are missing a feature.
 *
 * So this test generates the finance app the way a run would and checks every
 * capability against it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { capabilitiesFor, financeCapabilities, genericCapabilities } from '../scripts/project/capabilities.ts';
import { stripStringsAndComments } from '../scripts/live/kotlinLint.ts';
import { specForIdea } from '../scripts/domainModels.ts';
import { storeSource, activitySource, testSource, plannedStrings, emitManifest, layoutFor } from '../scripts/project/emitters.ts';

const IDEA = 'Smart Expense Tracker that records income and expenses, lets the user create edit and delete transactions, categorises them, keeps them in a local database, shows daily weekly and monthly summaries and the remaining balance, searches filters and sorts them, tracks monthly budgets by category, shows charts and warnings, exports CSV, supports SZL ZAR USD decimal amounts, locks with a PIN, has light and dark themes, validates input, navigates between sections and works offline with no account';

const spec = specForIdea(IDEA);

const store = stripStringsAndComments(storeSource(spec, IDEA));
const activity = stripStringsAndComments(activitySource(spec, IDEA));
const tests = stripStringsAndComments(testSource(spec));

/** The files the gate looks at, keyed by the glob it uses. */
function sourceFor(file: string): string {
  if (file.endsWith('ExpenseStore.kt')) return store;
  if (file.endsWith('MainActivity.kt')) return activity;
  if (file.endsWith('AndroidManifest.xml')) return manifest();
  return '';
}

function manifest(): string {
  const root = mkdtempSync(join(tmpdir(), 'manifest-'));
  const layout = layoutFor(root, 'com.builder.expensetracker', 'Smart Expense Tracker', spec);
  mkdirSync(layout.manifestDir, { recursive: true });
  const emitted = emitManifest(layout);
  return emitted.contents;
}

test('the finance archetype gets the finance catalogue', () => {
  assert.strictEqual(spec.className, 'Expense');
  assert.deepStrictEqual(capabilitiesFor(spec).map((c) => c.id), financeCapabilities().map((c) => c.id));
});

test('every capability of the finance catalogue is proved by a test the generator writes', () => {
  for (const capability of financeCapabilities()) {
    assert.ok(capability.tests.length > 0, `${capability.id} has no test to prove it`);
    for (const pattern of capability.tests) {
      const rx = new RegExp(pattern);
      const found = [...tests.matchAll(/fun\s+([A-Za-z0-9_]+)\s*\(/g)].some((m) => rx.test(m[1]));
      assert.ok(found, `${capability.id} expects a test matching ${pattern}, and the generator writes none`);
    }
  }
});

test('every capability of the finance catalogue is proved by a declaration the generator writes', () => {
  for (const capability of financeCapabilities()) {
    for (const evidence of capability.evidence) {
      const source = sourceFor(evidence.file);
      assert.ok(source, `no source for ${evidence.file}`);
      assert.ok(
        new RegExp(evidence.pattern).test(source),
        `${capability.id} expects ${evidence.pattern} in ${evidence.file}, and the generator writes none`
      );
    }
    for (const forbidden of capability.forbidden ?? []) {
      const source = sourceFor(forbidden.file);
      assert.ok(
        !new RegExp(forbidden.pattern).test(source),
        `${capability.id} forbids ${forbidden.pattern} in ${forbidden.file}, and the generator writes it`
      );
    }
  }
});

test('the offline capability is proved by the manifest really having no internet permission', () => {
  const offline = financeCapabilities().find((c) => c.id === 'offline-no-account');
  assert.ok(offline);
  assert.ok(!/android\.permission\.INTERNET/.test(manifest()), 'the finance app must not ask for internet access');
});

test('the generic catalogue asks only for what a plain record app really has', () => {
  const generic = genericCapabilities(specForIdea('a habit tracker'));
  assert.deepStrictEqual(generic.map((c) => c.id), ['create-records', 'list-records', 'delete-records']);
  for (const capability of generic) {
    for (const evidence of capability.evidence) {
      assert.match(evidence.pattern, /^fun /, 'the generic catalogue proves features by their methods');
    }
  }
});

test('every string the finance app renders is planned', () => {
  const planned = plannedStringNames();
  assert.ok(planned.size > 0);
  const used = [...activity.matchAll(/R\.string\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  for (const name of used) {
    assert.ok(planned.has(name), `the app renders ${name}, which is not planned`);
  }
});

test('the finance app never asks for a string it did not plan', () => {
  const planned = plannedStringNames();
  const used = new Set([...activity.matchAll(/R\.string\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  for (const name of used) assert.ok(planned.has(name), `${name} is used but not planned`);
});

/** The names of the string resources the plan commits to. */
function plannedStringNames(): Set<string> {
  const planned = plannedStrings(spec, 'Smart Expense Tracker');
  const names = new Set<string>();
  for (const line of planned) {
    const m = /<string name="([A-Za-z0-9_]+)"/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}
