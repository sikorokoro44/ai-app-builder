import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildVerifierAgent } from '../scripts/agents/agents/shipping.ts';
import { AgentExecutionError, type AgentContext } from '../scripts/agents/context.ts';

/**
 * cloudBuildExecute.ts reads BUILDER_IDEA for two things it cannot do
 * without it: validateGeneratedProject cross-checks the project against the
 * idea, and the dispatched build workflow only receives `-f idea=...` when the
 * variable is set. The plan is the authoritative source of the idea, so
 * build-verifier has to pass plan.idea itself instead of hoping an ancestor
 * process exported it.
 */
const IDEA = 'a moon base supply ledger with resupply countdowns';

describe('the build verifier propagates the plan idea into the cloud build', () => {
  test('every cloudBuildExecute step runs with BUILDER_IDEA set to plan.idea', () => {
    const calls: { args: string[]; env: Record<string, string> }[] = [];
    const ctx = {
      artifact: () => ({ idea: IDEA, packageId: 'com.builder.moonbase' }),
      runScriptOrThrow(args: string[], env: Record<string, string> = {}) {
        calls.push({ args, env });
        return '';
      },
      activity: () => {}
    } as unknown as AgentContext;

    // `--watch` reports no run id, so execute fails there: after all three
    // cloudBuildExecute calls, before any download can start.
    assert.throws(() => buildVerifierAgent.execute(ctx, undefined), AgentExecutionError);

    assert.deepStrictEqual(
      calls.map((c) => c.args),
      [
        ['scripts/cloudBuildExecute.ts', '--prepare'],
        ['scripts/cloudBuildExecute.ts', '--dispatch'],
        ['scripts/cloudBuildExecute.ts', '--watch']
      ],
      'the prepare, dispatch and watch steps must all run'
    );
    for (const call of calls) {
      assert.deepStrictEqual(
        call.env,
        { BUILDER_IDEA: IDEA },
        `${call.args.join(' ')} must receive the plan's idea as BUILDER_IDEA`
      );
    }
  });
});
