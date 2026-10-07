import { ProjectStates } from '../../shared/types.ts';

/**
 * Legal lifecycle transitions. Forward-only along the happy path, with explicit
 * repair/retry edges back into the pipeline. COMPLETED is terminal.
 */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  [ProjectStates.NOT_STARTED]: [ProjectStates.QUEUED, ProjectStates.ANALYZING, ProjectStates.FAILED],
  [ProjectStates.QUEUED]: [ProjectStates.ANALYZING, ProjectStates.BLOCKED, ProjectStates.FAILED],
  [ProjectStates.ANALYZING]: [ProjectStates.DESIGNING, ProjectStates.REPAIRING, ProjectStates.BLOCKED, ProjectStates.FAILED],
  [ProjectStates.DESIGNING]: [ProjectStates.PLANNING, ProjectStates.REPAIRING, ProjectStates.BLOCKED, ProjectStates.FAILED],
  [ProjectStates.PLANNING]: [ProjectStates.READY, ProjectStates.WAITING, ProjectStates.REPAIRING, ProjectStates.BLOCKED, ProjectStates.FAILED],
  [ProjectStates.WAITING]: [ProjectStates.READY, ProjectStates.PLANNING, ProjectStates.REPAIRING, ProjectStates.BLOCKED, ProjectStates.FAILED],
  [ProjectStates.READY]: [ProjectStates.BUILDING, ProjectStates.REPAIRING, ProjectStates.BLOCKED, ProjectStates.FAILED],
  // A pushed implementation goes straight to the cloud build: githubPush leaves
  // the state at BUILDING, and the canonical runner dispatches from there.
  [ProjectStates.BUILDING]: [ProjectStates.TESTING, ProjectStates.CLOUD_BUILDING, ProjectStates.REPAIRING, ProjectStates.BLOCKED, ProjectStates.FAILED],
  [ProjectStates.TESTING]: [ProjectStates.BUILDING, ProjectStates.CLOUD_BUILDING, ProjectStates.REPAIRING, ProjectStates.BLOCKED, ProjectStates.FAILED],
  [ProjectStates.REPAIRING]: [
    ProjectStates.READY, ProjectStates.BUILDING, ProjectStates.TESTING, ProjectStates.CLOUD_BUILDING,
    ProjectStates.VERIFYING, ProjectStates.RELEASING, ProjectStates.WAITING, ProjectStates.PLANNING,
    ProjectStates.BLOCKED, ProjectStates.FAILED
  ],
  [ProjectStates.CLOUD_BUILDING]: [ProjectStates.VERIFYING, ProjectStates.REPAIRING, ProjectStates.BLOCKED, ProjectStates.FAILED],
  [ProjectStates.VERIFYING]: [ProjectStates.CLOUD_BUILDING, ProjectStates.RELEASING, ProjectStates.REPAIRING, ProjectStates.BLOCKED, ProjectStates.FAILED],
  [ProjectStates.RELEASING]: [ProjectStates.VERIFYING, ProjectStates.DOWNLOAD_READY, ProjectStates.REPAIRING, ProjectStates.BLOCKED, ProjectStates.FAILED],
  [ProjectStates.DOWNLOAD_READY]: [ProjectStates.COMPLETED, ProjectStates.RELEASING, ProjectStates.VERIFYING, ProjectStates.REPAIRING, ProjectStates.FAILED],
  [ProjectStates.COMPLETED]: [ProjectStates.REPAIRING],
  [ProjectStates.BLOCKED]: [ProjectStates.REPAIRING, ProjectStates.FAILED, ProjectStates.WAITING, ProjectStates.READY],
  [ProjectStates.FAILED]: [ProjectStates.REPAIRING, ProjectStates.BLOCKED],
  [ProjectStates.PAUSED]: [
    ProjectStates.READY, ProjectStates.BUILDING, ProjectStates.TESTING, ProjectStates.CLOUD_BUILDING,
    ProjectStates.VERIFYING, ProjectStates.RELEASING, ProjectStates.REPAIRING
  ]
};

