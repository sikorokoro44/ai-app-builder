/**
 * Intent-fit gate for a generated project.
 *
 * The stored state and the GitHub Actions workflow already prove `generateAndroidApp`
 * ran and `validateGeneratedProject` passed. That proves the project is *structurally*
 * valid, but not that it is the app the idea asked for: a calculator generator had a bug
 * that emitted a dummy record/workspace screen for people who asked for calculator
 * functionality, and every structural check passed. This gate re-derives what the idea
 * demands (store class name, screen signature, tests, strings, identity) straight from
 * the generated files on disk and refuses a build until the generated project actually
 * implements the idea that was asked for.
 */
import { readFileSync, existsSync } from 'fs';
import { specForIdea, isCalculatorSpec } from '../domainModels.ts';
import { deriveAppName, derivePackageId, plannedStrings } from '../project/emitters.ts';

export interface IntentFitCheck {
  id: string;
  label: string;
  pass: boolean;
}

export interface IntentFitResult {
  ok: boolean;
  errors: string[];
  checks: IntentFitCheck[];
}

const KEY_RE = /<string name="([^"]+)">/g;

function keysOf(xml: string): string[] {
  const keys: string[] = [];
  for (const m of xml.matchAll(KEY_RE)) keys.push(m[1]);
  return keys;
}

export function checkIntentFit(projectDir: string, idea: string): IntentFitResult {
  const ideaText = (idea || '').trim();
  // Without an idea there is no intent to fit. The lifecycle tests drive
  // `--prepare` without BUILDER_IDEA to exercise the state machine, and the
  // workflow always supplies the idea for a real build.
  if (!ideaText) return { ok: true, errors: [], checks: [] };
  const spec = specForIdea(ideaText);
  const packageId = derivePackageId(ideaText);
  const appName = deriveAppName(ideaText);
  const pkgPath = packageId.replace(/\./g, '/');
  const root = `${projectDir}/app/src/main`;
  const sourceDir = `${root}/java/${pkgPath}`;
  const storePath = `${sourceDir}/${spec.className}Store.kt`;
  const activityPath = `${sourceDir}/MainActivity.kt`;
  const testPath = `${projectDir}/app/src/test/java/${pkgPath}/${spec.className}StoreTest.kt`;

  const read = (path: string): string => {
    try {
      return existsSync(path) ? readFileSync(path, 'utf-8') : '';
    } catch {
      return '';
    }
  };
  const store = read(storePath);
  const activity = read(activityPath);
  const tests = read(testPath);
  const stringsXml = read(`${root}/res/values/strings.xml`);
  const appGradle = read(`${projectDir}/app/build.gradle.kts`);

  const checks: IntentFitCheck[] = [];
  const add = (id: string, label: string, pass: boolean) => checks.push({ id, label, pass });

  add('store-file',
    `the ${spec.className} data layer exists and belongs to the idea`,
    existsSync(storePath) && store.includes(`class ${spec.className}Store`));

  add('screen',
    'the screen this idea requires is actually rendered',
    activity.includes(`fun ${spec.className}Screen(`));

  add('tests',
    'the data layer has generated JVM tests',
    existsSync(testPath) && /@Test/.test(tests));

  const expectedKeys = plannedStrings(spec, appName).reduce<string[]>((keys, line) => {
    const keys2 = [...line.matchAll(KEY_RE)].map((m) => m[1]);
    return keys.concat(keys2);
  }, []);
  const declaredKeys = keysOf(stringsXml);
  add('resources',
    'every string the plan demands exists in strings.xml',
    expectedKeys.length > 0 && expectedKeys.every((k) => declaredKeys.includes(k)));

  add('identity',
    'the project is named and packaged after the derived app',
    stringsXml.includes(`<string name="app_name">${appName}</string>`) &&
    appGradle.includes(`namespace = "${packageId}"`) &&
    appGradle.includes(`applicationId = "${packageId}"`));

  if (isCalculatorSpec(spec)) {
    add('engine',
      'the calculator actually evaluates expressions',
      store.includes('fun evaluate('));
    add('no-counting-ui',
      'the calculator is not a disguised add-list app',
      !activity.includes('R.string.add_button') && activity.includes('R.string.key_equals'));
  } else {
    add('capture-flow',
      'the record-keeping app can add a new item',
      activity.includes('R.string.add_button'));
  }

  const errors = checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.label}`);
  return { ok: errors.length === 0, errors, checks };
}