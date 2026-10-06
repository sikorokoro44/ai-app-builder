import https from 'https';
import { createHash } from 'crypto';

export interface ReleaseVerificationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
  status?: number;
  finalUrl?: string;
  contentType?: string;
  contentLength?: string;
  /** Every URL the download was actually served from, in order. */
  redirects?: string[];
}

const FAKE_HOST_PATTERNS = /(^|[.-])(example|example\.com|example\.org|example\.net|placeholder|fake|invalid|test\.local)([.-]|$)/i;

export function isValidHttpsUrl(url: string): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host) return false;
  if (FAKE_HOST_PATTERNS.test(host)) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) return false;
  if (!host.includes('.')) return false;
  return true;
}

export function rejectFakeReleaseUrl(url: string): boolean {
  if (!url) return true;
  if (url.startsWith('http://')) return true;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (FAKE_HOST_PATTERNS.test(host)) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return true;
  if (/(^|\/)(example|placeholder|fake|dummy|sample)\./i.test(url)) return true;
  return false;
}

export interface ReleaseEvidence {
  repo: string;
  tag: string;
  assetName: string;
  expectedSha256?: string;
  runId?: string;
}

export interface ReleaseChecks {
  releaseExists: boolean;
  releaseUrl?: string;
  assetExists: boolean;
  assetBrowserUrl?: string;
  assetSha256?: string;
  assetSize?: number;
  runId?: string;
}

export function validateReleaseEvidence(
  evidence: ReleaseChecks,
  expected: ReleaseEvidence,
  opts: { enforceRepoMatch?: boolean } = {}
): ReleaseVerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!evidence.releaseExists) {
    errors.push(`GitHub release ${expected.repo}@${expected.tag} does not exist`);
  }
  if (!evidence.assetExists) {
    errors.push(`Release ${expected.tag} has no asset ${expected.assetName}`);
  }
  if (!evidence.assetBrowserUrl) {
    errors.push('No asset browser download URL recorded');
  } else {
    if (!isValidHttpsUrl(evidence.assetBrowserUrl)) {
      errors.push(`Asset URL is not a genuine HTTPS URL: ${evidence.assetBrowserUrl}`);
    }
    if (rejectFakeReleaseUrl(evidence.assetBrowserUrl)) {
      errors.push(`Asset URL looks fabricated: ${evidence.assetBrowserUrl}`);
    }
    if (!evidence.assetBrowserUrl.endsWith(`/${expected.assetName}`)) {
      errors.push(`Asset URL does not end with the verified asset name ${expected.assetName}`);
    }
    if (opts.enforceRepoMatch !== false) {
      if (!evidence.assetBrowserUrl.includes(`/${expected.repo}/releases/download/`)) {
        errors.push(`Asset URL does not belong to ${expected.repo}`);
      }
      if (!evidence.assetBrowserUrl.includes(`/${expected.tag}/`)) {
        errors.push(`Asset URL does not belong to tag ${expected.tag}`);
      }
    }
  }
  if (expected.expectedSha256) {
    if (!evidence.assetSha256) {
      errors.push('Release asset checksum could not be read');
    } else if (evidence.assetSha256 !== expected.expectedSha256) {
      errors.push(`Release asset checksum ${evidence.assetSha256} != verified build artifact ${expected.expectedSha256}`);
    }
  }
  if (expected.runId) {
    if (!evidence.runId) {
      warnings.push('Release has no run id recorded');
    } else if (evidence.runId !== expected.runId) {
      errors.push(`Release belongs to run ${evidence.runId}, expected ${expected.runId}`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    finalUrl: evidence.assetBrowserUrl
  };
}

export type FetchLike = (url: string, maxRedirects: number) => Promise<ReleaseVerificationResult>;

const defaultFetch: FetchLike = (url, maxRedirects) =>
  new Promise((resolve) => {
    if (!isValidHttpsUrl(url)) {
      resolve({ valid: false, errors: ['Not a genuine HTTPS URL'] });
      return;
    }
    const req = https.request(url, { method: 'GET' }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      res.resume();
      if (status >= 300 && status < 400 && location) {
        if (maxRedirects <= 0) {
          resolve({ valid: false, errors: ['Too many redirects'], status });
          return;
        }
        const next = new URL(location, url).toString();
        // A release asset redirects to wherever GitHub is serving the bytes
        // from, and that hop is not a failure. The status that answers "is this
        // downloadable" is the last one, so that is the one reported: keeping
        // the 302 here reported a working download as broken, which is how
        // run 37399628858 failed release-publisher on a URL that served fine.
        defaultFetch(next, maxRedirects - 1).then((r) =>
          resolve({ ...r, redirects: [next, ...(r.redirects || [])] })
        );
        return;
      }
      const errors: string[] = [];
      if (status !== 200) errors.push(`Public download returned HTTP ${status}`);
      resolve({
        valid: errors.length === 0,
        errors,
        status,
        finalUrl: url,
        contentType: res.headers['content-type'],
        contentLength: res.headers['content-length']
      });
    });
    req.on('error', (e) => resolve({ valid: false, errors: [`Network error: ${e.message}`] }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ valid: false, errors: ['Public download timed out'] }); });
    req.end();
  });

