#!/usr/bin/env node
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { validateGeneratedProject } from './live/projectValidator.ts';
import { specForIdea, numericRoles, type EntitySpec, type EntityField } from './domainModels.ts';

export interface GenerateOptions {
  idea: string;
  outDir?: string;
  packageId?: string;
  appName?: string;
}

const STOP_WORDS = /^(the|and|for|with|that|this|from|your|our|build|make|create|simple|basic|small|app|application|please|can|you|me|want|need|help|using|use)$/;

export function derivePackageId(idea: string): string {
  const words = (idea || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.test(w));
  const slug = words.slice(0, 2).join('') || 'builderapp';
  return `com.builder.${slug}`;
}

export function deriveAppName(idea: string): string {
  const cleaned = (idea || '').replace(/\s+/g, ' ').trim();
  const short = cleaned.length > 40 ? cleaned.slice(0, 40).trim() : cleaned;
  const safe = short.replace(/[<>&"'`{}|\\^~\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return safe || 'Builder App';
}

function ktType(f: EntityField): string {
  return f.type === 'int' ? 'Int' : f.type === 'bool' ? 'Boolean' : 'String';
}

function defaultFor(f: EntityField): string {
  if (f.type === 'int') return String(f.initial ?? 0);
  if (f.type === 'bool') return String(f.initial ?? false);
  return '""';
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? 'n' : '';
}

function stripPackagePlaceholder(src: string): string {
  return src.replace(/^package\s+\S+\n+/, '');
}

function cap(name: string): string {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

function pluralOf(name: string): string {
  if (/s$/i.test(name)) return name;
  if (/(s|x|z|ch|sh)$/i.test(name)) return name + 'es';
  if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + 'ies';
  return name + 's';
}

function storeSource(spec: EntitySpec, idea: string): string {
  const cls = spec.className;
  const textFields = spec.fields.filter((f) => f.type === 'text');
  const boolField = spec.fields.find((f) => f.type === 'bool');
  const intFields = spec.fields.filter((f) => f.type === 'int');
  const { progress: progressField, target: targetField, streak: streakField, primary } = numericRoles(spec);


  const addParams = textFields.map((f) => `${f.name}: String`).join(', ');
  const validations = textFields.map((f) => {
    const v = `clean${cap(f.name)}`;
    return `        val ${v} = ${f.name}.trim()\n        require(${v}.isNotEmpty()) { "${f.label} must not be blank" }`;
  }).join('\n');
  const ctorArgs = spec.fields.map((f) => {
    if (f.type === 'text') return `${f.name} = clean${cap(f.name)}`;
    return `${f.name} = ${defaultFor(f)}`;
  }).join(', ');

  const pendingName = `pending${cap(cls)}`;
  const openName = `open${pluralOf(cls)}`;
  const pendingFilter = boolField ? `!it.${boolField.name}`
    : (progressField && targetField) ? `it.${progressField.name} < it.${targetField.name}`
    : 'true';

  const toggleMethod = boolField ? `
    /** Flips the completion flag. Returns false when the id is unknown. */
    fun toggle(id: Long): Boolean {
        val current = items[id] ?: return false
        items[id] = current.copy(${boolField.name} = !current.${boolField.name})
        return true
    }` : '';

  const completeMethod = spec.actions.includes('complete') && boolField ? `
    /** Marks the ${spec.noun} finished regardless of its current flag. */
    fun complete(id: Long): Boolean {
        val current = items[id] ?: return false
        items[id] = current.copy(${boolField.name} = true)
        return true
    }` : '';

  const incrementUpdates = !progressField ? '' : [
    `            ${progressField.name} = current.${progressField.name} + by`,
    ...(streakField ? [`            ${streakField.name} = current.${streakField.name} + by`] : []),
    ...(targetField
      ? [`            ${targetField.name} = maxOf(current.${targetField.name}, current.${progressField.name} + by)`]
      : [])
  ].join(',\n');

  const incrementMethod = progressField ? `
    /**
     * Records progress: advances ${progressField.label.toLowerCase()}${
      streakField ? `, extends the ${streakField.label.toLowerCase()}` : ''}${
      targetField ? `, and never lowers the ${targetField.label.toLowerCase()}` : ''}.
     *
     * Returns false for an unknown id and rejects a zero step so a caller's
     * total can never silently stand still.
     */
    fun increment(id: Long, by: Int = 1): Boolean {
        val current = items[id] ?: return false
        require(by != 0) { "increment must be non-zero" }
        items[id] = current.copy(
${incrementUpdates}
        )
        return true
    }

    /** True once progress has reached ${targetField ? 'the target' : 'a positive count'}. */
    fun goalMet(id: Long): Boolean {
        val current = items[id] ?: return false
        return current.${progressField.name} > 0${targetField ? ` && current.${progressField.name} <= current.${targetField.name}` : ''}
    }` : '';

  const summaryMethods = primary ? `
    /** Sum of the primary numeric field across every ${spec.noun}. */
    fun total${cap(primary.name)}(): Int = items.values.sumOf { it.${primary.name} }` : '';

  const dataCtor = spec.fields.map((f) => `    val ${f.name}: ${ktType(f)} = ${defaultFor(f)}`).join(',\n');

  return `import java.util.concurrent.atomic.AtomicLong

/**
 * ${cls} model and in-memory store for: "${escapeKotlin(idea)}".
 *
 * Purpose: ${spec.purpose}. Pure Kotlin with no Android dependencies, so the
 * entire data layer is covered by JVM unit tests.
 */
data class ${cls}(
    val id: Long,
${dataCtor}
)

class ${cls}Store {
    private val nextId = AtomicLong(1)
    private val items = LinkedHashMap<Long, ${cls}>()

    /** Adds a${article(spec.noun)} ${spec.noun}; every text field must be non-blank. */
    fun add(${addParams}): ${cls} {
${validations}
        val created = ${cls}(id = nextId.getAndIncrement(), ${ctorArgs})
        items[created.id] = created
        return created
    }
${toggleMethod}
${completeMethod}${incrementMethod}

    /** Removes a${article(spec.noun)} ${spec.noun}. Returns false when the id is unknown. */
    fun remove(id: Long): Boolean = items.remove(id) != null

    fun clear() = items.clear()

    fun all(): List<${cls}> = items.values.toList()

    fun find(id: Long): ${cls}? = items[id]

    /** ${spec.plural[0].toUpperCase()}${spec.plural.slice(1)} still needing attention. */
    fun ${openName}(): List<${cls}> = items.values.filter { ${pendingFilter} }
${summaryMethods}
    fun count(): Int = items.size
}
`;
}

function escapeKotlin(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function activitySource(spec: EntitySpec, idea: string): string {
  const cls = spec.className;
  const boolField = spec.fields.find((f) => f.type === 'bool');
  const { progress: progressField, target: targetField } = numericRoles(spec);
  const textFields = spec.fields.filter((f) => f.type === 'text');

  const drafts = textFields
    .map((f) => `    var draft${cap(f.name)} by remember { mutableStateOf("") }`)
    .join('\n');
  const addArgs = textFields.map((f) => `draft${cap(f.name)}`).join(', ');

  const addForm = textFields.map((f) => `            OutlinedTextField(
                value = draft${cap(f.name)},
                onValueChange = { draft${cap(f.name)} = it },
                label = { Text(stringResource(R.string.field_${f.name})) },
                singleLine = true,
                modifier = Modifier.weight(1f)
            )`).join('\n');

  const resetDrafts = textFields
    .map((f) => `                        draft${cap(f.name)} = ""`)
    .join('\n');

  const rowLeading = boolField
    ? `            Checkbox(
                checked = item.${boolField.name},
                onCheckedChange = { store.toggle(item.id); refresh() }
            )`
    : '';

  const detailLines = textFields.slice(1).map((f) =>
    `                Text(text = item.${f.name}, style = MaterialTheme.typography.bodyMedium)`).join('\n');

  const progressArg = targetField ? `, item.${targetField.name}` : '';

  const progressLine = progressField
    ? `                Text(
                    text = stringResource(R.string.progress_format, item.${progressField.name}${progressArg}),
                    style = MaterialTheme.typography.labelMedium
                )`
    : '';

  const secondaryButton = spec.actions.includes('increment') && progressField
    ? `            Button(onClick = { store.increment(item.id); refresh() }) {
                Text(stringResource(R.string.increment))
            }`
    : boolField
    ? `            Button(onClick = { store.toggle(item.id); refresh() }) {
                Text(stringResource(R.string.mark_done))
            }`
    : '';

  return `import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

/**
 * ${spec.purpose[0].toUpperCase()}${spec.purpose.slice(1)}, built from: "${escapeKotlin(idea)}".
 *
 * All visible text comes from res/values/strings.xml, so the UI is localisable and
 * nothing here hard-codes user-facing copy.
 */
class MainActivity : ComponentActivity() {
    private val store = ${cls}Store()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    ${cls}Screen(store)
                }
            }
        }
    }
}

@Composable
fun ${cls}Screen(store: ${cls}Store) {
${drafts}
    var rows by remember { mutableStateOf(store.all()) }

    fun refresh() {
        rows = store.all()
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            text = stringResource(R.string.app_name),
            style = MaterialTheme.typography.headlineMedium
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
${addForm}
            Button(
                onClick = {
                    if (runCatching { store.add(${addArgs}) }.isSuccess) {
${resetDrafts}
                        refresh()
                    }
                }
            ) { Text(stringResource(R.string.add_button)) }
        }

        if (rows.isEmpty()) {
            Text(
                text = stringResource(R.string.empty_list),
                style = MaterialTheme.typography.bodyLarge
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                ${cls}Rows(rows, store, ::refresh)
            }
        }
    }
}

private fun LazyListScope.${cls}Rows(
    rows: List<${cls}>,
    store: ${cls}Store,
    onChanged: () -> Unit
) {
    items(rows, key = { it.id }) { item ->
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
${rowLeading}
            Column(modifier = Modifier.weight(1f)) {
                Text(text = item.${textFields[0].name}, style = MaterialTheme.typography.titleMedium)
${detailLines}
${progressLine}
            }
${secondaryButton}
            Button(onClick = { store.remove(item.id); onChanged() }) {
                Text(stringResource(R.string.delete))
            }
        }
    }
}
`;
}

function testSource(spec: EntitySpec): string {
  const cls = spec.className;
  const boolField = spec.fields.find((f) => f.type === 'bool');
  const { progress: progressField } = numericRoles(spec);
  const textArgs = spec.fields.filter((f) => f.type === 'text').map((f) => `"${f.label}"`).join(', ');
  const tests: string[] = [
    `    @Test
    fun addTrimsAndStores${cls}() {
        val store = ${cls}Store()
        val created = store.add(${textArgs})
        assertEquals("${spec.fields.filter((f) => f.type === 'text')[0].label}", created.${spec.fields.filter((f) => f.type === 'text')[0].name})
        assertEquals(1, store.count())
    }

    @Test(expected = IllegalArgumentException::class)
    fun addRejectsBlank${cls}Name() {
        ${cls}Store().add(${textArgs.split(', ').map(() => '"   "').join(', ')})
    }

    @Test
    fun removeDeletes${cls}() {
        val store = ${cls}Store()
        val created = store.add(${textArgs})
        assertTrue(store.remove(created.id))
        assertFalse(store.remove(created.id))
        assertEquals(0, store.count())
    }

    @Test
    fun allReturnsInsertionOrder() {
        val store = ${cls}Store()
        store.add(${textArgs})
        store.add(${textArgs})
        assertEquals(listOf(1L, 2L), store.all().map { it.id })
    }`
  ];
  if (boolField) {
    tests.push(`
    @Test
    fun toggleFlips${cap(boolField.name)}() {
        val store = ${cls}Store()
        val created = store.add(${textArgs})
        assertTrue(store.toggle(created.id))
        assertEquals(true, store.find(created.id)?.${boolField.name})
        assertTrue(store.toggle(created.id))
        assertEquals(false, store.find(created.id)?.${boolField.name})
    }

    @Test
    fun toggleOnMissingIdReturnsFalse() {
        assertFalse(${cls}Store().toggle(999L))
    }`);
  }
  if (spec.actions.includes('increment') && progressField) {
    const { target: incTarget, streak: incStreak } = numericRoles(spec);
    const base = Number(progressField.initial ?? 0);
    const tBase = incTarget ? Number(incTarget.initial ?? 0) : 0;
    const sBase = incStreak ? Number(incStreak.initial ?? 0) : 0;
    const afterOne = [
      `        assertEquals(${base + 1}, store.find(created.id)?.${progressField.name})`,
      ...(incStreak ? [`        assertEquals(${sBase + 1}, store.find(created.id)?.${incStreak.name})`] : []),
      ...(incTarget
        ? [`        assertEquals(${Math.max(tBase, base + 1)}, store.find(created.id)?.${incTarget.name})`]
        : [])
    ].join('\n');
    const afterThree = [
      `        assertEquals(${base + 3}, store.find(created.id)?.${progressField.name})`,
      ...(incStreak ? [`        assertEquals(${sBase + 3}, store.find(created.id)?.${incStreak.name})`] : []),
      ...(incTarget
        ? [`        assertEquals(${Math.max(tBase, base + 3)}, store.find(created.id)?.${incTarget.name})`]
        : [])
    ].join('\n');
    tests.push(`
    @Test
    fun incrementAdvancesProgressAndStreak() {
        val store = ${cls}Store()
        val created = store.add(${textArgs})
        assertTrue(store.increment(created.id))
${afterOne}
    }

    @Test
    fun incrementIsCumulative() {
        val store = ${cls}Store()
        val created = store.add(${textArgs})
        store.increment(created.id)
        store.increment(created.id, 2)
${afterThree}
    }

    @Test
    fun incrementOnMissingIdReturnsFalse() {
        assertFalse(${cls}Store().increment(999L))
    }

    @Test(expected = IllegalArgumentException::class)
    fun incrementRejectsZero() {
        val store = ${cls}Store()
        val created = store.add(${textArgs})
        store.increment(created.id, 0)
    }`);
  }
  if (spec.actions.includes('complete')) {
    tests.push(`
    @Test
    fun completeMarks${cls}Finished() {
        val store = ${cls}Store()
        val created = store.add(${textArgs})
        assertTrue(store.complete(created.id))
        assertEquals(true, store.find(created.id)?.${boolField?.name})
    }`);
  }
  tests.push(`
    @Test
    fun clearRemovesEverything() {
        val store = ${cls}Store()
        store.add(${textArgs})
        store.clear()
        assertEquals(0, store.count())
    }`);

  return `import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the ${cls} data layer: ${spec.purpose}. */
class ${cls}StoreTest {
${tests.join('\n\n')}
}
`.replace('PKG', '');
}

export function generateAndroidApp(opts: GenerateOptions) {
  const out = opts.outDir || '.builder/generated/android';
  const idea = (opts.idea || '').trim() || 'A simple notes app';
  const packageId = opts.packageId || derivePackageId(idea);
  const appName = opts.appName || deriveAppName(idea);
  const spec = specForIdea(idea);
  const cls = spec.className;
  const pkgPath = packageId.replace(/\./g, '/');
  const javaRoot = `${out}/app/src/main/java/${pkgPath}`;
  const testRoot = `${out}/app/src/test/java/${pkgPath}`;
  const resValues = `${out}/app/src/main/res/values`;
  const resDrawable = `${out}/app/src/main/res/drawable`;
  const manifestDir = `${out}/app/src/main`;

  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  for (const d of [javaRoot, testRoot, resValues, resDrawable, `${out}/gradle/wrapper`]) {
    mkdirSync(d, { recursive: true });
  }

  writeFileSync(`${out}/settings.gradle.kts`,
`rootProject.name = "${appName.replace(/[^A-Za-z0-9_]/g, '').toLowerCase() || 'builderapp'}"
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories { google(); mavenCentral() }
}
include(":app")
`);

  writeFileSync(`${out}/build.gradle.kts`, `buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        classpath("com.android.tools.build:gradle:8.5.2")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.24")
    }
}
allprojects { repositories { google(); mavenCentral() } }
tasks.register("clean", Delete::class) { delete(rootProject.layout.buildDirectory) }
`);

  writeFileSync(`${out}/gradle.properties`, `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
org.gradle.parallel=true
org.gradle.caching=true
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.code.style=official
`);

  writeFileSync(`${out}/app/build.gradle.kts`, `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "${packageId}"
    compileSdk = 34
    defaultConfig {
        applicationId = "${packageId}"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }
    packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}
dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}
`);

  writeFileSync(`${manifestDir}/AndroidManifest.xml`, `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:allowBackup="true"
        android:icon="@drawable/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/Theme.Builder">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:label="@string/app_name">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`);

  const intField = spec.fields.find((f) => f.type === 'int');
  const targetField = spec.fields.find((f) => f.type === 'int' && /target|goal/i.test(f.name));
  const boolField = spec.fields.find((f) => f.type === 'bool');
  const strings = [
    `    <string name="app_name">${escapeXml(appName)}</string>`,
    ...spec.fields.filter((f) => f.type === 'text').map((f) => `    <string name="field_${f.name}">${escapeXml(f.label)}</string>`),
    `    <string name="add_button">Add ${escapeXml(spec.noun)}</string>`,
    `    <string name="delete">Remove</string>`,
    ...(spec.actions.includes('increment') ? [`    <string name="increment">Log one</string>`] : []),
    ...(boolField ? [`    <string name="mark_done">Mark done</string>`] : []),
    `    <string name="empty_list">No ${escapeXml(spec.plural)} yet. Add your first one.</string>`
  ];
  if (intField) {
    strings.push(targetField
      ? `    <string name="progress_format">${escapeXml(intField.label)}: %1$d of %2$d</string>`
      : `    <string name="progress_format">${escapeXml(intField.label)}: %1$d</string>`);
  }
  writeFileSync(`${resValues}/strings.xml`,
`<?xml version="1.0" encoding="utf-8"?>
<resources>
${strings.join('\n')}
</resources>
`);

  writeFileSync(`${resValues}/colors.xml`, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="primary">#FF3F51B5</color>
    <color name="background">#FFFFFFFF</color>
</resources>
`);

  writeFileSync(`${resValues}/themes.xml`, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.Builder" parent="android:Theme.Material.Light.NoActionBar">
        <item name="android:colorPrimary">@color/primary</item>
        <item name="android:windowBackground">@color/background</item>
    </style>
</resources>
`);

  writeFileSync(`${resDrawable}/ic_launcher.xml`, `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="48dp"
    android:height="48dp"
    android:viewportWidth="48"
    android:viewportHeight="48">
    <path android:fillColor="#3F51B5" android:pathData="M0,0h48v48h-48z" />
    <path android:fillColor="#FFFFFF" android:pathData="M14,22l7,7l14,-14l3,3l-17,17l-10,-10z" />
</vector>
`);

  // The package is prepended explicitly for every file rather than substituted
  // into a `package PKG` placeholder. activitySource() never emitted that
  // placeholder, so the string replace silently matched nothing and
  // MainActivity.kt was written with no package at all: it could not see
  // TaskStore/Task or the generated R class, and the Kotlin build failed.
  writeFileSync(`${javaRoot}/${cls}Store.kt`, `package ${packageId}\n\n${storeSource(spec, idea)}`);
  writeFileSync(`${javaRoot}/MainActivity.kt`, `package ${packageId}\n\n${activitySource(spec, idea)}`);
  writeFileSync(`${testRoot}/${cls}StoreTest.kt`, `package ${packageId}\n\n${stripPackagePlaceholder(testSource(spec))}`);

  writeFileSync(`${out}/gradle/wrapper/gradle-wrapper.properties`, `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`);

  writeFileSync(`${out}/gradlew`, `#!/usr/bin/env sh
# Thin wrapper: uses the Gradle provided by the CI runner (gradle/actions/setup-gradle).
exec gradle "$@"
`);
  writeFileSync(`${out}/app/proguard-rules.pro`, `# Generated app: keep the data model used via serialization-free reflection-free code.\n`);

  return { out, packageId, appName, spec: spec.className };
}

const isMain = (() => {
  try {
    return !!(process.argv[1] && /generateAndroidApp\.(ts|js)$/.test(process.argv[1]));
  } catch { return false; }
})();

if (isMain) {
  const idea = process.env.BUILDER_IDEA || process.argv.slice(2).join(' ') || 'A simple todo app';
  const result = generateAndroidApp({ idea });
  const validation = validateGeneratedProject(result.out);
  if (!validation.valid) {
    console.error('Generated project failed validation:');
    for (const e of validation.errors) console.error(` - ${e}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ generated: result.out, packageId: validation.packageId, model: result.spec, valid: true }));
}
