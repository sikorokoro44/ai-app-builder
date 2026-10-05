#!/usr/bin/env node
import { createServer } from 'http';
import { readState, readEvents, initStateStore } from './stateStore.ts';
import { enrichWithProgress } from '../../shared/stateWithProgress.ts';
import { buildLiveProgress } from '../../shared/liveProgress.ts';
import { URL } from 'url';

initStateStore();

function json(res: any, data: any) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

createServer((req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    if (u.pathname === '/live/state' && req.method === 'GET') {
      return json(res, enrichWithProgress(readState()));
    }
    // The ordered stage view a UI can poll: same authoritative state, projected
    // into the stages a user recognizes. Read-only, derived, never a second
    // source of truth.
    if (u.pathname === '/live/progress' && req.method === 'GET') {
      return json(res, buildLiveProgress(readState()));
    }
    if (u.pathname === '/live/events' && req.method === 'GET') {
      const since = u.searchParams.get('since');
      return json(res, readEvents(since || undefined));
    }
    if (u.pathname === '/live/health' && req.method === 'GET') {
      return json(res, { ok: true });
    }
    res.writeHead(404);
    res.end();
  } catch (e) {
    res.writeHead(500);
    res.end();
  }
}).listen(process.env.PORT ? Number(process.env.PORT) : 0, () => {
  console.log('Live builder API ready');
});
