import { test, describe } from 'node:test';
import assert from 'node:assert';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
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
}

/** A compiled resource XML references layers by resource id, not by name. */
function adaptiveXmlTree(backgroundId: number | null, foregroundId: number): string {
  const lines = ['N: http://schemas.android.com/apk/res/android', '  E: adaptive-icon (line=2)'];
  if (backgroundId !== null) {
    lines.push('    E: background', `      A: android:drawable(0x01010199)=(type 0x12)0x${backgroundId.toString(16)}`);
  }
  lines.push('    E: foreground', `      A: android:drawable(0x01010199)=(type 0x12)0x${foregroundId.toString(16)}`);
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
    adaptiveXml
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

function manifestTree(apk: FakeApk): string {
  const lines = [
    'N: android=http://schemas.android.com/apk/res/android',
    '  E: manifest',
    '    E: application',
    '      A: android:label(0x01010001)=(type 0x03)"Todo"'
  ];
  if (apk.declaredIconId !== undefined) {
    lines.push(`      A: android:icon(0x01010002)=(type 0x12)0x${apk.declaredIconId.toString(16)}`);
  } else if (apk.iconTarget) {
    const id = apk.entries.get(apk.iconTarget)?.id;
    if (id !== undefined) lines.push(`      A: android:icon(0x01010002)=(type 0x12)0x${id.toString(16)}`);
  }
  if (apk.roundTarget) {
    const id = apk.entries.get(apk.roundTarget)?.id;
    if (id !== undefined) lines.push(`      A: android:roundIcon(0x0101052c)=(type 0x12)0x${id.toString(16)}`);
  }
  lines.push('    E: activity', '      A: android:name(0x01010003)=(type 0x03)"MainActivity"');
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
writeFileSync(APK, 'placeholder: the fake aapt2 never reads the APK');

function audit(apk: FakeApk): ReturnType<typeof auditApkIcon> {
  return auditApkIcon(writeFakeAapt2('aapt2', apk), APK, TMP);
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
    const e = apk.entries.get(`mipmap/${ICON_RESOURCE_NAME}`)!;
    e.files = e.files.filter((f) => f !== `res/mipmap-xxhdpi/${ICON_RESOURCE_NAME}.png`);
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /mipmap-xxhdpi\/ic_launcher\.png/.test(x)), r.errors.join('; '));
  });

  test('a missing round density is reported by name', () => {
    const apk = goodApk();
    const e = apk.entries.get(`mipmap/${ICON_RESOURCE_NAME}`)!;
    e.files = e.files.filter((f) => f !== `res/mipmap-hdpi/${ROUND_ICON_RESOURCE_NAME}.png`);
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /mipmap-hdpi\/ic_launcher_round\.png/.test(x)), r.errors.join('; '));
  });

  test('a missing adaptive foreground density is reported by name', () => {
    const apk = goodApk();
    const e = apk.entries.get(`mipmap/${ICON_RESOURCE_NAME}`)!;
    e.files = e.files.filter((f) => f !== `res/mipmap-xhdpi/${FOREGROUND_RESOURCE_NAME}.png`);
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /ic_launcher_foreground\.png/.test(x)), r.errors.join('; '));
  });

  test('a missing adaptive configuration is rejected', () => {
    const apk = goodApk();
    const e = apk.entries.get(`mipmap/${ICON_RESOURCE_NAME}`)!;
    e.files = e.files.filter((f) => !f.includes('anydpi'));
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /adaptive icon is unreachable/.test(x)), r.errors.join('; '));
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

  test('an APK with no resources at all is rejected', () => {
    const apk = goodApk();
    apk.entries.clear();
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((x) => /no resources in the APK/.test(x)), r.errors.join('; '));
  });

  test('every failing reason is reported at once, not just the first', () => {
    const apk = goodApk();
    const e = apk.entries.get(`mipmap/${ICON_RESOURCE_NAME}`)!;
    e.files = e.files.filter((f) => f !== `res/mipmap-hdpi/${ICON_RESOURCE_NAME}.png`);
    apk.adaptiveXml = new Map([...apk.adaptiveXml.keys()].map((k) => [k, null] as [string, null]));
    const r = audit(apk);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.length >= 2, r.errors.join('; '));
    assert.ok(r.errors.some((x) => /mipmap-hdpi\/ic_launcher\.png/.test(x)), r.errors.join('; '));
    assert.ok(r.errors.some((x) => /could not be dumped/.test(x)), r.errors.join('; '));
  });
});