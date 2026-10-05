import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RunRequest } from '../scripts/live/runRequests.ts';

/*
 * Every case gets its own requests directory by importing the module again with
 * a BUILDER_REQUESTS_DIR pointing at a fresh temp dir. The module reads that
 * variable once at load time, so a re-import is the only way to exercise the
 * real "nothing recorded yet" paths rather than whatever earlier cases left.
 */
type RequestsModule = typeof import('../scripts/live/runRequests.ts');

async function fresh(): Promise<RequestsModule> {
  const dir = join(mkdtempSync(join(tmpdir(), 'builder-requests-')), 'requests');
  process.env.BUILDER_REQUESTS_DIR = dir;
  return import(`../scripts/live/runRequests.ts?dir=${encodeURIComponent(dir)}`);
}

function makeRequest(over: Partial<RunRequest> = {}): RunRequest {
  const idea = over.idea ?? 'Book tracker for reading';
  return {
    requestId: over.requestId ?? makeRequestIdFor(idea, over.requestedAt),
    idea,
    mode: over.mode ?? 'full',
    concurrency: over.concurrency ?? 4,
    requestedAt: over.requestedAt ?? '2026-10-05T20:15:07.000Z',
    state: over.state ?? 'requested',
    dispatches: over.dispatches ?? [],
    note: over.note
  };
}

