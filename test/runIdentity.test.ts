import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  correlateRun,
  makeDispatchId,
  parseRunTitle,
  runTitle,
  titleMatches,
  type TitledRun
} from '../scripts/live/runIdentity.ts';
import { ideaFromArgv } from '../scripts/live/cliArgs.ts';

/*
 * The correlation matrix, as tests.
 *
 * Every case here is a way the old "newest run wins" rule got it wrong: two
 * requests for one idea, a newer run for something else, a duplicate dispatch,
 * a dispatch the platform refused, a retry, a run with no identity at all, and
 * a resume. In each case the rule is the same: a run is only ever claimed by
 * the request and the dispatch attempt its title names.
 */

const REQUEST = '2026-10-05T20-15-07-000Z-book-tracker-for-reading-1a2b3c4d';
const OTHER_REQUEST = '2026-10-05T20-15-07-000Z-plant-watering-journal-9f8e7d6c';

function run(id: number, title: string, createdAt = '2026-10-05T20:16:00.000Z'): TitledRun {
  return { databaseId: id, displayTitle: title, createdAt, status: 'queued' };
}

describe('a run is named after the request and the attempt that asked for it', () => {
  test('the title round-trips', () => {
    const title = runTitle(REQUEST, 'abc123');
    assert.strictEqual(title, `Builder - ${REQUEST} # abc123`);
    assert.deepStrictEqual(parseRunTitle(title), { subject: REQUEST, dispatchId: 'abc123' });
  });

  test('a title from before dispatch ids names the request and nothing else', () => {
    assert.deepStrictEqual(parseRunTitle(`Builder - ${REQUEST}`), { subject: REQUEST });
  });

  test('a title that is not ours is not parsed at all', () => {
    assert.strictEqual(parseRunTitle('Some other workflow'), null);
    assert.strictEqual(parseRunTitle(undefined), null);
  });

  test('the match is exact: the request, and the attempt', () => {
    const title = runTitle(REQUEST, 'abc123');
    assert.ok(titleMatches(title, REQUEST, 'abc123'));
    assert.ok(!titleMatches(title, REQUEST, 'abc124'), 'a different attempt is a different run');
    assert.ok(!titleMatches(title, OTHER_REQUEST, 'abc123'), 'a different request is a different run');
    assert.ok(!titleMatches(title, `${REQUEST}x`, 'abc123'), 'a prefix is not the request');
  });

  test('a request id that merely appears inside another title does not match', () => {
    const title = `Builder - ${REQUEST}-other # abc123`;
    assert.ok(!titleMatches(title, REQUEST, 'abc123'));
  });

  test('every dispatch id is unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => makeDispatchId()));
    assert.strictEqual(ids.size, 200);
    for (const id of ids) assert.match(id, /^[a-f0-9]{12}$/);
  });
});

describe('finding the run that answered a dispatch', () => {
  test('the run that names the request and the attempt is the one that answered it', () => {
    const runs = [run(1, runTitle(OTHER_REQUEST, 'zzz')), run(2, runTitle(REQUEST, 'abc123'))];
    const correlation = correlateRun(runs, REQUEST, 'abc123');
    assert.strictEqual(correlation.runId, '2');
  });

  test('a newer run for a different request is never claimed', () => {
    const runs = [
      run(1, runTitle(REQUEST, 'abc123'), '2026-10-05T20:16:00.000Z'),
      run(2, runTitle(OTHER_REQUEST, 'zzz'), '2026-10-05T23:59:00.000Z')
    ];
    const correlation = correlateRun(runs, REQUEST, 'abc123');
    assert.strictEqual(correlation.runId, '1');
  });

  test('two requests for one idea each keep their own run', () => {
    const runs = [run(1, runTitle(REQUEST, 'abc123')), run(2, runTitle(OTHER_REQUEST, 'zzz'))];
    assert.strictEqual(correlateRun(runs, REQUEST, 'abc123').runId, '1');
    assert.strictEqual(correlateRun(runs, OTHER_REQUEST, 'zzz').runId, '2');
  });

  test('a duplicate dispatch of one request is a second attempt, not the same run', () => {
    const first = makeDispatchId();
    const second = makeDispatchId();
    const runs = [run(1, runTitle(REQUEST, first)), run(2, runTitle(REQUEST, second))];
    assert.strictEqual(correlateRun(runs, REQUEST, first).runId, '1');
    assert.strictEqual(correlateRun(runs, REQUEST, second).runId, '2');
  });

  test('a dispatch whose run never appeared claims nothing', () => {
    const runs = [run(1, runTitle(REQUEST, 'someone-elses-attempt'))];
    const correlation = correlateRun(runs, REQUEST, 'abc123');
    assert.strictEqual(correlation.runId, undefined);
    assert.match(correlation.reason!, /no run names request/);
  });

  test('two runs claiming the same attempt are not resolved by guessing', () => {
    const runs = [run(1, runTitle(REQUEST, 'abc123')), run(2, runTitle(REQUEST, 'abc123'))];
    const correlation = correlateRun(runs, REQUEST, 'abc123');
    assert.strictEqual(correlation.runId, undefined);
    assert.match(correlation.reason!, /none of them can be claimed/);
  });

  test('a retry of one request is reported as another attempt of the same request', () => {
    const runs = [run(1, runTitle(REQUEST, 'first')), run(2, runTitle(REQUEST, 'second'))];
    const correlation = correlateRun(runs, REQUEST, 'second');
    assert.strictEqual(correlation.runId, '2');
  });

  test('a run with no request in its title claims nothing', () => {
    const runs = [run(1, 'Builder - Book tracker for reading # manual')];
    const correlation = correlateRun(runs, REQUEST, 'abc123');
    assert.strictEqual(correlation.runId, undefined);
  });

  test('an empty run list claims nothing', () => {
    const correlation = correlateRun([], REQUEST, 'abc123');
    assert.strictEqual(correlation.runId, undefined);
    assert.ok(correlation.reason);
  });
});

