#!/usr/bin/env node
import { existsSync, statSync } from 'fs';
import { initStateStore, readState, writeState, appendEvent } from './live/stateStore.ts';
import { persistCheckpoint } from './live/checkpointStore.ts';
import { verifyApkFile, verifyBuildProvenance, rejectFakeApkUrl } from './live/apkValidator.ts';
import { recordStage } from './live/evidenceChain.ts';
import { assertValidTransition } from './live/stateValidator.ts';
import {
  validateLauncherIcon, sourceIconSignatures, sourceRoundSignatures, sourceForegroundSignatures,
  sourceIconPngBytes
} from './live/launcherIcon.ts';
import { verifyApkLauncherIcon } from './live/apkIconVerifier.ts';
import { ProjectStates, Events } from '../shared/types.ts';

initStateStore();
const s = readState();

const apkPath = process.env.BUILDER_APK_PATH || s.apkPath || '';
const runId = process.env.BUILDER_RUN_ID || s.cloudBuild.runId || '';
const artifactName = process.env.BUILDER_ARTIFACT_NAME || '';

if (!apkPath) {
  console.error('BUILDER_APK_PATH (or a recorded apkPath) is required; refusing to verify nothing');
  s.apkVerification = 'failed';
  s.apkVerificationErrors = ['no APK path provided'];
  s.projectState = ProjectStates.VERIFYING;
  writeState(s);
  process.exit(1);
}

if (s.projectState !== ProjectStates.VERIFYING) {
  try {
    assertValidTransition(s.projectState, ProjectStates.VERIFYING);
  } catch (e: any) {
    console.error(`Refusing out-of-order verification: ${e.message}`);
    process.exit(2);
  }
}
s.projectState = ProjectStates.VERIFYING;
s.apkVerification = 'verifying';
s.latestActivity = `Verifying APK ${apkPath}`;
persistCheckpoint('pre-apk-verify', s);
writeState(s);
appendEvent({ type: Events.BUILD_STAGE_CHANGED, stage: 'APK_VERIFY' });

const expectedPackageId = process.env.BUILDER_EXPECTED_PACKAGE_ID || s.apkPackageId || '';
const result = verifyApkFile(apkPath, expectedPackageId || undefined, {
  expectedSha256: process.env.BUILDER_EXPECTED_SHA256 || undefined,
  requireBuildId: true
});

const provenance = verifyBuildProvenance(
  s,
  apkPath,
  { runId: runId || undefined, headSha: process.env.BUILDER_HEAD_SHA || undefined, artifactName },
  result.sha256
);

const errors = [...result.errors, ...provenance.errors];
const warnings = provenance.warnings || [];

/*
 * Launcher icon verification.
 *
 * The generated sources are re-validated here and their pixels become the
 * expectation for the artifact, so the check compares the APK against the icon
 * this build was supposed to produce. It runs even when the APK is otherwise
 * fine: an APK that builds but ships no real icon still fails the pipeline.
 *
 * A pre-existing run already holds a verified APK: re-verifying it re-reads the
 * same bytes and rewrites the same evidence, so this stays correct when the step
 * is retried or resumed rather than trusting whatever was recorded before.
 */
const projectDir = process.env.BUILDER_PROJECT_DIR || '.builder/generated/android';
const sourceIcon = validateLauncherIcon(projectDir);
const iconErrors: string[] = [...sourceIcon.errors];
let iconVerification: ReturnType<typeof verifyApkLauncherIcon> | null = null;

s.icon = {
  ...(s.icon || { status: 'idle' }),
  status: 'verifying',
  category: s.icon?.category,
  purpose: s.icon?.purpose,
  reason: s.icon?.reason,
  fingerprint: sourceIcon.fingerprint || s.icon?.fingerprint,
  files: s.icon?.files,
  manifestIcon: sourceIcon.manifestIcon || s.icon?.manifestIcon,
  manifestRoundIcon: sourceIcon.manifestRoundIcon || s.icon?.manifestRoundIcon,
  errors: iconErrors.length ? iconErrors : undefined
};

if (iconErrors.length === 0) {
  iconVerification = verifyApkLauncherIcon(apkPath, {
    signatures: sourceIconSignatures(projectDir),
    roundSignatures: sourceRoundSignatures(projectDir),
    foregroundSignatures: sourceForegroundSignatures(projectDir),
    sourcePngBytes: sourceIconPngBytes(projectDir),
    fingerprint: sourceIcon.fingerprint
  });
  iconErrors.push(...iconVerification.errors);
}

