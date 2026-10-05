import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { readZipEntries, entryDataOffset, inflateRaw } from './apkValidator.ts';
import { decodePng, readPngInfo } from './png.ts';
import { iconSignature, iconStatistics, signatureDistance } from './iconRaster.ts';
import { LEGACY_ICON_SIZES, FOREGROUND_ICON_SIZES } from '../iconCatalog.ts';
import {
  ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME, FOREGROUND_RESOURCE_NAME,
  ICON_BACKGROUND_COLOR_NAME
} from './launcherIcon.ts';

/**
 * Proves that a compiled APK really carries the launcher icon the project
 * generated.
 *
 * Checking that an icon file exists in the source tree proves nothing about the
 * artifact: AAPT2 rewrites the manifest into a binary form where the icon is a
 * resource *id*, and it rewrites the resource table that decides which file that
 * id resolves to. So this checks the artifact end to end:
 *
 *   1. the compiled binary manifest declares `android:icon` as a resource
 *      reference, and it is a reference into the app's own package;
 *   2. the resource table of that same package declares the `mipmap` type, lists
 *      the generated icon entry names as resource keys, and points at the exact
 *      `res/...` paths of the generated icon files - so the icons are part of the
 *      compiled resource set, not stray files in the archive;
 *   3. every density of the legacy icon, round icon and adaptive foreground is
 *      present in the APK as a structurally valid, correctly sized PNG that is
 *      neither a flat placeholder nor a different picture;
 *   4. the adaptive icon configuration is present and wires up the generated
 *      background colour and foreground layer.
 *
 * Pixel comparison is against the generated source PNGs, so an APK that ships a
 * leftover icon from another app fails here even though a PNG exists in the ZIP.
 *
 * Note on scope: the exact entry index a resource id binds to is resolved
 * authoritatively by `aapt2` during the cloud build (see the icon verification
 * step in the Android workflow), which cross-checks this module's findings. This
 * module deliberately does not guess at `resources.arsc`'s dense/sparse entry
 * packing, because a wrong guess would produce confident but false evidence -
 * exactly the failure this project exists to prevent.
 */

const AXML_TYPE_STRING_POOL = 0x0001;
const AXML_TYPE_START_ELEMENT = 0x0102;
const AXML_TYPE_END_ELEMENT = 0x0103;
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

/** Attribute value type for a resource reference. */
const RES_TYPE_REFERENCE = 0x01;

const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

const ANDROID_PACKAGE_ID = 0x01;

/** Mean per-channel signature distance below which two renderings are the same picture. */
const MATCH_THRESHOLD = 20;

export interface AxmlStringPool {
  strings: string[];
  size: number;
}

export function readStringPool(buf: Buffer, start: number): AxmlStringPool | null {
  if (start + 28 > buf.length) return null;
  const chunkSize = buf.readUInt32LE(start + 4);
  const stringCount = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const isUtf8 = (flags & 0x00000100) !== 0;
  if (stringCount > 0x100000) return null;
  const strings: string[] = [];
  for (let i = 0; i < stringCount; i++) {
    const offEntry = start + 28 + i * 4;
    if (offEntry + 4 > buf.length) return null;
    let p = start + stringsStart + buf.readUInt32LE(offEntry);
    if (p < 0 || p >= buf.length) return null;
    if (isUtf8) {
      let n = buf[p++];
      if (n & 0x80) p++;
      let byteLen = buf[p++];
      if (byteLen & 0x80) byteLen = ((byteLen & 0x7f) << 8) | buf[p++];
      if (p + byteLen > buf.length) return null;
      strings.push(buf.subarray(p, p + byteLen).toString('utf8'));
    } else {
      if (p + 2 > buf.length) return null;
      const units = buf.readUInt16LE(p);
      p += 2;
      if (p + units * 2 > buf.length) return null;
      strings.push(buf.subarray(p, p + units * 2).toString('utf16le'));
    }
  }
  return { strings, size: chunkSize };
}

export interface ApplicationIconIds {
  iconId?: number;
  roundIconId?: number;
  /** True when `android:icon` existed but was not a resource reference. */
  iconIsReference?: boolean;
}

/**
 * Reads `android:icon` / `android:roundIcon` off the `<application>` element of a
 * compiled manifest and returns them as resource ids.
 *
 * Only the android namespace counts: an unprefixed `icon` attribute belongs to
 * some other schema and must not be mistaken for the launcher icon.
 */
