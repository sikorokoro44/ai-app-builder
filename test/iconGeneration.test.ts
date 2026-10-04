import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { encodePng, decodePng, readPngInfo } from '../scripts/live/png.ts';
import { decideIcon } from '../scripts/iconCatalog.ts';
import {
  writeLauncherIcon, validateLauncherIcon, launcherIconFingerprint,
  expectedIconResources, sourceIconSignatures, sourceForegroundSignatures, sourceIconPngBytes,
  ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME, FOREGROUND_RESOURCE_NAME, ICON_BACKGROUND_COLOR_NAME
} from '../scripts/live/launcherIcon.ts';
import { renderIcon, iconStatistics, iconSignature, signatureDistance } from '../scripts/live/iconRaster.ts';
import { validateGeneratedProject } from '../scripts/live/projectValidator.ts';
import { generateAndroidApp } from '../scripts/generateAndroidApp.ts';
import { LEGACY_ICON_SIZES, FOREGROUND_ICON_SIZES } from '../scripts/iconCatalog.ts';

const TMP = join(process.env.PREFIX || process.env.HOME, 'tmp', 'opencode', 'builder-test-icon');

function fresh(name: string): string {
  const root = join(TMP, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function res(projectRoot: string, rel: string): string {
  return join(projectRoot, 'app', 'src', 'main', 'res', rel);
}

function setManifest(projectRoot: string, attrs: string): void {
  const p = join(projectRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
  mkdirSync(join(projectRoot, 'app', 'src', 'main'), { recursive: true });
  writeFileSync(p, `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:label="X" ${attrs}>
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
    </activity>
  </application>
</manifest>
`);
}

const ICON_ATTRS = `android:icon="@mipmap/${ICON_RESOURCE_NAME}" android:roundIcon="@mipmap/${ROUND_ICON_RESOURCE_NAME}"`;

describe('PNG codec', () => {
  test('an encoded RGBA image decodes back to the same pixels', () => {
    const w = 7, h = 5;
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = (i * 7) % 256;
      rgba[i * 4 + 1] = (i * 13) % 256;
      rgba[i * 4 + 2] = (i * 29) % 256;
      rgba[i * 4 + 3] = i % 2 ? 255 : 0;
    }
    const png = encodePng(w, h, rgba);
    const back = decodePng(png)!;
    assert.strictEqual(back.width, w);
    assert.strictEqual(back.height, h);
    assert.deepStrictEqual(back.rgba, rgba);
  });

  test('a PNG carries the dimensions and an alpha channel', () => {
    const png = encodePng(4, 3, Buffer.alloc(4 * 3 * 4, 200));
    const info = readPngInfo(png)!;
    assert.strictEqual(info.structurallyValid, true, info.errors.join('; '));
    assert.strictEqual(info.width, 4);
    assert.strictEqual(info.height, 3);
    assert.strictEqual(info.colorType, 6, 'generated icons must be RGBA so the foreground layer can be transparent');
  });

  test('a corrupted CRC is detected instead of silently decoded', () => {
    const png = encodePng(8, 8, Buffer.alloc(8 * 8 * 4, 90));
    const bad = Buffer.from(png);
    bad[bad.length - 5] ^= 0xff;
    const info = readPngInfo(bad);
    assert.ok(!info!.structurallyValid, 'a bad CRC must not read as structurally valid');
  });

  test('a truncated PNG is rejected', () => {
    const png = encodePng(8, 8, Buffer.alloc(8 * 8 * 4, 90));
    const info = readPngInfo(png.subarray(0, png.length - 10));
    assert.ok(!info!.structurallyValid);
  });

  test('non-PNG bytes are rejected rather than guessed at', () => {
    const info = readPngInfo(Buffer.from('not a png at all'));
    assert.ok(info, 'a caller should get a verdict, not a crash');
    assert.strictEqual(info!.structurallyValid, false);
    assert.ok(info!.errors.length > 0);
    assert.strictEqual(decodePng(Buffer.from('not a png at all')), null);
  });
});

describe('icon category selection', () => {
  test('each domain picks a category that matches the purpose', () => {
    const cases: [string, string][] = [
      ['A todo list app', 'tasks'],
      ['A note taking journal', 'notes'],
      ['A pomodoro focus timer', 'timer'],
      ['A recipe organiser for my kitchen', 'recipes'],
      ['An expense tracker with budget', 'finance'],
      ['A vocabulary deck for exams', 'study'],
      ['A habit tracker with daily streaks', 'habits'],
      ['A contact phonebook', 'contacts'],
      ['A book reading list', 'media']
    ];
    for (const [idea, category] of cases) {
      assert.strictEqual(decideIcon(idea).definition.category, category, idea);
    }
  });

  test('the decision is deterministic and explains itself', () => {
    const a = decideIcon('A recipe organiser', 'Recipes');
    const b = decideIcon('A recipe organiser', 'Recipes');
    assert.strictEqual(a.definition.category, b.definition.category);
    assert.strictEqual(a.reason, b.reason);
    assert.ok(a.reason.length > 0, 'a decision must record why it was made');
  });

  test('an unrecognised idea still yields a designed icon, not a placeholder', () => {
    const d = decideIcon('zzz qqq unrecognisable nonsense xyzzy');
    assert.ok(d.definition.category.length > 0);
    assert.strictEqual(d.definition.glyph.length > 0, true, 'a fallback icon still needs a real glyph');
  });

  test('two different unrecognised ideas do not collapse to one identical icon', () => {
    const a = decideIcon('zzz qqq alpha one').definition;
    const b = decideIcon('zzz qqq beta two').definition;
    assert.ok(
      JSON.stringify(a.palette) !== JSON.stringify(b.palette) || JSON.stringify(a.glyph) !== JSON.stringify(b.glyph),
      'unrelated fallback apps must not share a single icon'
    );
  });
});

describe('rasterised icons look like icons', () => {
  test('the legacy icon fills its canvas and is not flat', () => {
    const def = decideIcon('A todo list app').definition;
    const img = decodePng(encodePng(96, 96, renderIcon(def, 96, 'legacy')))!;
    const st = iconStatistics(img.rgba, img.width, img.height);
    assert.ok(st.opaqueFraction > 0.8, `legacy icon should fill its canvas, got ${st.opaqueFraction}`);
    assert.ok(st.distinctColours >= 6, `expected a gradient, got ${st.distinctColours} colours`);
    assert.ok(st.contrastFraction >= 0.06, `expected a visible glyph, got ${st.contrastFraction}`);
  });

  test('the round variant is a circle, not a square', () => {
    const def = decideIcon('A todo list app').definition;
    const round = decodePng(encodePng(96, 96, renderIcon(def, 96, 'round')))!;
    const legacy = decodePng(encodePng(96, 96, renderIcon(def, 96, 'legacy')))!;
    const alpha = (img: typeof round, x: number, y: number) => img.rgba[(y * img.width + x) * 4 + 3];
    assert.ok(alpha(round, 48, 48) > 200, 'centre must be opaque');
    // A rounded-square legacy icon is opaque at the corner; the round icon must
    // not be, or the two variants are indistinguishable.
    // Near the corner the rounded square is still filled while the circle is not,
    // which is exactly what makes the two variants distinguishable.
    assert.ok(alpha(round, 10, 10) < 20, 'a point near the corner is outside the circle');
    assert.ok(alpha(legacy, 10, 10) > 200, 'but inside the rounded square');
    // And the transparent area must be the corners specifically, not a band.
    assert.ok(alpha(round, 48, 3) > 200, 'the middle of the top edge is inside the circle');
  });

  test('the adaptive foreground is a thin glyph on transparency', () => {
    const def = decideIcon('A todo list app').definition;
    const img = decodePng(encodePng(216, 216, renderIcon(def, 216, 'foreground')))!;
    const st = iconStatistics(img.rgba, img.width, img.height);
    assert.ok(st.opaqueFraction > 0.005, 'the foreground must actually draw something');
    assert.ok(st.opaqueFraction < 0.85, 'the foreground must leave the background layer visible');
  });

  test('rendering is deterministic', () => {
    const def = decideIcon('A habit tracker').definition;
    assert.deepStrictEqual(renderIcon(def, 96, 'legacy'), renderIcon(def, 96, 'legacy'));
  });

  test('different categories produce different pictures', () => {
    const a = iconSignature(renderIcon(decideIcon('A todo list app').definition, 96, 'legacy'), 96, 96);
    const b = iconSignature(renderIcon(decideIcon('A recipe organiser').definition, 96, 'legacy'), 96, 96);
    assert.ok(signatureDistance(a, b) > 5, 'a task app and a recipe app must not share one icon');
  });
});

describe('generated launcher icon resources', () => {
  test('every density of legacy, round and foreground is written', () => {
    const root = fresh('all-densities');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app', 'Todo');
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, true, v.errors.join('; '));
    for (const density of Object.keys(LEGACY_ICON_SIZES)) {
      assert.ok(existsSync(res(root, `mipmap-${density}/${ICON_RESOURCE_NAME}.png`)), density);
      assert.ok(existsSync(res(root, `mipmap-${density}/${ROUND_ICON_RESOURCE_NAME}.png`)), density);
      assert.ok(existsSync(res(root, `mipmap-${density}/${FOREGROUND_RESOURCE_NAME}.png`)), density);
    }
    assert.deepStrictEqual(v.densities, Object.keys(LEGACY_ICON_SIZES).sort());
  });

  test('each PNG is the size its density bucket requires', () => {
    const root = fresh('sizes');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    for (const { path, size, kind } of expectedIconResources()) {
      const info = readPngInfo(readFileSync(res(root, path)))!;
      assert.ok(info.structurallyValid, `${path} is not a valid PNG`);
      assert.strictEqual(info.width, size, path);
      assert.strictEqual(info.height, size, path);
      const expected = kind === 'foreground' ? FOREGROUND_ICON_SIZES : LEGACY_ICON_SIZES;
      const density = path.split('/')[0].replace('mipmap-', '');
      assert.strictEqual(size, expected[density as keyof typeof expected], `${path} has the wrong density size`);
    }
  });

  test('the adaptive icon wires up a background colour and foreground layer', () => {
    const root = fresh('adaptive');
    const def = decideIcon('A todo list app').definition;
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    for (const name of [ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME]) {
      const xml = readFileSync(res(root, `mipmap-anydpi-v26/${name}.xml`), 'utf-8');
      assert.match(xml, /<adaptive-icon/);
      assert.match(xml, new RegExp(`<background android:drawable="@color/${ICON_BACKGROUND_COLOR_NAME}"`));
      assert.match(xml, new RegExp(`<foreground android:drawable="@mipmap/${FOREGROUND_RESOURCE_NAME}"`));
    }
    const colors = readFileSync(res(root, 'values/ic_launcher_colors.xml'), 'utf-8');
    assert.match(colors, new RegExp(`<color name="${ICON_BACKGROUND_COLOR_NAME}">#[0-9A-F]{8}</color>`));
    // The declared colour has to be the palette this category actually uses.
    assert.ok(colors.includes(def.palette.to.replace('#', '').toUpperCase()));
  });

  test('the manifest references mipmap resources, not a drawable vector', () => {
    const root = fresh('manifest');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.manifestIcon, `@mipmap/${ICON_RESOURCE_NAME}`);
    assert.strictEqual(v.manifestRoundIcon, `@mipmap/${ROUND_ICON_RESOURCE_NAME}`);
  });

  test('the stale generic vector drawable is removed', () => {
    const root = fresh('stale-vector');
    setManifest(root, ICON_ATTRS);
    mkdirSync(res(root, 'drawable'), { recursive: true });
    writeFileSync(res(root, `drawable/${ICON_RESOURCE_NAME}.xml`), '<vector/>');
    writeLauncherIcon(root, 'A todo list app');
    assert.ok(!existsSync(res(root, `drawable/${ICON_RESOURCE_NAME}.xml`)),
      'a leftover vector would be a second, misleading launcher icon');
  });

  test('generation is byte-for-byte reproducible', () => {
    const a = fresh('determinism-a');
    const b = fresh('determinism-b');
    setManifest(a, ICON_ATTRS);
    setManifest(b, ICON_ATTRS);
    const da = writeLauncherIcon(a, 'A recipe organiser', 'Recipes');
    const db = writeLauncherIcon(b, 'A recipe organiser', 'Recipes');
    assert.strictEqual(da.fingerprint, db.fingerprint);
    assert.strictEqual(launcherIconFingerprint(a), launcherIconFingerprint(b));
    for (const { path } of expectedIconResources()) {
      assert.deepStrictEqual(readFileSync(res(a, path)), readFileSync(res(b, path)), path);
    }
  });

  test('the fingerprint changes when the icon changes', () => {
    const a = fresh('fp-a');
    const b = fresh('fp-b');
    setManifest(a, ICON_ATTRS);
    setManifest(b, ICON_ATTRS);
    const fa = writeLauncherIcon(a, 'A todo list app').fingerprint;
    const fb = writeLauncherIcon(b, 'A recipe organiser').fingerprint;
    assert.notStrictEqual(fa, fb, 'different categories must produce different icon sets');
  });

  test('the decision is reported for the evidence chain', () => {
    const root = fresh('decision');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A pomodoro focus timer');
    const v = validateLauncherIcon(root, 'A pomodoro focus timer');
    assert.strictEqual(v.valid, true, v.errors.join('; '));
    assert.strictEqual(v.category, 'timer');
    assert.ok(v.purpose && v.purpose.length > 0);
    assert.ok(v.reason && v.reason.length > 0);
    assert.ok(v.fingerprint && /^[0-9a-f]{64}$/.test(v.fingerprint));
    assert.ok((v.files || []).length >= 15);
  });
});

