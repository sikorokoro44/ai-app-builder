import './isolate.mjs';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { downloadAndHash, verifyPublicDownload, type DownloadLike } from '../scripts/live/releaseVerifier.ts';

/**
 * Run 37399628858 failed `release-publisher` with "the public download answered
 * HTTP 302, not 200" against a URL that served the APK perfectly well. GitHub
 * serves a release asset by redirecting to wherever the bytes happen to be
 * hosted, and the redirect handler reported the status of the hop instead of the
 * response that answered the question.
 *
 * The other half of this matters more. A `200` says something is served at an
 * address; it does not say the thing served is the artifact this run verified.
 */
const APK = randomBytes(4096);
const APK_SHA = createHash('sha256').update(APK).digest('hex');
const URL = 'https://github.com/o/r/releases/download/build-1/app-debug.apk';
const CDN = 'https://objects.githubusercontent.com/github-production-release-asset/signed';

/** A local stand-in for the redirect a release asset actually performs. */
function server(routes: Record<string, () => { status: number; headers?: Record<string, string>; body?: Buffer }>): DownloadLike {
  const http = createServer((req, res) => {
    const route = routes[req.url || '/'];
    if (!route) { res.writeHead(404); res.end(); return; }
    const { status, headers = {}, body = Buffer.alloc(0) } = route();
    res.writeHead(status, headers);
    res.end(body);
  });
  before(async () => { await new Promise<void>((r) => http.listen(0, '127.0.0.1', r)); });
  after(() => http.close());

  return async (url: string) => {
    const path = url === URL ? '/a.apk' : '/signed';
    const route = routes[path];
    if (!route) return { status: 404, headers: {}, body: Buffer.alloc(0) };
    const { status, headers = {}, body = Buffer.alloc(0) } = route();
    return { status, headers, body };
  };
}

describe('a public release download', () => {
  test('a redirected download is reported by the status that served the bytes', async () => {
    const res = await verifyPublicDownload(URL, async () => ({
      valid: true,
      errors: [],
      status: 200,
      finalUrl: CDN,
      redirects: [CDN]
    }));
    assert.ok(res.valid, 'a redirect ending in 200 is a successful download');
    assert.equal(res.status, 200, 'not the status of the hop before it');
  });

  test('the bytes served must be the bytes that were verified', async () => {
    const fetchImpl = server({
      '/a.apk': () => ({ status: 302, headers: { location: '/signed' } }),
      '/signed': () => ({ status: 200, headers: { 'content-type': 'application/vnd.android.package-archive' }, body: APK })
    });
    const good = await downloadAndHash(URL, APK_SHA, 5, fetchImpl);
    assert.equal(good.ok, true, 'the real artifact must pass');
    assert.equal(good.sha256, APK_SHA);
    assert.equal(good.bytes, APK.length);
  });

  test('a substituted asset is refused even though the address serves a 200', async () => {
    const fetchImpl = server({
      '/a.apk': () => ({ status: 302, headers: { location: '/signed' } }),
      '/signed': () => ({ status: 200, body: randomBytes(4096) })
    });
    const bad = await downloadAndHash(URL, APK_SHA, 5, fetchImpl);
    assert.equal(bad.ok, false, 'a replaced asset must not read as verified');
    assert.match(bad.errors.join(' '), /does not match the verified APK/);
    assert.equal(bad.bytes, 4096, 'and it must report what it actually received');
  });

  test('an empty body is never verified against a checksum', async () => {
    const fetchImpl = server({ '/a.apk': () => ({ status: 200, body: Buffer.alloc(0) }) });
    const res = await downloadAndHash(URL, APK_SHA, 5, fetchImpl);
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /empty body/);
  });

  test('a redirect loop is refused rather than followed forever', async () => {
    const fetchImpl = server({
      '/a.apk': () => ({ status: 302, headers: { location: '/signed' } }),
      '/signed': () => ({ status: 302, headers: { location: '/a.apk' } })
    });
    const res = await downloadAndHash(URL, APK_SHA, 2, fetchImpl);
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /redirect/i);
  });
});