/**
 * Confirms the public URL is genuinely downloadable: follows redirects over
 * HTTPS and requires a 200 response. A constructed-but-dead URL fails here.
 */
export async function verifyPublicDownload(url: string, fetchImpl: FetchLike = defaultFetch): Promise<ReleaseVerificationResult> {
  if (!url) return { valid: false, errors: ['No public download URL'] };
  if (!isValidHttpsUrl(url)) return { valid: false, errors: [`Not a genuine HTTPS URL: ${url}`] };
  if (rejectFakeReleaseUrl(url)) return { valid: false, errors: [`Public URL looks fabricated: ${url}`] };
  const res = await fetchImpl(url, 5);
  if (!res.valid) return res;
  const warnings = res.warnings || [];
  if (res.finalUrl && res.finalUrl !== url && !isValidHttpsUrl(res.finalUrl)) {
    return { valid: false, errors: [`Redirected to a non-HTTPS or fake URL: ${res.finalUrl}`], warnings };
  }
  if (res.finalUrl && res.finalUrl !== url && rejectFakeReleaseUrl(res.finalUrl)) {
    return { valid: false, errors: [`Redirected to a fabricated URL: ${res.finalUrl}`], warnings };
  }
  return { ...res, valid: true, warnings };
}
export interface DownloadResult {
  ok: boolean;
  errors: string[];
  sha256?: string;
  bytes?: number;
  finalUrl?: string;
  contentType?: string;
}

/** Streams a URL to the caller; the default speaks https, tests substitute a local server. */
export type DownloadLike = (url: string) => Promise<{ status: number; headers: Record<string, any>; body: Buffer }>;

const httpsDownload: DownloadLike = (url) =>
  new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers as Record<string, any>,
        body: Buffer.concat(chunks)
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Public download timed out')));
    req.end();
  });

/**
 * Downloads a URL and hashes what actually came back.
 *
 * A `200` proves something is being served at an address. It does not prove it
 * is the artifact this run verified: the release asset could have been replaced
 * after the APK was checked, and every other gate in the chain would still
 * read as passed. So the public check hashes the bytes it receives and compares
 * them to the verified checksum, which is the only statement that means
 * "a member of the public can download this exact APK".
 */