describe('launcher icon validation rejects unusable icons', () => {
  test('a manifest with no icon is rejected', () => {
    const root = fresh('no-icon');
    setManifest(root, '');
    writeLauncherIcon(root, 'A todo list app');
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /declares no android:icon/.test(e)), v.errors.join('; '));
  });

  test('a manifest pointing at a drawable instead of a mipmap is rejected', () => {
    const root = fresh('drawable-icon');
    setManifest(root, `android:icon="@drawable/${ICON_RESOURCE_NAME}"`);
    writeLauncherIcon(root, 'A todo list app');
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /must reference a @mipmap/.test(e)), v.errors.join('; '));
  });

  test('a missing density is named explicitly', () => {
    const root = fresh('missing-density');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    rmSync(res(root, `mipmap-xhdpi/${ICON_RESOURCE_NAME}.png`));
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /mipmap-xhdpi\/ic_launcher\.png/.test(e)), v.errors.join('; '));
  });

  test('a corrupt PNG is rejected rather than shipped', () => {
    const root = fresh('corrupt');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    const p = res(root, `mipmap-hdpi/${ICON_RESOURCE_NAME}.png`);
    const bytes = readFileSync(p);
    bytes[30] ^= 0xff;
    writeFileSync(p, bytes);
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /Malformed PNG/.test(e)), v.errors.join('; '));
  });

  test('an empty file is rejected', () => {
    const root = fresh('empty');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    writeFileSync(res(root, `mipmap-mdpi/${ICON_RESOURCE_NAME}.png`), '');
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /Empty launcher icon resource/.test(e)), v.errors.join('; '));
  });

  test('a flat single-colour placeholder is rejected', () => {
    const root = fresh('flat');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    // A solid fill: valid PNG, right dimensions, but no design at all.
    for (const { path, size } of expectedIconResources()) {
      const rgba = Buffer.alloc(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        rgba[i * 4] = 30; rgba[i * 4 + 1] = 90; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 255;
      }
      writeFileSync(res(root, path), encodePng(size, size, rgba));
    }
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /placeholder|no visible glyph/.test(e)), v.errors.join('; '));
  });

  test('an empty adaptive foreground is rejected', () => {
    const root = fresh('empty-foreground');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    const { size } = expectedIconResources().find((r) => r.kind === 'foreground' && r.path.includes('xhdpi'))!;
    writeFileSync(res(root, `mipmap-xhdpi/${FOREGROUND_RESOURCE_NAME}.png`), encodePng(size, size, Buffer.alloc(size * size * 4)));
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /foreground is empty/.test(e)), v.errors.join('; '));
  });

  test('a missing adaptive icon is rejected', () => {
    const root = fresh('no-adaptive');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    rmSync(res(root, `mipmap-anydpi-v26/${ICON_RESOURCE_NAME}.xml`));
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /Missing adaptive icon/.test(e)), v.errors.join('; '));
  });

  test('an adaptive icon that is not one is rejected', () => {
    const root = fresh('not-adaptive');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    writeFileSync(res(root, `mipmap-anydpi-v26/${ICON_RESOURCE_NAME}.xml`), '<layer-list/>');
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /not an <adaptive-icon>/.test(e)), v.errors.join('; '));
  });

  test('a missing adaptive background colour is rejected', () => {
    const root = fresh('no-colors');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    rmSync(res(root, 'values/ic_launcher_colors.xml'));
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /ic_launcher_colors\.xml/.test(e)), v.errors.join('; '));
  });

  test('an adaptive foreground pointing at nothing is rejected', () => {
    const root = fresh('dangling-fg');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    for (const name of [ICON_RESOURCE_NAME, ROUND_ICON_RESOURCE_NAME]) {
      const p = res(root, `mipmap-anydpi-v26/${name}.xml`);
      writeFileSync(p, readFileSync(p, 'utf-8').replace(
        `<foreground android:drawable="@mipmap/${FOREGROUND_RESOURCE_NAME}" />`,
        '<foreground android:drawable="@mipmap/does_not_exist" />'
      ));
    }
    const v = validateLauncherIcon(root, 'A todo list app');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /does not resolve/.test(e)), v.errors.join('; '));
  });
});

