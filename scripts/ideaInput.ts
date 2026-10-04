#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'fs';
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { recordStage } from './live/evidenceChain.ts';

const idea = process.env.BUILDER_IDEA || '';
if (!idea.trim()) {
  console.error('BUILDER_IDEA required');
  process.exit(1);
}
mkdirSync('.builder', { recursive: true });
writeFileSync('.builder/idea.txt', idea);

// The idea is the first link of the chain the completion gate walks, and nothing
// recorded it, so no real run could ever satisfy the gate.
initStateStore();
const s = readState();
recordStage(s, 'IDEA', `idea captured (${idea.trim().length} chars) to .builder/idea.txt`);
writeState(s);
console.log('Idea captured');