export function extractApplicationIconIds(axml: Buffer): ApplicationIconIds | null {
  if (axml.length < 8) return null;
  let pool: string[] | null = null;
  let off = 8;
  while (off + 8 <= axml.length) {
    const type = axml.readUInt16LE(off);
    const size = axml.readUInt32LE(off + 4);
    if (size < 8 || off + size > axml.length) return null;

    if (type === AXML_TYPE_STRING_POOL) {
      const parsed = readStringPool(axml, off);
      if (!parsed) return null;
      pool = parsed.strings;
    } else if (type === AXML_TYPE_START_ELEMENT && pool) {
      // ResXMLTree_node is 16 bytes; ResXMLTree_attrExt follows, and
      // `attributeStart` is measured from the start of that structure.
      const attrExt = off + 16;
      if (attrExt + 20 > axml.length) return null;
      const attributeStart = axml.readUInt16LE(attrExt + 8);
      const attributeSize = axml.readUInt16LE(attrExt + 10);
      const attributeCount = axml.readUInt16LE(attrExt + 12);
      if (attributeSize < 20) return null;

      const elementNameIdx = axml.readInt32LE(attrExt + 4);
      if (pool[elementNameIdx] === 'application') {
        const out: ApplicationIconIds = {};
        for (let i = 0; i < attributeCount; i++) {
          // ResXMLTree_attribute: ns +0, name +4, rawValue +8,
          // Res_value { size +12, res0 +14, dataType +15, data +16 }.
          const a = attrExt + attributeStart + i * attributeSize;
          if (a + 20 > axml.length) return null;
          const ns = axml.readInt32LE(a);
          const nameIdx = axml.readInt32LE(a + 4);
          const dataType = axml[a + 15];
          const data = axml.readUInt32LE(a + 16);
          if (ns >= 0 && ns < pool.length && pool[ns] !== ANDROID_NS) continue;
          const name = pool[nameIdx];
          if (name === 'icon') {
            out.iconIsReference = dataType === RES_TYPE_REFERENCE;
            if (dataType === RES_TYPE_REFERENCE) out.iconId = data;
          } else if (name === 'roundIcon' && dataType === RES_TYPE_REFERENCE) {
            out.roundIconId = data;
          }
        }
        return out;
      }
    } else if (type === AXML_TYPE_END_ELEMENT && pool) {
      const attrExt = off + 16;
      if (attrExt + 8 <= axml.length && pool[axml.readInt32LE(attrExt + 4)] === 'application') return {};
    }
    off += size;
  }
  return null;
}

export interface ArscSummary {
  packageId: number;
  /** Type names in declaration order, paired with `typeIds`. */
  typeNames: string[];
  /** Type ids in declaration order, e.g. [4, 8] for colour then mipmap. */
  typeIds: number[];
  /** Resource key names declared by the package. */
  keyNames: string[];
  /** Every `res/...` path the resource table points at. */
  filePaths: Set<string>;
  /** Entry counts per type id, as declared by the type-spec chunks. */
  typeEntryCounts: Map<number, number>;
  /** Where the package's pools were found, for diagnosing an unread table. */
  poolDetail: string;
}

/**
 * Summarises `resources.arsc`: the package, its type and key name pools, the
 * resource files it references and the declared size of each type.
 *
 * Only chunk headers, string pools and type-spec counts are interpreted; entry
 * packing is left alone on purpose (see the module comment).
 */
export function summariseResourceTable(arsc: Buffer): ArscSummary | null {
  if (arsc.length < 12 || arsc.readUInt16LE(0) !== RES_TABLE_TYPE) return null;
  const tableSize = arsc.readUInt32LE(4);
  if (tableSize > arsc.length) return null;

  let globalStrings: string[] = [];
  let off = 12;
  while (off + 8 <= tableSize) {
    const type = arsc.readUInt16LE(off);
    const size = arsc.readUInt32LE(off + 4);
    if (size < 8 || off + size > arsc.length) return null;
    if (type === AXML_TYPE_STRING_POOL) {
      const pool = readStringPool(arsc, off);
      if (!pool) return null;
      globalStrings = pool.strings;
      off += size;
      continue;
    }
    if (type !== RES_TABLE_PACKAGE_TYPE) {
      off += size;
      continue;
    }

    const packageId = arsc.readUInt32LE(off + 8);
    // ResTable_package fields are inside the chunk: id @+8, name @+12 (256
    // bytes), typeStrings @+268, lastPublicType @+272, keyStrings @+276.
    const packageEnd = Math.min(off + size, tableSize);

    const { typeNames, typeIds, keyNames, detail } = readPackagePools(arsc, off, arsc.readUInt16LE(off + 2), packageEnd);

    const typeEntryCounts = new Map<number, number>();
    let inner = off + arsc.readUInt16LE(off + 2);
    while (inner + 8 <= packageEnd) {
      const innerType = arsc.readUInt16LE(inner);
      const innerSize = arsc.readUInt32LE(inner + 4);
      if (innerSize < 8 || inner + innerSize > arsc.length) break;
      if (innerType === RES_TABLE_TYPE_SPEC_TYPE || innerType === RES_TABLE_TYPE_TYPE) {
        const typeId = arsc[inner + 8];
        const entryCount = arsc.readUInt32LE(inner + 12);
        if (typeId > 0 && entryCount > 0 && entryCount < 0x10000) {
          typeEntryCounts.set(typeId, Math.max(typeEntryCounts.get(typeId) ?? 0, entryCount));
        }
      }
      inner += innerSize;
    }

    return {
      packageId,
      typeNames,
      typeIds,
      keyNames,
      poolDetail: detail,
      filePaths: new Set(globalStrings.filter((s) => s.startsWith('res/'))),
      typeEntryCounts
    };
  }
  return null;
}