describe('expected signatures for the compiled-artifact check', () => {
  test('one signature per density is produced, keyed by pixel size', () => {
    const root = fresh('signatures');
    setManifest(root, ICON_ATTRS);
    writeLauncherIcon(root, 'A todo list app');
    const legacy = sourceIconSignatures(root);
    const foreground = sourceForegroundSignatures(root);
    assert.deepStrictEqual([...legacy.keys()].sort((a, b) => a - b), Object.values(LEGACY_ICON_SIZES).sort((a, b) => a - b));
    assert.deepStrictEqual([...foreground.keys()].sort((a, b) => a - b), Object.values(FOREGROUND_ICON_SIZES).sort((a, b) => a - b));
    assert.strictEqual(sourceIconPngBytes(root).size, Object.keys(LEGACY_ICON_SIZES).length);
  });

  test('signatures of a different icon are far apart', () => {
    const a = fresh('sig-a');
    const b = fresh('sig-b');
    setManifest(a, ICON_ATTRS);
    setManifest(b, ICON_ATTRS);
    writeLauncherIcon(a, 'A todo list app');
    writeLauncherIcon(b, 'A recipe organiser');
    const size = LEGACY_ICON_SIZES.xhdpi;
    const d = signatureDistance(sourceIconSignatures(a).get(size)!, sourceIconSignatures(b).get(size)!);
    assert.ok(d > 20, `different icons must not compare as the same picture (distance ${d})`);
  });
});

