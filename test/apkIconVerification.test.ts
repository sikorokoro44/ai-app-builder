import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { deflateRawSync, crc32 } from 'zlib';
import {
  verifyApkLauncherIconFromBuffer, extractApplicationIconIds, summariseResourceTable,
  readStringPool, expectedApkIconPaths
} from '../scripts/live/apkIconVerifier.ts';
import { encodePng } from '../scripts/live/png.ts';
import { renderIcon } from '../scripts/live/iconRaster.ts';
import { decideIcon, LEGACY_ICON_SIZES, FOREGROUND_ICON_SIZES } from '../scripts/iconCatalog.ts';
import {
  writeLauncherIcon, sourceIconSignatures, sourceRoundSignatures, sourceForegroundSignatures,
  sourceIconPngBytes,
  ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME, FOREGROUND_RESOURCE_NAME, ICON_BACKGROUND_COLOR_NAME
} from '../scripts/live/launcherIcon.ts';

const TMP = join(process.env.PREFIX || process.env.HOME, 'tmp', 'opencode', 'builder-test-apkicon');
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

mkdirSync(TMP, { recursive: true });

/* ---------------------------------------------------------------- ZIP ---- */

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

/* ------------------------------------------------- binary XML writer ---- */

/**
 * Builds a ResStringPool chunk for `strings`.
 *
 * UTF-8 pools store, per entry, the UTF-16 length as a 1- or 2-byte varint, the
 * byte length as a 1- or 2-byte varint, the bytes themselves, then a NUL. The
 * offsets array that precedes the data holds relative offsets from `stringsStart`.
 */
function poolChunk(strings: string[]): { buf: Buffer; size: number } {
  const encodeOne = (s: string): Buffer => {
    const bytes = Buffer.from(s, 'utf-8');
    const units = s.length;
    const lenBytes = units > 0x7f
      ? Buffer.from([0x80 | (units >> 8), units & 0xff])
      : Buffer.from([units]);
    const byteLen = bytes.length > 0x7f
      ? Buffer.from([0x80 | (bytes.length >> 8), bytes.length & 0xff])
      : Buffer.from([bytes.length]);
    return Buffer.concat([lenBytes, byteLen, bytes, Buffer.from([0])]);
  };
  const encoded = strings.map(encodeOne);
  const offsets: number[] = [];
  let cursor = 0;
  for (const e of encoded) {
    offsets.push(cursor);
    cursor += e.length;
  }
  const headerSize = 28;
  const stringsStart = headerSize + offsets.length * 4;
  const size = stringsStart + cursor;
  const buf = Buffer.alloc(size);
  buf.writeUInt16LE(0x0001, 0);
  buf.writeUInt16LE(headerSize, 2);
  buf.writeUInt32LE(size, 4);
  buf.writeUInt32LE(strings.length, 8);
  buf.writeUInt32LE(0, 12);
  buf.writeUInt32LE(0x00000100, 16);        // UTF-8 flag
  buf.writeUInt32LE(stringsStart, 20);
  buf.writeUInt32LE(0, 24);
  offsets.forEach((o, i) => buf.writeUInt32LE(o, headerSize + i * 4));
  encoded.forEach((e, i) => e.copy(buf, stringsStart + offsets[i]));
  return { buf, size };
}

interface AttrSpec {
  ns: string | null;
  name: string;
  dataType: number;
  data: number;
}

/**
 * Writes a real compiled AndroidManifest.xml: a string pool chunk followed by
 * `<application>` whose `android:icon` / `android:roundIcon` are resource
 * references.
 *
 * The resource *ids* are what the launcher actually resolves, so fixtures built
 * here can only pass by describing a genuine icon.
 */
function buildManifest(opts: {
  packageName: string;
  iconId?: number | null;
  roundIconId?: number | null;
  iconIsLiteral?: boolean;
} = { packageName: 'com.builder.todo' }): Buffer {
  const attrs: AttrSpec[] = [{ ns: ANDROID_NS, name: 'label', dataType: 0x01, data: 0x7f080000 }];
  if (opts.iconIsLiteral) {
    attrs.push({ ns: ANDROID_NS, name: 'icon', dataType: 0x03, data: 0 });
  } else if (opts.iconId !== undefined && opts.iconId !== null) {
    attrs.push({ ns: ANDROID_NS, name: 'icon', dataType: 0x01, data: opts.iconId });
  }
  if (!opts.iconIsLiteral && opts.roundIconId !== undefined && opts.roundIconId !== null) {
    attrs.push({ ns: ANDROID_NS, name: 'roundIcon', dataType: 0x01, data: opts.roundIconId });
  }

  // The pool has to be complete before it can be emitted, so every string the
  // element and its attributes mention is registered first.
  const strings = ['application', ANDROID_NS, ...attrs.map((a) => a.name)];
  const at = (s: string): number => strings.indexOf(s);
  const pool = poolChunk(strings);

  const attributeCount = attrs.length;
  const startSize = 16 + 20 + attributeCount * 20;
  const start = Buffer.alloc(startSize);
  start.writeUInt16LE(0x0102, 0);
  start.writeUInt16LE(16, 2);
  start.writeUInt32LE(startSize, 4);
  start.writeUInt32LE(1, 8);
  start.writeUInt32LE(0xffffffff, 12);
  const attrExt = 16;
  start.writeInt32LE(-1, attrExt);                    // element has no namespace
  start.writeInt32LE(at('application'), attrExt + 4);
  start.writeUInt16LE(20, attrExt + 8);               // attributeStart
  start.writeUInt16LE(20, attrExt + 10);              // attributeSize
  start.writeUInt16LE(attributeCount, attrExt + 12);

  attrs.forEach((a, i) => {
    // ResXMLTree_attribute: ns +0, name +4, rawValue +8,
    // Res_value { size +12, res0 +14, dataType +15, data +16 }.
    const o = attrExt + 20 + i * 20;
    start.writeInt32LE(a.ns === null ? -1 : at(a.ns), o);
    start.writeInt32LE(at(a.name), o + 4);
    start.writeInt32LE(-1, o + 8);
    start.writeUInt16LE(8, o + 12);
    start.writeUInt8(a.dataType, o + 15);
    start.writeUInt32LE(a.data >>> 0, o + 16);
  });

  const endSize = 24;
  const end = Buffer.alloc(endSize);
  end.writeUInt16LE(0x0103, 0);
  end.writeUInt16LE(16, 2);
  end.writeUInt32LE(endSize, 4);
  end.writeUInt32LE(1, 8);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeInt32LE(-1, 16);
  end.writeInt32LE(at('application'), 20);

  const payload = Buffer.concat([pool.buf, start, end]);
  const file = Buffer.alloc(8);
  file.writeUInt16LE(0x0003, 0);
  file.writeUInt16LE(8, 2);
  file.writeUInt32LE(8 + payload.length, 4);
  return Buffer.concat([file, payload]);
}

