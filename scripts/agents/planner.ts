/**
 * The real planner.
 *
 * Given an arbitrary idea it derives the entity model, the requirements, the
 * screens, the architecture, the security posture, the feature/task graph and
 * the execution waves. Everything is derived from the idea and from the pinned
 * build configuration: there is no demo feature list, no per-idea special case
 * and no work that the downstream agents cannot actually perform.
 */

import { specForIdea, numericRoles, ARCHETYPES, type EntitySpec } from '../domainModels.ts';
import { decideIcon } from '../iconCatalog.ts';
import { AGENT_ID_NAMES, isAgentId, agentIndex } from './agentIds.ts';
import { ownedPathsOf } from './ownership.ts';
import {
  GENERATED_BUILD,
  deriveAppName,
  derivePackageId,
  derivePackageId as packageIdFor,
  pluralOf,
  unitTestCount
} from '../project/emitters.ts';

export const PLANNER_VERSION = '2';


export type PlanStage = 'analysis' | 'design' | 'planning' | 'scaffold' | 'implement' | 'test' | 'ship' | 'oversight';

export interface PlannedRequirement {
  id: string;
  statement: string;
  rationale: string;
  acceptance: string[];
}

export interface PlannedScreen {
  id: string;
  name: string;
  purpose: string;
  elements: string[];
  states: string[];
  copyKeys: string[];
}

export interface PlannedArchitecture {
  language: string;
  uiToolkit: string;
  architecturePattern: string;
  persistence: string;
  minSdk: number;
  targetSdk: number;
  compileSdk: number;
  javaVersion: string;
  gradle: string;
  kotlinPlugin: string;
  packages: string[];
  entrypoint: string;
  files: string[];
  rationale: string[];
}

export interface PlannedSecurity {
  permissions: string[];
  network: 'none';
  dataAtRest: string;
  secretPolicy: string[];
  risks: string[];
  mitigations: string[];
}

export interface PlannedFeature {
  id: string;
  title: string;
  description: string;
  workstream: PlanStage;
  ownerAgent: string;
  dependsOn: string[];
  tasks: string[];
  acceptance: string[];
  files: string[];
}

export interface PlannedTask {
  id: string;
  featureId: string;
  title: string;
  agentId: string;
  stage: PlanStage;
  dependsOn: string[];
  files: string[];
  completion: string;
}

export interface BuildPlan {
  version: string;
  idea: string;
  appName: string;
  packageId: string;
  archetype: string;
  entity: EntitySpec & {
    slug: string;
    archetype: string;
    numericRoles: Record<string, string>;
    actions: string[];
  };
  icon: { category: string; purpose: string; reason: string; palette: { from: string; to: string; fg: string } };
  requirements: PlannedRequirement[];
  screens: PlannedScreen[];
  architecture: PlannedArchitecture;
  security: PlannedSecurity;
  features: PlannedFeature[];
  tasks: PlannedTask[];
  waves: string[][];
  verification: {
    generator: string;
    validator: string;
    cloudWorkflow: string;
    unitTestClass: string;
    minimumUnitTests: number;
  };
}

const REQUIRED_SCREEN_STATES = ['populated', 'empty', 'input-rejected'];

function archetypeFor(idea: string): string {
  const hit = ARCHETYPES.find((a) => a.match.test(idea));
  if (!hit) return 'generic record';
  const noun = hit.spec.plural;
  return noun;
}

function pkgPath(packageId: string): string {
  return packageId.replace(/\./g, '/');
}

/** "a recipe" but "an expense": the emitted copy has to read like English. */
function indefiniteArticle(noun: string): string {
  return /^[aeiou]/i.test(noun) ? 'An' : 'A';
}

function requirement(id: string, statement: string, rationale: string, acceptance: string[]): PlannedRequirement {
  return { id, statement, rationale, acceptance };
}

function actionLabel(action: string): string {
  if (action === 'toggle') return 'flag as done and back again';
  if (action === 'increment') return 'log progress against a target';
  return 'mark finished';
}

function feature(
  id: string,
  title: string,
  description: string,
  workstream: PlanStage,
  ownerAgent: string,
  dependsOn: string[],
  tasks: string[],
  acceptance: string[],
  files: string[]
): PlannedFeature {
  return { id, title, description, workstream, ownerAgent, dependsOn, tasks, acceptance, files };
}

export interface DerivedSections {
  icon: BuildPlan['icon'];
  requirements: PlannedRequirement[];
  screens: PlannedScreen[];
  architecture: PlannedArchitecture;
  security: PlannedSecurity;
  verification: BuildPlan['verification'];
}

