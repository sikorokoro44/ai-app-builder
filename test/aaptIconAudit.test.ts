import { test, describe } from 'node:test';
import assert from 'node:assert';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { deflateRawSync, crc32 } from 'zlib';
import { auditApkIcon, parseApplicationIcons, parseResourceDump } from '../scripts/verifyApkIconAapt.ts';
import { ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME, FOREGROUND_RESOURCE_NAME, ICON_BACKGROUND_COLOR_NAME } from '../scripts/live/launcherIcon.ts';
import { LEGACY_ICON_SIZES, FOREGROUND_ICON_SIZES } from '../scripts/iconCatalog.ts';

const TMP = join(process.env.PREFIX || process.env.HOME, 'tmp', 'opencode', 'builder-aapt-fixture');
mkdirSync(TMP, { recursive: true });

const ICON_ID = 0x7f010000;
const ROUND_ID = 0x7f010001;
const FOREGROUND_ID = 0x7f02000a;
const OTHER_FOREGROUND_ID = 0x7f02000f;
const BACKGROUND_ID = 0x7f030005;
const FRAMEWORK_ICON_ID = 0x0108001c;

/** The `res/...` paths a correct build lists under the launcher icon entry. */
function completeIconFiles(): string[] {
  const out = [
    `res/mipmap-anydpi-v26/${ICON_RESOURCE_NAME}.xml`,
    `res/mipmap-anydpi-v26/${ROUND_ICON_RESOURCE_NAME}.xml`
  ];
  for (const d of Object.keys(LEGACY_ICON_SIZES)) {
    out.push(`res/mipmap-${d}/${ICON_RESOURCE_NAME}.png`, `res/mipmap-${d}/${ROUND_ICON_RESOURCE_NAME}.png`);
  }
  for (const d of Object.keys(FOREGROUND_ICON_SIZES)) {
    out.push(`res/mipmap-${d}/${FOREGROUND_RESOURCE_NAME}.png`);
  }
  return out;
}

interface Entry {
  id: number;
  files: string[];
}

interface FakeApk {
  /** Qualified resource name, e.g. `mipmap/ic_launcher`, mapped to its entry. */
  entries: Map<string, Entry>;
  iconTarget: string | null;
  roundTarget: string | null;
  /** Compiled resource XML by `res/...` path; a null body makes the dump fail. */
  adaptiveXml: Map<string, string | null>;
  /** Resource id the manifest declares, when it should differ from the table. */
  declaredIconId?: number;
  /**
   * `res/...` paths the APK archive actually contains. The audit reads the zip
   * index rather than trusting `aapt2 dump resources`, so a missing density has
   * to be missing from the archive too.
   */
  packagedFiles: string[];
}

/** A compiled resource XML references layers by resource id, not by name. */
/**
 * Renders a compiled adaptive icon the way `aapt2 dump xmltree` prints it:
 * URI-qualified attribute names and `@`-prefixed resource references.
 */
function adaptiveXmlTree(backgroundId: number | null, foregroundId: number): string {
  const NS = 'http://schemas.android.com/apk/res/android';
  const lines = [`N: ${NS}`, '  E: adaptive-icon (line=2)'];
  if (backgroundId !== null) {
    lines.push('    E: background (line=3)', `      A: ${NS}:drawable(0x01010199)=@0x${backgroundId.toString(16)}`);
  }
  lines.push('    E: foreground (line=4)', `      A: ${NS}:drawable(0x01010199)=@0x${foregroundId.toString(16)}`);
  return lines.join('\n') + '\n';
}

