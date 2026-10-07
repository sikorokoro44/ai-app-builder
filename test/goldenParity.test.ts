import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { generateAndroidApp } from '../scripts/generateAndroidApp.ts';
import { decodePng } from '../scripts/live/png.ts';

const GOLDEN_PATH = join(import.meta.dirname, 'fixtures', 'generatedProjectGolden.json');
const golden: Record<string, { files: Record<string, string> }> = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'));
const TMP = mkdtempSync(join(tmpdir(), 'builder-golden-parity-'));

before(() => undefined);
after(() => rmSync(TMP, { recursive: true, force: true }));

function fileHash(file: string): string {
  const buf = readFileSync(file);
  if (file.endsWith('.png')) {
    const decoded = decodePng(buf);
    if (!decoded) return createHash('sha256').update(buf).digest('hex');
    return createHash('sha256').update(`${decoded.width}:${decoded.height}:`).update(decoded.rgba).digest('hex');
  }
  return createHash('sha256').update(buf).digest('hex');
}

function hashesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[full.slice(dir.length + 1)] = fileHash(full);
    }
  };
  walk(dir);
  return out;
}

describe('the generator is pinned to the golden fixture for every idea', () => {
  // The golden was produced by regenerateGolden.ts from this same generator, so
  // this reads as tautological until a change forgets to regenerate it — which
  // is exactly the regression: agentRun compares the *fleet's* output against
  // the golden, so a drift here would fail there with no clue what emitted it.
  // Comparing every idea keeps every archetype pinned, not just the one the
  // fleet runs.
  for (const [idea, entry] of Object.entries(golden)) {
    test(`${idea} reproduces its pinned files`, () => {
      const root = join(TMP, idea.replace(/[^a-z0-9]+/gi, '-'));
      generateAndroidApp({ idea, outDir: root });
      const actual = hashesOf(root);
      const expected = entry.files;
      const missing = Object.keys(expected).filter((f) => !(f in actual));
      const extra = Object.keys(actual).filter((f) => !(f in expected));
      const changed = Object.keys(expected).filter((f) => f in actual && actual[f] !== expected[f]);
      assert.deepStrictEqual(extra, [], `unexpected files for ${idea}`);
      assert.deepStrictEqual(missing, [], `missing files for ${idea}`);
      assert.deepStrictEqual(
        changed.map((f) => `${f}: ${expected[f].slice(0, 12)} -> ${actual[f].slice(0, 12)}`),
        [],
        `${idea} drifted from the golden fixture; rerun scripts/ci/regenerateGolden.ts`
      );
    });
  }
});