#!/usr/bin/env node
import { writeState } from '../live/stateStore.ts';
import { persistCheckpoint } from '../live/checkpointStore.ts';
import { ProjectStates } from '../../shared/types.ts';
import { assertValidTransition, InvalidTransitionError } from '../live/stateValidator.ts';

export const LIFECYCLE = [
  ProjectStates.NOT_STARTED,
  ProjectStates.QUEUED,
  ProjectStates.ANALYZING,
  ProjectStates.DESIGNING,
  ProjectStates.PLANNING,
  ProjectStates.READY,
  ProjectStates.BUILDING,
  ProjectStates.TESTING,
  ProjectStates.CLOUD_BUILDING,
  ProjectStates.VERIFYING,
  ProjectStates.RELEASING,
  ProjectStates.DOWNLOAD_READY,
  ProjectStates.COMPLETED
];

export function canAdvance(state: string): boolean {
  const i = LIFECYCLE.indexOf(state as any);
  return i >= 0 && i < LIFECYCLE.length - 1;
}

/**
 * Advances one step along the lifecycle. Illegal or out-of-order moves throw
 * instead of silently corrupting state; every advance is checkpointed first.
 */
export function advance(s: any, reason: string) {
  if (!canAdvance(s.projectState)) {
    throw new InvalidTransitionError(s.projectState, 'next');
  }
  const next = LIFECYCLE[LIFECYCLE.indexOf(s.projectState) + 1];
  assertValidTransition(s.projectState, next);
  persistCheckpoint(`pre-${s.projectState}`, s);
  s.projectState = next;
  s.latestActivity = reason;
  return s;
}

/**
 * Walks forward along the lifecycle to `target`, one legal step at a time, so a
 * stage script can record that a milestone is genuinely reached without ever
 * jumping a state. Each step is persisted before the next one starts: the state
 * store validates transitions against what is on disk, so an in-memory-only
 * hop would still look like a skipped stage.
 *
 * Refuses to walk backwards or to a state outside the lifecycle; use repairTo()
 * for a deliberate jump back to a failure point.
 */
export function advanceTo(s: any, target: string, reason: string) {
  const from = LIFECYCLE.indexOf(s.projectState);
  const to = LIFECYCLE.indexOf(target);
  if (from < 0) throw new InvalidTransitionError(String(s.projectState), target);
  if (to < 0) throw new InvalidTransitionError(s.projectState, target);
  if (to < from) {
    throw new InvalidTransitionError(
      s.projectState,
      `${target} (backwards; use repairTo for a repair)`
    );
  }
  while (s.projectState !== target) {
    advance(s, reason);
    writeState(s);
  }
  return s;
}

/**
 * Repairs resume at the recorded failure point, not from the beginning, so
 * already-verified stages keep their evidence.
 */
export function repairTo(s: any, target: string, reason: string) {
  assertValidTransition(s.projectState, target);
  persistCheckpoint(`pre-repair-${s.projectState}`, s);
  s.projectState = target;
  s.latestActivity = reason;
  return s;
}
