import { test, describe } from 'node:test';
import assert from 'node:assert';

// recordStage() appends to the live event log, so this suite must never point at
// the tracked `.builder/live`; it used to append >1000 fabricated evidence events
// there on every run. isolate.mjs points the store at a throwaway directory, and
// must be loaded before the store modules, which read these paths on import.
await import('./isolate.mjs');

const { createInitialState } = await import('../shared/state.ts');
const { ProjectStates } = await import('../shared/types.ts');
const { assertTruthful, looksFabricated } = await import('../scripts/live/stateValidator.ts');
const { assertLifecycleEvidence, recordStage, missingStages, hasStage, LifecycleStages } = await import('../scripts/live/evidenceChain.ts');
const { assertCompleteLifecycle, assertDownloadReadyGate } = await import('../scripts/live/lifecycleGate.ts');

const REPO = 'sikorokoro44/ai-app-builder';
const SHA = 'c'.repeat(64);
const URL = `https://github.com/${REPO}/releases/download/build-1/app-debug.apk`;

function fullyEvidenced(overrides: any = {}) {
  const s = createInitialState() as any;
  for (const stage of LifecycleStages) recordStage(s, stage as any, 'verified');
  s.projectState = ProjectStates.DOWNLOAD_READY;
  s.overallProgressPct = 100;
  s.cloudBuild = { state: 'succeeded', stage: 'RELEASE', status: 'passed', output: [], runId: '9001', headSha: 'abc', artifactSha256: SHA, finishedAt: '2026-10-07T00:00:00.000Z' };
  s.apkVerification = 'passed';
  s.icon = { status: 'passed', category: 'notes', purpose: 'notes', fingerprint: 'f'.repeat(64) };
  s.apkPath = '/data/data/com.termux/files/usr/tmp/opencode/app-debug.apk';
  s.apkSha256 = SHA;
  s.apkPackageId = 'com.builder.notes';
  s.release = { status: 'created', assetUrl: URL, assetName: 'app-debug.apk', assetSha256: SHA, repo: REPO, tag: 'build-1' };
  s.finalDownloadUrl = URL;
  s.evidence.publicDownloadVerified = true;
  s.evidence.publicDownloadUrl = URL;
  return Object.assign(s, overrides);
}

describe('fabricated value detection', () => {
  const fake = [
    'https://github.com/example/repo/releases/download/t/a.apk',
    'https://example.com/a.apk',
    'https://github.com/o/r/releases/download/t/placeholder.apk',
    'https://fake.example/a.apk',
    'https://localhost/a.apk',
    'http://github.com/o/r/a.apk',
    'https://example.org/a.apk',
    'https://github.com/o/r/releases/download/t/placeholder.apk',
    'http://192.168.1.5:8080/app.apk'
  ];
  for (const u of fake) {
    test(`detects ${u}`, () => assert.strictEqual(looksFabricated(u), true));
  }
  test('does not flag a genuine URL', () => assert.strictEqual(looksFabricated(URL), false));
});

