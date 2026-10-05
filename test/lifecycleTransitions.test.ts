import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { VALID_TRANSITIONS, isValidTransition, assertValidTransition, InvalidTransitionError } from '../scripts/live/stateValidator.ts';
import { LIFECYCLE } from '../scripts/orchestrator/lifecycle.ts';
import { ProjectStates } from '../shared/types.ts';

describe('valid lifecycle transitions', () => {
  test('every forward hop along LIFECYCLE is permitted', () => {
    for (let i = 0; i < LIFECYCLE.length - 1; i++) {
      const from = LIFECYCLE[i];
      const to = LIFECYCLE[i + 1];
      assert.strictEqual(isValidTransition(from, to), true, `${from} -> ${to} should be valid`);
    }
  });

  test('all LIFECYCLE states are declared in VALID_TRANSITIONS', () => {
    for (const st of LIFECYCLE) {
      assert.ok(VALID_TRANSITIONS[st], `missing transitions for ${st}`);
    }
  });

  test('every state can reach FAILED for genuine blockages', () => {
    for (const st of LIFECYCLE) {
      if (st === ProjectStates.COMPLETED) continue;
      if (st === ProjectStates.FAILED) continue;
      const allowed = VALID_TRANSITIONS[st] || [];
      assert.ok(allowed.includes(ProjectStates.FAILED), `${st} cannot reach FAILED`);
    }
  });

  test('a pushed implementation can go straight to the cloud build', () => {
    // githubPush leaves the state at BUILDING and the canonical runner dispatches
    // the cloud build from there, so this edge has to be legal. Reaching for the
    // release stages from BUILDING still is not.
    assert.ok(isValidTransition(ProjectStates.BUILDING, ProjectStates.CLOUD_BUILDING));
    assert.ok(!isValidTransition(ProjectStates.BUILDING, ProjectStates.VERIFYING));
    assert.ok(!isValidTransition(ProjectStates.BUILDING, ProjectStates.RELEASING));
  });

  test('repair state can return to every earlier build stage', () => {
    const allowed = VALID_TRANSITIONS[ProjectStates.REPAIRING];
    for (const target of [ProjectStates.READY, ProjectStates.BUILDING, ProjectStates.TESTING,
                          ProjectStates.CLOUD_BUILDING, ProjectStates.VERIFYING, ProjectStates.RELEASING]) {
      assert.ok(allowed.includes(target), `REPAIRING -> ${target} missing`);
    }
  });
});

describe('invalid / out-of-order transitions are rejected', () => {
  const illegal: [string, string][] = [
    [ProjectStates.NOT_STARTED, ProjectStates.COMPLETED],
    [ProjectStates.NOT_STARTED, ProjectStates.DOWNLOAD_READY],
    [ProjectStates.ANALYZING, ProjectStates.RELEASING],
    [ProjectStates.ANALYZING, ProjectStates.CLOUD_BUILDING],
    [ProjectStates.PLANNING, ProjectStates.VERIFYING],
    [ProjectStates.BUILDING, ProjectStates.DOWNLOAD_READY],
    [ProjectStates.TESTING, ProjectStates.RELEASING],
    [ProjectStates.CLOUD_BUILDING, ProjectStates.COMPLETED],
    [ProjectStates.VERIFYING, ProjectStates.COMPLETED],
    [ProjectStates.RELEASING, ProjectStates.COMPLETED],
    [ProjectStates.FAILED, ProjectStates.COMPLETED],
    [ProjectStates.BLOCKED, ProjectStates.COMPLETED],
    [ProjectStates.DESIGNING, ProjectStates.PLANNING === 'PLANNING' ? ProjectStates.BUILDING : ProjectStates.BUILDING]
  ];

  for (const [from, to] of illegal) {
    test(`${from} -> ${to} throws`, () => {
      assert.strictEqual(isValidTransition(from, to), false);
      assert.throws(() => assertValidTransition(from, to), InvalidTransitionError);
    });
  }

  test('COMPLETED only leads back into REPAIRING', () => {
    assert.strictEqual(isValidTransition(ProjectStates.COMPLETED, ProjectStates.REPAIRING), true);
    assert.strictEqual(isValidTransition(ProjectStates.COMPLETED, ProjectStates.BUILDING), false);
    assert.strictEqual(isValidTransition(ProjectStates.COMPLETED, ProjectStates.VERIFYING), false);
  });

  test('unknown states are never valid', () => {
    assert.strictEqual(isValidTransition('NONSENSE', ProjectStates.ANALYZING), false);
    assert.throws(() => assertValidTransition('NONSENSE', ProjectStates.ANALYZING));
  });

  test('self transition is a no-op, not a move', () => {
    assert.doesNotThrow(() => assertValidTransition(ProjectStates.BUILDING, ProjectStates.BUILDING));
  });
});

describe('orchestrator advance()', () => {
  test('advance refuses to move past COMPLETED', async () => {
    const { advance } = await import('../scripts/orchestrator/lifecycle.ts');
    const s = { projectState: ProjectStates.COMPLETED, latestActivity: '' };
    assert.throws(() => advance(s, 'done'), InvalidTransitionError);
  });

  test('advance refuses an out-of-order request by stepping forward only', async () => {
    const { advance } = await import('../scripts/orchestrator/lifecycle.ts');
    const s = { projectState: ProjectStates.ANALYZING, latestActivity: '' };
    advance(s, 'step');
    assert.strictEqual(s.projectState, ProjectStates.DESIGNING);
  });
});
