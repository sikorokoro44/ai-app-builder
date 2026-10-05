#!/usr/bin/env -S node --experimental-strip-types
/**
 * Authoritative compiled-launcher-icon check for CI, using the Android SDK's own
 * `aapt2`.
 *
 * `scripts/live/apkIconVerifier.ts` proves the artifact end to end from Node,
 * but it deliberately does not resolve a resource id to its exact table entry:
 * `resources.arsc` entry packing is easy to misread, and a wrong guess yields
 * confident but false evidence. This script closes that gap with the tool that
 * wrote the table, so the two approaches cross-check each other:
 *
 *   1. `aapt2 dump xmltree` reads `android:icon` / `android:roundIcon` off the
 *      compiled manifest as real resource ids.
 *   2. `aapt2 dump resources` maps every id to a resource name and to the
 *      concrete `res/...` files behind it.
 *   3. The icon id must be the app's `mipmap/ic_launcher`, and every density the
 *      generator wrote must be reachable from it.
 *   4. The compiled adaptive XML references resources by *id* too, so those ids
 *      are resolved the same way and must name the generated foreground layer
 *      and its background colour.
 *
 * Nothing here trusts the generator's own claims: the expectations come from the
 * icon catalogue, and the facts come from the APK.
 *
 * Usage: node --experimental-strip-types scripts/verifyApkIconAapt.ts <apk> [projectRoot]
 */
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { LEGACY_ICON_SIZES, FOREGROUND_ICON_SIZES } from './iconCatalog.ts';
import { readZipEntries } from './live/apkValidator.ts';
import {
  ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME, FOREGROUND_RESOURCE_NAME, ICON_BACKGROUND_COLOR_NAME,
  launcherIconFingerprint
} from './live/launcherIcon.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** Locates the `aapt2` binary from an explicit path, `PATH`, then the SDK layout. */
function findAapt2(): string {
  const explicit = process.env.AAPT2;
  if (explicit && existsSync(explicit)) return explicit;

  const fromPath = execFileSync('sh', ['-c', 'command -v aapt2 2>/dev/null || true'], { encoding: 'utf8' }).trim();
  if (fromPath) return fromPath;

  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(process.env.HOME || '', 'Android', 'Sdk')]
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const root of roots) {
    const buildTools = join(root, 'build-tools');
    if (!existsSync(buildTools)) continue;
    // Highest version first, so behaviour matches the SDK the build used.
    const versions = readdirSync(buildTools)
      .filter((v) => statSync(join(buildTools, v)).isDirectory())
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    for (const v of versions) {
      const candidate = join(buildTools, v, 'aapt2');
      if (existsSync(candidate)) return candidate;
    }
  }
  fail('aapt2 was not found; set ANDROID_HOME or AAPT2 so the compiled launcher icon can be checked');
}

function aapt2(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    fail(`\`aapt2 ${args.join(' ')}\` failed: ${stderr.trim() || String(err)}`);
  }
}

interface AaptFile {
  /** Configuration qualifier aapt2 printed, e.g. `mdpi`, `anydpi-v26`. */
  config: string;
  /** Path inside the APK, always `res/...`. */
  path: string;
  /** `PNG` / `XML`, when aapt2 reported the value type. */
  type?: string;
}

interface AaptEntry {
  /** Qualified or plain resource name, e.g. `mipmap/ic_launcher`. */
  name: string;
  /** Files reachable from this entry, one per configuration. */
  files: AaptFile[];
}

/**
 * Parses `aapt2 dump resources` into resource id -> entry.
 *
 * Density coverage is read from the per-configuration value lines, e.g.
 *
 *   resource 0x7f080000 mipmap/ic_launcher
 *     (mdpi) (file) res/mipmap-mdpi-v4/ic_launcher.png type=PNG
 *
 * The path comes from aapt2 rather than being recomputed from the density.
 * AAPT2 rewrites resource directories when it compiles, appending a version
 * qualifier the generator never wrote (`-v4` in this build), so a path
 * reconstructed from the density alone does not name the file that is actually
 * in the APK.
 */