/**
 * Elements and typed attribute values of a compiled binary XML. A compiled
 * resource holds references as numeric ids, so the names the generator wrote
 * are not in the string pool and have to be resolved through the resource table.
 */
export function extractXmlReferences(axml: Buffer): { elements: string[]; refs: { name: string; dataType: number; data: number }[] } {
  const out = { elements: [] as string[], refs: [] as { name: string; dataType: number; data: number }[] };
  if (axml.length < 8) return out;
  let pool: string[] | null = null;
  let off = 8;
  while (off + 8 <= axml.length) {
    const type = axml.readUInt16LE(off);
    const size = axml.readUInt32LE(off + 4);
    if (size < 8 || off + size > axml.length) return out;
    if (type === AXML_TYPE_STRING_POOL) {
      pool = readStringPool(axml, off)?.strings ?? null;
    } else if (type === AXML_TYPE_START_ELEMENT && pool) {
      const attrExt = off + 16;
      if (attrExt + 20 > axml.length) return out;
      const element = pool[axml.readInt32LE(attrExt + 4)];
      if (element) out.elements.push(element);
      const attributeStart = axml.readUInt16LE(attrExt + 8);
      const attributeSize = axml.readUInt16LE(attrExt + 10);
      const attributeCount = axml.readUInt16LE(attrExt + 12);
      if (attributeSize < 20) return out;
      for (let i = 0; i < attributeCount; i++) {
        const a = attrExt + attributeStart + i * attributeSize;
        if (a + 20 > axml.length) return out;
        out.refs.push({
          name: pool[axml.readInt32LE(a + 4)] ?? '',
          dataType: axml[a + 15],
          data: axml.readUInt32LE(a + 16)
        });
      }
    }
    off += size;
  }
  return out;
}

/**
 * Maps a compiled resource id to its `type/key` name, so references stored as
 * numbers in a compiled XML can be checked against the names the generator
 * wrote. Absent entries are included, because the point is to resolve any id.
 */
export function indexResourceIds(arsc: Buffer): Map<number, string> {
  const ids = new Map<number, string>();
  indexResourceFiles(arsc, undefined, ids);
  return ids;
}

/**
 * The type names pool and, per type id, that type's key pool.
 *
 * A package stores one key string pool per type while its header names only the
 * first, and the pools follow the type chunks in the order the types appear.
 * AAPT2 numbers types by the order it meets resources, so those ids are rarely
 * 1..n and the pools have to be paired against the ids actually present.
 */