describe('truthful state invariants', () => {
  test('a fresh state is truthful', () => {
    assert.doesNotThrow(() => assertTruthful(createInitialState()));
  });

  test('COMPLETED at 99% is rejected', () => {
    const s = fullyEvidenced({ projectState: ProjectStates.COMPLETED, overallProgressPct: 99 });
    assert.throws(() => assertTruthful(s), /overallProgressPct/);
  });

  test('COMPLETED without a passed APK verification is rejected', () => {
    const s = fullyEvidenced({ projectState: ProjectStates.COMPLETED, apkVerification: 'verifying' });
    assert.throws(() => assertTruthful(s), /APK verification/);
  });

  test('COMPLETED without a release is rejected', () => {
    const s = fullyEvidenced({ projectState: ProjectStates.COMPLETED, release: { status: 'idle' } });
    assert.throws(() => assertTruthful(s), /release/);
  });

  test('COMPLETED with a fake URL is rejected', () => {
    const s = fullyEvidenced({
      projectState: ProjectStates.COMPLETED,
      finalDownloadUrl: 'https://github.com/example/repo/releases/download/t/a.apk'
    });
    assert.throws(() => assertTruthful(s), /Fake final download URL/);
  });

  test('COMPLETED with a non-HTTPS URL is rejected', () => {
    const s = fullyEvidenced({ projectState: ProjectStates.COMPLETED, finalDownloadUrl: 'http://github.com/a/b/a.apk' });
    assert.throws(() => assertTruthful(s), /Fake final download URL|HTTPS/);
    const s2 = fullyEvidenced({ projectState: ProjectStates.COMPLETED });
    s2.release.assetUrl = 'http://github.com/a/b/a.apk';
    s2.release.assetSha256 = undefined;
    assert.throws(() => assertTruthful(s2), /Fake release URL/);
  });

  test('COMPLETED without a verified public download is rejected', () => {
    const s = fullyEvidenced({ projectState: ProjectStates.COMPLETED });
    s.evidence.publicDownloadVerified = false;
    assert.throws(() => assertTruthful(s), /public download/);
  });

  test('a fully evidenced COMPLETED state passes', () => {
    assert.doesNotThrow(() => assertTruthful(fullyEvidenced({ projectState: ProjectStates.COMPLETED })));
  });

  test('DOWNLOAD_READY without a passed build is rejected', () => {
    const s = fullyEvidenced();
    s.cloudBuild.status = 'running';
    assert.throws(() => assertTruthful(s), /passed cloud build/);
  });

  test('DOWNLOAD_READY with a passed status but a run that never finished is rejected', () => {
    const s = fullyEvidenced();
    s.cloudBuild.status = 'passed';
    s.cloudBuild.state = 'running';
    s.cloudBuild.finishedAt = undefined;
    assert.throws(() => assertTruthful(s), /state is running, not succeeded/);
  });

  test('DOWNLOAD_READY with a terminal state but no finishedAt is rejected', () => {
    const s = fullyEvidenced();
    s.cloudBuild.finishedAt = undefined;
    assert.throws(() => assertTruthful(s), /finishedAt/);
  });

  test('COMPLETED can never be claimed by a build still running', () => {
    const s = fullyEvidenced({ projectState: ProjectStates.COMPLETED });
    s.cloudBuild.status = 'passed';
    s.cloudBuild.state = 'running';
    s.cloudBuild.finishedAt = undefined;
    assert.throws(() => assertTruthful(s), /state is running, not succeeded/);
  });

  test('DOWNLOAD_READY without a verified download is rejected', () => {
    const s = fullyEvidenced();
    s.evidence.publicDownloadVerified = false;
    assert.throws(() => assertTruthful(s), /verified public download/);
  });

  test('a build marked passed without a run id is rejected', () => {
    const s = fullyEvidenced();
    s.cloudBuild.runId = undefined;
    assert.throws(() => assertTruthful(s), /run id/);
  });

  test('a release marked created without a checksum is rejected', () => {
    const s = fullyEvidenced();
    s.release.assetSha256 = undefined;
    assert.throws(() => assertTruthful(s), /checksum/);
  });

  test('a release whose checksum differs from the APK is rejected', () => {
    const s = fullyEvidenced();
    s.release.assetSha256 = 'd'.repeat(64);
    assert.throws(() => assertTruthful(s), /does not match/);
  });

  test('an APK verification marked passed without a path is rejected', () => {
    const s = fullyEvidenced();
    s.apkPath = undefined;
    assert.throws(() => assertTruthful(s), /APK path/);
  });

  test('a fake APK path is rejected', () => {
    const s = fullyEvidenced();
    s.apkPath = 'https://example.com/fake.apk';
    assert.throws(() => assertTruthful(s), /Fake APK path/);
  });

  test('an unknown projectState is rejected', () => {
    const s = fullyEvidenced({ projectState: 'MADE_UP' });
    assert.throws(() => assertTruthful(s), /Unknown projectState/);
  });
});

