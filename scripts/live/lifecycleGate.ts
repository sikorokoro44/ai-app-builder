import { assertTruthful } from './stateValidator.ts';
import type { FeatureGateState } from '../../shared/state.ts';

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
  cloudBuildState?: string;
  cloudBuildFinishedAt?: string;
  /** The verdict of the feature gate for this request. */
  featureGate?: FeatureGateState;
  /** The APK this run is releasing. */
  apkSha256?: string;
  /** The request this run answers. */
  requestId?: string;
}

/**
 * A cloud build is only "passed" once the observed run has concluded: status is
 * written alongside state=succeeded and finishedAt by cloudBuildExecute, and a
 * state still mid-flight (running/queued) means the verdict is a guess.
 */
function cloudBuildProblem(cb: Pick<GateInput, 'cloudBuildStatus' | 'cloudBuildState' | 'cloudBuildFinishedAt'>): string | null {
  if (cb.cloudBuildStatus !== 'passed') return null;
  if (cb.cloudBuildState !== 'succeeded') {
    return `cloudBuildState is ${cb.cloudBuildState ?? 'not recorded'}, not succeeded (the run has not finished)`;
  }
  if (!cb.cloudBuildFinishedAt) {
    return 'cloud build finished but no finishedAt timestamp was recorded';
  }
  return null;
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

/**
 * The features the request asked for have to be proved against the APK that is
 * being released.
 *
 * A gate verdict from an earlier run, from another request or for another APK
 * says nothing about this one, so the verdict is checked against the identity
 * of what is being released and not merely for having passed at some point.
 */
function featureGateProblem(g: Pick<GateInput, 'featureGate' | 'apkSha256' | 'requestId'>): string | null {
  const gate = g.featureGate;
  if (!gate) {
    return 'the feature gate never ran for this request (no requested feature was proved against a build)';
  }
  if (gate.passed !== true) {
    const first = gate.reasons[0] ?? (gate.failures.join(', ') || 'the gate refused the app');
    return `the feature gate refused this app: ${first}`;
  }
  if (g.apkSha256 && gate.apkSha256 && gate.apkSha256 !== g.apkSha256) {
    return 'the feature gate was run against a different APK than the one being released';
  }
  if (g.requestId && gate.requestId && gate.requestId !== g.requestId) {
    return 'the feature gate was run for a different request than the one being completed';
  }
  return null;
}

export function assertCompleteLifecycle(g: GateInput) {
  const errors: string[] = [];
  if (g.projectState !== 'COMPLETED') errors.push(`projectState is ${g.projectState}, not COMPLETED`);
  if (g.overallProgressPct !== 100) errors.push('overallProgressPct !== 100');
  if (g.currentStagePct !== 100) errors.push('currentStagePct !== 100');
  if (g.cloudBuildStatus !== 'passed') errors.push(`cloudBuildStatus is ${g.cloudBuildStatus}, not passed`);
  const buildState = cloudBuildProblem(g);
  if (buildState) errors.push(buildState);
  if (g.apkVerification !== 'passed') errors.push(`apkVerification is ${g.apkVerification}, not passed`);
  const icon = iconProblem(g.iconVerification);
  if (icon) errors.push(icon);
  const gate = featureGateProblem(g);
  if (gate) errors.push(gate);
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
  const buildState = cloudBuildProblem(g);
  if (buildState) errors.push(buildState);
  if (g.apkVerification !== 'passed') errors.push('APK verification not passed');
  const icon = iconProblem(g.iconVerification);
  if (icon) errors.push(icon);
  const gate = featureGateProblem(g);
  if (gate) errors.push(gate);
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
    cloudBuildStatus: s.cloudBuild?.status,
    cloudBuildState: s.cloudBuild?.state,
    cloudBuildFinishedAt: s.cloudBuild?.finishedAt,
    featureGate: s.featureGate,
    apkSha256: s.apkSha256,
    requestId: s.request?.requestId
  });
}