function readPackagePools(
  arsc: Buffer,
  off: number,
  headerSize: number,
  packageEnd: number
): { typeNames: string[]; typeIds: number[]; keyNames: string[]; detail: string } {
  const typeIdsInOrder: number[] = [];
  for (let scan = off + headerSize; scan + 8 <= packageEnd;) {
    const chunkType = arsc.readUInt16LE(scan);
    const chunkSize = arsc.readUInt32LE(scan + 4);
    if (chunkSize < 8 || scan + chunkSize > arsc.length) break;
    if (chunkType === RES_TABLE_TYPE_TYPE) {
      const id = arsc[scan + 8];
      if (!typeIdsInOrder.includes(id)) typeIdsInOrder.push(id);
    }
    scan += chunkSize;
  }

  const typeNames: string[] = [];
  const keyNames: string[] = [];
  const detail: string[] = [];
  // ResTable_package: id @0, name @4 (256 bytes), typeStrings @260,
  // lastPublicType @264, keyStrings @268, lastPublicKey @272.
  //
  // The header names the type names pool and the first key pool, and the other
  // key pools sit next to that one. Their position relative to the type chunks is
  // not something to rely on, so every string pool in the package is collected
  // and matched by identity: the pool the header calls the type names, and the
  // rest taken against the type ids in declaration order.
  // A zero typeStrings offset means the type names pool is the first chunk after
  // the header rather than "no pool", which is how aapt2 writes a package whose
  // only pools sit at the front.
  // These fields sit inside the chunk, after the 12-byte chunk header: id@+8,
  // name@+12 (256 bytes), typeStrings@+268, lastPublicType@+272, keyStrings@+276.
  const typeStringsOffset = arsc.readUInt32LE(off + 268);
  const namedPool = off + (typeStringsOffset > 0 ? typeStringsOffset : headerSize);
  const keyStringsOffset = arsc.readUInt32LE(off + 276);
  const firstKeyPool = keyStringsOffset > 0 ? off + keyStringsOffset : namedPool + 4;
  const pools: { at: number; strings: string[] }[] = [];
  const seen = new Set<number>();
  const takePool = (at: number): boolean => {
    if (at <= 0 || at + 8 > packageEnd || seen.has(at)) return false;
    seen.add(at);
    if (arsc.readUInt16LE(at) !== AXML_TYPE_STRING_POOL) return false;
    const parsed = readStringPool(arsc, at);
    detail.push(`pool@${at}(${arsc.readUInt16LE(at)} size=${arsc.readUInt32LE(at + 4)}) ${parsed ? `${parsed.strings.length} strings, first=${parsed.strings[0]}` : 'unreadable'}`);
    if (!parsed) return false;
    pools.push({ at, strings: parsed.strings });
    return true;
  };
  takePool(namedPool);
  takePool(firstKeyPool);
  // Any pool the header did not name is found by walking the package. Offsets
  // are aligned relative to the package start, so the step has to be too.
  for (let scan = off + headerSize; scan + 8 <= packageEnd;) {
    const chunkType = arsc.readUInt16LE(scan);
    const chunkSize = arsc.readUInt32LE(scan + 4);
    if (chunkSize < 8 || scan + chunkSize > arsc.length) break;
    if (chunkType === AXML_TYPE_STRING_POOL) takePool(scan);
    scan = off + ((scan - off + chunkSize + 3) & ~3);
  }
  const order = pools.slice().sort((a, b) => a.at - b.at);
  // The key pools are the ones from the header's key offset onwards; anything
  // before them is the type names pool.
  const typePool = order.find((p) => p.at === namedPool) ?? order.find((p) => p.at < firstKeyPool);
  if (typePool) typeNames.push(...typePool.strings);
  // Key indices are package-wide, not per type: each type's entries continue
  // where the previous type's stopped, so the pools form one index space. A
  // package with a single key pool is the common case and needs no special
  // handling; concatenating in file order is what keeps the space continuous
  // when a table splits it across several pools.
  for (const pool of order) {
    if (pool === typePool) continue;
    keyNames.push(...pool.strings);
  }
  detail.push(`typeStrings=${typeStringsOffset} keyStrings=${keyStringsOffset} typeIds=${typeIdsInOrder.join(',')}`);
  const inventory: string[] = [];
  for (let at = off + headerSize; at + 8 <= packageEnd;) {
    const chunkType = arsc.readUInt16LE(at);
    const chunkSize = arsc.readUInt32LE(at + 4);
    if (chunkSize < 8 || at + chunkSize > packageEnd) {
      inventory.push(`+${at - off}:0x${chunkType.toString(16)}/${chunkSize}(unreadable)`);
      break;
    }
    inventory.push(`+${at - off}:0x${chunkType.toString(16)}/${chunkSize}`);
    at = off + ((at - off + chunkSize + 3) & ~3);
  }
  detail.push(`chunks=${inventory.join(' ')}`);
  detail.push(`idOffset=${arsc.readUInt32LE(off + 284)} types=${typeNames.join('|')} keys=${keyNames.length}`);
  return { typeNames, typeIds: typeIdsInOrder, keyNames, detail: detail.join('; ') };
}

/**
 * Maps `type/key` to the `res/...` files the compiled table points at.
 *
 * Reading this out of `resources.arsc` rather than recomputing a path from the
 * density matters because AAPT2 rewrites resource directories as it compiles,
 * appending a version qualifier the generator never wrote (`mipmap-mdpi-v4`).
 * A path assembled from the density alone names a file the APK never had, and
 * reading the wrong one either rejects a correct APK or, worse, checks a
 * different file than the launcher would draw.
 *
 * Handles both entry shapes: a simple entry holding one value, and a map entry
 * holding one value per configuration, which is what a real APK uses for a
 * resource that exists at several densities.
 */
const ICON_TRACE_TYPES = new Set(['mipmap', 'drawable', 'color', 'colour']);