describe('the real generator produces a shippable launcher icon', () => {
  test('a generated app validates and reports its icon decision', () => {
    const root = join(TMP, 'generated');
    rmSync(root, { recursive: true, force: true });
    const result = generateAndroidApp({ idea: 'A pomodoro focus timer', outDir: root });
    const v = validateGeneratedProject(root, 'A pomodoro focus timer');
    assert.strictEqual(v.valid, true, v.errors.join('; '));
    assert.ok(v.launcherIcon?.valid);
    assert.strictEqual(v.launcherIcon?.category, 'timer');
    assert.strictEqual(result.icon.category, 'timer');
    assert.ok(result.icon.fingerprint);
  });

  test('a generated app gets an icon matching its domain, not a shared one', () => {
    const todo = generateAndroidApp({ idea: 'A todo list app', outDir: join(TMP, 'gen-todo') });
    const recipe = generateAndroidApp({ idea: 'A recipe organiser', outDir: join(TMP, 'gen-recipe') });
    assert.notStrictEqual(todo.icon.fingerprint, recipe.icon.fingerprint);
    assert.strictEqual(todo.icon.category, 'tasks');
    assert.strictEqual(recipe.icon.category, 'recipes');
  });

  test('the committed generated fixture carries a real launcher icon', () => {
    const root = join(process.cwd(), '.builder', 'generated', 'android');
    const v = validateGeneratedProject(root, 'A simple todo app');
    assert.strictEqual(v.valid, true, v.errors.join('; '));
    assert.ok(v.launcherIcon?.valid, 'the committed fixture must ship a valid icon');
  });
});