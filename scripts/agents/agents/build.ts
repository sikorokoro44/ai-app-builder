/**
 * Agents 8-13: the build wave.
 *
 * Each of these owns a disjoint set of files in the generated project. They can
 * run concurrently because their owned paths never overlap: the Gradle skeleton,
 * the manifest, the store, the Compose screen, the resource values and the
 * launcher icon.
 */

import { writeFileSync } from 'fs';
import { join, relative } from 'path';
import {
  activityFile,
  emitAppGradle,
  emitManifest,
  emitResourceValues,
  emitRootBuildFiles,
  emitWrapperAndProguard,
  plannedStrings,
  prepareProjectDirs,
  storeFile,
  GENERATED_BUILD
} from '../../project/emitters.ts';
import { decideIcon } from '../../iconCatalog.ts';
import { resRoot, validateLauncherIcon, writeLauncherIcon } from '../../live/launcherIcon.ts';
import type { AgentSpec } from '../../../shared/agentTypes.ts';
import {
  fail,
  layoutForPlan,
  missingRequiredFiles,
  ok,
  invalid,
  planFrom,
  plannedStringKeys,
  projectFileExists,
  readProject
} from './common.ts';

const SCAFFOLD_FILES = [
  'settings.gradle.kts',
  'build.gradle.kts',
  'gradle.properties',
  'app/build.gradle.kts',
  'gradlew',
  'gradle/wrapper/gradle-wrapper.properties',
  'app/proguard-rules.pro'
];

