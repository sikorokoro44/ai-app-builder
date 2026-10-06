import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const REPO = join(import.meta.dirname, '..');
const context = execFileSync('cat', [join(REPO, 'scripts/agents/context.ts')], { encoding: 'utf-8' });
const store = execFileSync('cat', [join(REPO, 'scripts/live/stateStore.ts')], { encoding: 'utf-8' });

/**
 * Run 37391565852 published a run whose evidence chain held every stage except
 * IMPLEMENT. `failure-diagnostician` depends only on `quality-auditor`, so it
 * ran alongside `repo-publisher`: it read the state, awaited a project
 * validation for over a second, and wrote back a snapshot taken before
 * `githubPush.ts` recorded the push. Nothing was wrong with the link the
 * diagnostician dropped — it was overwritten by a reader that had already gone.
 */
/**
 * Where the store keeps its lock for a given state directory: outside it, since
 * `.builder/live` is tracked and staged by the very push that holds the lock.
 */
const lockFor = (dir: string) => {
  const store = execFileSync('cat', [join(REPO, 'scripts/live/stateStore.ts')], { encoding: 'utf-8' });
  const name = store.match(/builder-state-\$\{createHash[\s\S]*?\.digest\('hex'\)\.slice\(0, 12\)\}/);
  assert.ok(name, 'the lock must be named after the state directory');
  return join(tmpdir(), 'builder-state-' + createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 12) + '.lock');
};

