#!/usr/bin/env node
/**
 * Check that every file the builder depends on is actually here.
 *
 * The paths are repo-root relative: this repository *is* the builder module, so
 * there is no `builder/` prefix. An older copy of this script looked for one and
 * therefore reported every file as missing, which is the kind of check that only
 * works when nobody runs it.
 */
import { existsSync } from 'node:fs';

const checks = [
  'config/builder.json',
  'package.json',
  'shared/types.ts',
  'shared/state.ts',
  'shared/progress.ts',
  'shared/stateWithProgressImpl.ts',
  'shared/agentTypes.ts',
  'shared/liveProgress.ts',
  'scripts/live/stateStore.ts',
  'scripts/live/stateValidator.ts',
  'scripts/live/evidenceChain.ts',
  'scripts/live/recoveryManager.ts',
  'scripts/live/api.ts',
  'scripts/live/orchestrator.ts',
  'scripts/planner.ts',
  'scripts/worker.ts',
  'scripts/coordinator.ts',
  'scripts/status.ts',
  'scripts/release.ts',
  'scripts/agents/agentIds.ts',
  'scripts/agents/registry.ts',
  'scripts/agents/ownership.ts',
  'scripts/agents/planner.ts',
  'scripts/agents/coordinator.ts',
  'scripts/agents/recovery.ts',
  'scripts/agents/index.ts',
  'scripts/agents/agents/analysis.ts',
  'scripts/agents/agents/design.ts',
  'scripts/agents/agents/build.ts',
  'scripts/agents/agents/quality.ts',
  'scripts/agents/agents/shipping.ts',
  'scripts/agents/agents/oversight.ts',
  'scripts/project/emitters.ts',
  'scripts/generateAndroidApp.ts',
  'scripts/cloudBuildExecute.ts',
  'scripts/requestRun.ts',
  'scripts/live/runRequests.ts',
  'scripts/live/workflowWatcher.ts',
  'scripts/live/failureClassifier.ts',
  'scripts/live/gitIdentity.ts',
  'scripts/apkVerify.ts',
  'scripts/artifactVerify.ts',
  'opencode/live-view-visual.ts',
  'opencode/live-progress.ts',
  '.github/workflows/builder-planner.yml',
  '.github/workflows/builder-coordinator.yml',
  '.github/workflows/builder-workers.yml',
  '.github/workflows/builder-android-build.yml',
  'test/fixtures/generatedProjectGolden.json'
];

const missing = checks.filter((c) => !existsSync(c));
if (missing.length > 0) {
  console.error('MISSING:', missing);
  process.exit(1);
}
console.log('All builder files present:', checks.length);
