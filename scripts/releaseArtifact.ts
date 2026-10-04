#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { existsSync, statSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { persistCheckpoint } from './live/checkpointStore.ts';
import { verifyApkFile } from './live/apkValidator.ts';
import {
  validateReleaseEvidence,
  assetBrowserUrl,
  isBrowserDownloadUrl,
  digestToSha256,
  planReleaseAction
} from './live/releaseVerifier.ts';
import { recordStage } from './live/evidenceChain.ts';
import { scanForSecrets } from './live/repoGuard.ts';
import { assertValidTransition } from './live/stateValidator.ts';
import { ProjectStates, Events } from '../shared/types.ts';

const REQUIRED_REPO = 'sikorokoro44/ai-app-builder';

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

interface ExistingAsset {
  assetExists: boolean;
  publishedSha256?: string;
  assetSize?: number;
  browserUrl?: string;
}

initStateStore();
const s = readState();

const repo = process.env.BUILDER_RELEASE_REPO || s.release.repo || REQUIRED_REPO;
if (repo !== REQUIRED_REPO) {
  fail(`Refusing to release to ${repo}; only ${REQUIRED_REPO} is permitted`);
}
const assetPath = process.env.BUILDER_ASSET_PATH || s.apkPath || '';
const runId = process.env.BUILDER_RUN_ID || s.cloudBuild.runId || '';

if (!assetPath || !existsSync(assetPath)) {
  fail(`No verified APK to release (path=${assetPath || '(unset)'})`);
}
if (s.apkVerification !== 'passed' || !s.apkSha256) {
  fail('Refusing to release: APK verification has not passed with a recorded checksum');
}

const disk = verifyApkFile(assetPath, process.env.BUILDER_EXPECTED_PACKAGE_ID || undefined);
if (!disk.valid) {
  fail(`Refusing to release invalid APK: ${disk.errors.join('; ')}`);
}
if (s.apkSha256 !== disk.sha256) {
  fail(`APK checksum drifted since verification (state=${s.apkSha256}, disk=${disk.sha256})`);
}

const assetName = process.env.BUILDER_ASSET_NAME || s.release.assetName || 'app-debug.apk';

const secretHits = scanForSecrets(readFileSync(assetPath).toString('latin1'));
if (secretHits.length > 0) {
  fail(`Refusing to publish APK containing possible secrets: ${secretHits.join(', ')}`);
}

const tag = process.env.BUILDER_RELEASE_TAG || `build-${runId || 'local'}`;

let releaseExists = false;
let asset: ExistingAsset = { assetExists: false };

