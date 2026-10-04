import { assertTruthful } from './stateValidator.ts';

export const REQUIRED_EVIDENCE_CHAIN = [
  'IDEA',
  'ANALYZE',
  'DESIGN',
  'PLAN',
  'SCAFFOLD',
  'IMPLEMENT',
  'TESTGEN',
  'VALIDATE',
  'CLOUD_BUILD',
  'BUILD_SUCCESS',
  'REAL_APK',
  'APK_VERIFY',
  'REAL_ICON_VERIFY',
  'RELEASE',
  'RELEASE_ASSET',
  'PUBLIC_HTTPS_URL',
  'PUBLIC_DOWNLOAD',
  'FINAL_VERIFY'
] as const;

export interface GateInput {
  projectState: string;
  overallProgressPct: number;
  currentStagePct: number;
  apkVerification: string;
  iconVerification?: string;
  releaseStatus: string;
  releaseAssetUrl?: string;
  finalDownloadUrl?: string;
  cloudBuildStatus: string;
}

/**
 * A build that produced an APK but never proved the APK ships a real launcher
 * icon is not a finished product: the user installs it and sees a default icon.
 * Both the completion and download gates therefore require the compiled-icon
 * check, not just the presence of a stage name.
 */
function iconProblem(status: string | undefined): string | null {
  if (status !== 'passed') {
    return `iconVerification is ${status ?? 'not recorded'}, not passed (the built APK's launcher icon is unproven)`;
  }
  return null;
}

export function assertCompleteLifecycle(g: GateInput) {
  const errors: string[] = [];
  if (g.projectState !== 'COMPLETED') errors.push(`projectState is ${g.projectState}, not COMPLETED`);
  if (g.overallProgressPct !== 100) errors.push('overallProgressPct !== 100');
  if (g.currentStagePct !== 100) errors.push('currentStagePct !== 100');
  if (g.cloudBuildStatus !== 'passed') errors.push(`cloudBuildStatus is ${g.cloudBuildStatus}, not passed`);
  if (g.apkVerification !== 'passed') errors.push(`apkVerification is ${g.apkVerification}, not passed`);
  const icon = iconProblem(g.iconVerification);
  if (icon) errors.push(icon);
  if (g.releaseStatus !== 'created') errors.push(`releaseStatus is ${g.releaseStatus}, not created`);
  const url = g.finalDownloadUrl || g.releaseAssetUrl;
  if (!url) {
    errors.push('No release/download URL present');
  } else {
    if (!url.startsWith('https://')) errors.push('Download URL is not HTTPS');
    if (/example|placeholder|fake|localhost/i.test(url)) errors.push('Download URL appears fake/placeholder');
  }
  if (errors.length > 0) {
    throw new Error(`Lifecycle incomplete:\n - ${errors.join('\n - ')}`);
  }
}

export function assertDownloadReadyGate(g: GateInput) {
  const errors: string[] = [];
  if (g.cloudBuildStatus !== 'passed') errors.push('cloud build not passed');
  if (g.apkVerification !== 'passed') errors.push('APK verification not passed');
  const icon = iconProblem(g.iconVerification);
  if (icon) errors.push(icon);
  if (g.releaseStatus !== 'created') errors.push('release not created');
  const url = g.finalDownloadUrl || g.releaseAssetUrl;
  if (!url) errors.push('no public URL');
  if (url && !url.startsWith('https://')) errors.push('URL not HTTPS');
  if (url && /example|placeholder|fake|localhost/i.test(url)) errors.push('URL looks fake/placeholder');
  if (errors.length > 0) {
    throw new Error(`DOWNLOAD_READY gate failed:\n - ${errors.join('\n - ')}`);
  }
}

export function assertStateTruthfulAndComplete(s: any) {
  assertTruthful(s);
  assertCompleteLifecycle({
    projectState: s.projectState,
    overallProgressPct: s.overallProgressPct,
    currentStagePct: s.currentStagePct,
    apkVerification: s.apkVerification,
    iconVerification: s.icon?.status,
    releaseStatus: s.release?.status,
    releaseAssetUrl: s.release?.assetUrl,
    finalDownloadUrl: s.finalDownloadUrl,
    cloudBuildStatus: s.cloudBuild?.status
  });
}
