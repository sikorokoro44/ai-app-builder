import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import {
  decideIcon, LEGACY_ICON_SIZES, FOREGROUND_ICON_SIZES,
  type IconCategory, type IconDecision
} from '../iconCatalog.ts';
import { renderIcon, iconStatistics, iconSignature, type IconVariant } from './iconRaster.ts';
import { encodePng, readPngInfo, decodePng } from './png.ts';

/**
 * Writes and validates the generated app's launcher icon.
 *
 * Two independent requirements are served here. Generation has to emit real,
 * density-complete Android resources wired into the manifest, because a build
 * with no `mipmap/ic_launcher` produces an APK with no launcher icon at all.
 * Validation has to be able to say *no* — a missing density, a flat placeholder
 * image, or a corrupt PNG must all be rejected before a cloud build is
 * dispatched, so the failure surfaces as a clear message instead of an app that
 * silently ships the system default icon.
 */

export const ICON_RESOURCE_NAME = 'ic_launcher';
export const ROUND_ICON_RESOURCE_NAME = 'ic_launcher_round';
export const FOREGROUND_RESOURCE_NAME = 'ic_launcher_foreground';
export const ICON_BACKGROUND_COLOR_NAME = 'ic_launcher_background';

export interface LauncherIconDescriptor {
  category: IconCategory;
  purpose: string;
  reason: string;
  /** Project-relative paths of every generated icon resource. */
  files: string[];
  /** Stable identity of the whole icon set. */
  fingerprint: string;
}

export interface LauncherIconValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Manifest values found, for reporting. */
  manifestIcon?: string;
  manifestRoundIcon?: string;
  densities: string[];
  fingerprint?: string;
  /** Category the idea mapped to, when the icon set is intact. */
  category?: string;
  /** What that category is for, in words. */
  purpose?: string;
  /** Why this category was chosen. */
  reason?: string;
  /** Project-relative paths of the validated icon resources. */
  files?: string[];
}

function resRoot(projectRoot: string): string {
  return join(projectRoot, 'app', 'src', 'main', 'res');
}

/** Every icon resource the generator is expected to produce, with its size. */
export function expectedIconResources(): Array<{ path: string; size: number; kind: 'legacy' | 'round' | 'foreground' }> {
  const out: Array<{ path: string; size: number; kind: 'legacy' | 'round' | 'foreground' }> = [];
  for (const [density, size] of Object.entries(LEGACY_ICON_SIZES)) {
    out.push({ path: `mipmap-${density}/${ICON_RESOURCE_NAME}.png`, size, kind: 'legacy' });
    out.push({ path: `mipmap-${density}/${ROUND_ICON_RESOURCE_NAME}.png`, size, kind: 'round' });
  }
  for (const [density, size] of Object.entries(FOREGROUND_ICON_SIZES)) {
    out.push({ path: `mipmap-${density}/${FOREGROUND_RESOURCE_NAME}.png`, size, kind: 'foreground' });
  }
  return out;
}

function adaptiveIconXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/${ICON_BACKGROUND_COLOR_NAME}" />
    <foreground android:drawable="@mipmap/${FOREGROUND_RESOURCE_NAME}" />
    <monochrome android:drawable="@mipmap/${FOREGROUND_RESOURCE_NAME}" />