export function parseResourceDump(dump: string): Map<number, AaptEntry> {
  const entries = new Map<number, AaptEntry>();
  let current: AaptEntry | null = null;
  for (const raw of dump.split('\n')) {
    const line = raw.trim();
    // `resource 0x7f010000 mipmap/ic_launcher` (aapt2 may qualify it as `pkg:mipmap/...`).
    const resMatch = /^resource\s+(0x[0-9a-fA-F]+)\s+(\S+)$/.exec(line);
    if (resMatch) {
      current = { name: resMatch[2], files: [] };
      entries.set(Number.parseInt(resMatch[1], 16), current);
      continue;
    }
    const valMatch = /^\(([^)]*)\)\s+\(file\)\s+(\S+)(?:\s+type=(\w+))?$/.exec(line);
    if (valMatch && current) {
      current.files.push({
        config: valMatch[1],
        path: valMatch[2].startsWith('res/') ? valMatch[2] : `res/${valMatch[2]}`,
        type: valMatch[3]
      });
    }
  }
  return entries;
}

/** Strips a `some.pkg:` qualifier so names can be compared directly. */
function bareName(name: string): string {
  const i = name.lastIndexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/**
 * Every file name the APK actually contains, read from its own zip central
 * directory. This is the artifact itself rather than a tool's rendering of it,
 * so it does not drift with `aapt2`'s output format.
 */
function packagedEntryNames(apk: string): Set<string> {
  const buf = readFileSync(apk);
  const entries = readZipEntries(buf);
  if (!entries) fail(`could not read the APK central directory at ${apk}`);
  return new Set(entries.map((e) => e.name));
}

/**
 * Resource ids referenced from an `aapt2 dump xmltree` attribute value.
 *
 * aapt2 renders a reference as `attr(0x01010199)=@0x7f0a0006`, so an attribute
 * line carries two ids: the framework attribute's own id first, then the
 * resource it points at. The resource is always the last id on the line, which
 * holds for the typed inline form too, e.g. `=(type 0x12)0x7f0a0006`.
 */
function parseReferences(xmltree: string): number[] {
  const out: number[] = [];
  for (const line of xmltree.split('\n')) {
    if (!/^\s*A:\s/.test(line)) continue;
    const ids = [...line.matchAll(/0x[0-9a-fA-F]+/g)];
    if (ids.length < 2) continue;
    out.push(Number.parseInt(ids[ids.length - 1][0], 16));
  }
  return out;
}

/**
 * Reads `android:icon` / `android:roundIcon` off the `<application>` element.
 *
 * aapt2 prints the attribute name fully qualified and the value as a resource
 * reference, e.g.
 *
 *   A: http://schemas.android.com/apk/res/android:icon(0x01010002)=@0x7f080000
 *
 * so the local name is whatever follows the last `:` before `(0x...)`, and the
 * value is the id after the `=@`. Matching the namespace with `\w+` is not
 * enough: a URI namespace contains `/` and `.`, and a looser match happily
 * accepts an unrelated attribute whose name merely contains "icon".
 */
const APP_ICON_ATTR = /^A:\s+(?:[^\s=]*:)?(icon|roundIcon)\(0x[0-9a-fA-F]+\)=@?(0x[0-9a-fA-F]+)/;

export function parseApplicationIcons(xmltree: string): { icon?: number; roundIcon?: number } {
  const out: { icon?: number; roundIcon?: number } = {};
  const lines = xmltree.split('\n');
  const start = lines.findIndex((l) => /^\s*E:\s*application\b/.test(l));
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*E:\s/.test(lines[i])) break;   // the next element ends <application>
    const m = APP_ICON_ATTR.exec(lines[i].trim());
    if (!m) continue;
    const value = Number.parseInt(m[2], 16);
    if (m[1] === 'icon') out.icon = value;
    else out.roundIcon = value;
  }
  return out;
}