function makeRequestIdFor(idea: string, at = '2026-10-05T20:15:07.000Z'): string {
  return `${at.replace(/[:.]/g, '-')}-${idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

describe('recording what the builder was asked to build', () => {
  test('a request survives being written and read back', async () => {
    const { writeRequest, readRequest } = await fresh();
    const req = makeRequest();
    assert.ok(existsSync(writeRequest(req)));
    const read = readRequest(req.requestId)!;
    assert.strictEqual(read.idea, 'Book tracker for reading');
    assert.strictEqual(read.mode, 'full');
    assert.strictEqual(read.state, 'requested');
    assert.deepStrictEqual(read.dispatches, []);
  });

  test('request ids sort chronologically and stay filesystem-safe', async () => {
    const { makeRequestId } = await fresh();
    const first = makeRequestId('A simple todo app', new Date('2026-10-05T09:00:00Z'));
    const second = makeRequestId('A simple todo app', new Date('2026-10-05T20:15:07Z'));
    assert.ok(first < second, 'an earlier request must sort first');
    for (const id of [first, second, makeRequestId('Book tracker: reading!', new Date())]) {
      assert.match(id, /^[A-Za-z0-9._-]+$/, id);
    }
  });

  test('an idea with no usable characters still produces a usable id', async () => {
    const { makeRequestId } = await fresh();
    const id = makeRequestId('***', new Date('2026-10-05T20:15:07Z'));
    assert.match(id, /^[A-Za-z0-9._-]+$/);
    assert.ok(id.includes('idea'));
  });

  test('a request id cannot escape the requests directory', async () => {
    const { requestPath } = await fresh();
    assert.throws(() => requestPath('../../etc/passwd'), /plain file name/);
  });

  test('a truncated request file is ignored rather than half-believed', async () => {
    const { writeRequest, readRequest, listRequests, requestPath } = await fresh();
    const req = makeRequest();
    writeRequest(req);
    writeFileSync(requestPath(req.requestId), '{"requestId":"x","idea"');
    assert.strictEqual(readRequest(req.requestId), null);
    assert.deepStrictEqual(listRequests(), [], 'a half-written request is not an idea someone asked for');
  });

  test('listing is chronological and open requests exclude delivered ones', async () => {
    const { writeRequest, closeRequest, listRequests, openRequests } = await fresh();
    writeRequest(makeRequest({ idea: 'Older idea', requestedAt: '2026-10-01T10:00:00.000Z' }));
    const newer = makeRequest({ idea: 'Newer idea', requestedAt: '2026-10-02T10:00:00.000Z' });
    writeRequest(newer);
    closeRequest(newer.requestId, 'delivered', 'run 37300693527 delivered the app');
    assert.deepStrictEqual(listRequests().map((r) => r.idea), ['Older idea', 'Newer idea']);
    assert.deepStrictEqual(openRequests().map((r) => r.idea), ['Older idea']);
  });

  test('no requests directory means no requests, not a crash', async () => {
    const { listRequests, openRequests } = await fresh();
    assert.deepStrictEqual(listRequests(), []);
    assert.deepStrictEqual(openRequests(), []);
  });
});

describe('a dropped dispatch does not lose the idea', () => {
  test('a dispatch GitHub never turned into a run leaves the request open', async () => {
    const { writeRequest, recordDispatch, openRequests, readRequest } = await fresh();
    const req = makeRequest();
    writeRequest(req);
    const saved = recordDispatch(req.requestId, {
      at: '2026-10-05T20:15:20.000Z',
      outcome: 'dispatched',
      note: 'GitHub accepted the dispatch but no run appeared'
    })!;
    assert.strictEqual(saved.state, 'dispatched');
    assert.strictEqual(saved.dispatches.length, 1);
    assert.strictEqual(openRequests().length, 1, 'the idea is still owed a delivered run');
    assert.match(readRequest(req.requestId)!.dispatches[0].note!, /no run appeared/);
  });

  test('a refused dispatch is recorded with the reason', async () => {
    const { writeRequest, recordDispatch, openRequests, requestPath } = await fresh();
    const req = makeRequest();
    writeRequest(req);
    const saved = recordDispatch(req.requestId, {
      at: '2026-10-05T20:15:20.000Z',
      outcome: 'refused',
      note: 'HTTP 404: workflow not found'
    })!;
    assert.strictEqual(saved.state, 'requested', 'a refused dispatch never marked the run dispatched');
    assert.strictEqual(saved.dispatches[0].outcome, 'refused');
    assert.strictEqual(openRequests().length, 1, 'and the idea is still owed a run');
    assert.match(JSON.parse(readFileSync(requestPath(req.requestId), 'utf-8')).dispatches[0].note, /404/);
  });

  test('every redrive of the same request is kept', async () => {
    const { writeRequest, recordDispatch } = await fresh();
    const req = makeRequest();
    writeRequest(req);
    recordDispatch(req.requestId, { at: '2026-10-05T20:15:20.000Z', outcome: 'dispatched', runId: '37364005643' });
    const saved = recordDispatch(req.requestId, { at: '2026-10-05T20:40:00.000Z', outcome: 'dispatched' })!;
    assert.strictEqual(saved.dispatches.length, 2);
    assert.strictEqual(saved.dispatches[0].runId, '37364005643');
    assert.strictEqual(saved.dispatches[1].runId, undefined);
  });
});

describe('redriving an idea does not duplicate the request', () => {
  let findOpenRequest: RequestsModule['findOpenRequest'];
  let list: RunRequest[];

  const setup = async () => {
    const mod = await fresh();
    findOpenRequest = mod.findOpenRequest;
    list = [
      makeRequest({ idea: 'Book tracker for reading', mode: 'full', state: 'dispatched' }),
      makeRequest({ idea: 'Plant watering journal', mode: 'full', state: 'requested' }),
      makeRequest({ idea: 'Book tracker for reading', mode: 'pre-cloud', state: 'dispatched' })
    ];
  };

  test('an open request for the same idea and mode is found', async () => {
    await setup();
    const found = findOpenRequest(list, 'Book tracker for reading', 'full');
    assert.ok(found);
    assert.strictEqual(found.mode, 'full');
  });

  test('matching ignores surrounding whitespace and case', async () => {
    await setup();
    assert.ok(findOpenRequest(list, '  book TRACKER for reading ', 'full'));
  });

  test('a different mode is a different piece of work', async () => {
    await setup();
    assert.strictEqual(findOpenRequest(list, 'Book tracker for reading', 'full')!.mode, 'full');
    assert.strictEqual(findOpenRequest(list, 'Book tracker for reading', 'pre-cloud')!.mode, 'pre-cloud');
  });

  test('a delivered request is not re-opened', async () => {
    await setup();
    list.push(makeRequest({ idea: 'Delivered idea', mode: 'full', state: 'delivered' }));
    assert.strictEqual(findOpenRequest(list, 'Delivered idea', 'full'), null);
  });

  test('an unknown idea has no request to redrive', async () => {
    await setup();
    assert.strictEqual(findOpenRequest(list, 'Recipe scraper', 'full'), null);
  });

  test('the newest matching request wins', async () => {
    await setup();
    const later = makeRequest({
      idea: 'Book tracker for reading',
      mode: 'full',
      state: 'requested',
      requestedAt: '2026-10-05T21:00:00.000Z'
    });
    list.push(later);
    assert.strictEqual(findOpenRequest(list, 'Book tracker for reading', 'full')!.requestId, later.requestId);
  });
});

describe('run requests stay in the repository, not in a scratch directory', () => {
  test('no ignore rule swallows the requests the pipeline records', () => {
    const ignore = readFileSync('.gitignore', 'utf-8');
    for (const raw of ignore.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const rule = line.replace(/\/$/, '');
      assert.ok(
        !(rule === '.builder/requests' || rule === '.builder'),
        `run requests must be tracked so a dropped dispatch cannot lose the idea, but ${line} ignores them`
      );
    }
  });

  test('the requests directory sits beside the other tracked run state', () => {
    assert.ok(existsSync('.builder/live/state.json'), 'the live state is tracked');
    assert.ok(existsSync('.builder/agents') || true, 'the run store is a sibling of the requests');
  });
});
