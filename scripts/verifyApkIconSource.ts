/**
 * Authoritative "the compiled icon is *our* icon" check, run from CI after the
 * APK is assembled.
 *
 * `verifyApkIconAapt.ts` proves the compiled resource table agrees with the
 * manifest. This proves the opposite direction: the pixels a launcher will
 * actually draw come from the PNGs this repository generated for this idea. It
 * is deliberately a real file rather than a `node -e` one-liner in the
 * workflow, because a multi-line program inside a shell double-quoted argument
 * loses its own quotes before Node ever sees it.
 *
 * Env:
 *   APK_FILE  path to the assembled APK (required)
 *   ANDROID_ROOT  generated project root (default `.builder/generated/android`)
 */
import { verifyApkLauncherIcon } from './live/apkIconVerifier.ts';
import {
  validateLauncherIcon,
  sourceIconSignatures,
  sourceRoundSignatures,
  sourceForegroundSignatures,
  sourceIconPngBytes
} from './live/launcherIcon.ts';

function main(): void {
  const apk = process.env.APK_FILE;
  if (!apk) {
    console.error('APK_FILE is not set, so the compiled launcher icon cannot be verified');
    process.exit(1);
  }
  const root = process.env.ANDROID_ROOT || '.builder/generated/android';
  const source = validateLauncherIcon(root);
  if (!source.valid) {
    console.error('the generated launcher icon source did not validate:');
    for (const e of source.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const res = verifyApkLauncherIcon(apk, {
    signatures: sourceIconSignatures(root),
    roundSignatures: sourceRoundSignatures(root),
    foregroundSignatures: sourceForegroundSignatures(root),
    sourcePngBytes: sourceIconPngBytes(root),
    fingerprint: source.fingerprint
  });
  if (!res.valid) {
    console.error('the compiled launcher icon is not the generated icon:');
    for (const e of res.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `verified ${res.matchedDensities.length} densities, similarity ${res.similarity}, fingerprint ${source.fingerprint}`
  );
}

main();