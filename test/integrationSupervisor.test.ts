import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { integrationSupervisorAgent } from '../scripts/agents/agents/oversight.ts';
import { AGENT_IDS } from '../scripts/agents/registry.ts';

/**
 * Run 37402835314 got all the way through the release — build-verifier and
 * release-publisher both passed, the published bytes matched the verified APK —
 * and then failed the last agent with "integration-supervisor did not complete
 * (status running, no output artifact)".
 *
 * The supervisor was failing on its own in-progress ledger entry. It is `running`
 * with no output artifact for exactly as long as it is auditing, so counting
 * itself in the audit means it can never satisfy the check it performs.
 */
const REPO = join(import.meta.dirname, '..');
const source = readFileSync(join(REPO, 'scripts/agents/agents/oversight.ts'), 'utf-8');

describe('the integration supervisor', () => {
  test('is the last of the twenty agents', () => {
    assert.equal(integrationSupervisorAgent.id, 'integration-supervisor');
    assert.equal(AGENT_IDS.length, 20, 'the fleet is twenty agents');
    assert.equal(AGENT_IDS[AGENT_IDS.length - 1].id, 'integration-supervisor',
      'and the supervisor has to be the one that closes the run');
    assert.equal(AGENT_IDS[19].index, 20, 'numbered as the twentieth');
  });

  test('does not count its own unfinished entry against itself', () => {
    assert.match(source, /a\.id !== 'integration-supervisor'/,
      'the supervisor must exclude itself, or it can never pass');
    // Excluding itself must not quietly become excluding everyone: the other
    // nineteen are still required to be complete, with a persisted artifact.
    assert.match(source, /a\.status !== 'completed' \|\| !a\.hasOutput/,
      'every other agent is still required to be complete, with an output artifact');
  });

  test('still refuses to close the run on missing evidence', () => {
    assert.match(source, /missing evidence stages/, 'a missing stage must still fail the run');
    assert.match(source, /the public download is not verified/, 'an unverified download must still fail the run');
    assert.match(source, /assertTruthful\(state\)/, 'an untruthful state must still fail the run');
  });

  test('completion still goes through the independent gate', () => {
    // markComplete.ts re-derives the whole chain from the state it is about to
    // write, so excluding the supervisor's own entry from the audit cannot
    // weaken the thing that actually decides whether a run completed.
    assert.match(source, /runScriptOrThrow\(\['scripts\/markComplete\.ts'\]\)/,
      'completion must go through the proven gate, not through this audit');
  });
});