/* ------------------------------------------ resources.arsc writer ---- */

/**
 * Writes a resource table that declares a `mipmap` type whose entries point at
 * the given files. Only the chunks the verifier reads are emitted: the global
 * value pool, a package with its type/key pools, a type-spec giving the entry
 * count, and one type chunk.
 */
function buildArsc(opts: {
  packageId: number;
  filePaths: string[];
  keyNames: string[];
  typeName?: string;
  entriesPerFile?: number;
  /**
   * Files per key, emitted as map entries with one value per configuration,
   * which is the shape a real APK uses for a resource that exists at several
   * densities. When omitted each key gets the single file at the same index.
   */
  keyPaths?: Record<string, string[]>;
  /**
   * Emit each config as its own ResTable_type chunk, keyed by config name, with
   * keys absent from that config recorded as zero-size gaps. This is the shape a
   * real APK has: one chunk per configuration, not one chunk for everything.
   */
  configChunks?: Record<string, Record<string, string[]>>;
}): Buffer {
  const typeName = opts.typeName || 'mipmap';
  const typeId = 1;
  const colours = [...opts.filePaths, 'res/values/colors.xml'];
  const fileIndex = new Map(colours.map((p, i) => [p, i]));
  const entryCount = Math.max(opts.entriesPerFile || opts.keyNames.length, opts.keyNames.length);

  const global = poolChunk(colours);
  const types = poolChunk([typeName, 'color']);
  const keys = poolChunk([...opts.keyNames, ICON_BACKGROUND_COLOR_NAME]);

  const typeSpecSize = 16 + entryCount * 4;
  const typeSpec = Buffer.alloc(typeSpecSize);
  typeSpec.writeUInt16LE(0x0202, 0);
  typeSpec.writeUInt16LE(16, 2);
  typeSpec.writeUInt32LE(typeSpecSize, 4);
  typeSpec.writeUInt8(typeId, 8);
  typeSpec.writeUInt32LE(entryCount, 12);

  // `color/ic_launcher_background`, declared so an adaptive icon's reference to
  // it resolves to a name.
  const colourSpec = Buffer.alloc(16 + 4);
  colourSpec.writeUInt16LE(0x0202, 0);
  colourSpec.writeUInt16LE(16, 2);
  colourSpec.writeUInt32LE(colourSpec.length, 4);
  colourSpec.writeUInt8(COLOUR_TYPE_ID, 8);
  colourSpec.writeUInt32LE(1, 12);

  const configSize = 64;
  const headerEnd = 20;
  const entriesStart = headerEnd + configSize;

  // Encodes one entry for `path` under `keyIndex`, as a map when the key has
  // several configurations, so a chunk can carry a key's values together.
  const encodeEntry = (keyIndex: number, paths: string[]): Buffer => {
    if (paths.length === 0) return Buffer.alloc(8);        // absent: size 0 header only
    if (paths.length === 1) {
      const e = Buffer.alloc(16);
      e.writeUInt16LE(8, 0);                                // ResTable_entry.size (header only)
      e.writeUInt16LE(0, 2);                                // simple entry
      e.writeUInt32LE(keyIndex, 4);
      e.writeUInt16LE(8, 8);                                // Res_value.size
      e.writeUInt8(0x03, 11);                               // Res_value dataType = string
      e.writeUInt32LE(fileIndex.get(paths[0])!, 12);
      return e;
    }
    const size = 16 + paths.length * 12;
    const e = Buffer.alloc(size);
    e.writeUInt16LE(size, 0);
    e.writeUInt16LE(0x0001, 2);                             // FLAG_COMPLEX
    e.writeUInt32LE(keyIndex, 4);
    e.writeUInt32LE(0, 8);                                   // parent
    e.writeUInt32LE(paths.length, 12);
    paths.forEach((p, m) => {
      const at = 16 + m * 12;
      e.writeUInt32LE(0, at);                                // ResTable_ref.name, unused
      e.writeUInt8(0x03, at + 7);                            // Res_value dataType = string
      e.writeUInt32LE(fileIndex.get(p)!, at + 8);
    });
    return e;
  };

  const typeChunkFor = (body: Buffer[], id = typeId): Buffer => {
    const size = entriesStart + body.reduce((n, e) => n + e.length, 0);
    const c = Buffer.alloc(size);
    c.writeUInt16LE(0x0201, 0);
    c.writeUInt16LE(16, 2);
    c.writeUInt32LE(size, 4);
    c.writeUInt8(id, 8);
    c.writeUInt32LE(entryCount, 12);
    c.writeUInt32LE(entriesStart, 16);
    c.writeUInt32LE(configSize, 20);
    let at = entriesStart;
    for (const e of body) { e.copy(c, at); at += e.length; }
    return c;
  };

  const entries: Buffer[] = [];
  for (let i = 0; i < entryCount; i++) {
    const keyIndex = i;
    const path = opts.filePaths[keyIndex];
    const e = Buffer.alloc(16);
    if (path !== undefined && fileIndex.has(path)) {
      e.writeUInt16LE(8, 0);            // ResTable_entry.size
      e.writeUInt16LE(0, 2);            // simple entry
      e.writeUInt32LE(keyIndex, 4);
      e.writeUInt8(0x03, 11);           // Res_value dataType = string
      e.writeUInt32LE(fileIndex.get(path)!, 12);
    }
    entries.push(e);
  }
  if (opts.keyPaths) {
    // One map entry per key, one ResTable_map per configuration.
    const maps: Buffer[] = [];
    for (let i = 0; i < entryCount; i++) {
      const keyName = opts.keyNames[i];
      const paths = opts.keyPaths[keyName] ?? [];
      if (paths.length === 0) {
        maps.push(Buffer.alloc(16));   // declared but absent, like a real empty entry
        continue;
      }
      const size = 16 + paths.length * 12;
      const e = Buffer.alloc(size);
      e.writeUInt16LE(size, 0);
      e.writeUInt16LE(0x0001, 2);     // FLAG_COMPLEX
      e.writeUInt32LE(i, 4);
      e.writeUInt32LE(0, 8);           // parent
      e.writeUInt32LE(paths.length, 12);
      paths.forEach((p, m) => {
        const at = 16 + m * 12;
        e.writeUInt32LE(0, at);                    // ResTable_ref.name, unused for values
        e.writeUInt8(0x03, at + 7);                // Res_value dataType = string
        e.writeUInt32LE(fileIndex.get(p)!, at + 8);
      });
      maps.push(e);
    }
    entries.length = 0;
    entries.push(...maps);
  }

  // One chunk per configuration, which is what aapt2 emits. Keys a configuration
  // does not carry are left as zero-size gaps.
  const chunks: Buffer[] = opts.configChunks
    ? Object.values(opts.configChunks).map((cfg) => typeChunkFor(
        opts.keyNames.map((keyName, i) => encodeEntry(i, (cfg[keyName] ?? []).filter((q) => fileIndex.has(q))))
      ))
    : [typeChunkFor(entries)];
  const colourEntry = Buffer.alloc(16);
  colourEntry.writeUInt16LE(8, 0);
  colourEntry.writeUInt16LE(0, 2);
  colourEntry.writeUInt32LE(opts.keyNames.length, 4);      // the colour key's index
  colourEntry.writeUInt16LE(8, 8);
  colourEntry.writeUInt8(0x03, 11);
  colourEntry.writeUInt32LE(fileIndex.get('res/values/colors.xml')!, 12);
  chunks.unshift(typeChunkFor([colourEntry], COLOUR_TYPE_ID));
  const allSpecs = [colourSpec, typeSpec];
  const typeBytes = allSpecs.reduce((n, c) => n + c.length, 0) + chunks.reduce((n, c) => n + c.length, 0);

  const typeStringsOffset = align4(288 + typeBytes);
  const keyStringsOffset = align4(typeStringsOffset + types.size);
  const packageSize = keyStringsOffset + keys.size;
  const pkg = Buffer.alloc(packageSize);
  pkg.writeUInt16LE(0x0200, 0);
  pkg.writeUInt16LE(288, 2);
  pkg.writeUInt32LE(packageSize, 4);
  pkg.writeUInt32LE(opts.packageId, 8);
  pkg.writeUInt32LE(typeStringsOffset, 268);
  pkg.writeUInt32LE(keyStringsOffset, 276);
  let chunkAt = 288;
  for (const spec of allSpecs) { spec.copy(pkg, chunkAt); chunkAt += spec.length; }
  for (const c of chunks) { c.copy(pkg, chunkAt); chunkAt += c.length; }
  types.buf.copy(pkg, typeStringsOffset);
  keys.buf.copy(pkg, keyStringsOffset);

  const tableSize = 12 + global.size + packageSize;
  const table = Buffer.alloc(tableSize);
  table.writeUInt16LE(0x0002, 0);
  table.writeUInt16LE(12, 2);
  table.writeUInt32LE(tableSize, 4);
  table.writeUInt32LE(1, 8);
  global.buf.copy(table, 12);
  pkg.copy(table, 12 + global.size);
  return table;
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** A compiled adaptive-icon XML, as AAPT2 would emit it. */
/**
 * A compiled adaptive icon. `@mipmap/...` and `@color/...` are stored as numeric
 * resource ids, not as text, so the verifier has to resolve them through the
 * resource table to learn which layer is referenced.
 */
function buildAdaptiveXml(): Buffer {
  const strings = ['adaptive-icon', 'background', 'foreground', 'drawable', ICON_BACKGROUND_COLOR_NAME, FOREGROUND_RESOURCE_NAME];
  const pool = poolChunk(strings);

  const startSize = 16 + 20 + 2 * 20;
  const start = Buffer.alloc(startSize);
  start.writeUInt16LE(0x0102, 0);
  start.writeUInt16LE(16, 2);
  start.writeUInt32LE(startSize, 4);
  const attrExt = 16;
  start.writeInt32LE(-1, attrExt);
  start.writeInt32LE(0, attrExt + 4);         // 'adaptive-icon'
  start.writeUInt16LE(20, attrExt + 8);
  start.writeUInt16LE(20, attrExt + 10);
  start.writeUInt16LE(2, attrExt + 12);
  start.writeInt32LE(-1, attrExt + 20);
  start.writeInt32LE(3, attrExt + 24);         // 'drawable'
  start.writeUInt8(0x01, attrExt + 35);        // Res_value dataType = reference
  start.writeUInt32LE(COLOUR_ID, attrExt + 36);
  start.writeInt32LE(-1, attrExt + 40);
  start.writeInt32LE(2, attrExt + 44);         // 'foreground'
  start.writeUInt8(0x01, attrExt + 55);        // Res_value dataType = reference
  start.writeUInt32LE(FOREGROUND_ID, attrExt + 56);

  const file = Buffer.alloc(8);
  file.writeUInt16LE(0x0003, 0);
  file.writeUInt16LE(8, 2);
  file.writeUInt32LE(8 + pool.buf.length + start.length, 4);
  return Buffer.concat([file, pool.buf, start]);
}

/* -------------------------------------------------- icon fixtures ---- */

const PACKAGE_ID = 0x7f;
const TYPE_ID = 1;
const COLOUR_TYPE_ID = 2;
const ICON_ENTRY = 0;
const ROUND_ENTRY = 1;
const FOREGROUND_ENTRY = 2;
/** `@color/ic_launcher_background` and `@mipmap/ic_launcher_foreground`. */
const COLOUR_ID = (PACKAGE_ID << 24) | (COLOUR_TYPE_ID << 16);
const FOREGROUND_ID = (PACKAGE_ID << 24) | (TYPE_ID << 16) | FOREGROUND_ENTRY;

function generatedIconPaths(): { legacy: string[]; foreground: string[]; adaptive: string[] } {
  const legacy: string[] = [];
  const foreground: string[] = [];
  for (const d of Object.keys(LEGACY_ICON_SIZES)) {
    legacy.push(`res/mipmap-${d}/${ICON_RESOURCE_NAME}.png`);
    legacy.push(`res/mipmap-${d}/${ROUND_ICON_RESOURCE_NAME}.png`);
    foreground.push(`res/mipmap-${d}/${FOREGROUND_RESOURCE_NAME}.png`);
  }
  const adaptive = [`res/mipmap-anydpi-v26/${ICON_RESOURCE_NAME}.xml`, `res/mipmap-anydpi-v26/${ROUND_ICON_RESOURCE_NAME}.xml`];
  return { legacy, foreground, adaptive };
}

/** Builds a generated project on disk so expectations come from real files. */
function realIconProject(name: string, idea = 'A todo list app'): string {
  const root = join(TMP, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'app', 'src', 'main'), { recursive: true });
  writeFileSync(join(root, 'app', 'src', 'main', 'AndroidManifest.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="${ANDROID_NS}">
  <application android:label="Todo" android:icon="@mipmap/${ICON_RESOURCE_NAME}" android:roundIcon="@mipmap/${ROUND_ICON_RESOURCE_NAME}" />
</manifest>
`);
  writeLauncherIcon(root, idea, 'Todo');
  return root;
}

function expectations(projectRoot: string) {
  return {
    signatures: sourceIconSignatures(projectRoot),
    roundSignatures: sourceRoundSignatures(projectRoot),
    foregroundSignatures: sourceForegroundSignatures(projectRoot),
    sourcePngBytes: sourceIconPngBytes(projectRoot),
    fingerprint: 'test'
  };
}

/**
 * An APK carrying the generated icon: every density's real pixels, an adaptive
 * icon, and a manifest whose icon attribute references the `mipmap` type.
 */
function apkWithIcon(opts: {
  projectRoot: string;
  idea?: string;
  iconId?: number | null;
  roundIconId?: number | null;
  iconIsLiteral?: boolean;
  omit?: string[];
  swapIconFor?: string;
  overridePng?: Record<string, Buffer>;
  withResources?: boolean;
  withManifest?: boolean;
  keyNames?: string[];
  typeName?: string;
} ): Buffer {
  const projectRoot = opts.projectRoot;
  const idea = opts.idea || 'A todo list app';
  const paths = generatedIconPaths();

  const entries: { name: string; data: Buffer }[] = [];
  entries.push({
    name: 'AndroidManifest.xml',
    data: opts.withManifest === false
      ? Buffer.from('<manifest/>')
      : buildManifest({
          packageName: 'com.builder.todo',
          iconId: opts.iconId === undefined ? ((PACKAGE_ID << 24) | (TYPE_ID << 16) | ICON_ENTRY) : opts.iconId,
          roundIconId: opts.roundIconId === undefined ? ((PACKAGE_ID << 24) | (TYPE_ID << 16) | ROUND_ENTRY) : opts.roundIconId,
          iconIsLiteral: opts.iconIsLiteral
        }),
    store: true
  });
  if (opts.withResources !== false) {
    entries.push({
      name: 'resources.arsc',
      data: buildArsc({
        packageId: PACKAGE_ID,
        filePaths: [...paths.legacy, ...paths.foreground, ...paths.adaptive],
        keyNames: opts.keyNames || [ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME, FOREGROUND_RESOURCE_NAME, ICON_BACKGROUND_COLOR_NAME],
        typeName: opts.typeName,
        keyPaths: {
          [ICON_RESOURCE_NAME]: paths.legacy
            .filter((p) => !opts.omit?.includes(p) && p.endsWith(`/${ICON_RESOURCE_NAME}.png`))
            .concat(paths.adaptive.filter((p) => !opts.omit?.includes(p) && p.endsWith(`/${ICON_RESOURCE_NAME}.xml`))),
          [ROUND_ICON_RESOURCE_NAME]: paths.legacy
            .filter((p) => !opts.omit?.includes(p) && p.endsWith(`/${ROUND_ICON_RESOURCE_NAME}.png`))
            .concat(paths.adaptive.filter((p) => !opts.omit?.includes(p) && p.endsWith(`/${ROUND_ICON_RESOURCE_NAME}.xml`))),
          [FOREGROUND_RESOURCE_NAME]: paths.foreground.filter((p) => !opts.omit?.includes(p)),
          [ICON_BACKGROUND_COLOR_NAME]: []
        }
      })
    });
  }
  // Every generated PNG, round and legacy alike, is shipped exactly as written.
  for (const rel of [...paths.legacy, ...paths.foreground]) {
    const density = rel.split('/')[1].replace('mipmap-', '');
    const file = rel.split('/')[2];
    if (opts.omit?.includes(rel)) continue;
    const override = opts.overridePng?.[rel];
    if (override) {
      entries.push({ name: rel, data: override });
      continue;
    }
    if (opts.swapIconFor && file === `${ICON_RESOURCE_NAME}.png`) {
      const px = LEGACY_ICON_SIZES[density as keyof typeof LEGACY_ICON_SIZES];
      entries.push({ name: rel, data: encodePng(px, px, renderIcon(decideIcon(opts.swapIconFor).definition, px, 'legacy')) });
      continue;
    }
    entries.push({ name: rel, data: readFileSync(join(projectRoot, 'app', 'src', 'main', 'res', `mipmap-${density}`, file)) });
  }
  for (const rel of paths.foreground) {
    const density = rel.split('/')[1].replace('mipmap-', '');
    if (opts.omit?.includes(rel)) continue;
    entries.push({ name: rel, data: readFileSync(join(projectRoot, 'app', 'src', 'main', 'res', `mipmap-${density}`, `${FOREGROUND_RESOURCE_NAME}.png`)) });
  }
  for (const rel of paths.adaptive) {
    if (opts.omit?.includes(rel)) continue;
    entries.push({ name: rel, data: buildAdaptiveXml() });
  }
  entries.push({ name: 'classes.dex', data: Buffer.concat([Buffer.from('dex\n035\0'), Buffer.alloc(4000, 1)]) });
  return zip(entries);
}

/* ------------------------------------------------------------ tests ---- */

describe('compiled manifest icon attributes', () => {
  test('a resource-reference icon is extracted as an id', () => {
    const ids = extractApplicationIconIds(buildManifest({ packageName: 'com.x', iconId: 0x7f010005, roundIconId: 0x7f010006 }))!;
    assert.strictEqual(ids.iconId, 0x7f010005);
    assert.strictEqual(ids.roundIconId, 0x7f010006);
    assert.strictEqual(ids.iconIsReference, true);
  });

  test('a literal icon value is reported as not a reference', () => {
    const ids = extractApplicationIconIds(buildManifest({ packageName: 'com.x', iconIsLiteral: true }))!;
    assert.strictEqual(ids.iconId, undefined);
    assert.strictEqual(ids.iconIsReference, false);
  });

  test('a manifest with no icon yields no id', () => {
    const ids = extractApplicationIconIds(buildManifest({ packageName: 'com.x', iconId: null }))!;
    assert.strictEqual(ids.iconId, undefined);
  });

  test('a string pool is read with UTF-8 lengths', () => {
    const xml = buildAdaptiveXml();
    const pool = readStringPool(xml, 8)!;
    assert.ok(pool.strings.includes('adaptive-icon'));
    assert.ok(pool.strings.includes(FOREGROUND_RESOURCE_NAME));
  });
});

describe('resource table summary', () => {
  test('the package, type name and referenced files are read back', () => {
    const paths = generatedIconPaths();
    const arsc = buildArsc({
      packageId: 0x7f,
      filePaths: [...paths.legacy, ...paths.foreground, ...paths.adaptive],
      keyNames: [ICON_RESOURCE_NAME]
    });
    const s = summariseResourceTable(arsc)!;
    assert.strictEqual(s.packageId, 0x7f);
    assert.strictEqual(s.typeNames[0], 'mipmap');
    assert.ok(s.keyNames.includes(ICON_RESOURCE_NAME));
    assert.ok(s.filePaths.has(`res/mipmap-xhdpi/${ICON_RESOURCE_NAME}.png`));
    assert.ok(!s.filePaths.has('res/values/strings.xml'));
  });

  test('garbage is rejected rather than half-parsed', () => {
    assert.strictEqual(summariseResourceTable(Buffer.alloc(64, 3)), null);
  });
});

describe('APK launcher icon verification', () => {
  test('a compile-time rewrite of resource directories does not hide the icon', () => {
    // AAPT2 appends a version qualifier to the mipmap directories as it compiles
    // (`mipmap-mdpi` -> `mipmap-mdpi-v4`), so the paths the generator wrote are not
    // the paths the APK ends up with. Resolution therefore goes through the
    // resource table's own key -> file map and matches on the compiled pixel size.
    const root = realIconProject('rewritten-paths');
    const rewrite = (p: string): string =>
      p.replace(/^res\/mipmap-(mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)\//, 'res/mipmap-$1-v4/');
    const paths = generatedIconPaths();
    const all = [...paths.legacy, ...paths.foreground, ...paths.adaptive].map(rewrite);
    const entries: { name: string; data: Buffer; store?: boolean }[] = [
      { name: 'AndroidManifest.xml', store: true, data: buildManifest({
        packageName: 'com.builder.todo',
        iconId: (PACKAGE_ID << 24) | (TYPE_ID << 16) | ICON_ENTRY,
        roundIconId: (PACKAGE_ID << 24) | (TYPE_ID << 16) | ROUND_ENTRY
      }) },
      { name: 'resources.arsc', data: buildArsc({
        packageId: PACKAGE_ID,
        filePaths: all,
        keyNames: [ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME, FOREGROUND_RESOURCE_NAME, ICON_BACKGROUND_COLOR_NAME],
        keyPaths: {
          [ICON_RESOURCE_NAME]: paths.legacy.filter((q) => q.endsWith(`/${ICON_RESOURCE_NAME}.png`)).map(rewrite)
            .concat(paths.adaptive.filter((q) => q.endsWith(`/${ICON_RESOURCE_NAME}.xml`)).map(rewrite)),
          [ROUND_ICON_RESOURCE_NAME]: paths.legacy.filter((q) => q.endsWith(`/${ROUND_ICON_RESOURCE_NAME}.png`)).map(rewrite)
            .concat(paths.adaptive.filter((q) => q.endsWith(`/${ROUND_ICON_RESOURCE_NAME}.xml`)).map(rewrite)),
          [FOREGROUND_RESOURCE_NAME]: paths.foreground.map(rewrite),
          [ICON_BACKGROUND_COLOR_NAME]: []
        }
      }) }
    ];
    for (const rel of [...paths.legacy, ...paths.foreground]) {
      const density = rel.split('/')[1].replace('mipmap-', '');
      const file = rel.split('/')[2];
      entries.push({
        name: rewrite(rel),
        data: readFileSync(join(root, 'app', 'src', 'main', 'res', `mipmap-${density}`, file))
      });
    }
    for (const rel of paths.adaptive) entries.push({ name: rewrite(rel), data: buildAdaptiveXml() });

    const r = verifyApkLauncherIconFromBuffer(zip(entries), expectations(root));
    assert.strictEqual(r.valid, true, r.errors.join('; '));
    assert.deepStrictEqual(r.matchedDensities, Object.keys(LEGACY_ICON_SIZES));
    const densities = r.resolvedPaths.filter((q) => /ic_launcher\.png$/.test(q));
    assert.strictEqual(densities.length, Object.keys(LEGACY_ICON_SIZES).length);
    assert.ok(densities.every((q) => /-v4\//.test(q)),
      `every compiled density path should carry the qualifier, got ${densities.join(', ')}`);
  });

  test('a resource split across per-configuration chunks is still fully read', () => {
    // AAPT2 emits one ResTable_type chunk per configuration and marks the keys a
    // configuration does not carry with a zero-size entry. A reader that stops at
    // the first such gap silently drops every later entry, which loses the round
    // icon's densities while the legacy ones still verify.
    const root = realIconProject('per-config-chunks');
    const paths = generatedIconPaths();
    const chunks: Record<string, Record<string, string[]>> = {};
    for (const d of Object.keys(LEGACY_ICON_SIZES)) {
      chunks[d] = {
        [ICON_RESOURCE_NAME]: [`res/mipmap-${d}-v4/${ICON_RESOURCE_NAME}.png`],
        [ROUND_ICON_RESOURCE_NAME]: [`res/mipmap-${d}-v4/${ROUND_ICON_RESOURCE_NAME}.png`],
        [FOREGROUND_RESOURCE_NAME]: [`res/mipmap-${d}-v4/${FOREGROUND_RESOURCE_NAME}.png`]
      };
    }
    // The adaptive configuration carries only the two XMLs, so the foreground key
    // is a gap in the middle of that chunk's entry array.
    chunks['anydpi-v26'] = {
      [ICON_RESOURCE_NAME]: [`res/mipmap-anydpi-v26/${ICON_RESOURCE_NAME}.xml`],
      [ROUND_ICON_RESOURCE_NAME]: [`res/mipmap-anydpi-v26/${ROUND_ICON_RESOURCE_NAME}.xml`],
      [FOREGROUND_RESOURCE_NAME]: []
    };
    const entries: { name: string; data: Buffer; store?: boolean }[] = [
      { name: 'AndroidManifest.xml', store: true, data: buildManifest({
        packageName: 'com.builder.todo',
        iconId: (PACKAGE_ID << 24) | (TYPE_ID << 16) | ICON_ENTRY,
        roundIconId: (PACKAGE_ID << 24) | (TYPE_ID << 16) | ROUND_ENTRY
      }) },
      { name: 'resources.arsc', data: buildArsc({
        packageId: PACKAGE_ID,
        filePaths: Object.values(chunks).flatMap((cfg) => Object.values(cfg).flat()),
        keyNames: [ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME, FOREGROUND_RESOURCE_NAME, ICON_BACKGROUND_COLOR_NAME],
        configChunks: chunks
      }) }
    ];
    for (const d of Object.keys(LEGACY_ICON_SIZES)) {
      for (const file of [`${ICON_RESOURCE_NAME}.png`, `${ROUND_ICON_RESOURCE_NAME}.png`, `${FOREGROUND_RESOURCE_NAME}.png`]) {
        entries.push({
          name: `res/mipmap-${d}-v4/${file}`,
          data: readFileSync(join(root, 'app', 'src', 'main', 'res', `mipmap-${d}`, file))
        });
      }
    }
    for (const rel of paths.adaptive) entries.push({ name: rel, data: buildAdaptiveXml() });

    const r = verifyApkLauncherIconFromBuffer(zip(entries), expectations(root));
    assert.strictEqual(r.valid, true, r.errors.join('; '));
    assert.deepStrictEqual(r.matchedDensities, Object.keys(LEGACY_ICON_SIZES));
  });

  test('an APK carrying the generated icon passes', () => {
    const root = realIconProject('good');
    const r = verifyApkLauncherIconFromBuffer(apkWithIcon({ projectRoot: root }), expectations(root));
    assert.strictEqual(r.valid, true, r.errors.join('; '));
    assert.strictEqual(r.manifestIconResourceId, '0x7f010000');
    assert.strictEqual(r.manifestIconType, 'mipmap');
    assert.ok(r.similarity! <= 20);
    assert.strictEqual(r.byteIdentical, true, 'the compiled PNG should be the generated PNG');
    assert.deepStrictEqual(r.matchedDensities, Object.keys(LEGACY_ICON_SIZES));
    assert.ok(r.iconSignatureSha256);
    assert.strictEqual(r.adaptiveIconsPresent, true);
  });

  test('every expected icon path is actually checked', () => {
    const paths = expectedApkIconPaths();
    assert.strictEqual(
      paths.length,
      Object.keys(LEGACY_ICON_SIZES).length * 2 + Object.keys(FOREGROUND_ICON_SIZES).length
    );
    assert.ok(paths.some((p) => p.kind === 'round' && p.path.includes(ROUND_ICON_RESOURCE_NAME)),
      'the round icon densities must be verified, not assumed');
    assert.ok(paths.every((p) => p.path.startsWith('res/mipmap-')));
  });

  test('an APK whose icon pixels come from a different app is rejected', () => {
    const root = realIconProject('swapped');
    const apk = apkWithIcon({ projectRoot: root, swapIconFor: 'A recipe organiser for my kitchen' });
    const r = verifyApkLauncherIconFromBuffer(apk, expectations(root));
    assert.strictEqual(r.valid, false, 'a different picture must not pass');
    assert.ok(r.errors.some((e) => /different picture/.test(e)), r.errors.join('; '));
  });

  test('a missing density is reported by name', () => {
    const root = realIconProject('missing-density');
    const missing = `res/mipmap-xxhdpi/${ICON_RESOURCE_NAME}.png`;
    const r = verifyApkLauncherIconFromBuffer(apkWithIcon({ projectRoot: root, omit: [missing] }), expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /xxhdpi density/.test(e)), r.errors.join('; '));
    assert.ok(r.errors.some((e) => /mipmap\/ic_launcher/.test(e)), r.errors.join('; '));
  });

  test('a missing round density is reported by name', () => {
    const root = realIconProject('missing-round');
    const missing = `res/mipmap-xhdpi/${ROUND_ICON_RESOURCE_NAME}.png`;
    const r = verifyApkLauncherIconFromBuffer(apkWithIcon({ projectRoot: root, omit: [missing] }), expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /mipmap\/ic_launcher_round/.test(e) && /xhdpi density/.test(e)), r.errors.join('; '));
  });

  test('a round icon showing a different picture is rejected', () => {
    const root = realIconProject('round-swapped');
    const density = 'xhdpi';
    const px = LEGACY_ICON_SIZES[density as keyof typeof LEGACY_ICON_SIZES];
    const wrong = encodePng(px, px, renderIcon(decideIcon('A recipe organiser for my kitchen').definition, px, 'round'));
    const rel = `res/mipmap-${density}/${ROUND_ICON_RESOURCE_NAME}.png`;
    const r = verifyApkLauncherIconFromBuffer(
      apkWithIcon({ projectRoot: root, overridePng: { [rel]: wrong } }), expectations(root));
    assert.strictEqual(r.valid, false, 'the round icon must be checked against its own pixels');
    assert.ok(r.errors.some((e) => /ic_launcher_round\.png/.test(e) && /different picture/.test(e)), r.errors.join('; '));
  });

  test('a missing adaptive foreground layer is rejected', () => {
    const root = realIconProject('missing-fg');
    const r = verifyApkLauncherIconFromBuffer(
      apkWithIcon({ projectRoot: root, omit: [`res/mipmap-xhdpi/${FOREGROUND_RESOURCE_NAME}.png`] }),
      expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /ic_launcher_foreground/.test(e)), r.errors.join('; '));
  });

  test('a missing adaptive icon configuration is rejected', () => {
    const root = realIconProject('missing-adaptive');
    const r = verifyApkLauncherIconFromBuffer(
      apkWithIcon({ projectRoot: root, omit: [`res/mipmap-anydpi-v26/${ICON_RESOURCE_NAME}.xml`] }),
      expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /adaptive icon/i.test(e)), r.errors.join('; '));
  });

  test('a manifest with no android:icon is rejected', () => {
    const root = realIconProject('no-manifest-icon');
    const r = verifyApkLauncherIconFromBuffer(apkWithIcon({ projectRoot: root, iconId: null }), expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /no android:icon/.test(e)), r.errors.join('; '));
  });

  test('a literal icon string in the manifest is rejected', () => {
    const root = realIconProject('literal-icon');
    const r = verifyApkLauncherIconFromBuffer(apkWithIcon({ projectRoot: root, iconIsLiteral: true }), expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /literal value/.test(e)), r.errors.join('; '));
  });

  test('an icon pointing at the framework package is rejected', () => {
    const root = realIconProject('framework-icon');
    const r = verifyApkLauncherIconFromBuffer(
      apkWithIcon({ projectRoot: root, iconId: (0x01 << 24) | (1 << 16) | 0, roundIconId: null }),
      expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /framework package/.test(e)), r.errors.join('; '));
  });

  test('an icon pointing at a type the package does not declare is rejected', () => {
    const root = realIconProject('unknown-type');
    const r = verifyApkLauncherIconFromBuffer(
      apkWithIcon({ projectRoot: root, iconId: (PACKAGE_ID << 24) | (9 << 16) | 0, roundIconId: null }),
      expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /does not declare/.test(e)), r.errors.join('; '));
  });

  test('an icon entry index outside the declared type is rejected', () => {
    const root = realIconProject('out-of-range');
    const r = verifyApkLauncherIconFromBuffer(
      apkWithIcon({ projectRoot: root, iconId: (PACKAGE_ID << 24) | (TYPE_ID << 16) | 0x00ff, roundIconId: null }),
      expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /outside/.test(e)), r.errors.join('; '));
  });

  test('a table that declares no ic_launcher is rejected', () => {
    const root = realIconProject('no-key');
    const r = verifyApkLauncherIconFromBuffer(apkWithIcon({ projectRoot: root, keyNames: ['something_else'] }), expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /does not declare a resource named ic_launcher/.test(e)), r.errors.join('; '));
  });

  test('a table that does not reference the icon files is rejected', () => {
    const root = realIconProject('unreferenced');
    const paths = generatedIconPaths();
    // The PNGs are in the ZIP, but the compiled table points somewhere else, so
    // they are not part of the app's resources.
    const apk = (() => {
      const withTable = apkWithIcon({ projectRoot: root });
      return withTable;
    })();
    const stripped = (() => {
      const paths2 = generatedIconPaths();
      const entries: { name: string; data: Buffer }[] = [
        { name: 'AndroidManifest.xml', data: buildManifest({ packageName: 'com.builder.todo', iconId: (PACKAGE_ID << 24) | (TYPE_ID << 16) | ICON_ENTRY, roundIconId: (PACKAGE_ID << 24) | (TYPE_ID << 16) | ROUND_ENTRY }), store: true },
        { name: 'resources.arsc', data: buildArsc({ packageId: PACKAGE_ID, filePaths: ['res/values/strings.xml'], keyNames: [ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME, FOREGROUND_RESOURCE_NAME, ICON_BACKGROUND_COLOR_NAME] }) }
      ];
      for (const rel of [...paths2.legacy, ...paths2.foreground, ...paths2.adaptive]) {
        const m = rel.match(/mipmap-([a-z0-9-]+)\/(.+)$/)!;
        const local = join(root, 'app', 'src', 'main', 'res', `mipmap-${m[1]}`, m[2].replace('.xml', '.png'));
        if (m[2].endsWith('.xml')) entries.push({ name: rel, data: buildAdaptiveXml() });
        else entries.push({ name: rel, data: readFileSync(local) });
      }
      return zip(entries);
    })();
    assert.ok(apk.length > 0);
    const r = verifyApkLauncherIconFromBuffer(stripped, expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /does not reference/.test(e)), r.errors.join('; '));
  });

  test('an APK with no resources.arsc is rejected', () => {
    const root = realIconProject('no-arsc');
    const r = verifyApkLauncherIconFromBuffer(apkWithIcon({ projectRoot: root, withResources: false }), expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /resources\.arsc is missing/.test(e)), r.errors.join('; '));
  });

  test('an APK whose manifest is not readable is rejected', () => {
    const root = realIconProject('bad-manifest');
    const r = verifyApkLauncherIconFromBuffer(apkWithIcon({ projectRoot: root, withManifest: false }), expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.length > 0);
  });

  test('a flat placeholder icon in the APK is rejected', () => {
    const root = realIconProject('flat-apk');
    // Each density keeps its own size, so the failure is the flat artwork rather
    // than an unresolved density.
    const flatAt = (size: number): Buffer => {
      const rgba = Buffer.alloc(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        rgba[i * 4] = 10; rgba[i * 4 + 1] = 10; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 255;
      }
      return encodePng(size, size, rgba);
    };
    const paths = generatedIconPaths();
    const entries: { name: string; data: Buffer; store?: boolean }[] = [
      { name: 'AndroidManifest.xml', data: buildManifest({ packageName: 'com.builder.todo', iconId: (PACKAGE_ID << 24) | (TYPE_ID << 16) | ICON_ENTRY, roundIconId: (PACKAGE_ID << 24) | (TYPE_ID << 16) | ROUND_ENTRY }), store: true },
      { name: 'resources.arsc', data: buildArsc({
        packageId: PACKAGE_ID,
        filePaths: [...paths.legacy, ...paths.foreground, ...paths.adaptive],
        keyNames: [ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME, FOREGROUND_RESOURCE_NAME, ICON_BACKGROUND_COLOR_NAME],
        keyPaths: {
          [ICON_RESOURCE_NAME]: paths.legacy.filter((p) => p.endsWith(`/${ICON_RESOURCE_NAME}.png`))
            .concat(paths.adaptive.filter((p) => p.endsWith(`/${ICON_RESOURCE_NAME}.xml`))),
          [ROUND_ICON_RESOURCE_NAME]: paths.legacy.filter((p) => p.endsWith(`/${ROUND_ICON_RESOURCE_NAME}.png`))
            .concat(paths.adaptive.filter((p) => p.endsWith(`/${ROUND_ICON_RESOURCE_NAME}.xml`))),
          [FOREGROUND_RESOURCE_NAME]: paths.foreground,
          [ICON_BACKGROUND_COLOR_NAME]: []
        }
      }) }
    ];
    for (const rel of paths.legacy) {
      const d = rel.split('/')[1].replace('mipmap-', '') as keyof typeof LEGACY_ICON_SIZES;
      entries.push({ name: rel, data: flatAt(LEGACY_ICON_SIZES[d]) });
    }
    for (const rel of paths.foreground) {
      const d = rel.split('/')[1].replace('mipmap-', '');
      entries.push({ name: rel, data: readFileSync(join(root, 'app', 'src', 'main', 'res', `mipmap-${d}`, `${FOREGROUND_RESOURCE_NAME}.png`)) });
    }
    for (const rel of paths.adaptive) entries.push({ name: rel, data: buildAdaptiveXml() });
    const r = verifyApkLauncherIconFromBuffer(zip(entries), expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /placeholder|different picture/.test(e)), r.errors.join('; '));
  });

  test('a truncated compiled PNG is rejected', () => {
    const root = realIconProject('corrupt-apk');
    const rel = `res/mipmap-hdpi/${ICON_RESOURCE_NAME}.png`;
    const original = readFileSync(join(root, 'app', 'src', 'main', 'res', 'mipmap-hdpi', `${ICON_RESOURCE_NAME}.png`));
    const r = verifyApkLauncherIconFromBuffer(
      apkWithIcon({ projectRoot: root, overridePng: { [rel]: original.subarray(0, original.length - 40) } }),
      expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /ic_launcher\.png/.test(e) && /not a valid PNG/.test(e)), r.errors.join('; '));
  });

  test('something that is not a ZIP is rejected', () => {
    const root = realIconProject('not-zip');
    const r = verifyApkLauncherIconFromBuffer(Buffer.from('this is not an apk'), expectations(root));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors[0].includes('ZIP'));
  });

  test('an APK built from a different idea fails against this idea\'s icon', () => {
    const todo = realIconProject('idea-todo', 'A todo list app');
    const recipe = realIconProject('idea-recipe', 'A recipe organiser for my kitchen');
    const apk = apkWithIcon({ projectRoot: recipe });
    const r = verifyApkLauncherIconFromBuffer(apk, expectations(todo));
    assert.strictEqual(r.valid, false, 'an APK must not satisfy another idea\'s icon expectation');
    assert.ok(r.errors.some((e) => /different picture/.test(e)), r.errors.join('; '));
  });
});