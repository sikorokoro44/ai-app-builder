#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { advanceTo } from './orchestrator/lifecycle.ts';
import { ProjectStates, TaskStates, Events } from '../shared/types.ts';
import { recordStage } from './live/evidenceChain.ts';

initStateStore();
let s = readState();
advanceTo(s, ProjectStates.PLANNING, 'Planning tasks and features');
const fid = 'feat-001';
if (!s.features[fid]) {
  s.features[fid] = { id: fid, title: 'Core app', description: 'Generated app', state: ProjectStates.PLANNING, tasks: ['task-001', 'task-002'] };
  s.totalFeatures = Object.keys(s.features).length;
}
['task-001', 'task-002'].forEach((tid) => {
  if (!s.tasks[tid]) {
    s.tasks[tid] = { id: tid, featureId: fid, title: `Task ${tid}`, state: TaskStates.READY, updatedAt: new Date().toISOString() };
    s.totalTasks = Object.keys(s.tasks).length;
    appendEvent({ type: Events.TASK_CREATED, taskId: tid, featureId: fid });
  }
});
// Planning is finished once the tasks exist, so the project becomes READY for
// implementation. Leaving it at PLANNING would make the next stage (BUILDING)
// an illegal skip, since READY is the state that actually means "plan accepted".
advanceTo(s, ProjectStates.READY, 'Plan ready for implementation');
recordStage(s, 'PLAN', `planned feature ${fid} with ${s.features[fid].tasks.length} tasks; state READY`);
writeState(s);
console.log('Planning complete');
