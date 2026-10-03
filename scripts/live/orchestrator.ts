#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from './stateStore.ts';
import { ProjectStates, AgentStates, TaskStates, CloudBuildStages, Events } from '../../shared/types.ts';

initStateStore();
let state = readState();

function updateProjectState(s: typeof ProjectStates[keyof typeof ProjectStates], activity: string) {
  state.projectState = s;
  state.latestActivity = activity;
  appendEvent({ type: Events.PROJECT_STATUS_CHANGED, projectState: s, activity });
}

function ensureAgent(id: string, name: string) {
  if (!state.agents[id]) {
    state.agents[id] = {
      id,
      name,
      state: AgentStates.IDLE,
      activity: 'Initialized',
      updatedAt: new Date().toISOString()
    };
    appendEvent({ type: Events.AGENT_STARTED, agentId: id, name });
  }
}

function agentActivity(id: string, activity: string, newState?: any) {
  ensureAgent(id, id);
  state.agents[id].activity = activity;
  if (newState) state.agents[id].state = newState;
  state.agents[id].updatedAt = new Date().toISOString();
  appendEvent({ type: Events.AGENT_ACTIVITY, agentId: id, activity, state: state.agents[id].state });
}

function setCloudStage(stage: any, line?: string) {
  state.cloudBuild.stage = stage;
  state.cloudBuild.status = 'running';
  state.projectState = ProjectStates.CLOUD_BUILDING;
  if (line) {
    const out = { timestamp: new Date().toISOString(), stage, line };
    state.cloudBuild.output.push(out);
    state.buildLogs.push(out);
    appendEvent({ type: Events.BUILD_OUTPUT, stage, line });
  }
  appendEvent({ type: Events.BUILD_STAGE_CHANGED, stage });
}

initStateStore();
state = readState();

// Initialize with 20 agents as per config
const agentCount = 20;
for (let i = 1; i <= agentCount; i++) {
  ensureAgent(`agent-${String(i).padStart(2, '0')}`, `Worker ${i}`);
}

updateProjectState(ProjectStates.READY, 'Orchestrator ready');
state.overallProgressPct = 0;
state.totalFeatures = 0;
state.totalTasks = 0;
state.completedFeatures = 0;
state.completedTasks = 0;

writeState(state);
console.log('Orchestrator initialized', { agents: agentCount, state: state.projectState });