/**
 * The analysis and design sections of a plan, derived from an idea alone.
 *
 * Each of these sections is owned by exactly one agent: the requirements
 * analyst publishes `requirements`, the architect publishes `architecture`, the
 * UI designer publishes `ui`, the security analyst publishes `security`. They
 * live here as pure functions so the agent does the deriving, the handoff does
 * the carrying, and the planner refuses to assemble a plan whose sections do
 * not agree with what these derivations say the idea requires.
 */
export function deriveSections(idea: string): DerivedSections {
  const spec = specForIdea(idea);
  const appName = deriveAppName(idea);
  const packageId = packageIdFor(idea);
  const iconDecision = decideIcon(idea, appName);
  const icon = {
    category: iconDecision.definition.category,
    purpose: iconDecision.definition.purpose,
    reason: iconDecision.reason,
    palette: iconDecision.definition.palette
  };
  const roles = numericRoles(spec);
  const cls = spec.className;
  const textFields = spec.fields.filter((f) => f.type === 'text');
  const requiredText = textFields.filter((f) => !f.optional);
  const optionalText = textFields.filter((f) => f.optional);
  const boolField = spec.fields.find((f) => f.type === 'bool');
  const actionWords = spec.actions.length ? spec.actions : ['toggle'];
  // Counted from the emitter, never estimated: the plan's test requirement and
  // the generated test file are the same number by construction.
  const unitTests = unitTestCount(spec);
  const javaRoot = `app/src/main/java/${pkgPath(packageId)}`;
  const testRoot = `app/src/test/java/${pkgPath(packageId)}`;

  const requirements: PlannedRequirement[] = [
    requirement('req-001',
      `The app exists to let one person ${spec.purpose}.`,
      'Derived from the entity archetype matched against the idea.',
      ['The launcher label names the app.', `The primary screen shows the ${spec.plural} of this person.`]),
    requirement('req-002',
      `${indefiniteArticle(spec.noun)} ${spec.noun} can be captured with: ${spec.fields.map((f) => f.label).join(', ')}.`,
      'Every field of the derived entity is user visible and editable.',
      [
        ...requiredText.map((f) => `A ${f.label.toLowerCase()} field rejects blank input.`),
        ...optionalText.map((f) => `The ${f.label.toLowerCase()} field may be left empty.`),
        ...(requiredText.length + optionalText.length === 0 ? ['The capture form writes every declared field.'] : [])
      ]),
    requirement('req-003',
      `Stored ${spec.plural} are listed with their detail after a restart.`,
      'Capture without review is not a usable app.',
      ['The list shows every stored item in insertion order.', 'The list survives process death.']),
    ...actionWords.map((a, i) => requirement(`req-00${4 + i}`,
      `Each ${spec.noun} can ${actionLabel(a)}.`,
      `The derived entity supports the "${a}" action.`,
      [`The ${a} control changes exactly one stored item.`, `The ${a} control reports failure for an unknown id.`])),
    requirement('req-010',
      'The app runs offline with no backend.',
      'A generated app must not depend on infrastructure it cannot provision.',
      ['No runtime network call exists in the generated sources.']),
    requirement('req-011',
      'A launcher icon exists at every density plus an adaptive icon.',
      'minSdk 24 means legacy mipmaps and a v26 adaptive icon are both used.',
      ['Every density folder contains ic_launcher and ic_launcher_round.', 'The adaptive icon references a real drawable.']),
    requirement('req-012',
      'The data layer is covered by JVM unit tests generated from the plan.',
      'Tests must be derived from the same model the generator uses.',
      [`${cls}StoreTest exists with at least ${unitTests} tests.`, 'Each derived action has a test that would fail if the action regressed.']),
    requirement('req-013',
      'The project builds into a signed debug APK on GitHub Actions.',
      'GitHub Actions is the authoritative build environment.',
      ['The workflow run concludes with success.', 'The downloaded APK passes independent verification.']),
    requirement('req-014',
      'The APK is published on a public HTTPS release URL.',
      'A build the user cannot download is not a result.',
      ['The release asset URL answers 200 over HTTPS.', 'The downloaded bytes match the verified sha256.']),
    requirement('req-015',
      'No credential is ever committed to the repository.',
      'Generated sources and metadata are scanned before publishing.',
      ['The secret scan reports zero findings over the generated project.']),
    ...(roles.primary ? [requirement('req-016',
      `Totals across every ${spec.noun} are visible.`,
      'A numeric field was derived for the archetype, so a total is meaningful.',
      [`The ${roles.primary.label.toLowerCase()} total is computed from the store.`])] : [])
  ];

  const screens: PlannedScreen[] = [
    {
      id: 'screen-workspace',
      name: 'Workspace',
      purpose: `The only screen: capture a ${spec.noun} and work through the ${spec.plural}.`,
      elements: [
        `App title`,
        ...textFields.map((f) => `Labelled "${f.label}" input`),
        `Add ${spec.noun} button`,
        `${spec.plural[0].toUpperCase()}${spec.plural.slice(1)} list`,
        ...(boolField ? ['Done checkbox per row'] : []),
        ...(roles.progress ? [`${roles.progress.label} progress per row`] : []),
        ...actionWords.map((a) => `${actionLabel(a)} control per row`),
        'Remove control per row'
      ],
      states: REQUIRED_SCREEN_STATES,
      copyKeys: [
        'app_name',
        ...textFields.map((f) => `field_${f.name}`),
        'add_button',
        'delete',
        'empty_list',
        ...(spec.actions.includes('increment') ? ['increment'] : []),
        ...(boolField ? ['mark_done'] : []),
        ...(roles.progress ? ['progress_format'] : [])
      ]
    }
  ];

  const architecture: PlannedArchitecture = {
    language: 'Kotlin',
    uiToolkit: 'Jetpack Compose (Material3)',
    architecturePattern: 'single-activity, unidirectional state read from an in-memory store',
    persistence: 'in-memory store behind a pure Kotlin class (JVM testable)',
    minSdk: GENERATED_BUILD.minSdk,
    targetSdk: GENERATED_BUILD.targetSdk,
    compileSdk: GENERATED_BUILD.compileSdk,
    javaVersion: GENERATED_BUILD.javaVersion,
    gradle: GENERATED_BUILD.gradleDistribution,
    kotlinPlugin: GENERATED_BUILD.kotlinGradlePlugin,
    packages: [packageId, `${packageId}.data`, `${packageId}.ui`],
    entrypoint: `${packageId}.MainActivity`,
    files: [
      'settings.gradle.kts',
      'build.gradle.kts',
      'gradle.properties',
      'app/build.gradle.kts',
      `${javaRoot}/${cls}Store.kt`,
      `${javaRoot}/MainActivity.kt`,
      `${testRoot}/${cls}StoreTest.kt`,
      'app/src/main/AndroidManifest.xml',
      'app/src/main/res/values/strings.xml'
    ],
    rationale: [
      'Compose keeps the screen declarative, so the generated UI stays a pure function of store state.',
      'A pure Kotlin store keeps the data layer testable on the JVM, which is what the generated unit tests exercise.',
      `compileSdk ${GENERATED_BUILD.compileSdk} with minSdk ${GENERATED_BUILD.minSdk} keeps legacy launcher mipmaps relevant.`
    ]
  };

  const security: PlannedSecurity = {
    permissions: ['android.permission.INTERNET'],
    network: 'none',
    dataAtRest: 'process memory only; nothing is written to disk by the app',
    secretPolicy: [
      'No token, key or credential is embedded in generated sources.',
      'The generated project is scanned for credential patterns before it is published.',
      'The manifest requests no permission beyond the one the platform build needs.'
    ],
    risks: [
      'Backup is enabled, so process memory can be captured by the platform backup agent.',
      'A debug-signed APK is not suitable for distribution.'
    ],
    mitigations: [
      'The APK is verified and checksummed independently before release.',
      'The release is attached to an immutable, checksummed asset URL.'
    ]
  };


  const verification = {
    generator: 'scripts/generateAndroidApp.ts',
    validator: 'scripts/live/projectValidator.ts',
    cloudWorkflow: '.github/workflows/builder-android-build.yml',
    unitTestClass: `${cls}StoreTest`,
    minimumUnitTests: unitTests
  };
  return { icon, requirements, screens, architecture, security, verification };
}

