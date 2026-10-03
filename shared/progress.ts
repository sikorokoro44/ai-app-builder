import { CloudBuildStages, ProjectStates } from './types.ts';

export function calcStagePct(
  projectState: typeof ProjectStates[keyof typeof ProjectStates],
  cloudStage: typeof CloudBuildStages[keyof typeof CloudBuildStages],
  completedTasks: number,
  totalTasks: number,
  testStats: { discovered: number; running: number; passed: number; failed: number },
  buildLogs: any[],
  apkVerification: string,
  releaseStatus: string
): { stageName: string; pct: number | null } {
  const stageNameMap: Record<string, string> = {
    [ProjectStates.ANALYZING]: 'ANALYZING',
    [ProjectStates.DESIGNING]: 'DESIGNING',
    [ProjectStates.PLANNING]: 'PLANNING',
    [ProjectStates.BUILDING]: 'BUILDING',
    [ProjectStates.TESTING]: 'TESTING',
    [ProjectStates.REPAIRING]: 'REPAIRING',
    [ProjectStates.CLOUD_BUILDING]: 'CLOUD_BUILD',
    [ProjectStates.VERIFYING]: 'APK_VERIFICATION',
    [ProjectStates.RELEASING]: 'RELEASING',
    [ProjectStates.DOWNLOAD_READY]: 'DOWNLOAD_READY',
    [ProjectStates.COMPLETED]: 'COMPLETE'
  };

  if (projectState === ProjectStates.COMPLETED) {
    return { stageName: 'COMPLETE', pct: 100 };
  }

  if (projectState === ProjectStates.DOWNLOAD_READY) {
    return { stageName: 'DOWNLOAD_READY', pct: 100 };
  }

  if (projectState === ProjectStates.CLOUD_BUILDING) {
    const stages = Object.values(CloudBuildStages);
    const idx = stages.indexOf(cloudStage);
    if (idx >= 0 && stages.length > 0) {
      const pct = Math.round(((idx) / (stages.length - 1)) * 100);
      return { stageName: 'CLOUD_BUILD', pct: Math.max(0, Math.min(100, pct)) };
    }
  }

  if (projectState === ProjectStates.BUILDING && totalTasks > 0) {
    const pct = Math.round((completedTasks / totalTasks) * 100);
    return { stageName: 'BUILDING', pct: Math.max(0, Math.min(100, pct)) };
  }

  if (projectState === ProjectStates.TESTING && testStats.discovered > 0) {
    const done = testStats.passed + testStats.failed;
    const pct = Math.round((done / testStats.discovered) * 100);
    return { stageName: 'TESTING', pct: Math.max(0, Math.min(100, pct)) };
  }

  if (projectState === ProjectStates.REPAIRING) {
    return { stageName: 'REPAIRING', pct: null };
  }

  if (projectState === ProjectStates.VERIFYING) {
    if (apkVerification === 'verifying') return { stageName: 'APK_VERIFICATION', pct: null };
    if (apkVerification === 'passed') return { stageName: 'APK_VERIFICATION', pct: 100 };
    if (apkVerification === 'failed') return { stageName: 'APK_VERIFICATION', pct: 0 };
  }

  if (projectState === ProjectStates.RELEASING) {
    if (releaseStatus === 'releasing') return { stageName: 'RELEASING', pct: null };
    if (releaseStatus === 'created') return { stageName: 'RELEASING', pct: 100 };
    if (releaseStatus === 'failed') return { stageName: 'RELEASING', pct: 0 };
  }

  const key = projectState as keyof typeof stageNameMap;
  if (stageNameMap[key]) {
    return { stageName: stageNameMap[key], pct: null };
  }
  return { stageName: projectState, pct: null };
}