/**
 * Dumps one compiled XML from the APK, or returns null when aapt2 will not.
 *
 * `aapt2 dump xmltree` is documented as `--file <entry> <apk>`, but aapt2's
 * argument parser also accepts the flags after the archive. Both spellings are
 * tried so the audit does not hinge on which one this build-tools release
 * happens to prefer; a null still means the file could not be read, and the
 * caller treats that as a failure.
 */
function tryDumpXml(bin: string, apk: string, entry: string): string | null {
  const orderings = [
    ['dump', 'xmltree', '--file', entry, apk],
    ['dump', 'xmltree', apk, '--file', entry]
  ];
  for (const args of orderings) {
    try {
      return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    } catch {
      // Try the next spelling before giving up.
    }
  }
  return null;
}

export interface AaptIconAudit {
  valid: boolean;
  errors: string[];
  iconResourceId?: string;
  iconResourceName?: string;
  roundResourceName?: string;
  aapt2Path: string;
}

/**
 * Runs the full audit and returns every problem found.
 *
 * Exported so the checks can be exercised against recorded `aapt2` output rather
 * than only against a live SDK.
 */
export function auditApkIcon(bin: string, apk: string, projectRoot: string): AaptIconAudit {
  const errors: string[] = [];
  const audit: AaptIconAudit = { valid: false, errors, aapt2Path: bin };

  const manifestTree = aapt2(bin, ['dump', 'xmltree', apk, '--file', 'AndroidManifest.xml']);
  const resources = parseResourceDump(aapt2(bin, ['dump', 'resources', apk]));
  if (resources.size === 0) errors.push('aapt2 reported no resources in the APK');

  const { icon, roundIcon } = parseApplicationIcons(manifestTree);
  if (icon === undefined) {
    errors.push('aapt2 reports no android:icon on <application>');
    // debug
    const lines = manifestTree.split('\n');
    const start = lines.findIndex((l) => /^\s*E:\s*application\b/.test(l));
    if (start >= 0) {
      errors.push('application context: ' + lines.slice(start, Math.min(start+10, lines.length)).join(' | '));
    }
    return audit;
  }
  audit.iconResourceId = `0x${icon.toString(16)}`;

  const APP_PACKAGE_ID = 0x7f;
  const iconEntry = resources.get(icon);
  if (!iconEntry) {
    errors.push(`android:icon (${audit.iconResourceId}) does not resolve to any resource in the APK`);
    return audit;
  }
  audit.iconResourceName = bareName(iconEntry.name);

  if ((icon >>> 24) !== APP_PACKAGE_ID) {
    errors.push(`android:icon resolves into package 0x${(icon >>> 24).toString(16)}, not the app's own resources`);
  }
  if (audit.iconResourceName !== `mipmap/${ICON_RESOURCE_NAME}`) {
    errors.push(
      `android:icon resolves to ${audit.iconResourceName}, expected mipmap/${ICON_RESOURCE_NAME} ` +
      '(the generated adaptive launcher icon)'
    );
  }

  // Density coverage.
  //
  // aapt2 owns this judgement because it is the tool that compiled the table:
  // it knows which configuration maps to which file. The paths it reports are
  // then checked against the APK's own zip index, so a declared file that is not
  // actually shipped is still a failure. Reading the path from aapt2 rather than
  // rebuilding it from the density matters because AAPT2 appends a version
  // qualifier at compile time (`mipmap-mdpi-v4`), which no generator wrote.
  const packaged = packagedEntryNames(apk);
  const legacyDensities = Object.keys(LEGACY_ICON_SIZES);
  const foregroundDensities = Object.keys(FOREGROUND_ICON_SIZES);

  const fileFor = (entry: AaptEntry, config: string): AaptFile | undefined =>
    entry.files.find((f) => f.config === config);

  // The foreground is not named by the manifest; it is a layer the adaptive XML
  // points at. Locate its entry by name so its densities are checked directly.
  let foregroundEntry: AaptEntry | undefined;
  for (const entry of resources.values()) {
    if (bareName(entry.name) === `mipmap/${FOREGROUND_RESOURCE_NAME}`) foregroundEntry = entry;
  }
  const roundEntry = roundIcon === undefined ? undefined : resources.get(roundIcon);

  // Every file the table attributes to an entry must really be in the archive.
  for (const entry of [iconEntry, roundEntry, foregroundEntry].filter((e): e is AaptEntry => !!e)) {
    for (const f of entry.files) {
      if (!packaged.has(f.path)) {
        errors.push(`aapt2 says ${bareName(entry.name)} uses ${f.path}, but the APK does not package it`);
      }
    }
  }

  const requireDensity = (entry: AaptEntry | undefined, label: string, densities: string[]): void => {
    if (!entry) return;   // the missing entry is already reported
    for (const density of densities) {
      const f = fileFor(entry, density);
      if (!f) {
        errors.push(`aapt2 reports no ${density} configuration for ${label}`);
      } else if (f.type && f.type !== 'PNG') {
        errors.push(`${label} is a ${f.type} at ${density}, expected a PNG`);
      }
    }
  };

  requireDensity(iconEntry, `mipmap/${ICON_RESOURCE_NAME}`, legacyDensities);
  requireDensity(roundEntry, `mipmap/${ROUND_ICON_RESOURCE_NAME}`, legacyDensities);
  requireDensity(foregroundEntry, `mipmap/${FOREGROUND_RESOURCE_NAME}`, foregroundDensities);

  // The compiled adaptive XML references layers by id, so resolve them too.
  for (const [entry, label] of [
    [iconEntry, `mipmap/${ICON_RESOURCE_NAME}`],
    [roundEntry, `mipmap/${ROUND_ICON_RESOURCE_NAME}`]
  ] as [AaptEntry | undefined, string][]) {
    const adaptive = entry && fileFor(entry, 'anydpi-v26');
    if (!adaptive) {
      errors.push(`aapt2 reports no anydpi-v26 configuration for ${label}, so the adaptive icon is unreachable`);
      continue;
    }
    if (!packaged.has(adaptive.path)) {
      errors.push(`the APK does not package ${adaptive.path}, so the adaptive icon is unreachable`);
      continue;
    }
    const rel = adaptive.path;   // already `res/...`, as aapt2 reports it
    const tree = tryDumpXml(bin, apk, rel);
    if (tree === null) {
      errors.push(`${rel} could not be dumped as compiled XML`);
      continue;
    }
    const referenced = parseReferences(tree).map((id) => bareName(resources.get(id)?.name ?? `0x${id.toString(16)}`));
    if (!referenced.includes(`mipmap/${FOREGROUND_RESOURCE_NAME}`)) {
      errors.push(`${rel} does not reference ${FOREGROUND_RESOURCE_NAME}`);
    }
    const hasBackground = referenced.some(
      (n) => n === `color/${ICON_BACKGROUND_COLOR_NAME}` || n === `drawable/${ICON_BACKGROUND_COLOR_NAME}`
    );
    if (!hasBackground) {
      errors.push(`${rel} does not reference ${ICON_BACKGROUND_COLOR_NAME}`);
    }
  }

  // A launcher draws the round icon on round devices and in the recents
  // carousel, so a manifest without one is a real defect, not a harmless
  // omission. The generator always writes it, so treat it as required.
  if (roundIcon === undefined) {
    errors.push(
      'the manifest declares no android:roundIcon, so round launchers and the recents ' +
      'carousel would fall back to a different image'
    );
  } else {
    const roundEntry = resources.get(roundIcon);
    if (!roundEntry) {
      errors.push(`android:roundIcon (0x${roundIcon.toString(16)}) does not resolve to any resource`);
    } else {
      audit.roundResourceName = bareName(roundEntry.name);
      if (audit.roundResourceName !== `mipmap/${ROUND_ICON_RESOURCE_NAME}`) {
        errors.push(`android:roundIcon resolves to ${audit.roundResourceName}, expected mipmap/${ROUND_ICON_RESOURCE_NAME}`);
      }
    }
  }

  audit.valid = errors.length === 0;
  return audit;
}

