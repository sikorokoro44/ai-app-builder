import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync, existsSync, unlinkSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { validateGeneratedProject } from '../scripts/live/projectValidator.ts';
import { generateAndroidApp, derivePackageId, deriveAppName } from '../scripts/generateAndroidApp.ts';
import { specForIdea, allSpecs, normalizeSpec, numericRoles } from '../scripts/domainModels.ts';
import { lintGeneratedSources, errorsOf } from '../scripts/live/kotlinLint.ts';

const IDEAS = [
  'A todo list app',
  'A note taking journal',
  'A recipe organiser for my kitchen',
  'An expense tracker with budget',
  'A flashcard study app',
  'A pomodoro focus timer',
  'A habit tracker with daily streaks',
  'A contact phonebook',
  'A book reading list'
];

const TMP = join(process.env.PREFIX || process.env.HOME, 'tmp', 'opencode', 'builder-test-project');

before(() => rmSync(TMP, { recursive: true, force: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

function scaffold(root: string) {
  mkdirSync(join(root, 'app/src/main/java/com/x/y'), { recursive: true });
  mkdirSync(join(root, 'app/src/main/res/values'), { recursive: true });
  mkdirSync(join(root, 'app/src/test/java/com/x/y'), { recursive: true });
  mkdirSync(join(root, 'gradle/wrapper'), { recursive: true });
  writeFileSync(join(root, 'settings.gradle.kts'), 'rootProject.name = "x"\ninclude(":app")\n');
  writeFileSync(join(root, 'build.gradle.kts'), 'allprojects { repositories { google(); mavenCentral() } }\n');
  writeFileSync(join(root, 'gradle.properties'), 'android.useAndroidX=true\n');
  writeFileSync(join(root, 'app/proguard-rules.pro'), '');
  writeFileSync(join(root, 'app/build.gradle.kts'), `plugins { id("com.android.application") }
android {
    namespace = "com.x.y"
    compileSdk = 34
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    defaultConfig {
        applicationId = "com.x.y"
        minSdk = 24
        targetSdk = 34
    }
    buildTypes { release { isMinifyEnabled = false } }
}
dependencies { implementation("androidx.core:core-ktx:1.13.1") }
`);
  writeFileSync(join(root, 'app/src/main/AndroidManifest.xml'), `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:label="X">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
    </activity>
  </application>
</manifest>
`);
  writeFileSync(join(root, 'app/src/main/java/com/x/y/MainActivity.kt'), 'package com.x.y\nclass MainActivity\n');
  writeFileSync(join(root, 'app/src/test/java/com/x/y/MainTest.kt'), 'package com.x.y\nclass MainTest\n');
  writeFileSync(join(root, 'app/src/main/res/values/strings.xml'), '<resources><string name="app_name">X</string></resources>');
}

describe('generated project validation', () => {
  test('a complete project passes and reports its package id', () => {
    const root = join(TMP, 'good');
    scaffold(root);
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, true, r.errors.join('; '));
    assert.strictEqual(r.packageId, 'com.x.y');
  });

  test('an empty directory is rejected with useful errors', () => {
    const root = join(TMP, 'empty');
    mkdirSync(root, { recursive: true });
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.length >= 5);
    assert.ok(r.errors.some((e) => e.includes('settings.gradle.kts')));
  });

  const removals: [string, RegExp][] = [
    ['settings.gradle.kts', /settings\.gradle\.kts/],
    ['build.gradle.kts', /build\.gradle\.kts/],
    ['gradle.properties', /gradle\.properties/],
    ['app/build.gradle.kts', /app\/build\.gradle\.kts/],
    ['app/src/main/AndroidManifest.xml', /AndroidManifest\.xml/]
  ];
  for (const [file, pattern] of removals) {
    test(`missing ${file} is rejected`, () => {
      const root = join(TMP, `rm-${file.replace(/\//g, '_')}`);
      scaffold(root);
      unlinkSync(join(root, file));
      const r = validateGeneratedProject(root);
      assert.strictEqual(r.valid, false);
      assert.ok(r.errors.some((e) => pattern.test(e)), r.errors.join('; '));
    });
  }

  test('an empty gradle file is rejected', () => {
    const root = join(TMP, 'emptyfile');
    scaffold(root);
    writeFileSync(join(root, 'gradle.properties'), '');
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /Empty file/.test(e)));
  });

  test('a missing applicationId is rejected', () => {
    const root = join(TMP, 'noappid');
    scaffold(root);
    writeFileSync(join(root, 'app/build.gradle.kts'), 'android { namespace = "com.x.y" compileSdk = 34 buildTypes { } }');
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /applicationId/.test(e)));
  });

  test('an invalid applicationId format is rejected', () => {
    const root = join(TMP, 'badappid');
    scaffold(root);
    const c = readFileSync(join(root, 'app/build.gradle.kts'), 'utf-8').replace('applicationId = "com.x.y"', 'applicationId = "nodots"');
    writeFileSync(join(root, 'app/build.gradle.kts'), c);
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /Invalid applicationId format/.test(e)));
  });

  test('a missing namespace is rejected', () => {
    const root = join(TMP, 'nons');
    scaffold(root);
    const c = readFileSync(join(root, 'app/build.gradle.kts'), 'utf-8').replace('namespace = "com.x.y"', '');
    writeFileSync(join(root, 'app/build.gradle.kts'), c);
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /namespace/.test(e)));
  });

  test('a missing compileSdk is rejected', () => {
    const root = join(TMP, 'nosdk');
    scaffold(root);
    const c = readFileSync(join(root, 'app/build.gradle.kts'), 'utf-8').replace('compileSdk = 34', '');
    writeFileSync(join(root, 'app/build.gradle.kts'), c);
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /compileSdk/.test(e)));
  });

  test('settings that do not include :app are rejected', () => {
    const root = join(TMP, 'nosettingsapp');
    scaffold(root);
    writeFileSync(join(root, 'settings.gradle.kts'), 'rootProject.name = "x"\n');
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /include.*:app/.test(e)), r.errors.join('; '));
  });

  test('a manifest with no launcher intent is rejected', () => {
    const root = join(TMP, 'nolauncher');
    scaffold(root);
    writeFileSync(join(root, 'app/src/main/AndroidManifest.xml'), '<manifest><application></application></manifest>');
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /MAIN launcher/.test(e)));
  });

  test('no source files is rejected', () => {
    const root = join(TMP, 'nosource');
    scaffold(root);
    unlinkSync(join(root, 'app/src/main/java/com/x/y/MainActivity.kt'));
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /No \.kt\/\.java source files/.test(e)));
  });

  test('a missing res directory is rejected', () => {
    const root = join(TMP, 'nores');
    scaffold(root);
    rmSync(join(root, 'app/src/main/res'), { recursive: true, force: true });
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /res directory/.test(e)));
  });

  test('missing unit tests are rejected', () => {
    const root = join(TMP, 'notest');
    scaffold(root);
    rmSync(join(root, 'app/src/test'), { recursive: true, force: true });
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /unit tests/.test(e)));
  });

  test('a missing strings.xml is rejected', () => {
    const root = join(TMP, 'nostrings');
    scaffold(root);
    unlinkSync(join(root, 'app/src/main/res/values/strings.xml'));
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => /strings\.xml/.test(e)));
  });
});

