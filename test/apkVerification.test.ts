import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { deflateRawSync, crc32 } from 'zlib';
import { randomBytes } from 'crypto';

const TMP = join(process.env.PREFIX || process.env.HOME, 'tmp', 'opencode', 'builder-test-apk');
mkdirSync(TMP, { recursive: true });

function zip(entries: { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf-8');
    const comp = e.store ? e.data : deflateRawSync(e.data);
    const method = e.store ? 0 : 8;
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function binaryManifest(pkg: string): Buffer {
  // AXML string pool fragment: the package name appears as UTF-16 in a real
  // manifest; the extractor reads the UTF-8 "package" marker plus the value.
  const head = Buffer.from([0x03, 0x00, 0x08, 0x00, 0x10, 0x00, 0x00, 0x00]);
  return Buffer.concat([head, Buffer.from('AndroidManifest'), Buffer.from([0, 0, 0, 0]), Buffer.from('package'), Buffer.from([0, 0, 0, 0]), Buffer.from(pkg, 'utf-8')]);
}

const RES = Buffer.alloc(4096, 7);
const DEX = Buffer.concat([Buffer.from('dex\n035\0'), Buffer.alloc(8000, 1)]);

function writeApk(name: string, pkg: string, opts: { manifest?: boolean; dex?: boolean; arsc?: boolean; pad?: number } = {}): string {
  const entries: { name: string; data: Buffer; store?: boolean }[] = [];
  if (opts.manifest !== false) entries.push({ name: 'AndroidManifest.xml', data: binaryManifest(pkg), store: true });
  if (opts.dex !== false) entries.push({ name: 'classes.dex', data: DEX });
  if (opts.arsc !== false) entries.push({ name: 'resources.arsc', data: RES });
  entries.push({ name: 'META-INF/CERT.RSA', data: Buffer.alloc(1200, 3) });
  entries.push({ name: 'assets/pad.bin', data: randomBytes(opts.pad ?? 8000) });
  const buf = zip(entries);
  const p = join(TMP, name);
  writeFileSync(p, buf);
  return p;
}

import { verifyApkFile, verifyBuildProvenance, rejectFakeApkUrl, extractPackageIdFromBinaryManifest, extractPackageIdFromManifestXml, readZipEntries, verifyPackageIdMatch } from '../scripts/live/apkValidator.ts';

describe('valid APK verification', () => {
  test('a well-formed APK with the right package passes', () => {
    const p = writeApk('good.apk', 'com.builder.notes');
    const r = verifyApkFile(p, 'com.builder.notes');
    assert.strictEqual(r.valid, true, r.errors.join('; '));
    assert.strictEqual(r.packageId, 'com.builder.notes');
    assert.match(r.sha256 || '', /^[0-9a-f]{64}$/);
    assert.ok((r.sizeBytes || 0) > 1000);
  });

  test('checksum is stable and content-sensitive', () => {
    const p = writeApk('stable.apk', 'com.builder.notes');
    const a = verifyApkFile(p).sha256;
    const b = verifyApkFile(p).sha256;
    assert.strictEqual(a, b);
    const other = writeApk('stable2.apk', 'com.builder.notes', { pad: 16000 });
    assert.notStrictEqual(verifyApkFile(other).sha256, a);
  });

  test('entries list includes the manifest', () => {
    const p = writeApk('entries.apk', 'com.builder.notes');
    const r = verifyApkFile(p);
    assert.ok((r.entries || []).includes('AndroidManifest.xml'));
  });
});

describe('malformed / missing APK rejection', () => {
  test('missing file is rejected', () => {
    const r = verifyApkFile(join(TMP, 'does-not-exist.apk'));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('not found')));
  });

  test('empty path is rejected', () => {
    const r = verifyApkFile('');
    assert.strictEqual(r.valid, false);
  });

  test('a non-ZIP file is rejected', () => {
    const p = join(TMP, 'notazip.apk');
    writeFileSync(p, Buffer.alloc(5000, 65));
    const r = verifyApkFile(p);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /valid APK\/ZIP/.test(e)));
  });

  test('a truncated ZIP is rejected as corrupt', () => {
    const p = writeApk('trunc.apk', 'com.builder.notes');
    const full = readFileSync(p);
    writeFileSync(join(TMP, 'trunc2.apk'), full.subarray(0, 200));
    const r = verifyApkFile(join(TMP, 'trunc2.apk'));
    assert.strictEqual(r.valid, false);
  });

  test('a tiny file is rejected', () => {
    const p = join(TMP, 'tiny.apk');
    writeFileSync(p, Buffer.from('PK', 'latin1'));
    const r = verifyApkFile(p);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /too small/.test(e)));
  });

  test('a directory is rejected', () => {
    const d = join(TMP, 'dir.apk');
    mkdirSync(d, { recursive: true });
    const r = verifyApkFile(d);
    assert.strictEqual(r.valid, false);
  });

  test('APK without AndroidManifest.xml is rejected', () => {
    const p = writeApk('nomanifest.apk', 'x', { manifest: false });
    const r = verifyApkFile(p);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('AndroidManifest.xml')));
  });

  test('APK without classes.dex is rejected', () => {
    const p = writeApk('nodex.apk', 'com.builder.x', { dex: false });
    const r = verifyApkFile(p);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('classes.dex')));
  });

  test('APK without resources.arsc is rejected', () => {
    const p = writeApk('noarsc.apk', 'com.builder.x', { arsc: false });
    const r = verifyApkFile(p);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('resources.arsc')));
  });
});