export function indexResourceFiles(
  arsc: Buffer,
  trace?: string[],
  ids?: Map<number, string>
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (arsc.length < 12 || arsc.readUInt16LE(0) !== RES_TABLE_TYPE) return out;
  const tableSize = Math.min(arsc.readUInt32LE(4), arsc.length);

  let globalStrings: string[] = [];
  let off = 12;
  while (off + 8 <= tableSize) {
    const type = arsc.readUInt16LE(off);
    const size = arsc.readUInt32LE(off + 4);
    if (size < 8 || off + size > arsc.length) break;
    if (type === AXML_TYPE_STRING_POOL) {
      const pool = readStringPool(arsc, off);
      if (!pool) break;
      globalStrings = pool.strings;
      off += size;
      continue;
    }
    if (type !== RES_TABLE_PACKAGE_TYPE) {
      off += size;
      continue;
    }

    const packageSize = arsc.readUInt32LE(off + 4);
    const packageEnd = Math.min(off + packageSize, tableSize);
    const headerSize = arsc.readUInt16LE(off + 2);

    const { typeNames, typeIds, keyNames } = readPackagePools(arsc, off, headerSize, packageEnd);

    const add = (typeName: string, keyName: string | undefined, value: string | undefined): void => {
      if (!keyName || typeof value !== 'string' || !value.startsWith('res/')) return;
      const k = `${typeName}/${keyName}`;
      const list = out.get(k) ?? [];
      if (!list.includes(value)) list.push(value);
      out.set(k, list);
    };

    let inner = off + arsc.readUInt16LE(off + 2);
    while (inner + 8 <= packageEnd) {
      const innerType = arsc.readUInt16LE(inner);
      const innerSize = arsc.readUInt32LE(inner + 4);
      if (innerSize < 8 || inner + innerSize > arsc.length) break;
      if (innerType === RES_TABLE_TYPE_TYPE) {
        const typeId = arsc[inner + 8];
        const typeName = typeNames[typeIds.indexOf(typeId)] ?? String(typeId);

        const entryCount = arsc.readUInt32LE(inner + 12);
        const entriesStart = arsc.readUInt32LE(inner + 16);
        let p = inner + entriesStart;
        // Ids from a chunk are only trusted when the walk ends exactly on the
        // chunk's last byte. A chunk holding a value this reader cannot step over
        // desynchronises, and without this check its garbled keys overwrite the
        // real ones in the id table.
        const chunkIds = new Map<number, string>();
        let clean = true;
        for (let i = 0; i < entryCount && p + 16 <= arsc.length && p + 8 <= packageEnd; i++) {
          const entrySize = arsc.readUInt16LE(p);
          // Only the types the icon is built from, so the trace stays readable
          // and the budget is not spent on the framework's own resources.
          if (trace && trace.length < 400 && ICON_TRACE_TYPES.has(typeName)) {
            trace.push(`${typeName} entry ${i} at ${p}: size=${entrySize} flags=0x${arsc.readUInt16LE(p + 2).toString(16)} ` +
              `key=${keyNames[arsc.readUInt32LE(p + 4)] ?? arsc.readUInt32LE(p + 4)}`);
          }
          const flags = arsc.readUInt16LE(p + 2);
          const keyIndex = arsc.readUInt32LE(p + 4);
          const keyName = keyNames[keyIndex];
          // A resource id is the package, the type and the entry's own position in
          // the chunk. The key index is only the entry's name, so it can drift from
          // the id whenever a key is absent from a configuration: aapt2 still
          // spends an entry index on that gap, and keying ids by key index instead
          // hands out ids the manifest and the compiled XML never reference.
          if (keyName === undefined) clean = false;
          if (keyName && entrySize !== 0) {
            chunkIds.set((arsc.readUInt32LE(off + 8) << 24) | (typeId << 16) | i, `${typeName}/${keyName}`);
          }
          // A configuration that does not carry an entry records size 0. Step over
          // the fixed header and keep going: stopping here drops every later entry,
          // which is how the round icon's densities went missing from its key.
          if (entrySize === 0) { p += 8; continue; }
          if (entrySize < 8) { clean = false; break; }
          // A simple entry's `size` covers only its own 8-byte header; the
          // Res_value that follows is counted separately, so the bytes actually
          // occupied are 8 + that value's size. A map entry's `size` already
          // covers the whole list. Getting this wrong desynchronises the walk and
          // silently attributes later densities to the wrong resource key.
          const total = (flags & 0x0001)
            ? entrySize
            : entrySize === 8
              ? 8 + arsc.readUInt16LE(p + 8)
              : entrySize;
          if (flags & 0x0001) {
            // ResTable_map_list is ResTable_entry { size, flags, key } followed by
            // { parent, count }, so the values start at a fixed 16 bytes in, not at
            // `entrySize`, which is where the whole entry ends.
            const count = arsc.readUInt32LE(p + 12);
            const listEnd = Math.min(p + total, arsc.length);
            let q = p + 16;
            for (let m = 0; m < count && q + 12 <= listEnd; m++) {
              // ResTable_map: ResTable_ref { name } then Res_value { size, res0, dataType, data }.
              if (arsc[q + 7] === 0x03) add(typeName, keyName, globalStrings[arsc.readUInt32LE(q + 8)]);
              q += 12;
            }
          } else if (arsc[p + 11] === 0x03) {
            add(typeName, keyName, globalStrings[arsc.readUInt32LE(p + 12)]);
          }
          p += total;
        }
        // A short walk, or one that ran past the chunk, means the step above did
        // not match this chunk's layout, so its ids are not trustworthy.
        if (p !== inner + innerSize) clean = false;
        if (ids && clean) for (const [id, name] of chunkIds) ids.set(id, name);
      }
      inner += innerSize;
    }
    return out;
  }
  return out;
}

export interface ApkIconExpectation {
  /** Expected pixel signature per pixel size, from the generated legacy icon. */
  signatures: Map<number, Buffer>;
  /** Expected pixel signature per pixel size, from the generated round icon. */
  roundSignatures?: Map<number, Buffer>;
  /** Expected pixel signature per pixel size, from the adaptive foreground. */
  foregroundSignatures?: Map<number, Buffer>;
  /** Exact source PNG bytes per pixel size, for an informational identity check. */
  sourcePngBytes?: Map<number, Buffer>;
  /** Fingerprint of the source icon resource set, recorded as evidence. */
  fingerprint?: string;
  /** Resource names the compiled table is expected to declare. */
  expectedNames?: string[];
}