export function planForIdea(idea: string): BuildPlan {
  const sections = deriveSections(idea);
  const spec = specForIdea(idea);
  const appName = deriveAppName(idea);
  const packageId = packageIdFor(idea);
  const icon = sections.icon;
  const roles = numericRoles(spec);
  const cls = spec.className;
  const textFields = spec.fields.filter((f) => f.type === 'text');
  const boolField = spec.fields.find((f) => f.type === 'bool');
  const actionWords = spec.actions.length ? spec.actions : ['toggle'];
  const unitTests = sections.verification.minimumUnitTests;
  const javaRoot = `app/src/main/java/${pkgPath(packageId)}`;
  const testRoot = `app/src/test/java/${pkgPath(packageId)}`;
  const requirements = sections.requirements;
  const screens = sections.screens;
  const architecture = sections.architecture;
  const security = sections.security;

  const features: PlannedFeature[] = [];
  const tasks: PlannedTask[] = [];
  let featureNo = 0;
  let taskNo = 0;
  const addFeature = (f: Omit<PlannedFeature, 'id' | 'tasks'>) => {
    featureNo += 1;
    const id = `feat-${String(featureNo).padStart(3, '0')}`;
    const created = { ...f, id, tasks: [] as string[] };
    features.push(created);
    return created;
  };
  const addTask = (f: PlannedFeature, title: string, agentId: string, stage: PlanStage, dependsOn: string[], files: string[], completion: string) => {
    taskNo += 1;
    const id = `task-${String(taskNo).padStart(3, '0')}`;
    tasks.push({ id, featureId: f.id, title, agentId, stage, dependsOn, files, completion });
    f.tasks.push(id);
    return id;
  };

  const ideaFeature = addFeature({
    title: 'Idea normalization',
    description: 'Turn the raw idea into a stated purpose and a non-empty normalized brief.',
    workstream: 'analysis',
    ownerAgent: 'idea-intake',
    dependsOn: [],
    acceptance: ['Normalized idea is non-empty.', 'Purpose statement names what the app does.'],
    files: []
  });
  const tIdea = addTask(ideaFeature, 'Normalize the idea and state the purpose', 'idea-intake', 'analysis', [], [], 'idea.json holds the normalized idea and purpose');

  const reqFeature = addFeature({
    title: 'Requirements',
    description: `Acceptance criteria for capturing, reviewing and acting on ${spec.plural}.`,
    workstream: 'analysis',
    ownerAgent: 'requirements-analyst',
    dependsOn: [ideaFeature.id],
    acceptance: ['Every requirement has acceptance criteria.', 'No requirement is unverifiable.'],
    files: []
  });
  const tReq = addTask(reqFeature, 'Derive requirements with acceptance criteria', 'requirements-analyst', 'analysis', [tIdea], [], 'requirements.json holds one entry per requirement');

  const domainFeature = addFeature({
    title: 'Domain model',
    description: `The ${cls} entity, its ${spec.fields.length} fields and its ${spec.actions.join(', ') || 'no'} extra actions.`,
    workstream: 'analysis',
    ownerAgent: 'domain-modeler',
    dependsOn: [ideaFeature.id],
    acceptance: ['Entity has at least one text field.', 'Actions match what the UI can trigger.'],
    files: []
  });
  const tDomain = addTask(domainFeature, 'Derive the entity, fields and actions', 'domain-modeler', 'analysis', [tIdea], [], 'domain.json matches the spec the generator will use');

  const archFeature = addFeature({
    title: 'Architecture',
    description: 'Toolchain, module layout, entrypoint and the rationale for each choice.',
    workstream: 'design',
    ownerAgent: 'architect',
    dependsOn: [reqFeature.id, domainFeature.id],
    acceptance: ['Toolchain matches the pinned build configuration.', 'Entrypoint exists in the generated sources.'],
    files: []
  });
  const tArch = addTask(archFeature, 'Choose the architecture and record the rationale', 'architect', 'design', [tReq, tDomain], [], 'architecture.json matches GENERATED_BUILD');

  const uiFeature = addFeature({
    title: 'Experience design',
    description: `Screen inventory, per-screen states and the exact copy keys the UI must use.`,
    workstream: 'design',
    ownerAgent: 'ui-designer',
    dependsOn: [domainFeature.id],
    acceptance: ['Every screen declares empty and input-rejected states.', 'Every visible string has a resource key.'],
    files: []
  });
  const tUi = addTask(uiFeature, 'Design the screens, states and copy keys', 'ui-designer', 'design', [tDomain], [], 'ui.json lists every copy key the generator emits');

  const secFeature = addFeature({
    title: 'Threat model',
    description: 'Permissions, data at rest and the credential policy for the generated app.',
    workstream: 'design',
    ownerAgent: 'security-analyst',
    dependsOn: [archFeature.id],
    acceptance: ['Permissions are justified.', 'Credential policy is enforceable.'],
    files: []
  });
  const tSec = addTask(secFeature, 'Threat model the generated app', 'security-analyst', 'design', [tArch], [], 'security.json lists permissions and mitigations');

  const planFeature = addFeature({
    title: 'Execution plan',
    description: 'The feature/task graph, the owning agent per task and the execution waves.',
    workstream: 'planning',
    ownerAgent: 'feature-planner',
    dependsOn: [uiFeature.id, secFeature.id],
    acceptance: ['Every task has an owner agent and a completion condition.', 'The graph is acyclic.'],
    files: []
  });
  const tPlan = addTask(planFeature, 'Build the task graph and waves', 'feature-planner', 'planning', [tUi, tSec], [], 'plan.json holds a resolvable task graph');

  const scaffoldFeature = addFeature({
    title: 'Project structure',
    description: 'Gradle build files, wrapper shim and proguard rules for the app module.',
    workstream: 'scaffold',
    ownerAgent: 'project-scaffolder',
    dependsOn: [planFeature.id],
    acceptance: ['settings/build/gradle.properties exist.', 'applicationId equals the planned package id.'],
    files: ['settings.gradle.kts', 'build.gradle.kts', 'gradle.properties', 'app/build.gradle.kts', 'gradlew', 'gradle/wrapper/gradle-wrapper.properties', 'app/proguard-rules.pro']
  });
  const tScaffold = addTask(scaffoldFeature, 'Emit the Gradle project skeleton', 'project-scaffolder', 'scaffold', [tPlan], ['settings.gradle.kts', 'build.gradle.kts', 'gradle.properties', 'app/build.gradle.kts', 'gradlew', 'gradle/wrapper/gradle-wrapper.properties', 'app/proguard-rules.pro'], 'Gradle files exist and name the planned package id');

  const manifestFeature = addFeature({
    title: 'Application manifest',
    description: 'Application id, launcher activity, icon references and theme.',
    workstream: 'scaffold',
    ownerAgent: 'manifest-engineer',
    dependsOn: [scaffoldFeature.id],
    acceptance: ['The launcher activity is exported and has a MAIN/LAUNCHER filter.', 'Icon references resolve to shipped mipmaps.'],
    files: ['app/src/main/AndroidManifest.xml']
  });
  const tManifest = addTask(manifestFeature, 'Emit and check the manifest', 'manifest-engineer', 'scaffold', [tScaffold], ['app/src/main/AndroidManifest.xml'], 'AndroidManifest.xml declares the launcher activity');

  const dataFeature = addFeature({
    title: `${cls} data layer`,
    description: `The ${cls} model and the store that captures, lists and mutates ${spec.plural}.`,
    workstream: 'implement',
    ownerAgent: 'data-engineer',
    dependsOn: [manifestFeature.id],
    acceptance: ['add() trims every text field and rejects blank required text.', 'Each derived action has a store method.'],
    files: [`${javaRoot}/${cls}Store.kt`]
  });
  const tData = addTask(dataFeature, 'Emit the model and store', 'data-engineer', 'implement', [tManifest], [`${javaRoot}/${cls}Store.kt`], 'Store source contains add, remove and every derived action');

  const uiImplFeature = addFeature({
    title: 'Workspace screen',
    description: `The Compose screen that captures a ${spec.noun} and works through the ${spec.plural}.`,
    workstream: 'implement',
    ownerAgent: 'ui-engineer',
    dependsOn: [manifestFeature.id],
    acceptance: ['Every visible string comes from a resource.', 'The empty state and per-item actions are rendered.'],
    files: [`${javaRoot}/MainActivity.kt`]
  });
  const tUiImpl = addTask(uiImplFeature, 'Emit the Compose activity', 'ui-engineer', 'implement', [tManifest], [`${javaRoot}/MainActivity.kt`], 'MainActivity renders capture, list and per-item actions');

  const resFeature = addFeature({
    title: 'Copy, colour and theme',
    description: 'String resources for every visible label, the palette and the app theme.',
    workstream: 'implement',
    ownerAgent: 'resource-engineer',
    dependsOn: [manifestFeature.id],
    acceptance: ['Every string key the UI references exists.', 'The theme referenced by the manifest exists.'],
    files: ['app/src/main/res/values/strings.xml', 'app/src/main/res/values/colors.xml', 'app/src/main/res/values/themes.xml']
  });
  const tRes = addTask(resFeature, 'Emit the resource values', 'resource-engineer', 'implement', [tManifest], ['app/src/main/res/values/strings.xml', 'app/src/main/res/values/colors.xml', 'app/src/main/res/values/themes.xml'], 'Resource values compile against the generated references');

  const brandFeature = addFeature({
    title: 'Launcher identity',
    description: `A ${icon.category} launcher icon chosen for "${icon.purpose}", at every density plus adaptive.`,
    workstream: 'implement',
    ownerAgent: 'brand-engineer',
    dependsOn: [manifestFeature.id],
    acceptance: ['All densities plus v26 adaptive are present.', 'The icon matches the icon decision fingerprint.'],
    files: [...ownedPathsOf('brand-engineer')]
  });
  const tBrand = addTask(brandFeature, 'Decide and emit the launcher icon', 'brand-engineer', 'implement', [tManifest], [...ownedPathsOf('brand-engineer')], 'Launcher icon validates at every density');

  const testFeature = addFeature({
    title: 'Generated unit tests',
    description: `JVM unit tests for the ${cls} store, one per derived behaviour.`,
    workstream: 'test',
    ownerAgent: 'test-engineer',
    dependsOn: [dataFeature.id, uiImplFeature.id],
    acceptance: [`At least ${unitTests} tests are generated.`, 'Every derived action has a test.'],
    files: [`${testRoot}/${cls}StoreTest.kt`]
  });
  const tTest = addTask(testFeature, 'Emit the store unit tests', 'test-engineer', 'test', [tData, tUiImpl], [`${testRoot}/${cls}StoreTest.kt`], 'Test source covers add, remove and every derived action');

  const qualityFeature = addFeature({
    title: 'Release quality gates',
    description: 'Structural validation, Kotlin lint, resource and secret checks before publishing.',
    workstream: 'test',
    ownerAgent: 'quality-auditor',
    dependsOn: [dataFeature.id, uiImplFeature.id, resFeature.id, brandFeature.id, testFeature.id],
    acceptance: ['Every validator passes.', 'Zero credential findings.'],
    files: []
  });
  const tQuality = addTask(qualityFeature, 'Run every pre-publish validator', 'quality-auditor', 'test', [tData, tUiImpl, tRes, tBrand, tTest], [], 'validation.json records each passing validator');

  const pushFeature = addFeature({
    title: 'Source of truth',
    description: 'Commit the generated project and push it to the authoritative repository.',
    workstream: 'ship',
    ownerAgent: 'repo-publisher',
    dependsOn: [qualityFeature.id],
    acceptance: ['The pushed commit contains the generated project.', 'The remote head equals the local head.'],
    files: []
  });
  const tPush = addTask(pushFeature, 'Commit and push the generated project', 'repo-publisher', 'ship', [tQuality], [], 'Remote head matches the local commit');

  const buildFeature = addFeature({
    title: 'Cloud build and artifact verification',
    description: 'Run the authoritative build workflow and verify the real APK and its icon independently.',
    workstream: 'ship',
    ownerAgent: 'build-verifier',
    dependsOn: [pushFeature.id],
    acceptance: ['The workflow run concluded with success.', 'The APK and its compiled icon pass independent verification.'],
    files: []
  });
  const tBuild = addTask(buildFeature, 'Build on GitHub Actions and verify the APK', 'build-verifier', 'ship', [tPush], [], 'A real APK exists with a recorded sha256 and a passing icon check');

  const releaseFeature = addFeature({
    title: 'Public release',
    description: 'Publish the verified APK and prove the public HTTPS download matches the verified bytes.',
    workstream: 'ship',
    ownerAgent: 'release-publisher',
    dependsOn: [buildFeature.id],
    acceptance: ['The release asset URL answers 200 over HTTPS.', 'The downloaded bytes match the verified sha256.'],
    files: []
  });
  const tRelease = addTask(releaseFeature, 'Release and verify the public download', 'release-publisher', 'ship', [tBuild], [], 'A checksummed public download URL is recorded');

  const diagnosisFeature = addFeature({
    title: 'Failure diagnosis',
    description: 'Baseline health analysis of the produced app plus failure classification when something breaks.',
    workstream: 'oversight',
    ownerAgent: 'failure-diagnostician',
    dependsOn: [qualityFeature.id],
    acceptance: ['A health report exists for the generated app.', 'Every observed failure is classified.'],
    files: []
  });
  const tDiagnosis = addTask(diagnosisFeature, 'Analyse app health and classify failures', 'failure-diagnostician', 'oversight', [tQuality], [], 'diagnosis.json reports health and classifications');

  const supervisionFeature = addFeature({
    title: 'Cross-agent completion',
    description: 'Verify every agent artifact, every evidence link and the download gate before completion.',
    workstream: 'oversight',
    ownerAgent: 'integration-supervisor',
    dependsOn: [releaseFeature.id, diagnosisFeature.id],
    acceptance: ['All 20 agents have a completed ledger entry.', 'The completion gate passes on evidence, not on claims.'],
    files: []
  });
  addTask(supervisionFeature, 'Verify the whole fleet and close the run', 'integration-supervisor', 'oversight', [tRelease, tDiagnosis], [], 'supervision.json lists the 20 verified agent entries');

  return {
    version: PLANNER_VERSION,
    idea,
    appName,
    packageId,
    archetype: archetypeFor(idea),
    entity: {
      ...spec,
      slug: `${spec.noun}-${spec.plural}`,
      archetype: archetypeFor(idea),
      numericRoles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v?.name ?? 'none'])),
      actions: spec.actions
    },
    icon,
    requirements,
    screens,
    architecture,
    security,
    features,
    tasks,
    waves: wavesFromTaskDependencies(tasks),
    verification: sections.verification
  };
}