try {
  const rel = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'tagName,url,assets,isDraft,isPrerelease']));
  releaseExists = true;
  const found = (rel.assets || []).find((a: any) => a.name === assetName);
  if (found) {
    asset = { assetExists: true, assetSize: found.size };

    // GitHub exposes the published checksum as a `sha256:<hex>` digest, but it
    // is null for assets uploaded before digests were recorded. Falling back to
    // downloading the published asset means we verify what users would actually
    // get rather than trusting metadata.
    try {
      const digestJson = gh(['api', `repos/${repo}/releases/tags/${tag}/assets`, '--jq',
        `[.[] | select(.name=="${assetName}")] | first | {digest, id, browser_download_url}`]);
      const meta = JSON.parse(digestJson || 'null') || {};
      asset.publishedSha256 = digestToSha256(meta.digest);
      const candidate: string | undefined = meta.browser_download_url;
      if (isBrowserDownloadUrl(candidate, repo, tag, assetName)) {
        asset.browserUrl = candidate;
      }
    } catch { /* digest and asset id are optional */ }

    if (!asset.publishedSha256) {
      const dir = mkdtempSync(join(tmpdir(), 'builder-release-'));
      try {
        gh(['release', 'download', tag, '--repo', repo, '--pattern', assetName, '--dir', dir, '--clobber']);
        const downloaded = join(dir, assetName);
        if (existsSync(downloaded)) asset.publishedSha256 = sha256File(downloaded);
      } catch {
        // Leave publishedSha256 undefined: the plan then requires a replacement.
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
} catch (e: any) {
  const msg = String(e.stderr || e.message);
  if (!/not found|could not resolve|no release/i.test(msg)) {
    fail(`Unexpected gh release view failure: ${msg}`);
  }
}

const plan = planReleaseAction({
  releaseExists,
  assetExists: asset.assetExists,
  publishedSha256: asset.publishedSha256,
  wantedSha256: disk.sha256
});
console.error(`Release ${tag}: ${plan.action} (${plan.reason})`);

if (plan.action !== 'reuse') {
  if (plan.action === 'create-release') {
    if (s.projectState !== ProjectStates.RELEASING) {
      try {
        assertValidTransition(s.projectState, ProjectStates.RELEASING);
      } catch (e: any) {
        fail(`Refusing out-of-order release: ${e.message}`);
      }
    }
    s.projectState = ProjectStates.RELEASING;
    s.release.status = 'releasing';
  }
  s.release.repo = repo;
  s.release.tag = tag;
  s.release.assetName = assetName;
  s.release.status = 'releasing';
  persistCheckpoint('pre-release', s);
  writeState(s);
  appendEvent({ type: Events.BUILD_STAGE_CHANGED, stage: 'RELEASE' });

  try {
    if (plan.action === 'create-release') {
      gh(['release', 'create', tag, '--title', 'Builder Android build', '--notes',
        `Automated build for ${runId || 'local run'}\nAPK sha256: ${disk.sha256}`,
        '--repo', repo, `${assetPath}#${assetName}`]);
    } else {
      // --clobber replaces an existing asset of the same name, which is how a
      // mismatched or unverifiable published artifact is repaired in place.
      gh(['release', 'upload', tag, `${assetPath}#${assetName}`, '--repo', repo, '--clobber']);
    }
  } catch (e: any) {
    const msg = String(e.stderr || e.message).slice(0, 500);
    s.release.status = 'failed';
    s.release.failedReason = `${plan.action} failed: ${msg}`;
    appendEvent({ type: Events.BUILD_FAILED, stage: 'RELEASE', error: s.release.failedReason });
    writeState(s);
    fail(`Release ${plan.action} failed: ${msg}`);
  }

  // After publishing, re-read the asset so the recorded URL and checksum come
  // from the release itself rather than from a locally constructed string.
  //
  // `releaseExists` is refreshed here too. It was captured *before* publishing,
  // so on a first-ever release it was false; validating against that stale value
  // rejected the release we had just successfully created.
  releaseExists = true;
  let publishedSha = disk.sha256;
  let browserUrl: string | undefined;
  try {
    const after = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}/assets`, '--jq',
      `[.[] | select(.name=="${assetName}")] | first | {digest, browser_download_url}`]));
    publishedSha = digestToSha256(after.digest) || publishedSha;
    if (isBrowserDownloadUrl(after.browser_download_url, repo, tag, assetName)) {
      browserUrl = after.browser_download_url;
    }
  } catch { /* fall back to the canonical URL */ }

  asset = {
    assetExists: true,
    publishedSha256: publishedSha,
    assetSize: statSync(assetPath).size,
    browserUrl
  };
}

const finalUrl = asset.browserUrl || assetBrowserUrl(repo, tag, assetName);
if (!isBrowserDownloadUrl(finalUrl, repo, tag, assetName)) {
  fail(`Refusing to record a non-browser asset URL: ${finalUrl}`);
}

const evidence = validateReleaseEvidence(
  {
    releaseExists,
    assetExists: asset.assetExists,
    assetBrowserUrl: finalUrl,
    assetSha256: asset.publishedSha256,
    runId: runId || undefined
  },
  { repo, tag, assetName, expectedSha256: disk.sha256, runId: runId || undefined }
);

if (!evidence.valid) {
  s.release.status = 'failed';
  s.release.failedReason = evidence.errors.join('; ');
  appendEvent({ type: Events.BUILD_FAILED, stage: 'RELEASE', errors: evidence.errors });
  writeState(s);
  fail(`Release verification failed: ${evidence.errors.join('; ')}`);
}

s.release.status = 'created';
s.release.repo = repo;
s.release.tag = tag;
s.release.assetName = assetName;
s.release.assetUrl = finalUrl;
s.release.assetSha256 = asset.publishedSha256;
s.release.runId = runId || undefined;
s.release.releaseUrl = `https://github.com/${repo}/releases/tag/${tag}`;
s.release.verifiedAt = new Date().toISOString();
s.finalDownloadUrl = finalUrl;
recordStage(s, 'RELEASE', `tag=${tag}`, runId || undefined);
recordStage(s, 'RELEASE_ASSET', `${assetName} sha256=${s.release.assetSha256}`, runId || undefined);
appendEvent({
  type: Events.RELEASE_CREATED,
  url: finalUrl,
  tag,
  sha256: s.release.assetSha256,
  repo,
  assetName
});
writeState(s);

console.log(JSON.stringify({
  ok: true,
  action: plan.action,
  reason: plan.reason,
  repo,
  tag,
  assetName,
  assetUrl: s.release.assetUrl,
  sha256: s.release.assetSha256
}, null, 2));