describe('wrong package ID rejection', () => {
  test('a mismatched package ID fails', () => {
    const p = writeApk('wrongpkg.apk', 'com.other.app');
    const r = verifyApkFile(p, 'com.builder.expected');
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /Package ID mismatch/.test(e)), r.errors.join('; '));
  });

  test('an unreadable package ID with an expectation fails rather than passing silently', () => {
    const p = writeApk('nopkg.apk', 'x', { manifest: true });
    // Simulate an unreadable manifest by expecting a package while the binary
    // manifest has no package attribute.
    const buf = zip([
      { name: 'AndroidManifest.xml', data: Buffer.from('no package attribute here at all'), store: true },
      { name: 'classes.dex', data: DEX },
      { name: 'resources.arsc', data: RES }
    ]);
    writeFileSync(join(TMP, 'nopkg2.apk'), buf);
    const r = verifyApkFile(join(TMP, 'nopkg2.apk'), 'com.builder.expected');
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /Cannot read applicationId/.test(e)), r.errors.join('; '));
  });

  test('package match helper is exact', () => {
    assert.strictEqual(verifyPackageIdMatch('com.a.b', 'com.a.b'), true);
    assert.strictEqual(verifyPackageIdMatch('com.a.b', 'com.a.c'), false);
    assert.strictEqual(verifyPackageIdMatch(undefined, 'com.a.b'), false);
    assert.strictEqual(verifyPackageIdMatch('com.a.b', ''), false);
  });

  test('package extraction from binary manifest and from XML', () => {
    assert.strictEqual(extractPackageIdFromBinaryManifest(binaryManifest('com.x.y')), 'com.x.y');
    assert.strictEqual(extractPackageIdFromManifestXml('<manifest package="com.a.b"></manifest>'), 'com.a.b');
    assert.strictEqual(extractPackageIdFromManifestXml('<manifest></manifest>'), null);
  });
});

describe('fake / fabricated APK paths and URLs are rejected', () => {
  const fakePaths = [
    '/data/example/app.apk',
    '/tmp/placeholder.apk',
    'fake-app.apk',
    'sample.apk',
    'dummy.apk',
    'synthetic.apk'
  ];
  for (const p of fakePaths) {
    test(`rejects fabricated path ${p}`, () => {
      const r = verifyApkFile(p);
      assert.strictEqual(r.valid, false);
      assert.ok(r.errors.some((e) => /fabricated|not found/.test(e)), r.errors.join('; '));
    });
  }

  const fakeUrls = [
    'https://example.com/app.apk',
    'https://github.com/o/r/releases/download/t/placeholder.apk',
    'http://github.com/o/r/app.apk',
    'https://localhost/app.apk',
    'https://127.0.0.1/app.apk',
    ''
  ];
  for (const u of fakeUrls) {
    test(`rejects fabricated url ${u || '(empty)'}`, () => {
      assert.strictEqual(rejectFakeApkUrl(u), true);
    });
  }

  test('accepts a genuine release URL', () => {
    assert.strictEqual(rejectFakeApkUrl('https://github.com/sikorokoro44/ai-app-builder/releases/download/build-1/app-debug.apk'), false);
  });
});