/** Deterministic topological layers over the agent dependency graph. */
export function wavesFromDependencies(agentIds: string[], dependsOn: (id: string) => string[]): string[][] {
  const remaining = new Map(agentIds.map((id) => [id, new Set(dependsOn(id).filter((d) => agentIds.includes(d)))]));
  const done = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => [...deps].every((d) => done.has(d))).map(([id]) => id);
    if (ready.length === 0) {
      throw new Error(`Agent dependency cycle among: ${[...remaining.keys()].join(', ')}`);
    }
    waves.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      done.add(id);
    }
  }
  return waves;
}

/** The upstream artifacts a plan is assembled from. */
export interface PlanHandoffs {
  requirements: PlannedRequirement[];
  domain: {
    spec: EntitySpec;
    archetype: string;
    numericRoles: Record<string, string>;
    actions: string[];
  };
  architecture: PlannedArchitecture;
  ui: { screens: PlannedScreen[] };
  security: PlannedSecurity;
}

export class PlanAssemblyError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Plan cannot be assembled from the upstream handoffs:\n - ${problems.join('\n - ')}`);
    this.name = 'PlanAssemblyError';
    this.problems = problems;
  }
}

/**
 * Assembles the plan from what the upstream agents actually published.
 *
 * The planner does not trust the handoffs and does not ignore them either: every
 * section is cross-checked against the derivation for the same idea, so an agent
 * that invents a requirement, a screen, a permission or an agent id is rejected
 * before a single file is written.
 */
export function assemblePlan(idea: string, handoffs: PlanHandoffs): BuildPlan {
  const expected = deriveSections(idea);
  const spec = specForIdea(idea);
  const problems: string[] = [];

  const expectedIds = expected.requirements.map((r) => r.id).sort();
  const actualIds = (handoffs.requirements || []).map((r) => r.id).sort();
  if (expectedIds.join(',') !== actualIds.join(',')) {
    problems.push(`requirements cover ${actualIds.join(',')} but the idea requires ${expectedIds.join(',')}`);
  }
  for (const want of expected.requirements) {
    const got = (handoffs.requirements || []).find((r) => r.id === want.id);
    if (!got) continue;
    if (got.statement !== want.statement) problems.push(`requirement ${want.id} was restated: "${got.statement}"`);
    if (!got.acceptance || got.acceptance.length === 0) problems.push(`requirement ${got.id} has no acceptance criteria`);
    if (got.rationale.trim().length < 5) problems.push(`requirement ${got.id} has no rationale`);
  }

  if (handoffs.domain.spec.className !== spec.className) {
    problems.push(`domain model says ${handoffs.domain.spec.className}, the idea derives ${spec.className}`);
  }
  if (handoffs.domain.spec.fields.length !== spec.fields.length) {
    problems.push(`domain model has ${handoffs.domain.spec.fields.length} fields, the idea derives ${spec.fields.length}`);
  }
  if (handoffs.domain.actions.join(',') !== spec.actions.join(',')) {
    problems.push(`domain actions ${handoffs.domain.actions.join(',')} do not match the derived ${spec.actions.join(',') || 'none'}`);
  }

  for (const key of ['language', 'uiToolkit', 'persistence', 'entrypoint', 'architecturePattern'] as const) {
    if (!handoffs.architecture[key] || handoffs.architecture[key] !== expected.architecture[key]) {
      problems.push(`architecture.${key} disagrees with the pinned build configuration`);
    }
  }
  if (handoffs.architecture.minSdk !== GENERATED_BUILD.minSdk || handoffs.architecture.targetSdk !== GENERATED_BUILD.targetSdk) {
    problems.push(`architecture sdk levels disagree with the pinned build (min ${GENERATED_BUILD.minSdk}, target ${GENERATED_BUILD.targetSdk})`);
  }

  const expectedKeys = new Set(expected.screens.flatMap((s) => s.copyKeys));
  const actualKeys = new Set((handoffs.ui.screens || []).flatMap((s) => s.copyKeys || []));
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) problems.push(`the UI design has no copy key for "${key}"`);
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) problems.push(`the UI design invents a copy key, "${key}", that no section defines`);
  }
  for (const screen of handoffs.ui.screens || []) {
    for (const state of REQUIRED_SCREEN_STATES) {
      if (!(screen.states || []).includes(state)) problems.push(`screen ${screen.id} does not design the "${state}" state`);
    }
    if (!(screen.elements || []).length) problems.push(`screen ${screen.id} designs no elements`);
  }

  const expectedPerms = expected.security.permissions.join(',');
  if ((handoffs.security.permissions || []).join(',') !== expectedPerms) {
    problems.push(`security declares permissions ${(handoffs.security.permissions || []).join(',')} but the app needs ${expectedPerms}`);
  }
  if (!(handoffs.security.secretPolicy || []).length) problems.push('security declares no secret policy');
  if (!(handoffs.security.mitigations || []).length) problems.push('security declares no mitigations');

  const plan = planForIdea(idea);
  plan.requirements = handoffs.requirements;
  plan.screens = handoffs.ui.screens;
  plan.architecture = handoffs.architecture;
  plan.security = handoffs.security;

  for (const task of plan.tasks) {
    if (!isAgentId(task.agentId)) problems.push(`task ${task.id} is assigned to unknown agent "${task.agentId}"`);
  }
  const taskIds = new Set(plan.tasks.map((t) => t.id));
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) problems.push(`task ${task.id} depends on unknown task ${dep}`);
    }
  }
  const featureIds = new Set(plan.features.map((f) => f.id));
  for (const feature of plan.features) {
    if (!featureIds.has(feature.id)) problems.push(`feature ${feature.id} does not exist`);
    if (!isAgentId(feature.ownerAgent)) problems.push(`feature ${feature.id} is owned by unknown agent "${feature.ownerAgent}"`);
    if (!feature.tasks.length) problems.push(`feature ${feature.id} has no tasks`);
    for (const dep of feature.dependsOn) {
      if (dep !== feature.id && !featureIds.has(dep)) problems.push(`feature ${feature.id} depends on unknown feature ${dep}`);
    }
  }
  try {
    plan.waves = wavesFromTaskDependencies(plan.tasks);
  } catch (e) {
    problems.push((e as Error).message);
  }

  const owners = new Set(plan.tasks.map((t) => t.agentId));
  for (const agent of AGENT_ID_NAMES) {
    if (!owners.has(agent)) problems.push(`no task is assigned to agent ${agent}`);
  }

  if (problems.length) throw new PlanAssemblyError(problems);
  return plan;
}

/**
 * Execution waves over the task graph, one layer per round of ready work.
 *
 * The waves hold task ids, not agent ids: two tasks of the same agent can sit in
 * different rounds, and a reader of the plan needs to know which round each piece
 * of work can start in.
 */
export function wavesFromTaskDependencies(tasks: PlannedTask[]): string[][] {
  const known = new Set(tasks.map((t) => t.id));
  const byTask = new Map<string, string[]>(tasks.map((t) => [t.id, t.dependsOn.filter((d) => known.has(d))]));
  const waves = wavesFromDependencies([...byTask.keys()], (id) => byTask.get(id) ?? []);
  const order = new Map(tasks.map((t, at) => [t.id, at]));
  return waves.map((wave) => [...wave].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)));
}

export function plannedFeatureTitles(plan: BuildPlan): string {
  return plan.features.map((f) => f.title).join(', ');
}

export function summary(plan: BuildPlan): string {
  return [
    `idea: ${plan.idea}`,
    `app: ${plan.appName} (${plan.packageId})`,
    `archetype: ${plan.archetype} -> ${plan.entity.className} with ${plan.entity.fields.length} fields`,
    `icon: ${plan.icon.category} because ${plan.icon.reason}`,
    `features: ${plan.features.length}`,
    `tasks: ${plan.tasks.length}`,
    `unit tests required: ${plan.verification.minimumUnitTests}`
  ].join('\n');
}

export { derivePackageId, deriveAppName, pluralOf };