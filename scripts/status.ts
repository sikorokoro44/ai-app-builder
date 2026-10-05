#!/usr/bin/env node
import { execSync } from 'child_process';

const configPath = process.env.BUILDER_CONFIG_PATH || 'config/builder.json';
const config = JSON.parse(execSync(`cat ${configPath}`).toString());
const ownerRepo = process.env.GITHUB_REPOSITORY || 'owner/repo';
const [owner, repo] = ownerRepo.split('/');

function listIssues(label: string) {
  try {
    const out = execSync(`gh issue list --label "${label}" --json number,title,url --state open --repo ${ownerRepo}`, { encoding: 'utf-8' });
    return JSON.parse(out);
  } catch (e) {
    return [];
  }
}

const notStarted = listIssues(config.status.labelNotStarted);
const building = listIssues(config.status.labelBuilding);
const complete = listIssues(config.status.labelComplete);
const failed = listIssues(config.status.labelFailed || 'FAILED');

console.log(JSON.stringify({ notStarted, building, complete, failed }, null, 2));