s.icon = {
  ...s.icon,
  manifestIconResourceId: iconVerification?.manifestIconResourceId,
  manifestIconType: iconVerification?.manifestIconType,
  matchedDensities: iconVerification?.matchedDensities,
  matchedPath: iconVerification?.matchedPath,
  similarity: iconVerification?.similarity,
  byteIdentical: iconVerification?.byteIdentical,
  iconSignatureSha256: iconVerification?.iconSignatureSha256,
  runId: runId || undefined,
  apkSha256: result.sha256,
  errors: iconErrors.length ? iconErrors : undefined
};

const iconPassed = iconErrors.length === 0;

if (result.valid && provenance.valid && iconPassed) {
  s.apkVerification = 'passed';
  s.apkPath = apkPath;
  s.apkSha256 = result.sha256;
  s.apkPackageId = result.packageId || expectedPackageId;
  s.apkVerificationErrors = undefined;
  s.icon = { ...s.icon, status: 'passed', verifiedAt: new Date().toISOString() };
  recordStage(s, 'REAL_APK', `apk=${apkPath} bytes=${result.sizeBytes}`, runId || undefined);
  recordStage(s, 'APK_VERIFY', `sha256=${result.sha256} package=${result.packageId || expectedPackageId}`, runId || undefined);
  recordStage(
    s,
    'REAL_ICON_VERIFY',
    `icon=${s.icon.manifestIcon} category=${s.icon.category} fingerprint=${s.icon.fingerprint} ` +
    `compiled=${s.icon.matchedPath} densities=${(s.icon.matchedDensities || []).join(',')} ` +
    `similarity=${s.icon.similarity} resource=${s.icon.manifestIconResourceId}`,
    runId || undefined
  );
  s.latestActivity = `APK verified: ${apkPath} (${result.sizeBytes} bytes), launcher icon proven in ${s.icon.matchedPath}`;
  appendEvent({ type: Events.ARTIFACT_VERIFIED, path: apkPath, sha256: result.sha256, packageId: result.packageId });
  writeState(s);
  console.log(JSON.stringify({
    ok: true,
    apk: apkPath,
    sha256: result.sha256,
    packageId: result.packageId || expectedPackageId,
    sizeBytes: result.sizeBytes,
    icon: {
      manifestIcon: s.icon.manifestIcon,
      category: s.icon.category,
      fingerprint: s.icon.fingerprint,
      compiledPath: s.icon.matchedPath,
      resourceId: s.icon.manifestIconResourceId,
      densities: s.icon.matchedDensities,
      similarity: s.icon.similarity
    },
    warnings
  }, null, 2));
  process.exit(0);
}

s.apkVerification = 'failed';
s.icon = { ...s.icon, status: 'failed' };
const iconOnlyFailure = result.valid && provenance.valid && !iconPassed;
s.apkVerificationErrors = iconOnlyFailure ? iconErrors : errors;
s.latestActivity = iconOnlyFailure
  ? `Launcher icon verification failed: ${iconErrors[0]}`
  : `APK verification failed: ${errors[0] || iconErrors[0]}`;
recordStage(s, 'REAL_APK', `failed: ${(errors.length ? errors : iconErrors).join('; ')}`, runId || undefined);
appendEvent({
  type: Events.BUILD_FAILED,
  stage: iconOnlyFailure ? 'REAL_ICON_VERIFY' : 'APK_VERIFY',
  errors: errors.length ? errors : iconErrors
});
if (iconOnlyFailure) {
  // A missing or wrong icon is a fixable defect in the generated project, so the
  // run goes back for repair instead of failing as an unrecoverable artifact.
  try {
    const { buildFailureSignal, enterRepair } = await import('./live/recoveryManager.ts');
    const signal = buildFailureSignal(
      s,
      'apk_verification_failed',
      iconErrors[0] || 'Launcher icon in the built APK does not match the generated icon',
      iconErrors
    );
    // Treat icon-only verification failure as repairable from REAL_ICON_VERIFY/validate generation.
    signal.stage = 'REAL_ICON_VERIFY';
    signal.repairFrom = 'VALIDATE';
    enterRepair(s, signal);
  } catch (e) {
    s.projectState = ProjectStates.REPAIRING;
    s.failureRepair = {
      state: 'FAILURE_DETECTED',
      failureDetectedAt: new Date().toISOString(),
      rootCause: 'Launcher icon in the built APK does not match the generated icon',
      changes: [
        'Regenerate the launcher icon set from the idea (writeLauncherIcon).',
        'Confirm AndroidManifest.xml references @mipmap/ic_launcher and @mipmap/ic_launcher_round.',
        'Rebuild so every mipmap density and the adaptive icon are compiled in.'
      ]
    };
  }
}
writeState(s);
console.error(JSON.stringify({ ok: false, errors, iconErrors, warnings }, null, 2));
process.exit(1);
