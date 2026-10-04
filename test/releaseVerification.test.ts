import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  isValidHttpsUrl,
  rejectFakeReleaseUrl,
  validateReleaseEvidence,
  verifyPublicDownload,
  planReleaseAction,
  assetBrowserUrl,
  type FetchLike
} from '../scripts/live/releaseVerifier.ts';

const REPO = 'sikorokoro44/ai-app-builder';
const TAG = 'build-1234567890';
const ASSET = 'app-debug.apk';
const SHA = 'a'.repeat(64);
const URL = `https://github.com/${REPO}/releases/download/${TAG}/${ASSET}`;

function okFetch(status = 200, contentType = 'application/vnd.android.package-archive'): FetchLike {
  return async (url) => ({
    valid: status === 200,
    errors: status === 200 ? [] : [`HTTP ${status}`],
    status,
    finalUrl: url,
    contentType,
    contentLength: '12345678'
  });
}

describe('URL genuineness', () => {
  test('accepts a real GitHub release asset URL', () => {
    assert.strictEqual(isValidHttpsUrl(URL), true);
    assert.strictEqual(rejectFakeReleaseUrl(URL), false);
  });

  const bad = [
    'http://github.com/a/b/releases/download/t/a.apk',
    'https://example.com/a.apk',
    'https://example.org/a.apk',
    'https://placeholder.example/a.apk',
    'https://fake.apk.com/a.apk',
    'https://localhost/a.apk',
    'https://127.0.0.1/a.apk',
    'https://myhost.local/a.apk',
    'not-a-url',
    ''
  ];
  for (const u of bad) {
    test(`rejects ${u || '(empty)'}`, () => {
      assert.strictEqual(isValidHttpsUrl(u), false, `${u} must not be treated as valid HTTPS`);
    });
  }

  for (const u of bad) {
    test(`flags ${u || '(empty)'} as fabricated`, () => {
      assert.strictEqual(rejectFakeReleaseUrl(u), true);
    });
  }

  test('rejects a host with no dot', () => {
    assert.strictEqual(isValidHttpsUrl('https://intranet/app.apk'), false);
  });
});

describe('release evidence verification', () => {
  const expected = { repo: REPO, tag: TAG, assetName: ASSET, expectedSha256: SHA, runId: '777' };

  test('a complete, matching release passes', () => {
    const r = validateReleaseEvidence(
      { releaseExists: true, assetExists: true, assetBrowserUrl: URL, assetSha256: SHA, runId: '777' },
      expected
    );
    assert.strictEqual(r.valid, true, r.errors.join('; '));
  });

  test('a missing release fails', () => {
    const r = validateReleaseEvidence({ releaseExists: false, assetExists: false }, expected);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /does not exist/.test(e)));
  });

  test('a release without the APK asset fails', () => {
    const r = validateReleaseEvidence({ releaseExists: true, assetExists: false }, expected);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /no asset/.test(e)));
  });

  test('an asset whose checksum differs from the verified APK fails', () => {
    const r = validateReleaseEvidence(
      { releaseExists: true, assetExists: true, assetBrowserUrl: URL, assetSha256: 'b'.repeat(64), runId: '777' },
      expected
    );
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /checksum/.test(e)));
  });

  test('an unreadable asset checksum fails', () => {
    const r = validateReleaseEvidence(
      { releaseExists: true, assetExists: true, assetBrowserUrl: URL, runId: '777' },
      expected
    );
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /checksum could not be read/.test(e)));
  });

  test('an asset URL pointing at another repo fails', () => {
    const other = `https://github.com/attacker/evil/releases/download/${TAG}/${ASSET}`;
    const r = validateReleaseEvidence(
      { releaseExists: true, assetExists: true, assetBrowserUrl: other, assetSha256: SHA, runId: '777' },
      expected
    );
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /does not belong to/.test(e)));
  });

  test('an asset URL pointing at another tag fails', () => {
    const other = `https://github.com/${REPO}/releases/download/build-other/${ASSET}`;
    const r = validateReleaseEvidence(
      { releaseExists: true, assetExists: true, assetBrowserUrl: other, assetSha256: SHA, runId: '777' },
      expected
    );
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /tag/.test(e)));
  });

  test('an asset URL with a different filename fails', () => {
    const other = `https://github.com/${REPO}/releases/download/${TAG}/other.apk`;
    const r = validateReleaseEvidence(
      { releaseExists: true, assetExists: true, assetBrowserUrl: other, assetSha256: SHA, runId: '777' },
      expected
    );
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /asset name/.test(e)));
  });

  test('a fabricated asset URL fails', () => {
    const other = `https://example.com/${REPO}/releases/download/${TAG}/${ASSET}`;
    const r = validateReleaseEvidence(
      { releaseExists: true, assetExists: true, assetBrowserUrl: other, assetSha256: SHA, runId: '777' },
      expected
    );
    assert.strictEqual(r.valid, false);
  });

  test('a release from a different run fails', () => {
    const r = validateReleaseEvidence(
      { releaseExists: true, assetExists: true, assetBrowserUrl: URL, assetSha256: SHA, runId: '111' },
      expected
    );
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /belongs to run 111/.test(e)));
  });

  test('no asset URL at all fails', () => {
    const r = validateReleaseEvidence({ releaseExists: true, assetExists: true }, expected);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /No asset browser download URL/.test(e)));
  });
});

