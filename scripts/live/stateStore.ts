import { createInitialState } from '../../shared/state.ts';
import type { LiveState } from '../../shared/state.ts';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const STATE_DIR = '.builder/live';
const STATE_FILE = `${STATE_DIR}/state.json`;
const EVENTS_FILE = `${STATE_DIR}/events.jsonl`;

export function initStateStore() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) {
    writeState(createInitialState());
  }
  if (!existsSync(EVENTS_FILE)) {
    writeFileSync(EVENTS_FILE, '');
  }
}

export function readState(): LiveState {
  if (!existsSync(STATE_FILE)) {
    const s = createInitialState();
    writeState(s);
    return s;
  }
  const raw = readFileSync(STATE_FILE, 'utf-8');
  try {
    return JSON.parse(raw) as LiveState;
  } catch (e) {
    const s = createInitialState();
    writeState(s);
    return s;
  }
}

export function writeState(state: LiveState) {
  state.lastUpdated = new Date().toISOString();
  state.version = (state.version || 0) + 1;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function appendEvent(event: any) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  writeFileSync(EVENTS_FILE, line, { flag: 'a' });
}

export function readEvents(sinceTs?: string): any[] {
  if (!existsSync(EVENTS_FILE)) return [];
  const raw = readFileSync(EVENTS_FILE, 'utf-8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => !sinceTs || e.ts > sinceTs);
}
