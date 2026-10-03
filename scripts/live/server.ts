#!/usr/bin/env node
import { createServer } from 'http';
import { readState, readEvents, initStateStore } from './stateStore.ts';
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
      return json(res, readState());
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
}).listen(0, () => {
  console.log('Live builder server ready (dynamic port)');
});