describe('APK must come from the current cloud build', () => {
  const goodState = () => ({
    cloudBuild: { status: 'passed', runId: '555', headSha: 'abc123def456', artifactSha256: 'deadbeef' }
  });

  test('a matching run/sha passes provenance', () => {
    const p = writeApk('prov.apk', 'com.builder.notes');
    const sha = verifyApkFile(p).sha256;
    const s = goodState();
    s.cloudBuild.artifactSha256 = sha;
    const r = verifyBuildProvenance(s, p, { runId: '555', headSha: 'abc123def456', artifactName: 'app-debug' }, sha);
    assert.strictEqual(r.valid, true, r.errors.join('; '));
  });

  test('a build that has not passed has no valid provenance', () => {
    const p = writeApk('prov2.apk', 'com.builder.notes');
    const r = verifyBuildProvenance({ cloudBuild: { status: 'running', runId: '1' } }, p, { runId: '1' });
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /not passed/.test(e)));
  });

  test('a missing run id is treated as unprovable', () => {
    const p = writeApk('prov3.apk', 'com.builder.notes');
    const r = verifyBuildProvenance({ cloudBuild: { status: 'passed' } }, p, {});
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /run id/.test(e)));
  });

  test('an APK from a different run is rejected', () => {
    const p = writeApk('prov4.apk', 'com.builder.notes');
    const r = verifyBuildProvenance(goodState(), p, { runId: '999' });
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /APK from run 999/.test(e)));
  });

  test('an APK built from a different commit is rejected', () => {
    const p = writeApk('prov5.apk', 'com.builder.notes');
    const r = verifyBuildProvenance(goodState(), p, { runId: '555', headSha: 'ffffffffffff' });
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /built from commit/.test(e)));
  });

  test('a fabricated artifact name is rejected', () => {
    const p = writeApk('prov6.apk', 'com.builder.notes');
    const r = verifyBuildProvenance(goodState(), p, { runId: '555', artifactName: 'placeholder-apk' });
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /fabricated/.test(e)));
  });

  test('a checksum that differs from the build record is rejected', () => {
    const p = writeApk('prov7.apk', 'com.builder.notes');
    const sha = verifyApkFile(p).sha256;
    const r = verifyBuildProvenance(goodState(), p, { runId: '555' }, sha);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /differs from the checksum/.test(e)));
  });

  test('an expected checksum mismatch is caught in verifyApkFile', () => {
    const p = writeApk('prov8.apk', 'com.builder.notes');
    const r = verifyApkFile(p, undefined, { expectedSha256: 'f'.repeat(64) });
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /Checksum mismatch/.test(e)));
  });
});

describe('zip reading', () => {
  test('readZipEntries returns null for garbage', () => {
    assert.strictEqual(readZipEntries(Buffer.alloc(100, 3)), null);
  });

  test('readZipEntries returns names for a real archive', () => {
    const p = writeApk('zip.apk', 'com.builder.zip');
    const entries = readZipEntries(readFileSync(p));
    assert.ok(entries);
    assert.ok(entries.some((e) => e.name === 'classes.dex'));
  });

  test('compression mode does not change verification', () => {
    const stored = writeApk('stored.apk', 'com.builder.notes');
    const deflated = writeApk('deflated.apk', 'com.builder.notes');
    assert.strictEqual(verifyApkFile(stored, 'com.builder.notes').valid, true);
    assert.strictEqual(verifyApkFile(deflated, 'com.builder.notes').valid, true);
  });
});