/**
 * Prints what aapt2 and the archive actually said, so a failing build shows the
 * evidence instead of only a conclusion.
 *
 * This matters because the audit compares against aapt2's rendering of the
 * resource table. When the check and the rendering disagree, the rendering is
 * the thing worth reading, and it is not otherwise recoverable from a CI log.
 * Bounded so a large dump cannot flood the log.
 */
function printDiagnostics(bin: string, apk: string): void {
  const want = new Set([
    `mipmap/${ICON_RESOURCE_NAME}`,
    `mipmap/${ROUND_ICON_RESOURCE_NAME}`,
    `mipmap/${FOREGROUND_RESOURCE_NAME}`
  ]);
  try {
    const lines = aapt2(bin, ['dump', 'resources', apk]).split('\n');
    let printing = false;
    let emitted = 0;
    for (const line of lines) {
      const entry = /^resource\s+(0x[0-9a-fA-F]+)\s+(\S+)$/.exec(line.trim());
      if (entry) {
        printing = want.has(bareName(entry[2]));
        if (printing) {
          console.error(`  [aapt2] ${line.trim()}`);
          emitted++;
        }
        continue;
      }
      if (printing && emitted < 200) {
        console.error(`  [aapt2] ${line.trim()}`);
        emitted++;
      }
    }
  } catch (err) {
    console.error(`  [aapt2] dump resources failed: ${String(err)}`);
  }
  try {
    const buf = readFileSync(apk);
    const entries = readZipEntries(buf);
    const res = (entries || []).map((e) => e.name).filter((n) => n.startsWith('res/'));
    console.error(`  [zip] ${res.length} res/ entries packaged`);
    for (const n of res.slice(0, 40)) console.error(`  [zip] ${n}`);
    if (res.length > 40) console.error(`  [zip] ... and ${res.length - 40} more`);
  } catch (err) {
    console.error(`  [zip] unreadable: ${String(err)}`);
  }
}

