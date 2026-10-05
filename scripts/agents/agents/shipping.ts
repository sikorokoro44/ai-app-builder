/**
 * Agents 16-18: the shipping chain.
 *
 * These three agents do not reimplement the cloud, verification or release
 * logic. They decide when each proven step must run, run it in its own process
 * so its guards and evidence recording stay exactly as they are, and then verify
 * the result independently: a script exiting zero is not accepted as proof that
 * an APK was built or that a URL works.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentSpec } from '../../../shared/agentTypes.ts';
import { fail, ok, invalid, planFrom } from './common.ts';

/**
 * The last complete JSON object a script printed.
 *
 * Taking the last `{` and the last `}` only works for output with no nested
 * objects, and most of this pipeline's output has some: artifactVerify.ts
 * reports an `icon` object inside its result, so the last `{` opens the icon and
 * the parse returned the icon instead of the report — which is how run
 * 37390432614 got a verified APK and then "apkVerify did not record a checksum".
 * The earliest position whose remaining text parses is the outermost object.
 */
function lastJson(stdout: string): Record<string, unknown> | null {
  const end = stdout.lastIndexOf('}');
  if (end === -1) return null;
  for (let start = stdout.indexOf('{'); start !== -1 && start < end; start = stdout.indexOf('{', start + 1)) {
    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Not the start of the object; try the next one.
    }
  }
  return null;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim();
}

export interface PushArtifact {
  headSha: string;
  branch: string;
  pushed: boolean;
  reason?: string;
}

export const repoPublisherAgent: AgentSpec<void, PushArtifact> = {
  id: 'repo-publisher',
  index: 16,
  name: 'Repository Publisher',
  role: 'Commit and push to GitHub',
  responsibility: 'Commit the generated project and push it to the authoritative repository through the proven push script, then confirm the remote head matches.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'validation', description: 'Validation report', producedBy: 'quality-auditor' }
    ],
    outputs: [{ kind: 'push', description: 'The commit that is on the remote' }],
    requiredOutputFields: ['headSha', 'branch', 'pushed']
  },
  tools: ['githubPush.ts', 'git'],
  dependsOn: ['quality-auditor'],
  entersState: 'TESTING',
  nextState: 'BUILDING',
  exclusiveGroup: 'git-workspace',
  ownedPaths: [],
  completionCriteria: [
    'The push script accepted the tree and recorded the IMPLEMENT evidence.',
    'The remote head equals the local head.',
    'The pushed commit contains the generated project.'
  ],
  failurePolicy: { retryable: true, maxAttempts: 2, repairable: false, maxRepairs: 0, onExhausted: 'rollback' },
  execute(ctx) {
    const plan = planFrom(ctx);
    const result = ctx.runScriptOrThrow(['scripts/githubPush.ts']);
    const parsed = lastJson(result) as PushArtifact | null;
    if (!parsed || !parsed.headSha) {
      fail('repo-publisher', 'githubPush did not report a head sha', result.split('\n').slice(-8));
    }
    const branch = parsed.branch || process.env.BUILDER_BRANCH || 'main';
    const remoteHead = git(['rev-parse', `origin/${branch}`]);
    if (remoteHead !== parsed.headSha) {
      fail('repo-publisher', `origin/${branch} is at ${remoteHead.slice(0, 7)} but the push reported ${parsed.headSha.slice(0, 7)}`);
    }
    const tracked = git(['ls-tree', '-r', '--name-only', parsed.headSha, '.builder/generated/android']);
    if (!tracked.includes('app/build.gradle.kts')) {
      fail('repo-publisher', `the pushed commit does not contain the generated project for ${plan.packageId}`);
    }
    const out: PushArtifact = { headSha: parsed.headSha, branch, pushed: !!parsed.pushed, reason: parsed.reason };
    ctx.publish('push', out);
    ctx.activity(`pushed ${out.headSha.slice(0, 7)} to ${branch}`);
    ctx.log(`origin/${branch} is at ${out.headSha.slice(0, 7)}${out.pushed ? '' : ` (${out.reason || 'nothing new to push'})`}`);
    return out;
  },
  validate(out) {
    const errors: string[] = [];
    if (!out?.headSha || !/^[0-9a-f]{40}$/.test(out.headSha)) errors.push(`the push reported no real commit sha (${out?.headSha})`);
    if (!out.branch) errors.push('no branch recorded');
    if (typeof out.pushed !== 'boolean') errors.push('the push result is not recorded');
    return errors.length ? invalid(errors) : ok();
  }
};

