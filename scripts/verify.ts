#!/usr/bin/env node
import { execSync } from 'child_process';
import { existsSync } from 'fs';

const checks = [
  'builder/config/builder.json',
  'builder/shared/types.ts',
  'builder/shared/state.ts',
  'builder/shared/progress.ts',
  'builder/shared/stateWithProgressImpl.ts',
  'builder/scripts/live/stateStore.ts',
  'builder/scripts/live/api.ts',
  'builder/scripts/live/orchestrator.ts',
  'builder/scripts/planner.ts',
  'builder/scripts/worker.ts',
  'builder/scripts/coordinator.ts',
  'builder/scripts/status.ts',
  'builder/scripts/release.ts',
  'builder/opencode/live-view-visual.ts',
  '.github/workflows/builder-planner.yml'
];

const missing = checks.filter((c) => !existsSync(c));
if (missing.length > 0) {
  console.error('MISSING:', missing);
  process.exit(1);
}
console.log('All builder files present:', checks.length);
