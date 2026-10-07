import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAndroidApp } from '../scripts/generateAndroidApp.ts';
import { checkIntentFit } from '../scripts/live/intentFit.ts';

function gen(idea: string): string {
  const root = mkdtempSync(join(tmpdir(), 'builder-intentfit-'));
  generateAndroidApp({ idea, outDir: root });
  return root;
}

describe('checkIntentFit', () => {
  test('accepts a generated calculator that is a real calculator', () => {
    const root = gen('A genuine modern calculator');
    const fit = checkIntentFit(root, 'A genuine modern calculator');
    assert.equal(fit.ok, true);
    assert.deepEqual(fit.errors, []);
    for (const c of fit.checks) {
      assert.equal(c.pass, true, `${c.id} should pass: ${c.label}`);
    }
  });

  test('accepts a generated record-keeping app', () => {
    const root = gen('A todo list app');
    const fit = checkIntentFit(root, 'A todo list app');
    assert.equal(fit.ok, true);
    assert.deepEqual(fit.errors, []);
  });

  test('rejects a todo app asked to be a calculator', () => {
    const root = gen('A todo list app');
    const fit = checkIntentFit(root, 'A genuine modern calculator');
    assert.equal(fit.ok, false);
    const ids = fit.checks.filter((c) => !c.pass).map((c) => c.id);
    assert.ok(ids.includes('store-file'), 'store file must not match the calculator');
    assert.ok(ids.includes('engine'), 'a todo store has no evaluate()');
  });

  test('rejects a calculator asked to be a todo app', () => {
    const root = gen('A genuine modern calculator');
    const fit = checkIntentFit(root, 'A todo list app');
    assert.equal(fit.ok, false);
    const ids = fit.checks.filter((c) => !c.pass).map((c) => c.id);
    assert.ok(ids.includes('store-file'), 'store file must not match the todo archetype');
    assert.ok(ids.includes('capture-flow'), 'a calculator activity must not render add_button');
  });

  test('identity check ties the package and app name to the derived idea', () => {
    const root = gen('A genuine modern calculator');
    const fit = checkIntentFit(root, 'A genuine modern calculator');
    assert.equal(fit.ok, true);
    const identity = fit.checks.find((c) => c.id === 'identity');
    assert.ok(identity?.pass);
  });
});