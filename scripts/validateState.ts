#!/usr/bin/env node
import { readState } from './live/stateStore.ts';
import { assertTruthful } from './live/stateValidator.ts';

const s = readState();
assertTruthful(s);
console.log('State is truthful');