export async function downloadAndHash(
  url: string,
  expectedSha256: string,
  maxRedirects = 5,
  transport: DownloadLike = httpsDownload
): Promise<DownloadResult> {
  if (!isValidHttpsUrl(url)) return { ok: false, errors: ['Not a genuine HTTPS URL'] };

  const seen: string[] = [];
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res: { status: number; headers: Record<string, any>; body: Buffer };
    try {
      res = await transport(current);
    } catch (e: any) {
      return { ok: false, errors: [`Network error: ${e.message}`] };
    }
    const status = res.status;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      if (hop === maxRedirects) return { ok: false, errors: ['Too many redirects'] };
      // A `Location` is allowed to be relative, and resolving it by hand
      // (`https://${location}`) turns `/asset` into a broken address.
      const next = new URL(location, current).toString();
      // The redirect target has to be as genuine as the address it came from,
      // or the check verifies whatever the redirect chose to point at.
      if (!isValidHttpsUrl(next)) return { ok: false, errors: [`Redirected to a non-HTTPS URL: ${next}`] };
      seen.push(next);
      current = next;
      continue;
    }
    if (status !== 200) return { ok: false, errors: [`Public download returned HTTP ${status}`] };

    const sha256 = createHash('sha256').update(res.body).digest('hex');
    const bytes = res.body.length;
    // An empty body would otherwise be "verified" against nothing.
    if (bytes === 0) return { ok: false, errors: ['Public download returned an empty body'] };
    if (expectedSha256 && sha256 !== expectedSha256) {
      return {
        ok: false,
        errors: [`public download hash ${sha256} does not match the verified APK ${expectedSha256}`],
        sha256,
        bytes,
        finalUrl: current
      };
    }
    return { ok: true, errors: [], sha256, bytes, finalUrl: current, contentType: res.headers['content-type'] };
  }
  return { ok: false, errors: ['Too many redirects'] };
}

export type ReleaseAction = 'reuse' | 'create-release' | 'upload-asset' | 'replace-asset';

export interface ReleasePlanInput {
  releaseExists: boolean;
  isDraft?: boolean;
  assetExists: boolean;
  /** Checksum of the asset already attached to the release, if known. */
  publishedSha256?: string;
  /** Checksum of the verified build artifact we intend to publish. */
  wantedSha256: string;
}

export interface ReleasePlan {
  action: ReleaseAction;
  /** Why this action was chosen, for the run log. */
  reason: string;
  /** True when the run must not proceed until the action succeeds. */
  blocking: boolean;
}

/**
 * Decides what to do about a release tag that may already exist.
 *
 * The point is idempotence without dishonesty: a tag that already carries the
 * identical, checksum-matching artifact is reused, a missing or mismatched asset
 * is repaired by upload, and only a genuinely absent tag triggers creation. A
 * mismatched asset must be replaced rather than accepted, otherwise the published
 * download would not be the artifact this run verified.
 */
export function planReleaseAction(input: ReleasePlanInput): ReleasePlan {
  if (!input.releaseExists) {
    return { action: 'create-release', reason: `tag does not exist yet`, blocking: true };
  }
  if (!input.assetExists) {
    return { action: 'upload-asset', reason: `release exists but has no matching asset`, blocking: true };
  }
  if (!input.publishedSha256) {
    // The published checksum could not be established, so it cannot be trusted.
    return { action: 'replace-asset', reason: `published asset checksum could not be read`, blocking: true };
  }
  if (input.publishedSha256 !== input.wantedSha256) {
    return {
      action: 'replace-asset',
      reason: `published asset sha256 ${input.publishedSha256} != verified artifact ${input.wantedSha256}`,
      blocking: true
    };
  }
  return { action: 'reuse', reason: `release already publishes the identical verified artifact`, blocking: false };
}

/** The canonical browser download URL for a release asset on github.com. */
export function assetBrowserUrl(repo: string, tag: string, assetName: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
}

/**
 * GitHub's release asset `url` is an API endpoint (api.github.com) that needs an
 * Accept header and returns JSON, not a file. Only `browser_download_url` can be
 * handed to a user, so an API URL must never be recorded as the download URL.
 */
export function isBrowserDownloadUrl(url: string | undefined, repo: string, tag: string, assetName: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname.toLowerCase() !== 'github.com') return false;
  if (parsed.pathname !== `/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`) {
    return false;
  }
  return parsed.search === '' && parsed.hash === '';
}

/** Extracts a sha256 from GitHub's `sha256:<hex>` asset digest, if usable. */
export function digestToSha256(digest: string | null | undefined): string | undefined {
  if (!digest) return undefined;
  const m = digest.trim().match(/^sha256:([0-9a-f]{64})$/i);
  return m ? m[1].toLowerCase() : undefined;
}
