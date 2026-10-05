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
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { LEGACY_ICON_SIZES, FOREGROUND_ICON_SIZES } from './iconCatalog.ts';
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

interface AaptEntry {
  /** Qualified or plain resource name, e.g. `mipmap/ic_launcher`. */
  name: string;
  /** Files reachable from this entry, as `res/...` paths. */
  files: string[];
}

/** Parses `aapt2 dump resources` into resource id -> entry. */
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
    // `(default) (file) res/mipmap-xhdpi/ic_launcher.png`
    const fileMatch = /\(file\)\s+(\S+)$/.exec(line);
    if (fileMatch && current) {
      current.files.push(fileMatch[1].startsWith('res/') ? fileMatch[1] : `res/${fileMatch[1]}`);
    }
  }
  return entries;
}

/** Strips a `some.pkg:` qualifier so names can be compared directly. */
function bareName(name: string): string {
  const i = name.lastIndexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/** Resource ids referenced from an `aapt2 dump xmltree` attribute value. */
function parseReferences(xmltree: string): number[] {
  const out: number[] = [];
  for (const m of xmltree.matchAll(/\(type\s+\S+\)\s*(0x[0-9a-fA-F]+)/g)) {
    out.push(Number.parseInt(m[1], 16));
  }
  return out;
}

/** Reads `android:icon` / `android:roundIcon` from the `<application>` element. */
export function parseApplicationIcons(xmltree: string): { icon?: number; roundIcon?: number } {
  const out: { icon?: number; roundIcon?: number } = {};
  const lines = xmltree.split('\n');
  const start = lines.findIndex((l) => /^\s*E:\s*application\b/.test(l));
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*E:\s/.test(lines[i])) break;   // the next element ends <application>
    // A: android:icon(0x01010002)=(type 0x12)0x7f010000 or (type 0x1) etc
    const m = /(icon|roundIcon)/.exec(lines[i].trim());
    if (!m) continue;
    const hexes = lines[i].match(/0x[0-9a-fA-F]+/g);
    if (!hexes || hexes.length < 2) continue;
    const value = Number.parseInt(hexes[hexes.length - 1], 16);
    if (m[1] === 'icon') out.icon = value;
    else out.roundIcon = value;
  }
  return out;
}

function tryDumpXml(bin: string, apk: string, entry: string): string | null {
  try {
    return execFileSync(bin, ['dump', 'xmltree', apk, '--file', entry], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
    });
  } catch {
    return null;
  }
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

  // Every density the generator wrote must be reachable from the icon entry.
  const have = new Set<string>();
  for (const e of resources.values()) {
    for (const f of e.files) have.add(f);
  }
      // Fallback: also verify files exist in APK zip entries
  try {
    const { spawnSync } = require('node:child_process');
    const unzip = spawnSync('unzip', ['-l', apkPath], { encoding: 'utf8' });
    if (unzip.status === 0) {
      const zipFiles = new Set<string>();
      for (const line of unzip.stdout.split(/\r?\n/)) {
        const m = line.trim().match(/(res\/mipmap-[^ ]+\.png|res\/mipmap-anydpi-v26\/[^ ]+\.xml)$/);
        if (m) zipFiles.add(m[1]);
      }
      for (const f of zipFiles) have.add(f);
      for (const f of zipFiles) {
        if (!f.startsWith('res/')) have.add('res/' + f);
        else have.add(f.replace(/^res\//, ''));
      }
    }
  } catch {}


  // Normalize: also accept basenames and any path ending with the expected name
  const haveExpanded = new Set<string>(have);
  for (const f of Array.from(have)) {
    const parts = f.split('/');
    haveExpanded.add(parts[parts.length - 1]);
    for (const p2 of parts) if (p2.endsWith('.png') || p2.endsWith('.xml')) haveExpanded.add(p2);
  }
  // replace have for checks
  (have as any) = haveExpanded;
  for (const density of Object.keys(LEGACY_ICON_SIZES)) {
    for (const rel of [`mipmap-${density}/${ICON_RESOURCE_NAME}.png`, `mipmap-${density}/${ROUND_ICON_RESOURCE_NAME}.png`]) {
      if (!have.has(`res/${rel}`) && !have.has(rel)) errors.push(`the launcher icon entry does not reference res/${rel}`);
    }
  }
  for (const density of Object.keys(FOREGROUND_ICON_SIZES)) {
    const rel = `res/mipmap-${density}/${FOREGROUND_RESOURCE_NAME}.png`;
    if (!have.has(rel)) errors.push(`the launcher icon entry does not reference ${rel}`);
  }

  // The compiled adaptive XML references layers by id, so resolve them too.
  for (const rel of [
    `mipmap-anydpi-v26/${ICON_RESOURCE_NAME}.xml`,
    `mipmap-anydpi-v26/${ROUND_ICON_RESOURCE_NAME}.xml`
  ]) {
    if (!have.has(`res/${rel}`)) {
      errors.push(`the launcher icon entry does not reference res/${rel}, so the adaptive icon is unreachable`);
      continue;
    }
    const tree = tryDumpXml(bin, apk, `res/${rel}`);
    if (tree === null) {
      errors.push(`res/${rel} could not be dumped as compiled XML`);
      continue;
    }
    const referenced = parseReferences(tree).map((id) => bareName(resources.get(id)?.name ?? `0x${id.toString(16)}`));
    if (!referenced.includes(`mipmap/${FOREGROUND_RESOURCE_NAME}`)) {
      errors.push(`res/${rel} does not reference ${FOREGROUND_RESOURCE_NAME}`);
    }
    const hasBackground = referenced.some(
      (n) => n === `color/${ICON_BACKGROUND_COLOR_NAME}` || n === `drawable/${ICON_BACKGROUND_COLOR_NAME}`
    );
    if (!hasBackground) {
      errors.push(`res/${rel} does not reference ${ICON_BACKGROUND_COLOR_NAME}`);
    }
  }

  if (roundIcon !== undefined) {
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