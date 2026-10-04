import { existsSync, statSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { inflateRawSync } from 'zlib';

export const MIN_APK_BYTES = 1024;

export interface ApkVerificationResult {
  valid: boolean;
  errors: string[];
  packageId?: string;
  sha256?: string;
  sizeBytes?: number;
  entries?: string[];
}

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  compressionMethod: number;
  crc32: number;
}

/**
 * Reads the ZIP central directory without decompressing, so verification stays
 * cheap on a phone. Returns null when the file is not a well-formed ZIP.
 */
export function readZipEntries(buf: Buffer): ZipEntry[] | null {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length) return null;
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const compressionMethod = buf.readUInt16LE(off + 10);
    const crc32 = buf.readUInt32LE(off + 16);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf-8');
    entries.push({ name, compressedSize, uncompressedSize, localHeaderOffset, compressionMethod, crc32 });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Locates the data offset of an entry by following its local file header.
 */
export function entryDataOffset(buf: Buffer, e: ZipEntry): number | null {
  const off = e.localHeaderOffset;
  if (off + 30 > buf.length) return null;
  if (buf.readUInt32LE(off) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  return off + 30 + nameLen + extraLen;
}

export function inflateRaw(buf: Buffer, offset: number, compressedSize: number): Buffer | null {
  try {
    return inflateRawSync(buf.subarray(offset, offset + compressedSize));
  } catch {
    return null;
  }
}

/**
 * Extracts the `package` attribute from a binary AndroidManifest.xml (AXML).
 * Android no longer stores the package name in release manifests for
 * namespace-only projects, so a miss is reported as "not found", not "mismatch".
 */
export function extractPackageIdFromBinaryManifest(axml: Buffer): string | null {
  const needle = Buffer.from('package', 'utf-8');
  const idx = axml.indexOf(needle);
  if (idx < 0) return null;
  const after = axml.subarray(idx + needle.length, idx + needle.length + 64);
  const m = after.toString('latin1').match(/([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)/i);
  return m ? m[1] : null;
}

export function extractPackageIdFromManifestXml(xml: string): string | null {
  const m = xml.match(/package\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

export function verifyPackageIdMatch(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  return actual === expected;
}

export function rejectFakeApkUrl(url: string): boolean {
  if (!url) return true;
  const u = url.toLowerCase();
  return u.includes('example') || u.includes('placeholder') || u.includes('fake') ||
         u.includes('localhost') || u.includes('127.0.0.1') || u.startsWith('http://');
}

export function verifyApkFile(
  path: string,
  expectedPackageId?: string,
  opts: { expectedSha256?: string; requireBuildId?: boolean; allowedHosts?: string[] } = {}
): ApkVerificationResult {
  const errors: string[] = [];
  if (!path) return { valid: false, errors: ['APK path is empty'] };

  const lower = path.toLowerCase();
  if (/example|placeholder|fake|sample|dummy|synthetic|stub/i.test(lower)) {
    errors.push(`APK path looks fabricated: ${path}`);
  }
  if (!existsSync(path)) {
    errors.push(`APK not found: ${path}`);
    return { valid: false, errors };
  }
  const st = statSync(path);
  if (!st.isFile()) {
    errors.push('APK path is not a regular file');
    return { valid: false, errors };
  }
  if (st.size < MIN_APK_BYTES) {
    errors.push(`APK too small to be real (${st.size} bytes < ${MIN_APK_BYTES})`);
  }

  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e: any) {
    errors.push(`Cannot read APK: ${e.message}`);
    return { valid: false, errors };
  }

  if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    errors.push('Not a valid APK/ZIP: missing local file header signature');
  }

  const entries = readZipEntries(buf);
  if (!entries) {
    errors.push('Corrupt ZIP central directory');
    return { valid: false, errors };
  }

  const names = entries.map((e) => e.name);
  const manifest = entries.find((e) => e.name === 'AndroidManifest.xml');
  if (!manifest) {
    errors.push('APK has no AndroidManifest.xml at the archive root');
  }
  if (!entries.some((e) => /^classes\d*\.dex$/.test(e.name))) {
    errors.push('APK has no classes.dex');
  }
  if (!entries.some((e) => e.name === 'resources.arsc')) {
    errors.push('APK has no compiled resources (resources.arsc)');
  }
  const totalUncompressed = entries.reduce((a, e) => a + e.uncompressedSize, 0);
  if (totalUncompressed < 1024) {
    errors.push('APK contents implausibly small for a real application');
  }

  let packageId: string | undefined;
  if (manifest) {
    const dataOff = entryDataOffset(buf, manifest);
    if (dataOff === null) {
      errors.push('APK manifest local header is corrupt');
    } else {
      const raw = manifest.compressionMethod === 0
        ? buf.subarray(dataOff, dataOff + manifest.compressedSize)
        : inflateRaw(buf, dataOff, manifest.compressedSize);
      if (!raw) {
        errors.push('Cannot decode AndroidManifest.xml');
      } else {
        const pkg = extractPackageIdFromBinaryManifest(raw);
        if (pkg) packageId = pkg;
      }
    }
  }

  if (expectedPackageId) {
    if (!packageId) {
      errors.push(`Cannot read applicationId from binary manifest (expected ${expectedPackageId})`);
    } else if (!verifyPackageIdMatch(packageId, expectedPackageId)) {
      errors.push(`Package ID mismatch: APK declares ${packageId}, expected ${expectedPackageId}`);
    }
  }

  const sha256 = createHash('sha256').update(buf).digest('hex');
  if (opts.expectedSha256 && opts.expectedSha256 !== sha256) {
    errors.push(`Checksum mismatch: got ${sha256}, expected ${opts.expectedSha256}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    packageId,
    sha256,
    sizeBytes: st.size,
    entries: names.slice(0, 50)
  };
}

export interface BuildProvenance {
  runId?: string;
  headSha?: string;
  artifactName?: string;
  workflowFile?: string;
}

export interface ProvenanceResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Confirms the APK came from the current cloud build rather than a leftover
 * file from an earlier run or a hand-placed sample.
 */
export function verifyBuildProvenance(
  state: any,
  apkPath: string,
  provenance: BuildProvenance,
  sha256?: string
): ProvenanceResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (state?.cloudBuild?.status !== 'passed') {
    errors.push(`Cloud build is not passed (status=${state?.cloudBuild?.status})`);
  }
  const recordedRun = state?.cloudBuild?.runId;
  if (!recordedRun) {
    errors.push('Cloud build run id was never recorded; artifact provenance unprovable');
  } else if (provenance.runId && provenance.runId !== recordedRun) {
    errors.push(`APK from run ${provenance.runId}, but state records run ${recordedRun}`);
  }

  const recordedHead = state?.cloudBuild?.headSha;
  if (provenance.headSha && recordedHead && provenance.headSha !== recordedHead) {
    errors.push(`APK built from commit ${provenance.headSha.slice(0, 7)}, state records ${recordedHead.slice(0, 7)}`);
  }
  if (!recordedHead) {
    warnings.push('No head SHA recorded for the cloud build');
  }

  if (provenance.artifactName && /example|placeholder|sample|dummy/i.test(provenance.artifactName)) {
    errors.push(`Artifact name looks fabricated: ${provenance.artifactName}`);
  }
  if (sha256 && state?.cloudBuild?.artifactSha256 && state.cloudBuild.artifactSha256 !== sha256) {
    errors.push('APK checksum differs from the checksum recorded for this build');
  }
  return { valid: errors.length === 0, errors, warnings };
}
