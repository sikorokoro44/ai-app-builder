import type { LiveState } from './state.ts';
import { calcStagePct } from './progress.ts';
import { ProjectStates } from './types.ts';

export interface ProgressView extends LiveState {
  currentStageName: string;
  currentStagePct: number | null;
}

export function enrichWithProgress(state: LiveState): ProgressView {
  const stage = calcStagePct(
    state.projectState as any,
    state.cloudBuild.stage as any,
    state.completedTasks,
    state.totalTasks,
    state.testStats,
    state.buildLogs,
    state.apkVerification,
    state.release.status
  );

  let cp = stage.pct;
  let name = stage.stageName;

  if (state.projectState === ProjectStates.COMPLETED) {
    cp = 100;
    name = 'COMPLETE';
  } else if (state.projectState === ProjectStates.DOWNLOAD_READY) {
    cp = 100;
    name = 'DOWNLOAD_READY';
  }

  return {
    ...state,
    currentStageName: name,
    currentStagePct: cp
  };
}