export interface ApkIconVerification {
  valid: boolean;
  errors: string[];
  manifestIconResourceId?: string;
  manifestRoundIconResourceId?: string;
  manifestIconType?: string;
  /** Compiled `res/...` icon paths that were checked. */
  resolvedPaths: string[];
  /** Legacy icon entry used for the pixel comparison. */
  matchedPath?: string;
  matchedSize?: number;
  /** Mean per-channel signature distance; 0 means identical. */
  similarity?: number;
  byteIdentical?: boolean;
  iconSignatureSha256?: string;
  adaptiveIconsPresent?: boolean;
  /** Densities whose compiled icon matched the generated pixels. */
  matchedDensities: string[];
}

interface DensityCheck {
  density: string;
  path: string;
  size: number;
  kind: 'legacy' | 'round' | 'foreground';
}

/**
 * Every compiled icon resource the APK must contain, as `res/...` paths.
 * These are exactly the resources the generator writes, so a build that dropped,
 * renamed or mis-sized one is caught instead of quietly shipping a default icon.
 */
export function expectedApkIconPaths(): DensityCheck[] {
  const out: DensityCheck[] = [];
  for (const [density, size] of Object.entries(LEGACY_ICON_SIZES)) {
    out.push({ density, path: `res/mipmap-${density}/ic_launcher.png`, size, kind: 'legacy' });
  }
  for (const [density, size] of Object.entries(LEGACY_ICON_SIZES)) {
    out.push({ density, path: `res/mipmap-${density}/ic_launcher_round.png`, size, kind: 'round' });
  }
  for (const [density, size] of Object.entries(FOREGROUND_ICON_SIZES)) {
    out.push({ density, path: `res/mipmap-${density}/ic_launcher_foreground.png`, size, kind: 'foreground' });
  }
  return out;
}

const ADAPTIVE_RESOURCE_NAMES = [ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME];
const MIN_CONTRAST = 0.06;
const MIN_COLOURS = 6;

