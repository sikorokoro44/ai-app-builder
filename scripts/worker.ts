#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const configPath = process.env.BUILDER_CONFIG_PATH || 'builder/config/builder.json';
const config = JSON.parse(execSync(`cat ${configPath}`).toString());
const workerId = process.env.BUILDER_WORKER_ID || 'worker-01';
const feature = JSON.parse(process.env.BUILDER_FEATURE_JSON || '{}');

const branch = `builder/feature/${feature.id}-${workerId}`;
execSync(`git checkout -b ${branch}`, { stdio: 'inherit' });
execSync(`git add .`, { stdio: 'inherit' });
execSync(`git -c user.name="builder" -c user.email="builder@local" commit -m "Build ${feature.id} (${workerId})" || true`, { stdio: 'inherit' });
execSync(`git push origin ${branch}`, { stdio: 'inherit' });
console.log(`Worker ${workerId} pushed ${branch}`);
