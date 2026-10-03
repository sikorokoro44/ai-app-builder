#!/usr/bin/env node
import { initStateStore, writeState } from './live/stateStore.ts';
import { createInitialState } from '../shared/state.ts';
import { ProjectStates } from '../shared/types.ts';

initStateStore();
const s = createInitialState();
writeState(s);
console.log('State reset');
