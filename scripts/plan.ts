#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { ProjectStates, TaskStates, Events } from '../shared/types.ts';

initStateStore();
let s = readState();
s.projectState = ProjectStates.PLANNING;
s.latestActivity = 'Planning tasks and features';
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
writeState(s);
console.log('Planning complete');
