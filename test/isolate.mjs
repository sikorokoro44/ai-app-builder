/**
 * Test state isolation.
 *
 * `.builder/live` is tracked on purpose so an interrupted run can be resumed in
 * a later session, which makes it very easy for a test to quietly overwrite a
 * real run. Running the suite has, in practice, done exactly that: it appended
 * thousands of fabricated evidence events to the real event log, and reset the
 * tracked projectState to whatever stage a fixture used. Two failures came
 * straight out of that — a stale tracked state made a legal transition illegal.
 *
 * This module redirects every directory the pipeline writes into a throwaway temp
 * dir: the live state, the checkpoints and the agent run store. Each of them
 * defaults to a tracked path, so a test that runs the fleet would otherwise
 * overwrite the very state `.builder/live` exists to keep. The generated Android
 * project is the exception, because several tests deliberately check the tracked
 * project in `.builder/generated/android`; a test that needs a throwaway copy of
 * it passes `projectRoot` to the coordinator. It is wired in two ways so no runner
 * can bypass it:
 *
 *   - as a `--import` preload from the npm test script, which covers every file
 *   - as the first import of any test file that itself touches the state store
 *
 * Import evaluation order makes the second form sufficient on its own: ES module
 * imports are evaluated in the order they appear, so env vars set here are in
 * place before the store modules are loaded and read them.
 *
 * The guard keeps it idempotent, so being loaded as both a preload and a test
 * file's first import yields a single directory rather than a second one.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.BUILDER_STATE_DIR) {
  const root = process.env.BUILDER_TEST_TMP_ROOT || join(tmpdir(), 'builder-test');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'state-'));
  process.env.BUILDER_STATE_DIR = join(dir, 'live');
  process.env.BUILDER_CHECKPOINT_DIR = join(dir, 'checkpoints');
  // Keeps a stray release/artifact download from touching the real state.
  process.env.BUILDER_TMP_DIR = dir;
  // The agent run store. A test that runs the fleet writes a manifest, a ledger
  // and a directory per agent into it.
  process.env.BUILDER_AGENT_DIR = join(dir, 'agents');
}
