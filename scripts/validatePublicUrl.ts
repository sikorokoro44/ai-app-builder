#!/usr/bin/env node
import https from 'https';
import { initStateStore, readState, writeState } from './live/stateStore.ts';
import { ProjectStates } from '../shared/types.ts';

function head(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD' }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 301);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function main() {
  initStateStore();
  let s = readState();
  const url = s.finalDownloadUrl || s.release.assetUrl;
  if (!url || url.includes('example')) {
    console.error('No real public URL');
    process.exit(1);
  }
  const ok = await head(url);
  if (!ok) {
    console.error('URL not accessible');
    process.exit(1);
  }
  s.projectState = ProjectStates.DOWNLOAD_READY;
  s.currentStagePct = 100;
  s.overallProgressPct = Math.max(s.overallProgressPct, 99);
  writeState(s);
  console.log('Public URL validated');
}

main();
