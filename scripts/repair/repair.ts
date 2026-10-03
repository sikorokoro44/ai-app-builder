#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from '../live/stateStore.ts';
import { FailureRepairStates, Events } from '../../shared/types.ts';

initStateStore();
let s = readState();
if (s.failureRepair.state === 'idle' || s.failureRepair.state === 'VERIFIED') {
  s.failureRepair = {
    state: FailureRepairStates.FAILURE_DETECTED,
    failureDetectedAt: new Date().toISOString(),
    rootCause: 'Autonomous diagnosis pending'
  };
  appendEvent({ type: Events.REPAIR_STARTED, state: s.failureRepair.state });
}
writeState(s);