function goodApk(): FakeApk {
  const all = completeIconFiles();
  const adaptiveXml = new Map<string, string | null>([
    [`res/mipmap-anydpi-v26/${ICON_RESOURCE_NAME}.xml`, adaptiveXmlTree(BACKGROUND_ID, FOREGROUND_ID)],
    [`res/mipmap-anydpi-v26/${ROUND_ICON_RESOURCE_NAME}.xml`, adaptiveXmlTree(BACKGROUND_ID, FOREGROUND_ID)]
  ]);
  return {
    entries: new Map<string, Entry>([
      [`mipmap/${ICON_RESOURCE_NAME}`, { id: ICON_ID, files: all }],
      [`mipmap/${ROUND_ICON_RESOURCE_NAME}`, { id: ROUND_ID, files: all.filter((f) => f.includes('_round')) }],
      [`mipmap/${FOREGROUND_RESOURCE_NAME}`, { id: FOREGROUND_ID, files: all.filter((f) => f.includes('_foreground')) }],
      [`color/${ICON_BACKGROUND_COLOR_NAME}`, { id: BACKGROUND_ID, files: [] }]
    ]),
    iconTarget: `mipmap/${ICON_RESOURCE_NAME}`,
    roundTarget: `mipmap/${ROUND_ICON_RESOURCE_NAME}`,
    adaptiveXml,
    packagedFiles: all
  };
}

/** Renders `aapt2 dump resources`. */
function resourceDump(apk: FakeApk): string {
  const lines = ['Package Group 0 id=0x7f', '  Package Group 0 id=0x7f'];
  let lastType = '';
  for (const [name, entry] of apk.entries) {
    const type = name.split('/')[0];
    if (type !== lastType) {
      lines.push(`    type ${type === 'mipmap' ? 1 : type === 'color' ? 3 : 2} ${type}`);
      lastType = type;
    }
    lines.push(`      resource 0x${entry.id.toString(16)} ${name}`);
    for (const f of entry.files) lines.push(`        (default) (file) ${f}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Renders the manifest the way `aapt2 dump xmltree` actually prints it.
 *
 * The attribute name is fully URI-qualified and the value is written as a
 * resource reference, which is what build-tools 35.0.0 emits. Reproducing that
 * exactly is the point: a fixture written in a hand-rolled shape agrees with
 * whichever parser was written against it and hides the real format.
 */
function manifestTree(apk: FakeApk): string {
  const NS = 'http://schemas.android.com/apk/res/android';
  const lines = [
    `N: ${NS}`,
    '  E: manifest (line=2)',
    '    E: application (line=19)',
    `      A: ${NS}:label(0x01010001)=@0x7f090002`
  ];
  if (apk.declaredIconId !== undefined) {
    lines.push(`      A: ${NS}:icon(0x01010002)=@0x${apk.declaredIconId.toString(16)}`);
  } else if (apk.iconTarget) {
    const id = apk.entries.get(apk.iconTarget)?.id;
    if (id !== undefined) lines.push(`      A: ${NS}:icon(0x01010002)=@0x${id.toString(16)}`);
  }
  if (apk.roundTarget) {
    const id = apk.entries.get(apk.roundTarget)?.id;
    if (id !== undefined) lines.push(`      A: ${NS}:roundIcon(0x0101052c)=@0x${id.toString(16)}`);
  }
  lines.push(
    `      A: ${NS}:debuggable(0x0101000f)=true`,
    '    E: activity (line=23)',
    `      A: ${NS}:name(0x01010003)=(type 0x03)"MainActivity"`
  );
  return lines.join('\n') + '\n';
}

/**
 * Writes an executable that answers the way aapt2 would, so the audit is
 * exercised against recorded tool output rather than only a live SDK.
 */
function writeFakeAapt2(name: string, apk: FakeApk): string {
  const script = join(TMP, name);
  const dumps = [...apk.adaptiveXml.entries()]
    .map(([path, body]) => `if [ "$requested" = "${path}" ]; then\n${body === null
      ? `  echo "aapt2: no such file: $requested" >&2\n  exit 1`
      : `  cat <<'XML'\n${body}XML\n  exit 0`}\nfi\n`)
    .join('\n');
  writeFileSync(script, `#!/bin/sh
requested="\${5:-}"
mode="$1 $2"
case "$mode" in
  "dump xmltree")
    if [ "$requested" = "AndroidManifest.xml" ]; then
      cat <<'MANIFEST'
${manifestTree(apk)}MANIFEST
    else
${dumps}      echo "aapt2: no such file: $requested" >&2
      exit 1
    fi
    ;;
  "dump resources")
    cat <<'RESOURCES'
${resourceDump(apk)}RESOURCES
    ;;
  "dump badging")
    echo "package: name='com.builder.todo' versionCode='1'"
    ;;
  *) exit 1 ;;
