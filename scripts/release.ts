#!/usr/bin/env node
import { execSync } from 'child_process';

const featureId = process.env.BUILDER_FEATURE_ID || 'feat-000';
const featureTitle = process.env.BUILDER_FEATURE_TITLE || 'Feature';
const assetPath = process.env.BUILDER_ASSET_PATH || '';
const tag = process.env.BUILDER_RELEASE_TAG || `builder-${featureId}-${Date.now()}`;
const configPath = process.env.BUILDER_CONFIG_PATH || 'builder/config/builder.json';
JSON.parse(execSync(`cat ${configPath}`).toString()); // validate

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.error('GITHUB_REPOSITORY not set');
  process.exit(1);
}

try {
  if (assetPath && assetPath.trim()) {
    execSync(`gh release create ${tag} --title "${featureTitle}" --notes "Auto-generated public release for ${featureId}" --repo "${repo}" --public "${assetPath}"`, { stdio: 'inherit' });
  } else {
    execSync(`gh release create ${tag} --title "${featureTitle}" --notes "Auto-generated public release for ${featureId}" --repo "${repo}" --public`, { stdio: 'inherit' });
  }
} catch (e) {
  console.error('Release creation failed:', e);
  process.exit(1);
}
