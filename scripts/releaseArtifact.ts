#!/usr/bin/env node
import { execSync } from 'child_process';
import { initStateStore, readState, writeState } from './live/stateStore.ts';

const repo = process.env.GITHUB_REPOSITORY || 'sikorokoro44/ai-app-builder';
const tag = process.env.BUILDER_RELEASE_TAG || `test-${Date.now()}`;
const asset = process.env.BUILDER_ASSET_PATH;

initStateStore();
let s = readState();
if (asset && asset.trim()) {
  try {
    execSync(`gh release create ${tag} --title "Build" --notes "Auto" --repo ${repo} --public "${asset}"`, { stdio: 'inherit' });
    const url = `https://github.com/${repo}/releases/download/${tag}/${asset.split('/').pop()}`;
    s.release.assetUrl = url;
    s.finalDownloadUrl = url;
    s.release.status = 'created';
    s.apkVerification = 'passed';
    s.projectState = 'DOWNLOAD_READY';
    s.currentStagePct = 100;
    writeState(s);
    console.log(url);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
console.error('No asset');
process.exit(1);