</adaptive-icon>
`;
}

/**
 * Generates the full icon set for an idea and returns what was written and why.
 * Deterministic: the same idea produces byte-identical resources.
 */
export function writeLauncherIcon(projectRoot: string, idea: string, appName?: string): LauncherIconDescriptor {
  const decision: IconDecision = decideIcon(idea, appName);
  const def = decision.definition;
  const res = resRoot(projectRoot);
  const files: string[] = [];

  for (const [density, size] of Object.entries(LEGACY_ICON_SIZES)) {
    const dir = join(res, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    for (const [name, variant] of [[ICON_RESOURCE_NAME, 'legacy'], [ROUND_ICON_RESOURCE_NAME, 'round']] as Array<[string, IconVariant]>) {
      const png = encodePng(size, size, renderIcon(def, size, variant));
      writeFileSync(join(dir, `${name}.png`), png);
      files.push(`mipmap-${density}/${name}.png`);
    }
  }

  for (const [density, size] of Object.entries(FOREGROUND_ICON_SIZES)) {
    const dir = join(res, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    const png = encodePng(size, size, renderIcon(def, size, 'foreground'));
    writeFileSync(join(dir, `${FOREGROUND_RESOURCE_NAME}.png`), png);
    files.push(`mipmap-${density}/${FOREGROUND_RESOURCE_NAME}.png`);
  }

  const anydpi = join(res, 'mipmap-anydpi-v26');
  mkdirSync(anydpi, { recursive: true });
  for (const name of [ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME]) {
    writeFileSync(join(anydpi, `${name}.xml`), adaptiveIconXml());
    files.push(`mipmap-anydpi-v26/${name}.xml`);
  }

  const values = join(res, 'values');
  mkdirSync(values, { recursive: true });
  writeFileSync(join(values, 'ic_launcher_colors.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="${ICON_BACKGROUND_COLOR_NAME}">#FF${def.palette.to.replace('#', '').toUpperCase()}</color>
</resources>
`);
  files.push('values/ic_launcher_colors.xml');

  // The old generic vector is not referenced any more. Leaving it behind would
  // keep a second, misleading launcher icon in the project.
  const legacyVector = join(res, 'drawable', `${ICON_RESOURCE_NAME}.xml`);
  if (existsSync(legacyVector)) rmSync(legacyVector, { force: true });

  files.sort();
  const fingerprint = createHash('sha256');
  for (const rel of files) {
    fingerprint.update(rel);
    fingerprint.update(readFileSync(join(res, rel)));
  }

  return {
    category: def.category,
    purpose: def.purpose,
    reason: decision.reason,
    files,
    fingerprint: fingerprint.digest('hex')
  };
}

/**
 * Fingerprint of the icon resources currently on disk. Used to tie recorded
 * icon evidence to the files that were actually built.
 */
export function launcherIconFingerprint(projectRoot: string): string | undefined {
  const res = resRoot(projectRoot);
  const expected = expectedIconResources().map((r) => r.path)
    .concat([`mipmap-anydpi-v26/${ICON_RESOURCE_NAME}.xml`, `mipmap-anydpi-v26/${ROUND_ICON_RESOURCE_NAME}.xml`, 'values/ic_launcher_colors.xml'])
    .sort();
  const hash = createHash('sha256');
  for (const rel of expected) {
    const p = join(res, rel);
    if (!existsSync(p)) return undefined;
    hash.update(rel);
    hash.update(readFileSync(p));
  }
  return hash.digest('hex');
}

/** Signature of one rendered density, for source-vs-APK comparison. */
export function sourceIconSignature(projectRoot: string, density = 'xhdpi'): { signature: Buffer; size: number } | undefined {
  const p = join(resRoot(projectRoot), `mipmap-${density}`, `${ICON_RESOURCE_NAME}.png`);
  if (!existsSync(p)) return undefined;
  const img = decodePng(readFileSync(p));
  if (!img) return undefined;
  return { signature: iconSignature(img.rgba, img.width, img.height), size: img.width };
}

/**
 * Expected pixel signature for every density the generator emits, keyed by pixel
 * size. The APK verifier compares a compiled icon against the entry for its own
 * dimensions, so a density mismatch cannot be mistaken for a match.
 */
function signaturesOfKind(projectRoot: string, kind: 'legacy' | 'round' | 'foreground'): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  for (const { path, kind: k } of expectedIconResources()) {
    if (k !== kind) continue;
    const p = join(resRoot(projectRoot), path);
    if (!existsSync(p)) continue;
    const img = decodePng(readFileSync(p));
    if (img) out.set(img.width, iconSignature(img.rgba, img.width, img.height));
  }
  return out;
}

export function sourceIconSignatures(projectRoot: string): Map<number, Buffer> {
  return signaturesOfKind(projectRoot, 'legacy');
}

/**
 * Expected signatures for the round launcher icon.
 *
 * The round icon is what launchers show on masked launchers, so it is verified
 * against its own pixels rather than assumed to match the legacy icon.
 */
export function sourceRoundSignatures(projectRoot: string): Map<number, Buffer> {
  return signaturesOfKind(projectRoot, 'round');
}

export function sourceForegroundSignatures(projectRoot: string): Map<number, Buffer> {
  return signaturesOfKind(projectRoot, 'foreground');
}

/** Exact PNG bytes per pixel size, for the informational identity check. */
export function sourceIconPngBytes(projectRoot: string): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  for (const { path, size, kind } of expectedIconResources()) {
    if (kind !== 'legacy') continue;
    const p = join(resRoot(projectRoot), path);
    if (!existsSync(p)) continue;
    out.set(size, readFileSync(p));
  }
  return out;
}