describe('public download reachability', () => {
  test('a 200 with APK content type passes', async () => {
    const r = await verifyPublicDownload(URL, okFetch());
    assert.strictEqual(r.valid, true, r.errors.join('; '));
    assert.strictEqual(r.status, 200);
  });

  test('a 404 fails and is not treated as downloadable', async () => {
    const r = await verifyPublicDownload(URL, okFetch(404));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /404/.test(e)));
  });

  test('a 403 fails', async () => {
    const r = await verifyPublicDownload(URL, okFetch(403));
    assert.strictEqual(r.valid, false);
  });

  test('a 500 fails', async () => {
    const r = await verifyPublicDownload(URL, okFetch(500));
    assert.strictEqual(r.valid, false);
  });

  test('an unreachable host fails', async () => {
    const fetchImpl: FetchLike = async () => ({ valid: false, errors: ['Network error: ENOTFOUND'] });
    const r = await verifyPublicDownload(URL, fetchImpl);
    assert.strictEqual(r.valid, false);
  });

  test('a timeout fails', async () => {
    const fetchImpl: FetchLike = async () => ({ valid: false, errors: ['Public download timed out'] });
    const r = await verifyPublicDownload(URL, fetchImpl);
    assert.strictEqual(r.valid, false);
  });

  test('a redirect to a fabricated host is rejected', async () => {
    const fetchImpl: FetchLike = async (url) => ({ valid: true, errors: [], status: 200, finalUrl: 'https://example.com/app.apk' });
    const r = await verifyPublicDownload(URL, fetchImpl);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /non-HTTPS or fake URL/.test(e)), r.errors.join('; '));
  });

  test('a redirect to plain HTTP is rejected', async () => {
    const fetchImpl: FetchLike = async () => ({ valid: true, errors: [], status: 200, finalUrl: 'http://github.com/a/b.apk' });
    const r = await verifyPublicDownload(URL, fetchImpl);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /non-HTTPS/.test(e)));
  });

  test('a legitimate redirect is accepted', async () => {
    const cdn = 'https://objects.githubusercontent.com/github-production-release-asset/app.apk';
    const fetchImpl: FetchLike = async () => ({ valid: true, errors: [], status: 200, finalUrl: cdn });
    const r = await verifyPublicDownload(URL, fetchImpl);
    assert.strictEqual(r.valid, true, r.errors.join('; '));
    assert.strictEqual(r.finalUrl, cdn);
  });

  test('verification is not cached: it re-requests each time', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async (url) => {
      calls++;
      return { valid: true, errors: [], status: 200, finalUrl: url };
    };
    await verifyPublicDownload(URL, fetchImpl);
    await verifyPublicDownload(URL, fetchImpl);
    assert.strictEqual(calls, 2, 'each verification must actually hit the network');
  });

  test('no URL at all fails without any request', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => { calls++; return { valid: true, errors: [] }; };
    const r = await verifyPublicDownload('', fetchImpl);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(calls, 0);
  });

  test('a constructed-but-fake URL is refused before any request', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => { calls++; return { valid: true, errors: [] }; };
    const r = await verifyPublicDownload(`https://github.com/${REPO}/releases/download/${TAG}/example.apk`, fetchImpl);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(calls, 0);
  });

  test('a first release is not rejected for having not existed before it was created', () => {
    // releaseExists is captured before publishing, so on a brand new tag it is
    // false. Validating against that stale flag rejected the release the script
    // had just created, which made first-ever releases impossible.
    const repo = 'sikorokoro44/ai-app-builder';
    const tag = 'build-9001';
    const assetName = 'app-debug.apk';
    const sha = 'a'.repeat(64);
    const url = assetBrowserUrl(repo, tag, assetName);

    const plan = planReleaseAction({
      releaseExists: false, assetExists: false, publishedSha256: undefined, wantedSha256: sha,
    });
    assert.strictEqual(plan.action, 'create-release');

    // After a successful create the release does exist, so the refreshed flag
    // must let the evidence through.
    const refreshed = validateReleaseEvidence(
      { releaseExists: true, assetExists: true, assetBrowserUrl: url, assetSha256: sha, runId: '9001' },
      { repo, tag, assetName, expectedSha256: sha, runId: '9001' }
    );
    assert.ok(refreshed.valid, `unexpected errors: ${refreshed.errors.join('; ')}`);

    // The pre-publish value must still fail, which is what makes the refresh
    // in releaseArtifact.ts load-bearing rather than cosmetic.
    const stale = validateReleaseEvidence(
      { releaseExists: false, assetExists: true, assetBrowserUrl: url, assetSha256: sha, runId: '9001' },
      { repo, tag, assetName, expectedSha256: sha, runId: '9001' }
    );
    assert.strictEqual(stale.valid, false);
    assert.match(stale.errors.join(' '), /does not exist/);
  });
});
