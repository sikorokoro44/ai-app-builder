#!/usr/bin/env node
import { enrichWithProgress } from '../shared/stateWithProgress.ts';
import { readState, readEvents } from '../scripts/live/stateStore.ts';

function format() {
  const s = enrichWithProgress(readState());
  const events = readEvents().slice(-15);
  const stagePct = s.currentStagePct === null ? '—' : s.currentStagePct + '%';
  const activeAgents = Object.values(s.agents).filter((a: any) => a.state === 'WORKING' || a.state === 'REPAIRING' || a.state === 'TESTING');
  return {
    headline: `OVERALL: ${s.overallProgressPct}% | CURRENT STAGE: ${s.currentStageName} ${stagePct}`,
    project: s.projectState,
    features: `${s.completedFeatures}/${s.totalFeatures}`,
    tasks: `${s.completedTasks}/${s.totalTasks}`,
    activeAgents,
    cloud: { stage: s.cloudBuild.stage, status: s.cloudBuild.status },
    apk: s.apkVerification,
    release: s.release,
    download: s.finalDownloadUrl || s.release.assetUrl || null,
    failureRepair: s.failureRepair,
    latest: s.latestActivity,
    events
  };
}

console.log(JSON.stringify(format(), null, 2));
