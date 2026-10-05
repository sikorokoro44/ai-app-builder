import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const shipping = readFileSync(join(REPO, 'scripts/agents/agents/shipping.ts'), 'utf-8');
const artifactVerify = readFileSync(join(REPO, 'scripts/artifactVerify.ts'), 'utf-8');

const body = (agent: string) => {
  const start = shipping.indexOf(`export const ${agent}`);
  assert.ok(start > -1, `no agent ${agent}`);
  const end = shipping.indexOf('\nexport const ', start + 1);
  return shipping.slice(start, end === -1 ? shipping.length : end);
};

describe('a verification gate is not used as a way to read a field', () => {
  test('the gate refuses before an APK is verified, which is the point of it', () => {
    assert.match(artifactVerify, /process\.exit\(1\)/, 'the gate must be able to refuse');
    assert.match(artifactVerify, /the verified APK is not on disk/, 'an absent APK is one of its refusals');
  });

  test('build-verifier reads the run id from the watch step, not from the gate', () => {
    const verifier = body('buildVerifierAgent');

    // Run 37383514445 built the APK successfully and then failed in one second:
    // build-verifier called artifactVerify.ts to learn the run id, the gate
    // correctly reported that no APK had been downloaded or verified, and the
    // call threw before the download ever happened.
    const gateCalls = verifier.match(/runScriptOrThrow\(\['scripts\/artifactVerify\.ts'/g) || [];
    assert.strictEqual(gateCalls.length, 1, 'the gate may be consulted once, after verification, never to fetch a run id');

    const watchAt = verifier.indexOf("['scripts/cloudBuildExecute.ts', '--watch']");
    const readsRunId = verifier.indexOf("as { runId?: string; headSha?: string }");
    assert.ok(watchAt > -1, 'the watch step must report the run it waited for');
    assert.ok(readsRunId > watchAt, 'the run id must come from the watch output');
    assert.match(verifier, /watched\?\.runId/, 'the run id must be read from what --watch reported');
  });

  test('the head sha falls back to what the watch step reported', () => {
    const verifier = body('buildVerifierAgent');
    assert.match(verifier, /verified\?\.headSha \?\? watched\?\.headSha/);
    assert.doesNotMatch(verifier, /prepared/, 'the removed reader must not linger');
  });

  test('the gate is still consulted after verification, where it must pass', () => {
    const verifier = body('buildVerifierAgent');
    const downloadAt = verifier.indexOf("'run', 'download'");
    const apkVerifyAt = verifier.indexOf("['scripts/apkVerify.ts']");
    const gateAt = verifier.indexOf("runScriptOrThrow(['scripts/artifactVerify.ts'");
    assert.ok(downloadAt > -1 && apkVerifyAt > downloadAt, 'the APK must be downloaded before it is verified');
    assert.ok(gateAt > apkVerifyAt, 'the gate comes last, when the APK exists to be judged');
  });
});