describe('the idea never swallows a flag value', () => {
  test('a request id is not part of the idea', () => {
    const idea = ideaFromArgv([REQUEST, '--request-id', REQUEST, '--concurrency', '4']);
    assert.strictEqual(idea, REQUEST);
  });

  test('a resumed run id is not part of the idea', () => {
    assert.strictEqual(ideaFromArgv(['--resume', '39713520545', 'A book tracker']), 'A book tracker');
  });

  test('an ordinary idea is left alone', () => {
    assert.strictEqual(ideaFromArgv(['A genuine modern calculator app']), 'A genuine modern calculator app');
  });

  test('an idea that arrives as one argument keeps its words', () => {
    assert.strictEqual(ideaFromArgv(['A book tracker for reading']), 'A book tracker for reading');
  });

  test('the builder does not strip quotes; the shell does that', () => {
    assert.strictEqual(ideaFromArgv(['"A book tracker for reading"']), '"A book tracker for reading"');
  });

  test('a flag with no value does not eat the next flag', () => {
    assert.strictEqual(ideaFromArgv(['A book tracker', '--pre-cloud']), 'A book tracker');
  });
});

describe('the request ids themselves cannot collide', () => {
  test('two requests for one idea in the same second are still two requests', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'builder-ids-')), 'requests');
    process.env.BUILDER_REQUESTS_DIR = dir;
    const mod = await import(`../scripts/live/runRequests.ts?ids=${encodeURIComponent(dir)}`);
    const at = new Date('2026-10-05T20:15:07.000Z');
    const first = mod.makeRequestId('Book tracker for reading', at);
    const second = mod.makeRequestId('Book tracker for reading', at);
    assert.notStrictEqual(first, second);
    const base = {
      idea: 'Book tracker for reading',
      mode: 'full' as const,
      concurrency: 4,
      requestedAt: at.toISOString(),
      state: 'requested' as const,
      dispatches: []
    };
    mod.writeRequest({ ...base, requestId: first });
    mod.writeRequest({ ...base, requestId: second });
    assert.ok(existsSync(mod.requestPath(first)));
    assert.ok(existsSync(mod.requestPath(second)));
    assert.deepStrictEqual(mod.listRequests().map((r) => r.requestId).sort(), [first, second].sort());
  });

  test('a request id is still a plain file name', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'builder-ids-')), 'requests');
    process.env.BUILDER_REQUESTS_DIR = dir;
    const mod = await import(`../scripts/live/runRequests.ts?ids2=${encodeURIComponent(dir)}`);
    const id = mod.makeRequestId('Book tracker: reading!', new Date());
    assert.match(id, /^[A-Za-z0-9._-]+$/);
    assert.doesNotThrow(() => mod.requestPath(id));
  });

  test('every open request for an idea is found, not just one of them', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'builder-ids-')), 'requests');
    process.env.BUILDER_REQUESTS_DIR = dir;
    const mod = await import(`../scripts/live/runRequests.ts?ids3=${encodeURIComponent(dir)}`);
    const base = {
      idea: 'Book tracker for reading',
      mode: 'full' as const,
      concurrency: 4,
      requestedAt: '2026-10-05T20:15:07.000Z',
      state: 'dispatched' as const,
      dispatches: []
    };
    const list = [
      { ...base, requestId: 'first' },
      { ...base, requestId: 'second' },
      { ...base, requestId: 'third', mode: 'pre-cloud' as const }
    ];
    assert.deepStrictEqual(mod.findOpenRequests(list, 'book tracker for reading', 'full').map((r) => r.requestId), ['first', 'second']);
  });
});
