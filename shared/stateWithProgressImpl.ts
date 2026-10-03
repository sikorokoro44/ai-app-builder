import type { LiveState } from './state.ts';
import { calcStagePct } from './progress.ts';

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
  return {
    ...state,
    currentStageName: stage.stageName,
    currentStagePct: stage.pct
  };
}
