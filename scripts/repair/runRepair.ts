#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from '../live/stateStore.ts';
import { FailureRepairStates, Events, ProjectStates } from '../../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.REPAIRING;
s.failureRepair.state = FailureRepairStates.REPAIRING;
s.latestActivity = 'Repairing failure';
appendEvent({ type: Events.REPAIR_STARTED });
writeState(s);
console.log('Repair running');