describe('a state snapshot cannot be written over one that moved on', () => {
  test('an agent never writes back a state it did not change', () => {
    const mutate = context.slice(context.indexOf('async mutate'), context.indexOf('async evidence('));
    // `failure-diagnostician` reads the state and publishes a diagnosis without
    // changing anything. Writing that snapshot back is not a no-op: it is a
    // stale write, and it is what cost run 37391565852 its IMPLEMENT link.
    assert.match(mutate, /JSON\.stringify\(state\) !== before/, 'an unchanged state must not be written back');
    const compareAt = mutate.indexOf('JSON.stringify(state) !== before');
    const writeAt = mutate.indexOf('writeState(');
    assert.ok(compareAt < writeAt, 'the change has to be decided before the write');
  });

  test('a write that lost the race rebases onto the newer state', () => {
    const mutate = context.slice(context.indexOf('async mutate'), context.indexOf('async evidence('));
    assert.match(mutate, /withStateLock\(\(\) => \{/, 'the write must not land inside another writer');
    // Refusing was tried first and it failed run 37397529479 at
    // `failure-diagnostician`: the conflict is real and will happen again, so
    // the only question is whose work survives it.
    assert.match(mutate, /mergeConcurrentState\(current, base, state\)/,
      'the loser must rebase, not overwrite the winner');
    assert.doesNotMatch(mutate, /another writer advanced the state while this one was working/,
      'a conflict that ends the run is not resolved');
    assert.match(mutate, /STATE_REBASED/, 'an interleaving has to be visible in the log');
  });

  test('a spawned script holds the lock for as long as it runs', () => {
    // Lifecycle scripts read and write the state from another process, so the
    // caller's lock has to cover the child as well as the caller.
    const runScript = context.slice(context.indexOf('runScript(args'), context.indexOf('runScriptOrThrow'));
    assert.match(runScript, /withStateLock/, 'runScript must hold the lock around the child');
    const lockAt = runScript.indexOf('withStateLock');
    const spawnAt = runScript.indexOf('execFileSync(process.execPath');
    assert.ok(lockAt < spawnAt, 'the lock must be held while the child runs');
  });

  test('a rebase is visible in the event log', () => {
    assert.match(store, /export function mergeConcurrentState/, 'the merge must be part of the store');
    assert.match(context, /Events\.STATE_REBASED/, 'and the rebase must be recorded');
  });

  test('a stale snapshot written over a newer state is refused', () => {
    const dir = join(tmpdir(), `builder-stale-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    // Stands in for the pair that lost run 37391565852 its IMPLEMENT link: one
    // writer commits while the other is still holding the state it read.
    const script = join(dir, 'stale.mjs');
    writeFileSync(script, `
      import { readState, writeState } from ${JSON.stringify(join(REPO, 'scripts/live/stateStore.ts'))};
      const held = readState();
      const readVersion = held.version;
      writeState({ ...held, latestActivity: 'first writer' }, { allowUncheckedTransition: true });
      if (readState().version !== readVersion) throw new Error('another writer advanced the state while this one was working');
      writeState({ ...held, latestActivity: 'second writer' }, { allowUncheckedTransition: true });
    `);

    const res = spawnSync(process.execPath, ['--experimental-strip-types', script], {
      env: { ...process.env, BUILDER_STATE_DIR: dir },
      encoding: 'utf-8'
    });
    assert.notEqual(res.status, 0, 'the stale write must not be reached');
    assert.match(res.stderr, /another writer advanced the state/, 'and the conflict must be named');

    const after = execFileSync('cat', [join(dir, 'state.json')], { encoding: 'utf-8' });
    assert.match(after, /"latestActivity": "first writer"/, 'the newer write must survive');
    rmSync(dir, { recursive: true, force: true });
  });

  test('two writers that overlap both keep their work', async () => {
    const stages = ['IDEA', 'ANALYZE', 'DESIGN', 'PLAN', 'SCAFFOLD'];
    const dir = join(tmpdir(), `builder-rebase-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const script = join(dir, 'rebase.mjs');
    writeFileSync(script, `
      import { readState, writeState, withStateLock } from ${JSON.stringify(join(REPO, 'scripts/live/stateStore.ts'))};
      import { recordStage } from ${JSON.stringify(join(REPO, 'scripts/live/evidenceChain.ts'))};
      const stages = ${JSON.stringify(stages)};

      // The diagnostician's shape: read the state, do slow work, write back.
      const base = readState();
      for (const stage of stages.slice(0, 4)) recordStage(base, stage, 'early');
      const baseCopy = JSON.parse(JSON.stringify(base));
      await new Promise((r) => setTimeout(r, 400));
      writeState(base, { allowUncheckedTransition: true });

      // The publisher's shape, landing in the middle of that work.
      const theirs = readState();
      recordStage(theirs, 'SCAFFOLD', 'pushed commit 049f1f1');
      writeState(theirs, { allowUncheckedTransition: true });

      // The diagnostician comes back and finds a newer state than it read.
      const fresh = readState();
      const { mergeConcurrentState } = await import(${JSON.stringify(join(REPO, 'scripts/live/stateStore.ts'))});
      writeState(mergeConcurrentState(fresh, baseCopy, base), { allowUncheckedTransition: true });
    `);

    const res = spawnSync(process.execPath, ['--experimental-strip-types', script], {
      env: { ...process.env, BUILDER_STATE_DIR: dir },
      encoding: 'utf-8'
    });
    assert.equal(res.status, 0, res.stderr);

    const state = JSON.parse(execFileSync('cat', [join(dir, 'state.json')], { encoding: 'utf-8' }));
    const recorded = new Map(state.evidence.stages.map((s) => [s.stage, s.evidence]));
    // The overlap must cost neither writer its work: this is precisely the pair
    // that left run 37391565852 with a chain missing IMPLEMENT.
    assert.equal(recorded.get('SCAFFOLD'), 'pushed commit 049f1f1', "the publisher's evidence must survive the rebase");
    for (const stage of stages.slice(0, 4)) {
      assert.equal(recorded.get(stage), 'early', `${stage} must survive the rebase`);
    }
    const order = state.evidence.stages.map((s) => s.stage);
    assert.deepEqual(order, stages, 'and the chain must stay in lifecycle order');
    rmSync(dir, { recursive: true, force: true });
  });

  test('a second writer waits for the first and leaves no lock behind', () => {
    const dir = join(tmpdir(), `builder-lock-race-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    // Stand in for an agent part way through `mutate`: it holds the lock while
    // it awaits, and the next writer must not be able to slip past it.
    const holder = join(dir, 'holder.mjs');
    writeFileSync(holder, `
      import { writeFileSync } from 'node:fs';
      import { withStateLock, STATE_DIR } from ${JSON.stringify(join(REPO, 'scripts/live/stateStore.ts'))};
      withStateLock(() => {
        writeFileSync(STATE_DIR + '/held', 'yes');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      });
    `);

    execFileSync(process.execPath, ['--experimental-strip-types', holder], {
      env: { ...process.env, BUILDER_STATE_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    assert.ok(existsSync(join(dir, 'held')), 'the holder ran');
    assert.ok(
      !existsSync(lockFor(dir)),
      'the lock must be released, or the next writer waits forever'
    );

    rmSync(dir, { recursive: true, force: true });
  });

  test('a second process cannot take the lock while it is held', async () => {
    const dir = join(tmpdir(), `builder-lock-excl-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const writer = (name: string, holdMs: number, signal: string | null) => `
      import { appendFileSync, writeFileSync } from 'node:fs';
      import { withStateLock, STATE_DIR } from ${JSON.stringify(join(REPO, 'scripts/live/stateStore.ts'))};
      withStateLock(() => {
        appendFileSync(STATE_DIR + '/order', '${name}\\n');
        ${signal ? `writeFileSync(STATE_DIR + '/${signal}', '1');` : ''}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
      });
    `;

    writeFileSync(join(dir, 'holder.mjs'), writer('holder', 600, 'held'));
    writeFileSync(join(dir, 'contender.mjs'), writer('contender', 0, null));

    const env = { ...process.env, BUILDER_STATE_DIR: dir };
    const run = (script: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', join(dir, script)], { env, stdio: 'ignore' });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
      child.on('error', reject);
    });

    const held = run('holder.mjs');
    // Wait until the holder is inside its lock, so the contender cannot win the
    // race by starting first.
    for (let i = 0; i < 200 && !existsSync(join(dir, 'held')); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(existsSync(join(dir, 'held')), 'the holder must be inside the lock before the contender starts');

    const contender = run('contender.mjs');
    await Promise.all([held, contender]);

    const order = execFileSync('cat', [join(dir, 'order')], { encoding: 'utf-8' }).trim().split('\n');
    assert.deepEqual(order, ['holder', 'contender'], 'the contender must not write while the lock is held');
    assert.ok(!existsSync(lockFor(dir)), 'the lock must not outlive the writers');
    assert.ok(!existsSync(join(dir, '.state.lock')), 'and it must not sit inside the tracked state directory');
    rmSync(dir, { recursive: true, force: true });
  });
});