function main(): void {
  const apk = process.argv[2];
  const projectRoot = process.argv[3] || join(process.cwd(), '.builder/generated/android');
  if (!apk) fail('usage: verifyApkIconAapt.ts <apk> [projectRoot]');
  if (!existsSync(apk)) fail(`APK not found: ${apk}`);

  const bin = findAapt2();
  const audit = auditApkIcon(bin, apk, projectRoot);

  if (!audit.valid) {
    console.error('::error::The compiled launcher icon did not verify:');
    for (const e of audit.errors) console.error(`  - ${e}`);
    printDiagnostics(bin, apk);
    process.exit(1);
  }

  const badging = aapt2(bin, ['dump', 'badging', apk]);
  const pkg = /package:\s*name='([^']+)'/.exec(badging);
  const summary = [
    '### Verified launcher icon',
    '',
    `- resource: \`${audit.iconResourceId}\` -> \`${audit.iconResourceName}\``,
    `- round icon: \`${audit.roundResourceName ?? 'not declared'}\``,
    `- densities: ${Object.keys(LEGACY_ICON_SIZES).join(', ')}`,
    `- foreground densities: ${Object.keys(FOREGROUND_ICON_SIZES).join(', ')}`,
    `- source fingerprint: \`${launcherIconFingerprint(projectRoot) ?? 'unavailable'}\``,
    `- package: \`${pkg ? pkg[1] : 'unknown'}\``,
    `- aapt2: \`${bin}\``
  ];
  console.log(summary.join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) main();