export interface BuildArtifact {
  runId: string;
  conclusion: string;
  headSha: string;
  apkPath: string;
  sha256: string;
  packageId: string;
  sizeBytes: number;
  icon: {
    status?: string;
    category?: string;
    fingerprint?: string;
    compiledPath?: string;
    densities?: string[];
    similarity?: number;
  };
}

export const buildVerifierAgent: AgentSpec<void, BuildArtifact> = {
  id: 'build-verifier',
  index: 17,
  name: 'Build Verifier',
  role: 'Cloud build and APK verification',
  responsibility: 'Run the authoritative GitHub Actions build for the pushed commit, download the real artifact, and verify the APK and its compiled launcher icon independently.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'push', description: 'Pushed commit', producedBy: 'repo-publisher' }
    ],
    outputs: [{ kind: 'build', description: 'The cloud run, the real APK and the icon verification result' }],
    requiredOutputFields: ['runId', 'conclusion', 'apkPath', 'sha256', 'packageId', 'icon']
  },
  tools: ['cloudBuildExecute.ts', 'gh run download', 'apkVerify.ts'],
  dependsOn: ['repo-publisher'],
  entersState: 'BUILDING',
  nextState: 'VERIFYING',
  exclusiveGroup: 'cloud',
  ownedPaths: [],
  completionCriteria: [
    'A GitHub Actions run concluded with success for the pushed commit.',
    'The downloaded APK passes independent verification with a recorded sha256.',
    'The compiled launcher icon matches the icon that was generated.'
  ],
  failurePolicy: { retryable: true, maxAttempts: 3, repairable: false, maxRepairs: 0, onExhausted: 'rollback' },
  execute(ctx) {
    const plan = planFrom(ctx);
    ctx.runScriptOrThrow(['scripts/cloudBuildExecute.ts', '--prepare']);
    ctx.runScriptOrThrow(['scripts/cloudBuildExecute.ts', '--dispatch']);
    ctx.activity('waiting for the GitHub Actions build to finish');
    // `--watch` reports the run it waited for. Asking artifactVerify.ts for it
    // was wrong twice over: the gate legitimately refuses before an APK has been
    // downloaded and verified, so the call threw before the download began, and
    // using a verification gate to read a field makes the gate depend on the
    // order it is called in.
    const watched = lastJson(ctx.runScriptOrThrow(['scripts/cloudBuildExecute.ts', '--watch'])) as { runId?: string; headSha?: string } | null;
    const runId = watched?.runId || '';
    if (!runId) fail('build-verifier', 'the cloud build did not record a run id');

    const dir = mkdtempSync(join(tmpdir(), `builder-apk-${runId}-`));
    try {
      execFileSync('gh', ['run', 'download', runId, '--name', 'app-debug-apk', '--dir', dir], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      const err = e as { stderr?: string };
      fail('build-verifier', `could not download the artifact of run ${runId}`, [String(err.stderr || e).slice(0, 400)]);
    }
    const apk = readdirSync(dir).map((f) => join(dir, f)).find((f) => statSync(f).isFile() && f.endsWith('.apk'));
    if (!apk) fail('build-verifier', `run ${runId} produced no APK in its artifact`, readdirSync(dir));

    ctx.runScriptOrThrow(['scripts/apkVerify.ts'], { BUILDER_APK_PATH: apk, BUILDER_EXPECTED_PACKAGE_ID: plan.packageId, BUILDER_RUN_ID: runId });

    const verified = lastJson(ctx.runScriptOrThrow(['scripts/artifactVerify.ts'])) as Record<string, unknown> | null;
    const out: BuildArtifact = {
      runId,
      conclusion: String(verified?.conclusion ?? ''),
      headSha: String(verified?.headSha ?? watched?.headSha ?? ''),
      apkPath: apk,
      sha256: String(verified?.sha256 ?? ''),
      packageId: String(verified?.packageId ?? plan.packageId),
      sizeBytes: Number(verified?.sizeBytes ?? 0),
      icon: (verified?.icon ?? {}) as BuildArtifact['icon']
    };
    if (!out.sha256) fail('build-verifier', 'apkVerify did not record a checksum', ['no sha256 in the verification output']);
    ctx.publish('build', out);
    ctx.activity(`verified ${out.sizeBytes} byte APK from run ${runId}`);
    ctx.log(`run ${runId} ${out.conclusion}: sha256=${out.sha256.slice(0, 12)}… icon=${out.icon?.compiledPath ?? 'unmatched'}`);
    return out;
  },
  validate(out) {
    const errors: string[] = [];
    if (!out?.runId || !/^\d+$/.test(out.runId)) errors.push(`no real workflow run id (${out?.runId})`);
    if (out.conclusion !== 'success') errors.push(`the workflow concluded "${out.conclusion}", not success`);
    if (!/^[0-9a-f]{64}$/.test(out.sha256 || '')) errors.push(`the APK has no real checksum (${out.sha256})`);
    if (!out.packageId) errors.push('the APK has no package id');
    if (!out.sizeBytes) errors.push('the APK has no recorded size');
    if (!existsSync(out.apkPath || '')) errors.push(`the verified APK is not on disk: ${out.apkPath}`);
    if (out.icon?.status !== 'passed') errors.push(`the compiled launcher icon did not pass verification (${out.icon?.status})`);
    if (!out.icon?.compiledPath) errors.push('the compiled icon was not matched to a resource in the APK');
    return errors.length ? invalid(errors) : ok();
  }
};

