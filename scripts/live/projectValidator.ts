import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { lintGeneratedSources, errorsOf, type LintFinding } from './kotlinLint.ts';

export interface ProjectValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
  packageId?: string;
  lint?: LintFinding[];
  sourceFiles?: string[];
}

function readStringNames(xml: string): Set<string> {
  const names = new Set<string>();
  for (const m of xml.matchAll(/<string\s+name="([^"]+)"/g)) names.add(m[1]);
  for (const m of xml.matchAll(/<plurals\s+name="([^"]+)"/g)) names.add(m[1]);
  for (const m of xml.matchAll(/<string-array\s+name="([^"]+)"/g)) names.add(m[1]);
  return names;
}

export function validateGeneratedProject(root: string): ProjectValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const required = [
    'settings.gradle.kts',
    'build.gradle.kts',
    'app/build.gradle.kts',
    'app/src/main/AndroidManifest.xml',
    'gradle.properties'
  ];
  for (const f of required) {
    const p = `${root}/${f}`;
    if (!existsSync(p)) {
      errors.push(`Missing required file: ${f}`);
    } else {
      try {
        if (statSync(p).size === 0) errors.push(`Empty file: ${f}`);
      } catch (e: any) {
        errors.push(`Cannot stat ${f}: ${e.message}`);
      }
    }
  }

  let packageId: string | undefined;
  const appGradle = `${root}/app/build.gradle.kts`;
  if (existsSync(appGradle)) {
    const content = readFileSync(appGradle, 'utf-8');
    const appIdMatch = content.match(/applicationId\s*=\s*"([^"]+)"/);
    if (!appIdMatch) {
      errors.push('app/build.gradle.kts missing applicationId');
    } else {
      packageId = appIdMatch[1];
      if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(packageId)) {
        errors.push(`Invalid applicationId format: ${packageId}`);
      }
    }
    const nsMatch = content.match(/namespace\s*=\s*"([^"]+)"/);
    if (!nsMatch) errors.push('app/build.gradle.kts missing namespace');
    else if (packageId && nsMatch[1] !== packageId) {
      errors.push(`namespace ${nsMatch[1]} does not match applicationId ${packageId}`);
    }
    if (!/compileSdk\s*=\s*\d+/.test(content)) errors.push('app/build.gradle.kts missing compileSdk');
    if (!/minSdk\s*=\s*\d+/.test(content)) errors.push('app/build.gradle.kts missing minSdk');
    if (!/targetSdk\s*=\s*\d+/.test(content)) errors.push('app/build.gradle.kts missing targetSdk');
    if (!content.includes('com.android.application')) errors.push('Missing android application plugin');
    if (!content.includes('buildTypes')) errors.push('Missing buildTypes block');
    if (!/JavaVersion\.VERSION_17/.test(content)) errors.push('Missing Java 17 compile/target compatibility');
    if (!/jvmTarget\s*=\s*"17"/.test(content)) errors.push('Missing Kotlin jvmTarget 17');
  }

  const settings = `${root}/settings.gradle.kts`;
  if (existsSync(settings)) {
    const content = readFileSync(settings, 'utf-8');
    if (!/include\(":app"\)/.test(content)) {
      errors.push('settings.gradle.kts does not include ":app"');
    }
    if (!/rootProject\.name\s*=/.test(content)) {
      errors.push('settings.gradle.kts missing rootProject.name');
    }
  }

  const props = `${root}/gradle.properties`;
  if (existsSync(props)) {
    const content = readFileSync(props, 'utf-8');
    if (!/android\.useAndroidX\s*=\s*true/.test(content)) {
      errors.push('gradle.properties must set android.useAndroidX=true');
    }
  }

  const manifest = `${root}/app/src/main/AndroidManifest.xml`;
  let drawables = new Set<string>();
  if (existsSync(manifest)) {
    const content = readFileSync(manifest, 'utf-8');
    if (!/<application[\s>]/.test(content)) errors.push('AndroidManifest.xml missing <application>');
    if (!/android\.intent\.action\.MAIN/.test(content)) {
      errors.push('AndroidManifest.xml missing MAIN launcher intent-filter');
    }
    if (!/android:exported\s*=\s*"true"/.test(content)) {
      errors.push('AndroidManifest.xml launcher activity must be exported for Android 12+');
    }
    if (/android:name="\.[A-Za-z]+"/.test(content)) {
      const rel = content.match(/android:name="\.[A-Za-z]+"/)?.[0] || '';
      const cls = rel.replace('android:name=".', '').replace('"', '');
      if (cls && !existsSync(`${root}/app/src/main/java/${packageId?.replace(/\./g, '/')}/${cls}.kt`)) {
        errors.push(`manifest activity .${cls} has no matching Kotlin source file`);
      }
    }
    for (const m of content.matchAll(/@drawable\/([A-Za-z0-9_]+)/g)) drawables.add(m[1]);
  }

  const javaRoot = `${root}/app/src/main/java`;
  const ktRoot = `${root}/app/src/main/kotlin`;
  const hasSrc = (existsSync(javaRoot) && statSync(javaRoot).isDirectory()) ||
                 (existsSync(ktRoot) && statSync(ktRoot).isDirectory());
  if (!hasSrc) {
    errors.push('No Kotlin/Java source directory found');
  }

  const testDir = `${root}/app/src/test`;
  if (!existsSync(testDir)) {
    errors.push('Missing app/src/test directory (no unit tests)');
  } else if (findSources(testDir).length === 0) {
    errors.push('app/src/test contains no .kt/.java unit test sources');
  }

  const resDir = `${root}/app/src/main/res`;
  const stringsXml = `${resDir}/values/strings.xml`;
  const stringNames = new Set<string>();
  if (!existsSync(resDir)) {
    errors.push('Missing app/src/main/res directory');
  } else if (!statSync(resDir).isDirectory()) {
    errors.push('app/src/main/res is not a directory');
  } else if (!existsSync(stringsXml)) {
    errors.push('Missing res/values/strings.xml');
  } else if (statSync(stringsXml).size === 0) {
    errors.push('Empty res/values/strings.xml');
  } else {
    const xml = readFileSync(stringsXml, 'utf-8');
    for (const n of readStringNames(xml)) stringNames.add(n);
    for (const m of xml.matchAll(/android:name="@string\/([A-Za-z0-9_]+)"/g)) {
      if (!stringNames.has(m[1])) {
        errors.push(`AndroidManifest references @string/${m[1]}, which strings.xml does not declare`);
      }
    }
  }

  // Source and resource structural lint: catches generator bugs before any
  // cloud build is dispatched. GitHub Actions remains the real compiler.
  const files: Record<string, string> = {};
  const mainSources = [
    ...(existsSync(javaRoot) ? findSources(javaRoot) : []),
    ...(existsSync(ktRoot) ? findSources(ktRoot) : [])
  ];
  const testSources = existsSync(testDir) ? findSources(testDir) : [];
  if (mainSources.length === 0) errors.push('No .kt/.java source files found');
  const sourceFiles = [...mainSources, ...testSources];
  for (const f of sourceFiles) {
    files[f.slice(root.length + 1)] = readFileSync(f, 'utf-8');
  }
  if (existsSync(manifest)) files['app/src/main/AndroidManifest.xml'] = readFileSync(manifest, 'utf-8');
  if (existsSync(stringsXml)) files['app/src/main/res/values/strings.xml'] = readFileSync(stringsXml, 'utf-8');

  const lint = lintGeneratedSources({
    files,
    packageId: packageId || '',
    stringNames
  });
  for (const f of lint) {
    const msg = `${f.file}: ${f.message}`;
    if (f.severity === 'error') errors.push(msg);
    else warnings.push(msg);
  }
  for (const d of drawables) {
    const xmlPath = `${resDir}/drawable/${d}.xml`;
    if (!existsSync(xmlPath) && !existsSync(`${resDir}/drawable-${d}`)) {
      warnings.push(`verify drawable ${d} exists`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    packageId,
    lint,
    sourceFiles: sourceFiles.map((f) => f.slice(root.length + 1))
  };
}

function findSources(dir: string): string[] {
  const out: string[] = [];
  let entries: any[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as any[];
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...findSources(p));
    else if (e.name.endsWith('.kt') || e.name.endsWith('.java')) out.push(p);
  }
  return out;
}
