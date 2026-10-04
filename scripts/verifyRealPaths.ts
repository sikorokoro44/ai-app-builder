#!/usr/bin/env node
import { existsSync } from 'fs';

const required = [
  'scripts/generateAndroidApp.ts',
  '.github/workflows/builder-android-build.yml',
  'scripts/planner_real.ts'
];
const missing = required.filter((p) => !existsSync(p));
if (missing.length) {
  console.error('MISSING', missing);
  process.exit(1);
}
console.log('OK');
