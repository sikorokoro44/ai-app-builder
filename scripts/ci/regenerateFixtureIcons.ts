#!/usr/bin/env node
/**
 * Regenerates the committed fixture's launcher icon resources.
 *
 * `c3d8d34` stopped tracking the mipmap PNGs because their deflate stream differs
 * between the platform the icons were first generated on and the CI runner, yet
 * the test suite still validates the committed fixture's icons. The icons must be
 * present and structurally valid, so this writes them back with the same pure-TS
 * generator the app itself uses. `writeLauncherIcon` touches only the icon
 * resources, so the hand-tuned Kotlin and Gradle files in the fixture are left
 * exactly as they are.
 *
 * Runs on a GitHub runner (Node only): no Android SDK, Gradle, Java or Kotlin.
 */

import { writeLauncherIcon, validateLauncherIcon } from '../live/launcherIcon.ts';
import { deriveAppName } from '../project/emitters.ts';

const FIXTURE = '.builder/generated/android';
const IDEA = 'A genuine modern calculator';

const icon = writeLauncherIcon(FIXTURE, IDEA, deriveAppName(IDEA));

const check = validateLauncherIcon(FIXTURE, IDEA);
if (!check.valid) {
  console.error('regenerated fixture icon failed validation:');
  for (const e of check.errors) console.error(` - ${e}`);
  process.exit(1);
}

console.log(`wrote ${icon.files.length} icon resources for "${IDEA}" (category ${icon.category})`);