describe('the real generator produces a valid, idea-derived app', () => {
  test('generating and then validating succeeds', () => {
    const root = join(TMP, 'gen-valid');
    const result = generateAndroidApp({ idea: 'A habit tracker with streaks', outDir: root });
    const r = validateGeneratedProject(root);
    assert.strictEqual(r.valid, true, r.errors.join('; '));
    assert.strictEqual(r.packageId, result.packageId);
    assert.strictEqual(result.packageId, 'com.builder.habittracker');
  });

  test('the generated app contains real behaviour, not a placeholder', () => {
    const root = join(TMP, 'gen-real');
    const r = generateAndroidApp({ idea: 'An errand list', outDir: root });
    assert.strictEqual(r.spec, 'Task');
    const store = readFileSync(join(root, 'app/src/main/java/com/builder/errandlist/TaskStore.kt'), 'utf-8');
    const activity = readFileSync(join(root, 'app/src/main/java/com/builder/errandlist/MainActivity.kt'), 'utf-8');
    assert.match(store, /fun add\(/);
    assert.match(store, /fun toggle\(/);
    assert.match(store, /fun remove\(/);
    assert.match(activity, /@Composable/);
    assert.match(activity, /LazyColumn/);
    assert.ok(!/\bTODO\b|\bFIXME\b|placeholder|not implemented/i.test(store + activity));
  });

  test('a numeric tracker updates exactly the fields its tests assert', () => {
    const root = join(TMP, 'gen-increment');
    generateAndroidApp({ idea: 'A habit tracker with daily streaks', outDir: root });
    const store = readFileSync(join(root, 'app/src/main/java/com/builder/habittracker/EntryStore.kt'), 'utf-8');
    const test = readFileSync(join(root, 'app/src/test/java/com/builder/habittracker/EntryStoreTest.kt'), 'utf-8');
    // increment must advance progress and streak, and must not lower the target.
    assert.match(store, /count = current\.count \+ by/);
    assert.match(store, /streak = current\.streak \+ by/);
    assert.match(store, /target = maxOf\(current\.target, current\.count \+ by\)/);
    assert.doesNotMatch(store, /target = current\.target \+ by/);
    // Every assertion in the generated test must be satisfiable by that store.
    assert.match(test, /assertEquals\(1, store\.find\(created\.id\)\?\.count\)/);
    assert.match(test, /assertEquals\(1, store\.find\(created\.id\)\?\.streak\)/);
    assert.match(test, /assertEquals\(8, store\.find\(created\.id\)\?\.target\)/);
  });

  test('the generated app has real unit tests', () => {
    const root = join(TMP, 'gen-tests');
    generateAndroidApp({ idea: 'An errand list', outDir: root });
    const test = readFileSync(join(root, 'app/src/test/java/com/builder/errandlist/TaskStoreTest.kt'), 'utf-8');
    assert.match(test, /@Test/);
    assert.ok((test.match(/@Test/g) || []).length >= 4);
  });

  test('the idea is recorded in generated sources', () => {
    const root = join(TMP, 'gen-idea');
    generateAndroidApp({ idea: 'A recipe organiser', outDir: root });
    const store = readFileSync(join(root, 'app/src/main/java/com/builder/recipeorganiser/RecipeStore.kt'), 'utf-8');
    assert.ok(store.includes('A recipe organiser'));
  });

  test('regenerating is idempotent and never leaves stale files', () => {
    const root = join(TMP, 'gen-idem');
    generateAndroidApp({ idea: 'A notes app', outDir: root });
    writeFileSync(join(root, 'STALE.txt'), 'stale');
    const a = generateAndroidApp({ idea: 'A notes app', outDir: root });
    const b = generateAndroidApp({ idea: 'A notes app', outDir: root });
    assert.ok(!existsSync(join(root, 'STALE.txt')));
    assert.strictEqual(a.packageId, b.packageId);
    assert.strictEqual(a.spec, b.spec);
    assert.strictEqual(validateGeneratedProject(root).valid, true);
  });

  test('every archetype generates a project that passes validation', () => {
    for (const idea of IDEAS) {
      const root = join(TMP, 'arch-' + derivePackageId(idea));
      let result;
      try {
        result = generateAndroidApp({ idea, outDir: root });
      } catch (e: any) {
        assert.fail(`${idea} threw: ${e.message}`);
      }
      const r = validateGeneratedProject(root);
      assert.strictEqual(r.valid, true, `${idea} -> ${result.spec}: ${r.errors.join('; ')}`);
    }
  });

  test('distinct ideas that share a domain still generate cleanly', () => {
    const specs = new Map<string, string>();
    for (const idea of IDEAS) {
      const result = generateAndroidApp({ idea, outDir: join(TMP, 'dom-' + specs.size) });
      specs.set(result.spec, result.packageId);
    }
    assert.ok(specs.size >= 6, `expected several domains, got ${specs.size}`);
  });

  test('package ids are always valid and derived from the idea', () => {
    for (const idea of ['A todo app', 'Bitcoin price tracker 24/7', '!!!', 'Make me a recipe organiser']) {
      const pkg = derivePackageId(idea);
      assert.match(pkg, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, idea);
    }
  });

  test('app names strip characters that would break XML', () => {
    const name = deriveAppName('A "quoted" <idea> & more');
    assert.ok(!/[<>&"]/.test(name));
  });
});

describe('idea-to-domain selection', () => {
  const cases: [string, string][] = [
    ['A todo list app', 'Task'],
    ['Keep track of my groceries', 'Task'],
    ['A bug report tracker', 'Task'],
    ['A note taking journal', 'Note'],
    ['A pomodoro focus timer', 'Session'],
    ['A parking timer', 'Session'],
    ['A recipe organiser', 'Recipe'],
    ['An expense tracker with budget', 'Expense'],
    ['A vocabulary deck for exams', 'Card'],
    ['A habit tracker with daily streaks', 'Entry'],
    ['A water intake tracker', 'Entry'],
    ['A plant watering schedule', 'Entry'],
    ['A contact phonebook', 'Contact'],
    ['A book reading list', 'Item'],
    ['A gift wishlist', 'Item'],
    ['something completely unrecognised zzz', 'Record']
  ];
  for (const [idea, cls] of cases) {
    test(`${idea} selects ${cls}`, () => {
      assert.strictEqual(specForIdea(idea).className, cls);
    });
  }

  test('every archetype is reachable and never loses an action', () => {
    const seen = new Set<string>();
    for (const spec of allSpecs()) {
      seen.add(spec.className);
      assert.deepStrictEqual(
        normalizeSpec(spec).actions,
        spec.actions,
        `${spec.className} declares an action its fields cannot support`
      );
      assert.ok(spec.fields.some((f) => f.type === 'text'), `${spec.className} has no text field`);
      assert.ok(spec.plural.endsWith('s'), `${spec.className} plural looks wrong`);
    }
    assert.strictEqual(seen.size, 10);
  });

  test('numeric roles pick target, streak and progress deterministically', () => {
    const roles = numericRoles(specForIdea('A habit tracker with daily streaks'));
    assert.strictEqual(roles.target?.name, 'target');
    assert.strictEqual(roles.streak?.name, 'streak');
    assert.strictEqual(roles.progress?.name, 'count');
  });
});

describe('structural lint of generated sources', () => {
  test('an unbalanced paren in Kotlin is reported', () => {
    const findings = lintGeneratedSources({
      files: { 'A.kt': 'package com.x\nfun a() { foo( }\n' },
      packageId: 'com.x',
      stringNames: new Set()
    });
    assert.ok(errorsOf(findings).some((f) => /unbalanced parentheses/.test(f.message)));
  });

  test('a package mismatch is reported', () => {
    const findings = lintGeneratedSources({
      files: { 'A.kt': 'package com.other\nclass A\n' },
      packageId: 'com.x',
      stringNames: new Set()
    });
    assert.ok(errorsOf(findings).some((f) => /does not match applicationId/.test(f.message)));
  });

  test('an undeclared string resource is reported', () => {
    const findings = lintGeneratedSources({
      files: { 'A.kt': 'package com.x\nval a = R.string.missing_label\n' },
      packageId: 'com.x',
      stringNames: new Set(['app_name'])
    });
    assert.ok(errorsOf(findings).some((f) => /R\.string\.missing_label/.test(f.message)));
  });

  test('a string resource used only inside a comment or literal is ignored', () => {
    const findings = lintGeneratedSources({
      files: { 'A.kt': 'package com.x\n// R.string.gone\nval a = "R.string.gone"\n' },
      packageId: 'com.x',
      stringNames: new Set()
    });
    assert.deepStrictEqual(errorsOf(findings), []);
  });

  test('a leftover generator placeholder is reported', () => {
    const findings = lintGeneratedSources({
      files: { 'A.kt': 'package com.x\nval a = "\${PLACEHOLDER_PKG}"\n' },
      packageId: 'com.x',
      stringNames: new Set()
    });
    assert.ok(findings.some((f) => /placeholder/.test(f.message)));
  });

  test('a shadowing local val is reported', () => {
    const findings = lintGeneratedSources({
      files: { 'A.kt': 'package com.x\nfun a() { val name = name.trim() }\n' },
      packageId: 'com.x',
      stringNames: new Set()
    });
    assert.ok(errorsOf(findings).some((f) => /shadows/.test(f.message)));
  });
});

describe('generated sources declare the package the build needs', () => {
  // A source file written with no package line passes every other structural
  // check, then fails the Kotlin build with a wall of "Unresolved reference"
  // errors for its sibling classes and the generated R class. This is the exact
  // defect that only GitHub Actions caught, so it is pinned here.
  test('every generated Kotlin file declares the expected package', async () => {
    const out = join(TMP, 'pkg-ok');
    const { generateAndroidApp } = await import('../scripts/generateAndroidApp.ts');
    const { validateGeneratedProject } = await import('../scripts/live/projectValidator.ts');
    const r = generateAndroidApp({ idea: 'A simple todo app', outDir: out });
    assert.ok(r.packageId);

    const kt = [
      join(out, 'app/src/main/java', r.packageId.replace(/\./g, '/'), 'MainActivity.kt'),
      join(out, 'app/src/main/java', r.packageId.replace(/\./g, '/'), `${r.spec}Store.kt`),
      join(out, 'app/src/test/java', r.packageId.replace(/\./g, '/'), `${r.spec}StoreTest.kt`)
    ];
    for (const f of kt) {
      const src = readFileSync(f, 'utf-8');
      assert.match(src, new RegExp(`^package ${r.packageId.replace(/\./g, '\\.')}\\b`, 'm'),
        `${f} must declare package ${r.packageId}`);
    }
    assert.ok(validateGeneratedProject(out).valid);
  });

  test('a source file with no package declaration is rejected', async () => {
    const out = join(TMP, 'pkg-missing');
    const { generateAndroidApp } = await import('../scripts/generateAndroidApp.ts');
    const { validateGeneratedProject } = await import('../scripts/live/projectValidator.ts');
    const r = generateAndroidApp({ idea: 'A simple todo app', outDir: out });

    const f = join(out, 'app/src/main/java', r.packageId.replace(/\./g, '/'), 'MainActivity.kt');
    writeFileSync(f, readFileSync(f, 'utf-8').replace(`package ${r.packageId}\n\n`, ''));

    const v = validateGeneratedProject(out);
    assert.strictEqual(v.valid, false, 'a package-less source must be rejected before dispatch');
    assert.ok(v.errors.some((e: string) => /MainActivity\.kt has no package declaration/.test(e)),
      `expected a package error, saw: ${v.errors.join(' | ')}`);
  });

  test('a source file declaring a different package is rejected', async () => {
    const out = join(TMP, 'pkg-wrong');
    const { generateAndroidApp } = await import('../scripts/generateAndroidApp.ts');
    const { validateGeneratedProject } = await import('../scripts/live/projectValidator.ts');
    const r = generateAndroidApp({ idea: 'A simple todo app', outDir: out });

    const f = join(out, 'app/src/main/java', r.packageId.replace(/\./g, '/'), `${r.spec}Store.kt`);
    writeFileSync(f, readFileSync(f, 'utf-8').replace(`package ${r.packageId}`, 'package com.other.thing'));

    const v = validateGeneratedProject(out);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e: string) => /declares package com\.other\.thing/.test(e)));
  });
});

describe('row composable callbacks are in scope', () => {
  // The row composable is an extension on LazyListScope that receives its
  // invalidation callback as the parameter `onChanged`. `refresh` belongs to the
  // enclosing activity and is not in scope there, so a `refresh()` call inside
  // the rows function cannot compile. The generated activity called it from both
  // the checkbox and the secondary button; only the Kotlin compiler found it.
  function rowsBody(src: string): string {
    const m = /\bfun\s+(?:[A-Za-z0-9_]+\.)?[A-Za-z0-9_]*Rows\s*\(/.exec(src);
    assert.ok(m, 'generated activity must define a row composable');
    const header = src.slice(m!.index!);
    const open = header.indexOf('{', header.indexOf(')'));
    assert.ok(open > 0);
    let depth = 0;
    for (let i = open; i < header.length; i++) {
      if (header[i] === '{') depth++;
      else if (header[i] === '}') {
        depth--;
        if (depth === 0) return header.slice(open + 1, i);
      }
    }
    throw new Error('unbalanced row composable body');
  }

  test('no archetype emits refresh() inside the row composable', async () => {
    const { generateAndroidApp } = await import('../scripts/generateAndroidApp.ts');
    const { lintGeneratedSources, errorsOf: errs } = await import('../scripts/live/kotlinLint.ts');
    const ideas = [
      'A simple todo app',
      'A fitness tracker to log workouts and keep a streak',
      'A recipe collection with ratings',
      'A budget tracker for monthly spending'
    ];
    for (const idea of ideas) {
      const out = join(TMP, 'rows-' + derivePackageId(idea));
      const r = generateAndroidApp({ idea, outDir: out });
      const f = join(out, 'app/src/main/java', r.packageId.replace(/\./g, '/'), 'MainActivity.kt');
      const src = readFileSync(f, 'utf-8');

      assert.ok(!/\brefresh\s*\(/.test(rowsBody(src)),
        `${idea}: row composable must call onChanged(), not refresh()`);

      const strings = new Set([...src.matchAll(/R\.string\.([A-Za-z0-9_]+)/g)].map((m) => m![1]));
      const found = errs(lintGeneratedSources({
        files: { [f]: src },
        packageId: r.packageId,
        stringNames: strings
      })).map((e: { message: string }) => e.message);
      assert.ok(!found.some((m: string) => /out of scope/.test(m)), `${idea}: ${found.join(' | ')}`);
    }
  });

  test('a refresh() call in the row composable is reported by the linter', async () => {
    const { generateAndroidApp } = await import('../scripts/generateAndroidApp.ts');
    const { lintGeneratedSources, errorsOf: errs } = await import('../scripts/live/kotlinLint.ts');
    const out = join(TMP, 'rows-bad');
    const r = generateAndroidApp({ idea: 'A simple todo app', outDir: out });
    const f = join(out, 'app/src/main/java', r.packageId.replace(/\./g, '/'), 'MainActivity.kt');
    const bad = readFileSync(f, 'utf-8')
      .replace('store.toggle(item.id); onChanged() }', 'store.toggle(item.id); refresh() }');
    assert.notStrictEqual(bad, readFileSync(f, 'utf-8'), 'regression: fixture did not change');

    const strings = new Set([...bad.matchAll(/R\.string\.([A-Za-z0-9_]+)/g)].map((m) => m![1]));
    const found = errs(lintGeneratedSources({
      files: { [f]: bad },
      packageId: r.packageId,
      stringNames: strings
    })).map((e: { message: string }) => e.message);
    assert.ok(found.some((m: string) => /out of scope/.test(m)), `linter missed it: ${found.join(' | ')}`);
  });
});