export function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export class InvalidTransitionError extends Error {
  // Declared explicitly rather than as constructor parameter properties: Node's
  // strip-only TypeScript mode cannot erase parameter properties, so this file
  // must stay syntactically erasable for `npm test` to run without a build step.
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super(`Invalid lifecycle transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertValidTransition(from: string, to: string): void {
  if (from === to) return;
  if (!isValidTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/**
 * Markers of fabricated values. Note this deliberately does not flag `/tmp/`:
 * Termux legitimately uses `files/usr/tmp` for downloaded build artifacts.
 */
const FAKE_HOSTS = /(^|[.-])(example|example\.(com|org|net)|placeholder|fake|faked|dummy|sample|insecure|invalid)([.-]|$)/i;
const FAKE_PATH = /\/(example|placeholder|fake|dummy|sample|notreal|doesnotexist)\b/i;
const FAKE_WORDS = /\b(fake|placeholder|dummy|sample|faker|fakeapk|testonly|notreal)\b/i;
const FAKE_ADDR = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

export function looksFabricated(value?: string): boolean {
  if (!value) return false;
  const v = value.trim();
  if (FAKE_WORDS.test(v) || FAKE_PATH.test(v)) return true;
  if (v.startsWith('http://')) return true;
  if (v.startsWith('https://')) {
    try {
      const host = new URL(v).hostname.toLowerCase();
      if (FAKE_HOSTS.test(host) || FAKE_ADDR.test(host)) return true;
      return FAKE_PATH.test(new URL(v).pathname);
    } catch {
      return FAKE_PATH.test(v) || FAKE_WORDS.test(v);
    }
  }
  if (v.includes('://')) return true;
  const hostLike = v.split('/')[0];
  return FAKE_ADDR.test(hostLike) || FAKE_HOSTS.test(hostLike);
}

/**
 * Truthfulness invariant: a state may never assert readiness or completion
 * without concrete, non-fabricated evidence. Invoked before every write of a
 * terminal state and by the self-audit.
 */
export function assertTruthful(s: any): void {
  if (!s || typeof s !== 'object') throw new Error('Invalid state');
  const state = s.projectState;
  if (typeof state !== 'string') throw new Error('projectState missing');
  if (!VALID_TRANSITIONS[state]) throw new Error(`Unknown projectState: ${state}`);

  const url = s.finalDownloadUrl || s.release?.assetUrl;

  if (s.release?.assetUrl && looksFabricated(s.release.assetUrl)) {
    throw new Error(`Fake release URL detected: ${s.release.assetUrl}`);
  }
  if (s.finalDownloadUrl && looksFabricated(s.finalDownloadUrl)) {
    throw new Error(`Fake final download URL detected: ${s.finalDownloadUrl}`);
  }
  if (s.apkPath && looksFabricated(s.apkPath)) {
    throw new Error(`Fake APK path detected: ${s.apkPath}`);
  }

  if (s.cloudBuild?.status === 'passed' && !s.cloudBuild.runId) {
    throw new Error('cloud build marked passed without a run id');
  }

  if (s.apkVerification === 'passed') {
    if (!s.apkPath) throw new Error('APK verification passed without an APK path');
    if (!s.apkSha256) throw new Error('APK verification passed without a checksum');
  }

  if (s.release?.status === 'created') {
    if (!s.release.assetUrl) throw new Error('release marked created without an asset URL');
    if (!s.release.assetSha256) throw new Error('release marked created without an asset checksum');
    if (s.apkSha256 && s.release.assetSha256 !== s.apkSha256) {
      throw new Error('release asset checksum does not match the verified APK checksum');
    }
  }

  if (state === ProjectStates.DOWNLOAD_READY) {
    if (s.overallProgressPct !== 100) {
      throw new Error(`DOWNLOAD_READY requires overallProgressPct===100 (got ${s.overallProgressPct})`);
    }
    if (s.cloudBuild?.status !== 'passed') throw new Error('DOWNLOAD_READY requires a passed cloud build');
    if (s.apkVerification !== 'passed') throw new Error('DOWNLOAD_READY requires passed APK verification');
    if (s.release?.status !== 'created') throw new Error('DOWNLOAD_READY requires a created release');
    if (!url) throw new Error('DOWNLOAD_READY requires a public URL');
    if (!url.startsWith('https://')) throw new Error('DOWNLOAD_READY requires an HTTPS public URL');
    if (!s.evidence?.publicDownloadVerified) {
      throw new Error('DOWNLOAD_READY requires a verified public download');
    }
  }

  if (state === ProjectStates.COMPLETED) {
    if (s.overallProgressPct !== 100) throw new Error('COMPLETED requires overallProgressPct===100');
    if (s.apkVerification !== 'passed') throw new Error('COMPLETED requires passed APK verification');
    if (s.release?.status !== 'created') throw new Error('COMPLETED requires a created release');
    if (!url) throw new Error('COMPLETED requires a real public URL');
    if (!url.startsWith('https://')) throw new Error('COMPLETED requires an HTTPS public URL');
    if (!s.evidence?.publicDownloadVerified) throw new Error('COMPLETED requires a verified public download');
  }

  // A build marked `passed` must also have reached its terminal state. `status`
  // alone can be written by code that saw a green run before the workflow had
  // actually finished; `state` only becomes `succeeded` alongside `finishedAt`
  // when cloudBuildExecute has observed the run conclude. Requiring all three at
  // the gates below is what distinguishes a finished build from a hopeful one.
  if ((state === ProjectStates.DOWNLOAD_READY || state === ProjectStates.COMPLETED) && s.cloudBuild?.status === 'passed') {
    if (s.cloudBuild.state !== 'succeeded') {
      throw new Error(`cloud build marked passed but its state is ${s.cloudBuild.state ?? 'missing'}, not succeeded`);
    }
    if (!s.cloudBuild.finishedAt) {
      throw new Error('cloud build marked passed without a finishedAt timestamp');
    }
  }
}
