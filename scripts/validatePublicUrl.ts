#!/usr/bin/env node
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { verifyPublicDownload, isValidHttpsUrl, rejectFakeReleaseUrl } from './live/releaseVerifier.ts';
import { recordStage } from './live/evidenceChain.ts';
import { ProjectStates, Events } from '../shared/types.ts';

async function main() {
  initStateStore();
  const s = readState();
  const url = process.env.BUILDER_PUBLIC_URL || s.finalDownloadUrl || s.release.assetUrl || '';

  if (!url) {
    console.error('No public URL recorded; a URL must never be assumed to work');
    process.exit(1);
  }
  if (!isValidHttpsUrl(url) || rejectFakeReleaseUrl(url)) {
    console.error(`Refusing non-genuine public URL: ${url}`);
    s.evidence = { ...(s.evidence || { stages: [] }), publicDownloadVerified: false };
    writeState(s);
    process.exit(1);
  }

  const res = await verifyPublicDownload(url);
  if (!res.valid) {
    console.error(JSON.stringify({ ok: false, url, errors: res.errors, status: res.status }, null, 2));
    s.evidence = { ...(s.evidence || { stages: [] }), publicDownloadVerified: false };
    s.release.status = 'failed';
    s.release.failedReason = `public download unreachable: ${res.errors.join('; ')}`;
    appendEvent({ type: Events.RELEASE_CREATED, error: res.errors });
    writeState(s);
    process.exit(1);
  }

  recordStage(s, 'PUBLIC_HTTPS_URL', `https url ${url}`, s.cloudBuild.runId);
  recordStage(s, 'PUBLIC_DOWNLOAD', `HTTP 200 via ${res.finalUrl || url}${res.contentLength ? ` len=${res.contentLength}` : ''}`, s.cloudBuild.runId);
  s.finalDownloadUrl = url;
  s.evidence = {
    ...(s.evidence || { stages: [] }),
    publicDownloadVerified: true,
    publicDownloadUrl: url,
    finalVerifyAt: new Date().toISOString()
  };
  s.latestActivity = `Public download verified: ${url}`;
  appendEvent({ type: Events.DOWNLOAD_READY, url, status: res.status, finalUrl: res.finalUrl });
  appendEvent({ type: Events.PUBLIC_DOWNLOAD_VERIFIED, verified: true, url, status: res.status });
  writeState(s);
  console.log(JSON.stringify({
    ok: true,
    url,
    status: res.status,
    finalUrl: res.finalUrl,
    contentType: res.contentType,
    contentLength: res.contentLength
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