export function verifyApkLauncherIconFromBuffer(
  apk: Buffer,
  expected: ApkIconExpectation
): ApkIconVerification {
  const errors: string[] = [];
  const resolvedPaths: string[] = [];
  const matchedDensities: string[] = [];
  const result: ApkIconVerification = { valid: false, errors, resolvedPaths, matchedDensities };

  const entries = readZipEntries(apk);
  if (!entries) {
    errors.push('APK is not a readable ZIP, cannot inspect its resources');
    return result;
  }
  const byName = new Map(entries.map((e) => [e.name, e]));

  const readEntry = (name: string): Buffer | null => {
    const e = byName.get(name);
    if (!e) return null;
    const off = entryDataOffset(apk, e);
    if (off === null) return null;
    return e.compressionMethod === 0
      ? apk.subarray(off, off + e.uncompressedSize)
      : inflateRaw(apk, off, e.compressedSize);
  };

  // 1. The compiled manifest must reference the icon as a resource id.
  const manifestBytes = readEntry('AndroidManifest.xml');
  if (!manifestBytes) {
    errors.push('AndroidManifest.xml could not be read from the APK');
    return result;
  }
  const ids = extractApplicationIconIds(manifestBytes);
  if (!ids) {
    errors.push('Binary manifest could not be parsed for an <application> element');
    return result;
  }
  if (ids.iconId === undefined) {
    errors.push(
      ids.iconIsReference === false
        ? 'The compiled manifest declares android:icon with a literal value, not a resource reference'
        : 'The compiled manifest declares no android:icon, so the APK has no launcher icon'
    );
    return result;
  }
  result.manifestIconResourceId = `0x${(ids.iconId >>> 0).toString(16)}`;
  if (ids.roundIconId !== undefined) {
    result.manifestRoundIconResourceId = `0x${(ids.roundIconId >>> 0).toString(16)}`;
    if ((ids.roundIconId >>> 24) !== (ids.iconId >>> 24)) {
      errors.push('Manifest icon and roundIcon point into different resource packages');
    }
  }

  const iconPackageId = (ids.iconId >>> 24) & 0xff;
  const iconTypeId = (ids.iconId >>> 16) & 0xff;
  const iconEntryIndex = ids.iconId & 0xffff;
  if (iconPackageId === ANDROID_PACKAGE_ID) {
    errors.push('Manifest icon points at the android framework package instead of the app');
    return result;
  }
  if (iconEntryIndex === 0xffffffff) {
    errors.push('Manifest icon reference is the NO_ENTRY sentinel');
    return result;
  }

  // 2. The compiled resource table must be the app's, and must declare the icon.
  const arsc = readEntry('resources.arsc');
  if (!arsc) {
    errors.push('resources.arsc is missing, so the icon reference cannot be resolved');
    return result;
  }
  const table = summariseResourceTable(arsc);
  if (!table) {
    errors.push('resources.arsc could not be parsed, so the icon reference cannot be resolved');
    return result;
  }
  if ((table.packageId & 0xff) !== iconPackageId) {
    errors.push(
      `Manifest icon references package 0x${iconPackageId.toString(16)} but the only compiled ` +
      `resource package is 0x${(table.packageId & 0xff).toString(16)}`
    );
    return result;
  }

  // Type ids are assigned by the order AAPT2 meets resources, so they are not
  // 1-based positions in the type names.
  const iconTypeName = table.typeNames[table.typeIds.indexOf(iconTypeId)];
  result.manifestIconType = iconTypeName;
  if (!iconTypeName) {
    errors.push(
      `Manifest icon references resource type id ${iconTypeId}, which the package does not declare ` +
      `(declared types: ${table.typeIds.map((id, i) => `${id}=${table.typeNames[i]}`).join(', ') || 'none'}; ${table.poolDetail})`
    );
    return result;
  }
  const declaredCount = table.typeEntryCounts.get(iconTypeId);
  if (declaredCount !== undefined && iconEntryIndex >= declaredCount) {
    errors.push(
      `Manifest icon entry index ${iconEntryIndex} is outside ${iconTypeName}, which declares ` +
      `${declaredCount} entries`
    );
  }

  const expectedNames = expected.expectedNames ?? ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground', 'ic_launcher_background'];
  for (const name of expectedNames) {
    if (!table.keyNames.includes(name)) {
      errors.push(`The compiled resource table does not declare a resource named ${name}`);
    }
  }

  // Resolve each icon key to the files the compiled table actually points at,
  // then locate each expected density by the size of the compiled PNG. Keying on
  // pixel size rather than on a reconstructed path is what makes this survive
  // AAPT2's compile-time rewrite of resource directories.
  const trace: string[] = [];
  const resourceIds = new Map<number, string>();
  const filesByKey = indexResourceFiles(arsc, trace, resourceIds);
  // Every exit that reports a failure carries the walk, so the next question is
  // always answerable from the log instead of a guess.
  const withWalkTrace = (): ApkIconVerification => {
    if (trace.length > 0) errors.push(`Compiled resource table walk:\n${trace.slice(0, 120).join('\n')}`);
    return result;
  };
  const keyFor = {
    legacy: `${iconTypeName}/${ICON_RESOURCE_NAME}`,
    round: `${iconTypeName}/${ROUND_ICON_RESOURCE_NAME}`,
    foreground: `${iconTypeName}/${FOREGROUND_RESOURCE_NAME}`
  };
  const xmlsFor = (key: string): string | undefined =>
    (filesByKey.get(key) ?? []).find((p) => p.toLowerCase().endsWith('.xml'));
  const pngsFor = (kind: DensityCheck['kind']): { path: string; size: number }[] => {
    const out: { path: string; size: number }[] = [];
    for (const path of filesByKey.get(keyFor[kind]) ?? []) {
      if (!path.toLowerCase().endsWith('.png')) continue;
      const bytes = readEntry(path);
      if (!bytes) continue;
      const info = readPngInfo(bytes);
      if (info) out.push({ path, size: info.width });
    }
    return out;
  };

  const required = expectedApkIconPaths().map((check) => {
    const candidates = pngsFor(check.kind).filter((c) => c.size === check.size);
    return { ...check, resolved: candidates[0]?.path };
  });
  for (const check of required) {
    if (!check.resolved) {
      const have = (filesByKey.get(keyFor[check.kind]) ?? []).join(', ') || 'no files';
      errors.push(
        `The compiled resource table has no ${check.size}x${check.size} ${check.kind} PNG for ` +
        `${keyFor[check.kind]} at the ${check.density} density (it maps ${have})`
      );
    }
  }

  // Resolved the same way as the densities: the adaptive XML is whichever file
  // the icon and round keys actually point at, not a rebuilt `anydpi-v26` path.
  const adaptivePaths = ADAPTIVE_RESOURCE_NAMES.map((name) => xmlsFor(`${iconTypeName}/${name}`));
  for (let i = 0; i < adaptivePaths.length; i++) {
    if (!adaptivePaths[i]) {
      errors.push(
        `The compiled resource table does not reference an adaptive icon XML for ` +
        `${iconTypeName}/${ADAPTIVE_RESOURCE_NAMES[i]} (it maps ` +
        `${(filesByKey.get(`${iconTypeName}/${ADAPTIVE_RESOURCE_NAMES[i]}`) ?? []).join(', ') || 'no files'})`
      );
    }
  }
  if (errors.length > 0) return withWalkTrace();

  // 3. Every density must be present, correctly sized, and not a placeholder.
  for (const check of required) {
    const resolved = check.resolved as string;
    const bytes = readEntry(resolved);
    if (!bytes) {
      errors.push(`Compiled icon ${resolved} is missing from the APK`);
      continue;
    }
    const info = readPngInfo(bytes);
    if (!info || !info.structurallyValid) {
      errors.push(`Compiled icon ${resolved} is not a valid PNG: ${info ? info.errors.join('; ') : 'unreadable'}`);
      continue;
    }
    if (info.width !== check.size || info.height !== check.size) {
      errors.push(`Compiled icon ${resolved} is ${info.width}x${info.height}, expected ${check.size}x${check.size}`);
      continue;
    }
    const img = decodePng(bytes);
    if (!img) {
      errors.push(`Compiled icon ${resolved} could not be decoded`);
      continue;
    }
    const isForeground = check.kind === 'foreground';
    const st = iconStatistics(img.rgba, img.width, img.height);
    if (isForeground) {
      if (st.opaqueFraction < 0.005 || st.opaqueFraction > 0.85) {
        errors.push(`Compiled adaptive foreground ${resolved} is not a glyph layer (${(st.opaqueFraction * 100).toFixed(1)}% drawn)`);
        continue;
      }
    } else {
      if (st.opaqueFraction < 0.5) {
        errors.push(`Compiled icon ${resolved} is mostly transparent (${(st.opaqueFraction * 100).toFixed(1)}% opaque)`);
        continue;
      }
      if (st.distinctColours < MIN_COLOURS || st.contrastFraction < MIN_CONTRAST) {
        errors.push(
          `Compiled icon ${resolved} looks like a flat placeholder (${st.distinctColours} colours, ` +
          `${(st.contrastFraction * 100).toFixed(1)}% contrast)`
        );
        continue;
      }
    }

    const signatures = check.kind === 'foreground'
      ? expected.foregroundSignatures
      : check.kind === 'round'
        ? expected.roundSignatures
        : expected.signatures;
    const want = signatures?.get(img.width);
    if (!want) {
      errors.push(`Compiled icon ${resolved} is ${img.width}px wide, which the generator never produces`);
      continue;
    }
    const sig = iconSignature(img.rgba, img.width, img.height);
    const distance = signatureDistance(sig, want);
    if (distance > MATCH_THRESHOLD) {
      errors.push(
        `Compiled icon ${resolved} is a different picture from the generated icon ` +
        `(signature distance ${distance.toFixed(1)} > ${MATCH_THRESHOLD})`
      );
      continue;
    }

    resolvedPaths.push(resolved);
    if (check.kind === 'legacy') {
      matchedDensities.push(check.density);
      if (!result.matchedPath) {
        result.matchedPath = resolved;
        result.matchedSize = img.width;
        result.similarity = Number(distance.toFixed(3));
        result.iconSignatureSha256 = createHash('sha256').update(sig).digest('hex');
        const source = expected.sourcePngBytes?.get(img.width);
        result.byteIdentical = source ? source.equals(bytes) : undefined;
      }
    }
  }

  // 4. The adaptive icon configuration must be compiled in and wired up.
  for (let i = 0; i < adaptivePaths.length; i++) {
    const path = adaptivePaths[i] as string;
    const bytes = readEntry(path);
    if (!bytes) {
      errors.push(`Adaptive icon ${path} is missing from the APK`);
      continue;
    }
    const parsed = extractXmlReferences(bytes);
    if (!parsed.elements.includes('adaptive-icon')) {
      errors.push(`Adaptive icon ${path} is not a compiled adaptive-icon`);
      continue;
    }
    // The compiled XML stores `@mipmap/...` and `@color/...` as numeric ids, so
    // the referenced names are recovered through the resource table rather than
    // looked up as text.
    const referenced = new Set<string>();
    for (const ref of parsed.refs) {
      if (ref.dataType !== RES_TYPE_REFERENCE) continue;
      referenced.add(resourceIds.get(ref.data) ?? `0x${ref.data.toString(16)}`);
    }
    for (const needed of [
      `mipmap/${FOREGROUND_RESOURCE_NAME}`,
      `color/${ICON_BACKGROUND_COLOR_NAME}`
    ]) {
      if (!referenced.has(needed)) {
        errors.push(
          `Adaptive icon ${path} does not reference ${needed} ` +
          `(it references ${[...referenced].join(', ') || 'nothing'}; ` +
          `${resourceIds.size} ids resolved, icon ids ${JSON.stringify([...resourceIds].filter(([, n]) => n.includes('ic_launcher')))}; ` +
          `${JSON.stringify([...resourceIds].filter(([id]) => (id >>> 16) === 0x7f08).slice(0, 6))})`
        );
      }
    }
  }

  const allDensities = Object.keys(LEGACY_ICON_SIZES);
  if (matchedDensities.length === 0) {
    errors.push('No compiled launcher icon density matched the generated icon');
  } else if (matchedDensities.length !== allDensities.length) {
    const missing = allDensities.filter((d) => !matchedDensities.includes(d));
    errors.push(`Compiled launcher icon is missing densities: ${missing.join(', ')}`);
  }

  result.adaptiveIconsPresent = adaptivePaths.every((p) => p !== undefined && byName.has(p));
  if (errors.length > 0) return withWalkTrace();
  result.valid = true;
  return result;
}

export function verifyApkLauncherIcon(apkPath: string, expected: ApkIconExpectation): ApkIconVerification {
  if (!apkPath || !existsSync(apkPath)) {
    return { valid: false, errors: [`APK not found: ${apkPath}`], resolvedPaths: [], matchedDensities: [] };
  }
  return verifyApkLauncherIconFromBuffer(readFileSync(apkPath), expected);
}