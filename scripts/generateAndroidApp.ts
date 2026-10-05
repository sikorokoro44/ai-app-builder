#!/usr/bin/env node
/**
 * Generates the Android project for an idea.
 *
 * This is a composition of the shared emitters in scripts/project/emitters.ts:
 * the same functions the project scaffolder, manifest engineer, data engineer,
 * UI engineer and resource engineer each own a slice of. It exists so the
 * authoritative GitHub Actions build can regenerate the app from the idea in one
 * command, and it must keep producing byte-identical output (pinned by
 * test/fixtures/generatedProjectGolden.json).
 */

import { validateGeneratedProject } from './live/projectValidator.ts';
import { writeLauncherIcon, validateLauncherIcon } from './live/launcherIcon.ts';
import { specForIdea } from './domainModels.ts';
import {
  deriveAppName,
  derivePackageId,
  emitAppGradle,
  emitKotlinSources,
  emitManifest,
  emitResourceValues,
  emitRootBuildFiles,
  emitWrapperAndProguard,
  layoutFor,
  prepareProjectDirs
} from './project/emitters.ts';

export interface GenerateOptions {
  idea: string;
  outDir?: string;
  packageId?: string;
  appName?: string;
}

export { derivePackageId, deriveAppName } from './project/emitters.ts';

export function generateAndroidApp(opts: GenerateOptions) {
  const out = opts.outDir || '.builder/generated/android';
  const idea = (opts.idea || '').trim() || 'A simple notes app';
  const packageId = opts.packageId || derivePackageId(idea);
  const appName = opts.appName || deriveAppName(idea);
  const spec = specForIdea(idea);
  const layout = layoutFor(out, packageId, appName, spec);

  prepareProjectDirs(layout);
  emitRootBuildFiles(layout);
  emitAppGradle(layout);
  emitManifest(layout);
  emitResourceValues(layout);

  // The launcher icon is generated from the app's purpose rather than shipped as
  // a fixed asset: one hardcoded vector for every app made "the icon exists" true
  // while saying nothing about whether it suited the app. Density-complete PNGs
  // plus a v26 adaptive icon are written, because minSdk 24 means both are used.
  const icon = writeLauncherIcon(out, idea, appName);
  const iconCheck = validateLauncherIcon(out);
  if (!iconCheck.valid) {
    throw new Error(`Generated launcher icon failed validation:\n - ${iconCheck.errors.join('\n - ')}`);
  }

  emitKotlinSources(layout, idea);
  emitWrapperAndProguard(layout);

  return {
    out,
    packageId,
    appName,
    spec: spec.className,
    icon: {
      category: icon.category,
      purpose: icon.purpose,
      reason: icon.reason,
      fingerprint: icon.fingerprint,
      files: icon.files
    }
  };
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
  console.log(JSON.stringify({
    generated: result.out,
    packageId: validation.packageId,
    model: result.spec,
    icon: {
      category: result.icon.category,
      purpose: result.icon.purpose,
      reason: result.icon.reason,
      fingerprint: result.icon.fingerprint,
      resourceCount: result.icon.files.length
    },
    valid: true
  }));
}