export const projectScaffolderAgent: AgentSpec<void, { files: string[]; packageId: string; appName: string }> = {
  id: 'project-scaffolder',
  index: 8,
  name: 'Project Scaffolder',
  role: 'Gradle project skeleton',
  responsibility: 'Create the Gradle project the app will be built from: settings, build scripts, properties, wrapper shim and proguard rules.',
  contract: {
    inputs: [{ kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' }],
    outputs: [{ kind: 'scaffold', description: 'The Gradle files that were written' }],
    requiredOutputFields: ['files', 'packageId', 'appName'],
    requiredFiles: SCAFFOLD_FILES
  },
  tools: ['writeFile', 'mkdir'],
  dependsOn: ['feature-planner'],
  entersState: 'PLANNING',
  nextState: 'READY',
  evidenceStage: 'SCAFFOLD',
  evidence: (out) => out ? `gradle project scaffolded for ${out.packageId}` : null,
  describe: (out) => (out ? `scaffolded the Gradle project for ${out.packageId} with ${out.files.length} files` : null),
  exclusiveGroup: 'project-root',
  ownedPaths: ['settings.gradle.kts', 'build.gradle.kts', 'gradle.properties', 'app/build.gradle.kts', 'gradlew', 'gradle/wrapper', 'app/proguard-rules.pro'],
  completionCriteria: [
    'Every Gradle file exists and is non-empty.',
    'The application id in app/build.gradle.kts is the planned package id.',
    'The toolchain versions match the pinned build configuration.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: true, maxRepairs: 2, onExhausted: 'replan' },
  execute(ctx) {
    const plan = planFrom(ctx);
    const layout = layoutForPlan(ctx, plan);
    prepareProjectDirs(layout);
    emitRootBuildFiles(layout);
    emitAppGradle(layout);
    emitWrapperAndProguard(layout);
    const out = { files: SCAFFOLD_FILES, packageId: layout.packageId, appName: layout.appName };
    ctx.publish('scaffold', out);
    ctx.activity(`scaffolded ${SCAFFOLD_FILES.length} Gradle files for ${layout.packageId}`);
    ctx.log(`created the Gradle skeleton for ${layout.appName} (${layout.packageId})`);
    return out;
  },
  validate(out, ctx) {
    const errors: string[] = [];
    const plan = planFrom(ctx);
    errors.push(...missingRequiredFiles(ctx, SCAFFOLD_FILES));
    const appGradle = readProject(ctx, 'app/build.gradle.kts') ?? '';
    if (!appGradle.includes(`applicationId = "${plan.packageId}"`)) {
      errors.push(`app/build.gradle.kts does not declare applicationId ${plan.packageId}`);
    }
    if (!appGradle.includes(`minSdk = ${GENERATED_BUILD.minSdk}`)) errors.push(`app/build.gradle.kts does not pin minSdk ${GENERATED_BUILD.minSdk}`);
    if (!appGradle.includes(`targetSdk = ${GENERATED_BUILD.targetSdk}`)) errors.push(`app/build.gradle.kts does not pin targetSdk ${GENERATED_BUILD.targetSdk}`);
    if (!out?.files?.length) errors.push('no files reported');
    return errors.length ? invalid(errors) : ok();
  }
};

export const manifestEngineerAgent: AgentSpec<void, { path: string; permissions: string[]; activity: string }> = {
  id: 'manifest-engineer',
  index: 9,
  name: 'Manifest Engineer',
  role: 'AndroidManifest.xml',
  responsibility: 'Emit the Android manifest: application identity, launcher activity with the MAIN/LAUNCHER filter, icon references and theme.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'scaffold', description: 'Gradle skeleton', producedBy: 'project-scaffolder' }
    ],
    outputs: [{ kind: 'manifest', description: 'The manifest that was written' }],
    requiredOutputFields: ['path', 'permissions', 'activity'],
    requiredFiles: ['app/src/main/AndroidManifest.xml']
  },
  tools: ['emitManifest', 'xml read'],
  dependsOn: ['project-scaffolder'],
  entersState: 'READY',
  ownedPaths: ['app/src/main/AndroidManifest.xml'],
  completionCriteria: [
    'The manifest exists and is non-empty.',
    'The launcher activity is exported and carries a MAIN/LAUNCHER intent filter.',
    'The icon and theme references are the ones the rest of the build wave emits.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: true, maxRepairs: 2, onExhausted: 'replan' },
  execute(ctx) {
    const plan = planFrom(ctx);
    const layout = layoutForPlan(ctx, plan);
    const path = emitManifest(layout);
    const xml = readProject(ctx, 'app/src/main/AndroidManifest.xml') ?? '';
    const permissions = [...xml.matchAll(/uses-permission android:name="([^"]+)"/g)].map((m) => m[1]);
    const activity = xml.match(/android:name="(\.MainActivity)"/)?.[1] ?? '';
    const out = { path: 'app/src/main/AndroidManifest.xml', permissions, activity };
    ctx.publish('manifest', out);
    ctx.log(`emitted the manifest with ${permissions.length} permission(s) and launcher activity ${activity}`);
    return out;
  },
  validate(out, ctx) {
    const errors: string[] = [];
    errors.push(...missingRequiredFiles(ctx, ['app/src/main/AndroidManifest.xml']));
    const xml = readProject(ctx, 'app/src/main/AndroidManifest.xml') ?? '';
    const plan = planFrom(ctx);
    if (!xml.startsWith('<?xml')) errors.push('the manifest has no xml declaration');
    if (!xml.includes('android.intent.category.LAUNCHER')) errors.push('the manifest declares no launcher category');
    if (!xml.includes('android.intent.action.MAIN')) errors.push('the manifest declares no MAIN action');
    if (!/android:exported="true"/.test(xml)) errors.push('the launcher activity is not exported');
    if (!xml.includes(`android:icon="@mipmap/ic_launcher"`)) errors.push('the manifest does not reference the launcher icon');
    if (!xml.includes(`android:theme="@style/${GENERATED_BUILD.theme}"`)) errors.push(`the manifest does not reference ${GENERATED_BUILD.theme}`);
    const expectedPerms = plan.security.permissions.join(',');
    if ((out?.permissions ?? []).join(',') !== expectedPerms) {
      errors.push(`manifest permissions [${(out?.permissions ?? []).join(', ')}] do not match the security analysis [${expectedPerms}]`);
    }
    return errors.length ? invalid(errors) : ok();
  }
};

export const dataEngineerAgent: AgentSpec<void, { path: string; methods: string[]; actions: string[] }> = {
  id: 'data-engineer',
  index: 10,
  name: 'Data Engineer',
  role: 'Model and store',
  responsibility: 'Emit the entity model and the store that captures, lists, mutates and removes items, with one method per derived action.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'scaffold', description: 'Gradle skeleton', producedBy: 'project-scaffolder' }
    ],
    outputs: [{ kind: 'data', description: 'The store file and the methods it exposes' }],
    requiredOutputFields: ['path', 'methods', 'actions']
  },
  tools: ['emitStore', 'file write'],
  dependsOn: ['manifest-engineer'],
  entersState: 'READY',
  nextState: 'BUILDING',
  ownedPaths: ['app/src/main/java/**/*Store.kt'],
  completionCriteria: [
    'The store file exists and declares the planned package.',
    'It exposes add, all, find, remove and every derived action.',
    'The class is pure Kotlin, so the JVM tests can exercise it.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: true, maxRepairs: 2, onExhausted: 'replan' },
  execute(ctx) {
    const plan = planFrom(ctx);
    const layout = layoutForPlan(ctx, plan);
    const file = storeFile(layout, plan.idea);
    const rel = file.path.replace(`${ctx.projectRoot}/`, '');
    writeFileSync(file.path, file.contents);
    const methods = [...file.contents.matchAll(/\n    fun ([a-zA-Z0-9_]+)\(/g)].map((m) => m[1]);
    const out = { path: rel, methods, actions: plan.entity.actions };
    ctx.publish('data', out);
    ctx.log(`emitted ${rel} with methods: ${methods.join(', ')}`);
    return out;
  },
  validate(out, ctx) {
    const errors: string[] = [];
    const plan = planFrom(ctx);
    const src = out?.path ? readProject(ctx, out.path) ?? '' : '';
    if (!src) return invalid([`the store file ${out?.path ?? '(none)'} was not written`]);
    if (!src.startsWith(`package ${plan.packageId}`)) errors.push(`the store does not declare package ${plan.packageId}`);
    if (!src.includes(`class ${plan.entity.className}Store`)) errors.push(`the store does not define ${plan.entity.className}Store`);
    for (const method of ['add', 'all', 'find', 'remove']) {
      if (!src.includes(`fun ${method}(`)) errors.push(`the store has no ${method}() method`);
    }
    if (plan.entity.actions.includes('toggle') && !src.includes('fun toggle(')) errors.push('the entity supports toggle but the store has no toggle()');
    if (plan.entity.actions.includes('increment') && !src.includes('fun increment(')) errors.push('the entity supports increment but the store has no increment()');
    if (plan.entity.actions.includes('complete') && !src.includes('fun complete(')) errors.push('the entity supports complete but the store has no complete()');
    for (const field of plan.entity.fields) {
      if (!src.includes(`val ${field.name}:`)) errors.push(`the model is missing field ${field.name}`);
    }
    return errors.length ? invalid(errors) : ok();
  }
};

export const uiEngineerAgent: AgentSpec<void, { path: string; copyKeysUsed: string[] }> = {
  id: 'ui-engineer',
  index: 11,
  name: 'UI Engineer',
  role: 'Compose screen',
  responsibility: 'Emit the Compose activity: the capture form, the list, the per-item controls and the empty state, all reading copy from resources.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'scaffold', description: 'Gradle skeleton', producedBy: 'project-scaffolder' }
    ],
    outputs: [{ kind: 'ui-source', description: 'The activity file and the resource keys it reads' }],
    requiredOutputFields: ['path', 'copyKeysUsed']
  },
  tools: ['emitActivity', 'file write'],
  dependsOn: ['manifest-engineer'],
  entersState: 'READY',
  ownedPaths: ['app/src/main/java/**/MainActivity.kt'],
  completionCriteria: [
    'The activity exists, declares the planned package and extends ComponentActivity.',
    'Every visible string comes from a resource key, never a literal.',
    'The empty state and the per-item controls are rendered.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: true, maxRepairs: 2, onExhausted: 'replan' },
  execute(ctx) {
    const plan = planFrom(ctx);
    const layout = layoutForPlan(ctx, plan);
    const file = activityFile(layout, plan.idea);
    const rel = file.path.replace(`${ctx.projectRoot}/`, '');
    writeFileSync(file.path, file.contents);
    const copyKeysUsed = [...new Set([...file.contents.matchAll(/stringResource\(R\.string\.([a-zA-Z0-9_]+)\)/g)].map((m) => m[1]))];
    const out = { path: rel, copyKeysUsed };
    ctx.publish('ui-source', out);
    ctx.log(`emitted ${rel} reading ${copyKeysUsed.length} resource keys`);
    return out;
  },
  validate(out, ctx) {
    const errors: string[] = [];
    const plan = planFrom(ctx);
    const src = out?.path ? readProject(ctx, out.path) ?? '' : '';
    if (!src) return invalid([`the activity file ${out?.path ?? '(none)'} was not written`]);
    if (!src.startsWith(`package ${plan.packageId}`)) errors.push(`the activity does not declare package ${plan.packageId}`);
    if (!src.includes('class MainActivity : ComponentActivity()')) errors.push('the activity is not a ComponentActivity');
    if (!src.includes(`fun ${plan.entity.className}Screen(`)) errors.push(`the activity has no ${plan.entity.className}Screen composable`);
    if (!src.includes('R.string.empty_list')) errors.push('the screen has no empty state');
    const shipped = plannedStringKeys(plan);
    for (const key of out?.copyKeysUsed ?? []) {
      if (!shipped.includes(key)) errors.push(`the screen reads R.string.${key} which the resource set does not define`);
    }
    if (!src.includes('store.add(')) errors.push('the screen cannot capture anything');
    if (!src.includes('store.remove(')) errors.push('the screen cannot remove an item');
    return errors.length ? invalid(errors) : ok();
  }
};

export const resourceEngineerAgent: AgentSpec<void, { files: string[]; keys: string[] }> = {
  id: 'resource-engineer',
  index: 12,
  name: 'Resource Engineer',
  role: 'Strings, colours and theme',
  responsibility: 'Emit the string resources for every visible label, the colour palette and the theme the manifest references.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'scaffold', description: 'Gradle skeleton', producedBy: 'project-scaffolder' }
    ],
    outputs: [{ kind: 'resources', description: 'The resource files and the keys they define' }],
    requiredOutputFields: ['files', 'keys'],
    requiredFiles: ['app/src/main/res/values/strings.xml', 'app/src/main/res/values/colors.xml', 'app/src/main/res/values/themes.xml']
  },
  tools: ['emitResourceValues', 'xml read'],
  dependsOn: ['manifest-engineer'],
  entersState: 'READY',
  ownedPaths: [
    'app/src/main/res/values/strings.xml',
    'app/src/main/res/values/colors.xml',
    'app/src/main/res/values/themes.xml'
  ],
  completionCriteria: [
    'All three resource files exist.',
    'Every key the screen reads is defined.',
    'The theme the manifest references is defined.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: true, maxRepairs: 2, onExhausted: 'replan' },
  describe: (out) => (out ? `emitted ${out.files.length} resource files defining ${out.keys.length} keys` : null),
  execute(ctx) {
    const plan = planFrom(ctx);
    const layout = layoutForPlan(ctx, plan);
    const files = emitResourceValues(layout).map((f) => f.replace(`${ctx.projectRoot}/`, ''));
    const strings = readProject(ctx, 'app/src/main/res/values/strings.xml') ?? '';
    const keys = [...strings.matchAll(/<string name="([^"]+)">/g)].map((m) => m[1]);
    const out = { files, keys };
    ctx.publish('resources', out);
    ctx.log(`emitted ${keys.length} strings, the colour palette and ${GENERATED_BUILD.theme}`);
    return out;
  },
  validate(out, ctx) {
    const errors: string[] = [];
    errors.push(...missingRequiredFiles(ctx, ['app/src/main/res/values/strings.xml', 'app/src/main/res/values/colors.xml', 'app/src/main/res/values/themes.xml']));
    const plan = planFrom(ctx);
    const required = plannedStringKeys(plan);
    const defined = new Set(out?.keys ?? []);
    for (const key of required) {
      if (!defined.has(key)) errors.push(`strings.xml does not define ${key}`);
    }
    const themes = readProject(ctx, 'app/src/main/res/values/themes.xml') ?? '';
    if (!themes.includes(`name="${GENERATED_BUILD.theme}"`)) errors.push(`themes.xml does not define ${GENERATED_BUILD.theme}`);
    const colors = readProject(ctx, 'app/src/main/res/values/colors.xml') ?? '';
    for (const colour of ['primary', 'background']) {
      if (!colors.includes(`name="${colour}"`)) errors.push(`colors.xml does not define ${colour}`);
    }
    const expectedKeys = new Set(plannedStrings(layoutForPlan(ctx, plan).spec, plan.appName)
      .map((l) => l.match(/name="([^"]+)"/)?.[1]).filter((k): k is string => !!k));
    for (const key of expectedKeys) {
      if (!defined.has(key)) errors.push(`strings.xml is missing the planned key ${key}`);
    }
    return errors.length ? invalid(errors) : ok();
  }
};

export const brandEngineerAgent: AgentSpec<void, { category: string; purpose: string; reason: string; fingerprint: string; files: string[] }> = {
  id: 'brand-engineer',
  index: 13,
  name: 'Brand and Icon Engineer',
  role: 'Launcher icon',
  responsibility: 'Decide the launcher icon from the idea and emit it at every density, with an adaptive icon for API 26 and up.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'scaffold', description: 'Gradle skeleton', producedBy: 'project-scaffolder' }
    ],
    outputs: [{ kind: 'brand', description: 'The icon decision and the resources it emitted' }],
    requiredOutputFields: ['category', 'purpose', 'reason', 'fingerprint', 'files']
  },
  tools: ['decideIcon', 'writeLauncherIcon', 'validateLauncherIcon'],
  dependsOn: ['manifest-engineer'],
  entersState: 'READY',
  ownedPaths: [
    'app/src/main/res/mipmap-mdpi',
    'app/src/main/res/mipmap-hdpi',
    'app/src/main/res/mipmap-xhdpi',
    'app/src/main/res/mipmap-xxhdpi',
    'app/src/main/res/mipmap-xxxhdpi',
    'app/src/main/res/mipmap-anydpi-v26',
    'app/src/main/res/drawable',
    'app/src/main/res/values/ic_launcher_colors.xml'
  ],
  completionCriteria: [
    'The icon validates at every density with an adaptive icon for v26.',
    'The emitted icon matches the decision taken from the idea.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: true, maxRepairs: 2, onExhausted: 'replan' },
  describe: (out) => (out ? `${out.category} icon for ${out.purpose}, emitted at ${out.files.length} densities` : null),
  execute(ctx) {
    const plan = planFrom(ctx);
    const decision = decideIcon(plan.idea, plan.appName);
    const icon = writeLauncherIcon(ctx.projectRoot, plan.idea, plan.appName);
    const check = validateLauncherIcon(ctx.projectRoot);
    if (!check.valid) fail('brand-engineer', `the launcher icon failed validation: ${check.errors[0]}`, check.errors);
    const out = {
      category: decision.definition.category,
      purpose: decision.definition.purpose,
      reason: decision.reason,
      fingerprint: icon.fingerprint,
      files: icon.files.map((f) => relative(ctx.projectRoot, join(resRoot(ctx.projectRoot), f)))
    };
    ctx.publish('brand', out);
    ctx.activity(`emitted a ${out.category} launcher icon (${out.files.length} resources)`);
    ctx.log(`icon: ${out.category} because ${out.reason}`);
    return out;
  },
  validate(out, ctx) {
    const errors: string[] = [];
    const plan = planFrom(ctx);
    const decision = decideIcon(plan.idea, plan.appName);
    if (out?.category !== decision.definition.category) {
      errors.push(`the emitted icon is ${out?.category} but the idea derives ${decision.definition.category}`);
    }
    const check = validateLauncherIcon(ctx.projectRoot);
    errors.push(...check.errors);
    for (const rel of out?.files ?? []) {
      if (!projectFileExists(ctx, rel)) errors.push(`declared icon resource is missing: ${rel}`);
    }
    if (!out?.fingerprint) errors.push('no icon fingerprint recorded');
    return errors.length ? invalid(errors) : ok();
  }
};

export function projectScaffoldFiles(): string[] {
  return [...SCAFFOLD_FILES];
}