describe('a command running is not completion', () => {
  test('build stage advanced but not finished is not build success', () => {
    const s = createInitialState() as any;
    s.projectState = ProjectStates.CLOUD_BUILDING;
    s.cloudBuild.stage = 'COMPILING';
    s.cloudBuild.status = 'running';
    assert.throws(() => assertLifecycleEvidence({
      projectState: s.projectState, overallProgressPct: 0, currentStagePct: 0,
      cloudBuild: s.cloudBuild, apkVerification: 'idle', iconVerification: 'idle', release: { status: 'idle' },
      evidence: s.evidence
    }), /cloudBuild.status=running/);
  });

  test('a running workflow never satisfies the completion gate', () => {
    const s = fullyEvidenced({ projectState: ProjectStates.COMPLETED });
    s.cloudBuild.status = 'running';
    s.cloudBuild.conclusion = null;
    assert.throws(() => assertCompleteLifecycle({
      projectState: 'COMPLETED', overallProgressPct: 100, currentStagePct: 100,
      apkVerification: 'passed', iconVerification: 'passed', releaseStatus: 'created', releaseAssetUrl: URL,
      finalDownloadUrl: URL, cloudBuildStatus: 'running'
    }), /cloudBuildStatus is running/);
  });

  test('generated source alone cannot claim completion', () => {
    const s = createInitialState() as any;
    recordStage(s, 'IMPLEMENT', 'files written');
    assert.ok(missingStages(s).includes('VALIDATE'));
    assert.ok(missingStages(s).includes('CLOUD_BUILD'));
    assert.throws(() => assertCompleteLifecycle({
      projectState: 'IMPLEMENT', overallProgressPct: 50, currentStagePct: 50,
      apkVerification: 'idle', iconVerification: 'idle', releaseStatus: 'idle', cloudBuildStatus: 'idle'
    }));
  });

  test('a build artifact is not release success', () => {
    const s = fullyEvidenced({ projectState: ProjectStates.VERIFYING });
    s.release.status = 'idle';
    s.release.assetUrl = undefined;
    s.finalDownloadUrl = undefined;
    assert.throws(() => assertDownloadReadyGate({
      projectState: s.projectState, overallProgressPct: s.overallProgressPct, currentStagePct: 100,
      apkVerification: 'passed', iconVerification: 'passed', releaseStatus: 'idle', releaseAssetUrl: undefined,
      finalDownloadUrl: undefined, cloudBuildStatus: 'passed'
    }), /release not created/);
  });

  test('a release URL is not download success', () => {
    const s = fullyEvidenced();
    s.evidence.publicDownloadVerified = false;
    assert.throws(() => assertTruthful(s), /verified public download/);
  });

  test('an unreachable public URL blocks DOWNLOAD_READY', async () => {
    const s = fullyEvidenced();
    s.evidence.publicDownloadVerified = false;
    let ok = true;
    try { assertTruthful(s); } catch { ok = false; }
    assert.strictEqual(ok, false);
  });
});

describe('DOWNLOAD_READY gate', () => {
  const base = {
    projectState: ProjectStates.DOWNLOAD_READY,
    overallProgressPct: 100,
    currentStagePct: 100,
    apkVerification: 'passed',
    iconVerification: 'passed',
    releaseStatus: 'created',
    releaseAssetUrl: URL,
    finalDownloadUrl: URL,
    cloudBuildStatus: 'passed',
    cloudBuildState: 'succeeded',
    cloudBuildFinishedAt: '2026-10-07T00:00:00.000Z'
  };
  test('a fully evidenced gate passes', () => {
    assert.doesNotThrow(() => assertDownloadReadyGate(base));
  });
  test('fails when the build is not passed', () => {
    assert.throws(() => assertDownloadReadyGate({ ...base, cloudBuildStatus: 'running' }), /cloud build not passed/);
  });
  test('fails when the build is passed but never finished', () => {
    assert.throws(() => assertDownloadReadyGate({ ...base, cloudBuildState: 'running', cloudBuildFinishedAt: undefined }), /not finished/);
  });
  test('fails when the build finished but lost its finishedAt', () => {
    assert.throws(() => assertDownloadReadyGate({ ...base, cloudBuildState: 'succeeded', cloudBuildFinishedAt: undefined }), /finishedAt/);
  });
  test('fails when the APK is unverified', () => {
    assert.throws(() => assertDownloadReadyGate({ ...base, apkVerification: 'verifying' }), /APK verification not passed/);
    assert.throws(() => assertDownloadReadyGate({ ...base, iconVerification: 'failed' }), /icon/i);
  });
  test('fails when there is no URL', () => {
    assert.throws(() => assertDownloadReadyGate({ ...base, releaseAssetUrl: undefined, finalDownloadUrl: undefined }), /no public URL/);
  });
  test('fails for a fabricated URL', () => {
    assert.throws(() => assertDownloadReadyGate({ ...base, finalDownloadUrl: 'https://example.com/a.apk' }), /looks fake/);
  });
  test('fails for a non-HTTPS URL', () => {
    assert.throws(() => assertDownloadReadyGate({ ...base, finalDownloadUrl: 'http://github.com/a/b.apk' }), /not HTTPS/);
  });
});