esac
`);
  chmodSync(script, 0o755);
  return script;
}

const APK = join(TMP, 'app-debug.apk');

/**
 * Minimal but real zip container.
 *
 * The audit reads the APK's own central directory to decide which density files
 * are actually packaged, so the fixture cannot be a placeholder file the fake
 * `aapt2` happens to ignore: it has to be a genuine archive whose index the
 * verifier can walk.
 */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf-8');
    const comp = deflateRawSync(e.data);
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
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

function writeApk(paths: string[]): string {
  writeFileSync(APK, zip([
    { name: 'AndroidManifest.xml', data: Buffer.from('binary manifest') },
    { name: 'resources.arsc', data: Buffer.from('resource table') },
    ...paths.map((p) => ({ name: p, data: Buffer.from(`pixels for ${p}`) }))
  ]));
  return APK;
}

function audit(apk: FakeApk): ReturnType<typeof auditApkIcon> {
  return auditApkIcon(writeFakeAapt2('aapt2', apk), writeApk(apk.packagedFiles), TMP);
}

/**
 * Drops a path from the archive and from the dump, so the scenario is a build
 * that genuinely never produced the file.
 */
function dropEverywhere(apk: FakeApk, keep: (path: string) => boolean): void {
  apk.packagedFiles = apk.packagedFiles.filter(keep);
  for (const entry of apk.entries.values()) entry.files = entry.files.filter(keep);
}

describe('aapt2 output parsing', () => {
  test('resource ids, qualified names and files are read from a real dump', () => {
    const m = parseResourceDump(resourceDump(goodApk()));
    assert.strictEqual(m.size, 4);
    assert.strictEqual(m.get(ICON_ID)!.name, `mipmap/${ICON_RESOURCE_NAME}`);
    assert.ok(m.get(ICON_ID)!.files.includes(`res/mipmap-xhdpi/${ICON_RESOURCE_NAME}.png`));
    assert.strictEqual(m.get(BACKGROUND_ID)!.name, `color/${ICON_BACKGROUND_COLOR_NAME}`);
  });

  test('icon and roundIcon are read from the application element', () => {
    const ids = parseApplicationIcons(manifestTree(goodApk()));
    assert.strictEqual(ids.icon, ICON_ID);
    assert.strictEqual(ids.roundIcon, ROUND_ID);
  });

  test('an attribute on a later element is not mistaken for the application icon', () => {
    const tree = '  E: application\n    E: activity\n      A: android:icon(0x01010002)=(type 0x12)0x7f01dead\n';
    assert.strictEqual(parseApplicationIcons(tree).icon, undefined);
  });

  test('aapt2 URI-qualified attribute names are read', () => {
    // Captured verbatim from build-tools 35.0.0 on a real build. The namespace
    // is a URI, so a matcher that only accepts `android:icon` reports a correct
    // manifest as having no icon at all.
    const tree = [
      'N: http://schemas.android.com/apk/res/android',
      '  E: application (line=19)',
      '    A: http://schemas.android.com/apk/res/android:theme(0x01010000)=@0x7f0a0008',
      '    A: http://schemas.android.com/apk/res/android:label(0x01010001)=@0x7f090002',
      '    A: http://schemas.android.com/apk/res/android:icon(0x01010002)=@0x7f080000',
      '    A: http://schemas.android.com/apk/res/android:debuggable(0x0101000f)=true',
      '    A: http://schemas.android.com/apk/res/android:roundIcon(0x0101052c)=@0x7f080002',
      '    A: http://schemas.android.com/apk/res/android:appComponentFactory(0x0101057a)="androidx.core.app.CoreComponentFactory"',
      ''
    ].join('\n');
    assert.deepStrictEqual(parseApplicationIcons(tree), { icon: 0x7f080000, roundIcon: 0x7f080002 });
  });

  test('the resource id is the referenced value, not the framework attribute id', () => {
    // Both ids sit on the line: 0x01010002 is `android:icon` itself and 0x7f080000
    // is what it points at. Reading the wrong one resolves into the framework
    // package and rejects a correct APK.
    const tree = '  E: application\n    A: android:roundIcon(0x0101052c)=@0x7f080002\n';
    assert.deepStrictEqual(parseApplicationIcons(tree), { roundIcon: 0x7f080002 });
  });

  test('an unrelated attribute containing "icon" is not read as the launcher icon', () => {
    const tree = [
      '  E: application',
      '    A: android:appComponentFactory(0x0101057a)="com.example.IconFactory"',
      '    A: android:icon(0x01010002)=@0x7f080000',
      ''
    ].join('\n');
    assert.strictEqual(parseApplicationIcons(tree).icon, 0x7f080000);
  });

  test('an icon set to a literal string is not treated as a resource reference', () => {
    // A literal cannot be the generated mipmap, so there is nothing to resolve.
    const tree = '  E: application\n    A: android:icon(0x01010002)=(type 0x03)"android/drawable/other"\n';
    assert.strictEqual(parseApplicationIcons(tree).icon, undefined);
  });

  test('a package-qualified resource name is accepted', () => {
    const m = parseResourceDump('      resource 0x7f010000 com.builder.todo:mipmap/ic_launcher\n');
    assert.strictEqual(m.get(ICON_ID)!.name, 'com.builder.todo:mipmap/ic_launcher');
  });
});

describe('aapt2 launcher icon audit', () => {
  test('a correctly built APK passes and names what it resolved', () => {
    const r = audit(goodApk());
    assert.strictEqual(r.valid, true, r.errors.join('; '));
    assert.strictEqual(r.iconResourceId, '0x7f010000');
    assert.strictEqual(r.iconResourceName, `mipmap/${ICON_RESOURCE_NAME}`);
    assert.strictEqual(r.roundResourceName, `mipmap/${ROUND_ICON_RESOURCE_NAME}`);
  });

  test('a manifest with no icon is rejected', () => {
    const apk = goodApk();
    apk.iconTarget = null;
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /no android:icon/.test(e)), r.errors.join('; '));
  });

  test('an icon pointing at the framework package is rejected', () => {
    const apk = goodApk();
    apk.entries.set('drawable/framework_icon', { id: FRAMEWORK_ICON_ID, files: [] });
    apk.iconTarget = 'drawable/framework_icon';
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /package 0x1/.test(e)), r.errors.join('; '));
  });

  test('an icon resolving to a non-mipmap resource is rejected', () => {
    const apk = goodApk();
    apk.entries.set('drawable/ic_launcher_logo', { id: 0x7f050002, files: completeIconFiles() });
    apk.iconTarget = 'drawable/ic_launcher_logo';
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /resolves to drawable\/ic_launcher_logo/.test(e)), r.errors.join('; '));
  });

  test('an icon id that resolves to nothing is rejected', () => {
    const apk = goodApk();
    // The manifest declares an id that the resource table never defines.
    apk.declaredIconId = 0x7f01dead;
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /does not resolve to any resource/.test(e)), r.errors.join('; '));
  });

  test('a missing legacy density is reported by name', () => {
    const apk = goodApk();
    dropEverywhere(apk, (f) => f !== `res/mipmap-xxhdpi/${ICON_RESOURCE_NAME}.png`);
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /mipmap-xxhdpi\/ic_launcher\.png/.test(x)), r.errors.join('; '));
  });

  test('a missing round density is reported by name', () => {
    const apk = goodApk();
    dropEverywhere(apk, (f) => f !== `res/mipmap-hdpi/${ROUND_ICON_RESOURCE_NAME}.png`);
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /mipmap-hdpi\/ic_launcher_round\.png/.test(x)), r.errors.join('; '));
  });

  test('a missing adaptive foreground density is reported by name', () => {
    const apk = goodApk();
    dropEverywhere(apk, (f) => f !== `res/mipmap-xhdpi/${FOREGROUND_RESOURCE_NAME}.png`);
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /ic_launcher_foreground\.png/.test(x)), r.errors.join('; '));
  });

  test('a missing adaptive configuration is rejected', () => {
    const apk = goodApk();
    dropEverywhere(apk, (f) => !f.includes('anydpi'));
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /adaptive icon is unreachable/.test(x)), r.errors.join('; '));
  });

  test('a build-tools dump that lists no density files is still accepted', () => {
    // `aapt2 dump resources` only lists per-entry file paths in some versions;
    // in others the entry carries just its id. Those file paths are the one
    // part of the dump that is not a stable contract, so a dump with none must
    // not fail a build whose archive really does contain every density.
    const apk = goodApk();
    for (const entry of apk.entries.values()) entry.files = [];
    const r = audit(apk);
    assert.strictEqual(r.valid, true, r.errors.join('; '));
  });

  test('a density the archive lacks is rejected even when the dump claims it', () => {
    // The archive is the artifact, so it outranks the dump: listing a path in
    // `aapt2 dump resources` cannot substitute for shipping the file.
    const apk = goodApk();
    apk.packagedFiles = apk.packagedFiles.filter((f) => f !== `res/mipmap-xxxhdpi/${ICON_RESOURCE_NAME}.png`);
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /does not package res\/mipmap-xxxhdpi\/ic_launcher\.png/.test(x)), r.errors.join('; '));
  });

  test('an adaptive icon wired to the wrong foreground is rejected', () => {
    const apk = goodApk();
    apk.entries.set('mipmap/ic_other_foreground', { id: OTHER_FOREGROUND_ID, files: [] });
    apk.adaptiveXml = new Map([...apk.adaptiveXml].map(([k]) => [k, adaptiveXmlTree(BACKGROUND_ID, OTHER_FOREGROUND_ID)] as [string, string]));
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /does not reference ic_launcher_foreground/.test(x)), r.errors.join('; '));
  });

  test('an adaptive icon with no background colour is rejected', () => {
    const apk = goodApk();
    apk.adaptiveXml = new Map([...apk.adaptiveXml.keys()].map((k) => [k, adaptiveXmlTree(null, FOREGROUND_ID)] as [string, string]));
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /does not reference ic_launcher_background/.test(x)), r.errors.join('; '));
  });

  test('an adaptive configuration that cannot be dumped is rejected', () => {
    const apk = goodApk();
    apk.adaptiveXml = new Map([...apk.adaptiveXml.keys()].map((k) => [k, null] as [string, null]));
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /could not be dumped as compiled XML/.test(x)), r.errors.join('; '));
  });

  test('a roundIcon pointing elsewhere is rejected', () => {
    const apk = goodApk();
    apk.roundTarget = `mipmap/${ICON_RESOURCE_NAME}`;
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /roundIcon resolves to/.test(x)), r.errors.join('; '));
  });

  test('a manifest with no roundIcon is rejected', () => {
    // Round launchers and the recents carousel would otherwise fall back to a
    // different image than the one this repo generated and proved.
    const apk = goodApk();
    apk.roundTarget = null;
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /no android:roundIcon/.test(x)), r.errors.join('; '));
  });

  test('an APK with no resources at all is rejected', () => {
    const apk = goodApk();
    apk.entries.clear();
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /no resources in the APK/.test(x)), r.errors.join('; '));
  });

  test('every failing reason is reported at once, not just the first', () => {
    const apk = goodApk();
    dropEverywhere(apk, (f) => f !== `res/mipmap-hdpi/${ICON_RESOURCE_NAME}.png`);
    apk.adaptiveXml = new Map([...apk.adaptiveXml.keys()].map((k) => [k, null] as [string, null]));
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.length >= 2, r.errors.join('; '));
    assert.ok(r.errors.some((x) => /mipmap-hdpi\/ic_launcher\.png/.test(x)), r.errors.join('; '));
    assert.ok(r.errors.some((x) => /could not be dumped/.test(x)), r.errors.join('; '));
  });
});