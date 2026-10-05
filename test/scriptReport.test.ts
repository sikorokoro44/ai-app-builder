import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const shipping = readFileSync(join(REPO, 'scripts/agents/agents/shipping.ts'), 'utf-8');

/**
 * The behaviour scripts rely on: a JSON report printed to stdout, read back by
 * the agent that ran the script.
 */
function lastJson(stdout: string): Record<string, unknown> | null {
  const end = stdout.lastIndexOf('}');
  if (end === -1) return null;
  for (let start = stdout.indexOf('{'); start !== -1 && start < end; start = stdout.indexOf('{', start + 1)) {
    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Not the start of the object; try the next one.
    }
  }
  return null;
}

const report = {
  ok: true,
  verified: true,
  runId: '37390452087',
  conclusion: 'success',
  sha256: 'a'.repeat(64),
  packageId: 'com.builder.plantwatering',
  sizeBytes: 918273,
  icon: { status: 'passed', compiledPath: 'res/mipmap-hdpi-v4/ic_launcher.png', densities: ['hdpi'] }
};

describe('a script report is read whole, nested objects included', () => {
  test('a report with a nested object is read as the report', () => {
    const stdout = JSON.stringify(report, null, 2);
    const parsed = lastJson(stdout);

    // Run 37390432614 verified the APK, then reported "apkVerify did not record a
    // checksum": the reader took the last `{`, which opened `icon`, so the
    // fields beside it were never seen.
    assert.ok(parsed, 'the report must be readable');
    assert.strictEqual(parsed.sha256, 'a'.repeat(64));
    assert.strictEqual(parsed.runId, '37390452087');
    assert.strictEqual(parsed.packageId, 'com.builder.plantwatering');
    assert.strictEqual(parsed.sizeBytes, 918273);
  });

  test('the nested object is still reachable', () => {
    const parsed = lastJson(JSON.stringify(report, null, 2));
    assert.deepStrictEqual((parsed?.icon as any)?.status, 'passed');
  });

  test('a report printed after other output is the one that is read', () => {
    const stdout = [
      'compiling...',
      'running tests...',
      JSON.stringify({ ok: true, reason: 'nothing new to push', branch: 'main' })
    ].join('\n');
    const parsed = lastJson(stdout);
    assert.strictEqual(parsed?.branch, 'main');
    assert.strictEqual(parsed?.reason, 'nothing new to push');
  });

  test('output with no JSON, or with broken JSON, yields nothing rather than a guess', () => {
    assert.strictEqual(lastJson('no json here'), null);
    assert.strictEqual(lastJson(''), null);
    assert.strictEqual(lastJson('{"a": '), null);
    assert.strictEqual(lastJson('[1, 2]'), null, 'an array is not a report object');
  });

  test('the agent uses this reader rather than one keyed on the last brace', () => {
    const reader = shipping.slice(shipping.indexOf('function lastJson'), shipping.indexOf('function git('));
    assert.doesNotMatch(reader, /lastIndexOf\('\{'\)/, 'the last brace opens a nested object, not the report');
    assert.match(reader, /JSON\.parse\(stdout\.slice\(start, end \+ 1\)\)/);
  });
});