describe('full lifecycle evidence chain', () => {
  function gateInput(overrides: any = {}) {
    const s = fullyEvidenced({ projectState: ProjectStates.COMPLETED, overallProgressPct: 100 });
    return {
      projectState: s.projectState,
      overallProgressPct: s.overallProgressPct,
      currentStagePct: 100,
      cloudBuild: s.cloudBuild,
      apkVerification: s.apkVerification,
      iconVerification: s.icon.status,
      apkPath: s.apkPath,
      apkSha256: s.apkSha256,
      apkPackageId: s.apkPackageId,
      release: s.release,
      finalDownloadUrl: s.finalDownloadUrl,
      evidence: s.evidence,
      publicDownloadVerified: s.evidence.publicDownloadVerified,
      ...overrides
    };
  }

  test('a complete chain passes', () => {
    assert.doesNotThrow(() => assertLifecycleEvidence(gateInput()));
  });

  test('one missing stage at a time is always caught', () => {
    for (const stage of LifecycleStages) {
      const s = fullyEvidenced({ projectState: ProjectStates.COMPLETED, overallProgressPct: 100 });
      s.evidence.stages = s.evidence.stages.filter((x: any) => x.stage !== stage);
      assert.throws(
        () => assertLifecycleEvidence(gateInput({ evidence: s.evidence })),
        new RegExp(`missing evidence stage: ${stage}`),
        `removing ${stage} must block completion`
      );
    }
  });

  test('a missing APK path blocks completion', () => {
    assert.throws(() => assertLifecycleEvidence(gateInput({ apkPath: undefined })), /no APK path/);
  });
  test('a missing APK checksum blocks completion', () => {
    assert.throws(() => assertLifecycleEvidence(gateInput({ apkSha256: undefined })), /no APK checksum/);
  });
  test('a missing APK package id blocks completion', () => {
    assert.throws(() => assertLifecycleEvidence(gateInput({ apkPackageId: undefined })), /package\/application id/);
  });
  test('a release asset checksum mismatch blocks completion', () => {
    assert.throws(() => assertLifecycleEvidence(gateInput({
      release: { ...fullyEvidenced().release, assetSha256: 'e'.repeat(64) }
    })), /does not match/);
  });
  test('a missing release repo blocks completion', () => {
    const r = fullyEvidenced().release;
    delete r.repo;
    assert.throws(() => assertLifecycleEvidence(gateInput({ release: r })), /release repo not recorded/);
  });
  test('a missing release tag blocks completion', () => {
    const r = fullyEvidenced().release;
    delete r.tag;
    assert.throws(() => assertLifecycleEvidence(gateInput({ release: r })), /release tag not recorded/);
  });
  test('an unverified public download blocks completion', () => {
    assert.throws(() => assertLifecycleEvidence(gateInput({ publicDownloadVerified: false })), /never verified/);
  });
  test('a fabricated public URL blocks completion', () => {
    assert.throws(() => assertLifecycleEvidence(gateInput({ finalDownloadUrl: 'https://example.com/a.apk' })), /fabricated/);
  });
  test('a running build blocks completion', () => {
    const s = fullyEvidenced();
    s.cloudBuild.status = 'running';
    assert.throws(() => assertLifecycleEvidence(gateInput({ cloudBuild: s.cloudBuild })), /want passed/);
  });
  test('a build marked passed while still running blocks completion', () => {
    const s = fullyEvidenced();
    s.cloudBuild.status = 'passed';
    s.cloudBuild.state = 'running';
    s.cloudBuild.finishedAt = undefined;
    assert.throws(() => assertLifecycleEvidence(gateInput({ cloudBuild: s.cloudBuild })), /state=running/);
  });
  test('a passed build with no finishedAt blocks completion', () => {
    const s = fullyEvidenced();
    s.cloudBuild.finishedAt = undefined;
    assert.throws(() => assertLifecycleEvidence(gateInput({ cloudBuild: s.cloudBuild })), /finishedAt/);
  });
  test('a build without a run id blocks completion', () => {
    const cb = fullyEvidenced().cloudBuild;
    cb.runId = undefined;
    assert.throws(() => assertLifecycleEvidence(gateInput({ cloudBuild: cb })), /no run id/);
  });
  test('progress below 100 blocks completion', () => {
    assert.throws(() => assertLifecycleEvidence(gateInput({ overallProgressPct: 99 })), /overallProgressPct/);
    assert.throws(() => assertLifecycleEvidence(gateInput({ currentStagePct: 40 })), /currentStagePct/);
  });

  test('evidence stage order is normalized to the pipeline', () => {
    const s = createInitialState() as any;
    recordStage(s, 'RELEASE', 'r');
    recordStage(s, 'IDEA', 'i');
    recordStage(s, 'CLOUD_BUILD', 'c');
    assert.deepStrictEqual(s.evidence.stages.map((x: any) => x.stage), ['IDEA', 'CLOUD_BUILD', 'RELEASE']);
  });

  test('re-recording a stage replaces rather than duplicates', () => {
    const s = createInitialState() as any;
    recordStage(s, 'CLOUD_BUILD', 'first');
    recordStage(s, 'CLOUD_BUILD', 'second');
    assert.strictEqual(s.evidence.stages.filter((x: any) => x.stage === 'CLOUD_BUILD').length, 1);
    assert.strictEqual(hasStage(s, 'CLOUD_BUILD'), true);
  });
});