export interface ReleaseArtifact {
  tag: string;
  assetName: string;
  assetUrl: string;
  sha256: string;
  finalDownloadUrl: string;
  httpStatus: number;
  state: string;
}

export const releasePublisherAgent: AgentSpec<void, ReleaseArtifact> = {
  id: 'release-publisher',
  index: 18,
  name: 'Release Publisher',
  role: 'Release and public download',
  responsibility: 'Publish the verified APK as a release, prove the public HTTPS URL really serves those exact bytes, and close the download-ready gate.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'build', description: 'Verified APK', producedBy: 'build-verifier' }
    ],
    outputs: [{ kind: 'release', description: 'The release tag, asset URL, checksum and verified download' }],
    requiredOutputFields: ['tag', 'assetName', 'assetUrl', 'sha256', 'finalDownloadUrl', 'state']
  },
  tools: ['releaseArtifact.ts', 'validatePublicUrl.ts', 'markDownloadReady.ts'],
  dependsOn: ['build-verifier'],
  entersState: 'VERIFYING',
  nextState: 'RELEASING',
  exclusiveGroup: 'release',
  ownedPaths: [],
  completionCriteria: [
    'The release exists with the verified APK as its asset.',
    'The public URL answers over HTTPS and matches the verified checksum.',
    'The download-ready gate passes on the recorded evidence.'
  ],
  failurePolicy: { retryable: true, maxAttempts: 2, repairable: true, maxRepairs: 1, onExhausted: 'rollback' },
  execute(ctx) {
    const build = ctx.artifact<BuildArtifact>('build-verifier', 'build');
    const published = lastJson(ctx.runScriptOrThrow(['scripts/releaseArtifact.ts'])) as Record<string, unknown> | null;
    if (!published?.assetUrl) fail('release-publisher', 'releaseArtifact published no asset url');
    const served = lastJson(ctx.runScriptOrThrow(['scripts/validatePublicUrl.ts'], { BUILDER_PUBLIC_URL: String(published.assetUrl) })) as Record<string, unknown> | null;
    if (!served || served.ok !== true) fail('release-publisher', `the public URL did not verify: ${published.assetUrl}`);
    const ready = lastJson(ctx.runScriptOrThrow(['scripts/markDownloadReady.ts'])) as Record<string, unknown> | null;
    if (!ready?.ok) fail('release-publisher', 'the download-ready gate refused the run');

    const out: ReleaseArtifact = {
      tag: String(published.tag ?? ''),
      assetName: String(published.assetName ?? ''),
      assetUrl: String(published.assetUrl ?? ''),
      sha256: String(published.sha256 ?? build.sha256),
      finalDownloadUrl: String(ready.url ?? published.assetUrl),
      httpStatus: Number(served.status ?? 0),
      state: String(ready.state ?? '')
    };
    ctx.publish('release', out);
    ctx.activity(`published ${out.tag} and verified the public download (HTTP ${out.httpStatus})`);
    ctx.log(`release ${out.tag}: ${out.assetUrl}`);
    return out;
  },
  validate(out) {
    const errors: string[] = [];
    if (!out?.tag) errors.push('no release tag');
    if (!out.assetName) errors.push('no release asset name');
    if (!/^https:\/\/github\.com\//.test(out.assetUrl || '')) errors.push(`the asset url is not a genuine GitHub release url (${out.assetUrl})`);
    if (!/^[0-9a-f]{64}$/.test(out.sha256 || '')) errors.push(`the release has no real checksum (${out.sha256})`);
    if (out.finalDownloadUrl !== out.assetUrl) errors.push('the final download url is not the verified asset url');
    if (out.httpStatus !== 200) errors.push(`the public download answered HTTP ${out.httpStatus}, not 200`);
    if (out.state !== 'DOWNLOAD_READY') errors.push(`the run is in ${out.state}, not DOWNLOAD_READY`);
    return errors.length ? invalid(errors) : ok();
  }
};
