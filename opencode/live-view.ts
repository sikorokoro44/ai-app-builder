#!/usr/bin/env node
import { readState, readEvents } from '../scripts/live/stateStore.ts';

function formatState() {
  const s = readState();
  const events = readEvents(s.lastUpdated ? undefined : undefined).slice(-20);
  return {
    project: {
      state: s.projectState,
      progress: s.overallProgressPct,
      completedFeatures: s.completedFeatures,
      totalFeatures: s.totalFeatures,
      completedTasks: s.completedTasks,
      totalTasks: s.totalTasks,
      elapsedMs: s.elapsedMs,
      latestActivity: s.latestActivity
    },
    agents: Object.values(s.agents).map((a) => ({
      id: a.id,
      state: a.state,
      activity: a.activity,
      task: a.currentTaskId,
      feature: a.currentFeatureId,
      waiting: a.waitingReason,
      blocked: a.blockingReason
    })),
    tests: s.testStats,
    cloud: { stage: s.cloudBuild.stage, status: s.cloudBuild.status },
    apk: s.apkVerification,
    release: s.release,
    download: s.finalDownloadUrl || s.release.assetUrl,
    failureRepair: s.failureRepair,
    repairs: s.repairs,
    recentEvents: events
  };
}

console.log(JSON.stringify(formatState(), null, 2));