const PLACEHOLDER_MIN_CONTRAST = 0.06;
const PLACEHOLDER_MIN_COLOURS = 6;

/**
 * Validates the launcher icon of a generated project.
 *
 * Rejects, with a specific message in each case: a manifest that points at a
 * drawable instead of a mipmap, a missing density, an image whose dimensions do
 * not match its density bucket, a corrupt PNG, and a flat single-colour image
 * standing in for a real design.
 */
export function validateLauncherIcon(projectRoot: string, idea = ''): LauncherIconValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const res = resRoot(projectRoot);
  const manifestPath = join(projectRoot, 'app', 'src', 'main', 'AndroidManifest.xml');

  if (!existsSync(manifestPath)) {
    return { valid: false, errors: ['AndroidManifest.xml is missing, cannot verify the launcher icon'], warnings, densities: [] };
  }
  const manifest = readFileSync(manifestPath, 'utf-8');
  const iconMatch = manifest.match(/android:icon\s*=\s*"@([a-z]+)\/([A-Za-z0-9_]+)"/);
  const roundMatch = manifest.match(/android:roundIcon\s*=\s*"@([a-z]+)\/([A-Za-z0-9_]+)"/);

  if (!iconMatch) {
    errors.push('AndroidManifest.xml declares no android:icon');
    return { valid: false, errors, warnings, densities: [] };
  }
  if (iconMatch[1] !== 'mipmap') {
    errors.push(`android:icon must reference a @mipmap launcher resource, found @${iconMatch[1]}/${iconMatch[2]}`);
  }
  if (roundMatch && roundMatch[1] !== 'mipmap') {
    errors.push(`android:roundIcon must reference a @mipmap resource, found @${roundMatch[1]}/${roundMatch[2]}`);
  }

  const iconName = iconMatch[2];
  const densities: string[] = [];

  if (existsSync(res)) {
    for (const entry of readdirSync(res) as string[]) {
      // `anydpi-v26` is a configuration, not a density bucket, so it is not
      // reported as one; the adaptive icons are checked separately below.
      if (entry.startsWith('mipmap-') && !entry.includes('anydpi')) {
        densities.push(entry.replace(/^mipmap-/, ''));
      }
    }
  }

  // Every density bucket must carry the legacy icon, its round variant and the
  // adaptive foreground, at the size Android expects for that bucket.
  for (const expected of expectedIconResources()) {
    const p = join(res, expected.path);
    if (!existsSync(p)) {
      errors.push(`Missing launcher icon resource: app/src/main/res/${expected.path}`);
      continue;
    }
    if (statSync(p).size === 0) {
      errors.push(`Empty launcher icon resource: app/src/main/res/${expected.path}`);
      continue;
    }
    const bytes = readFileSync(p);
    const info = readPngInfo(bytes);
    if (!info || !info.structurallyValid) {
      errors.push(`Malformed PNG for ${expected.path}: ${info ? info.errors.join('; ') : 'unreadable'}`);
      continue;
    }
    if (info.width !== expected.size || info.height !== expected.size) {
      errors.push(`${expected.path} is ${info.width}x${info.height}, expected ${expected.size}x${expected.size} for its density`);
      continue;
    }
    const decoded = decodePng(bytes);
    if (!decoded) {
      errors.push(`PNG pixels could not be decoded for ${expected.path}`);
      continue;
    }
    if (expected.kind === 'foreground') {
      // The adaptive foreground is transparent by design and the glyph is a thin
      // stroke inside the 72/108dp safe zone, so it covers only a few percent of
      // the canvas. "Empty" is the failure to catch, which means a lower bound
      // well under a real glyph's coverage plus a non-flat colour count; the upper
      // bound catches a full-bleed image masquerading as a foreground layer.
      const st = iconStatistics(decoded.rgba, decoded.width, decoded.height);
      if (st.opaqueFraction < 0.005) {
        errors.push(`${expected.path} adaptive foreground is empty (${(st.opaqueFraction * 100).toFixed(2)}% drawn); no glyph was rendered`);
      } else if (st.opaqueFraction > 0.85) {
        errors.push(`${expected.path} fills ${(st.opaqueFraction * 100).toFixed(0)}% of the canvas; an adaptive foreground must leave the background layer visible`);
      } else if (st.distinctColours < 2) {
        errors.push(`${expected.path} adaptive foreground is a flat shape with no antialiasing; it does not look like a rendered glyph`);
      }
      continue;
    }
    const st = iconStatistics(decoded.rgba, decoded.width, decoded.height);
    if (st.opaqueFraction < 0.5) {
      errors.push(`${expected.path} is mostly transparent (${(st.opaqueFraction * 100).toFixed(1)}% opaque); a launcher icon must fill its canvas`);
    }
    if (st.distinctColours < PLACEHOLDER_MIN_COLOURS) {
      errors.push(`${expected.path} looks like a flat placeholder (only ${st.distinctColours} distinct colours)`);
    }
    if (st.contrastFraction < PLACEHOLDER_MIN_CONTRAST) {
      errors.push(`${expected.path} has no visible glyph (only ${(st.contrastFraction * 100).toFixed(1)}% of pixels differ from the background)`);
    }
  }

  // Adaptive icon configuration.
  for (const name of [iconName, roundMatch ? roundMatch[2] : ROUND_ICON_RESOURCE_NAME]) {
    const p = join(res, 'mipmap-anydpi-v26', `${name}.xml`);
    if (!existsSync(p)) {
      errors.push(`Missing adaptive icon: app/src/main/res/mipmap-anydpi-v26/${name}.xml`);
      continue;
    }
    const xml = readFileSync(p, 'utf-8');
    if (!/<adaptive-icon[\s>]/.test(xml)) {
      errors.push(`mipmap-anydpi-v26/${name}.xml is not an <adaptive-icon>`);
    }
    if (!/<background\s+android:drawable\s*=\s*"@color\/([A-Za-z0-9_]+)"/.test(xml)) {
      errors.push(`mipmap-anydpi-v26/${name}.xml has no <background> colour reference`);
    }
    const fg = xml.match(/<foreground\s+android:drawable\s*=\s*"@mipmap\/([A-Za-z0-9_]+)"/);
    if (!fg) {
      errors.push(`mipmap-anydpi-v26/${name}.xml has no <foreground> mipmap reference`);
    } else if (!existsSync(join(res, 'mipmap-xhdpi', `${fg[1]}.png`))) {
      errors.push(`Adaptive icon foreground @mipmap/${fg[1]} does not resolve to any generated resource`);
    }
  }

  const colorsXml = join(res, 'values', 'ic_launcher_colors.xml');
  if (!existsSync(colorsXml)) {
    errors.push('Missing app/src/main/res/values/ic_launcher_colors.xml declaring the adaptive background colour');
  } else {
    const xml = readFileSync(colorsXml, 'utf-8');
    if (!new RegExp(`<color\\s+name="${ICON_BACKGROUND_COLOR_NAME}"`).test(xml)) {
      errors.push(`ic_launcher_colors.xml does not declare ${ICON_BACKGROUND_COLOR_NAME}`);
    }
  }

  // A leftover generic vector from the old generator would mean two competing
  // launcher icons; the manifest no longer points at it, so it must be gone.
  const stale = join(res, 'drawable', `${ICON_RESOURCE_NAME}.xml`);
  if (existsSync(stale)) {
    warnings.push(`Stale app/src/main/res/drawable/${ICON_RESOURCE_NAME}.xml is present but unreferenced; the launcher icon lives in mipmap/`);
  }

  const valid = errors.length === 0;
  const fingerprint = valid ? launcherIconFingerprint(projectRoot) : undefined;
  // The category is only reported when the whole set is intact, so a half-written
  // icon directory can never be recorded as a decided design. It is recomputed
  // from the idea rather than trusted from disk, which keeps the reported
  // decision and the resources that were actually written in agreement.
  const decision = valid ? decideIcon(idea || '', appNameOf(projectRoot)) : undefined;

  return {
    valid,
    errors,
    warnings,
    manifestIcon: `@${iconMatch[1]}/${iconName}`,
    manifestRoundIcon: roundMatch ? `@${roundMatch[1]}/${roundMatch[2]}` : undefined,
    densities: densities.sort(),
    fingerprint,
    category: decision?.definition.category,
    purpose: decision?.definition.purpose,
    reason: decision?.reason,
    files: valid ? expectedIconResources().map((r) => `app/src/main/res/${r.path}`) : undefined
  };
}

/** The generated app's label, which the icon decision also considers. */
function appNameOf(projectRoot: string): string | undefined {
  const strings = join(resRoot(projectRoot), 'values', 'strings.xml');
  if (!existsSync(strings)) return undefined;
  const m = readFileSync(strings, 'utf-8').match(/<string name="app_name">([^<]*)<\/string>/);
  return m ? m[1] : undefined;
}
