#!/usr/bin/env node
/** Repository safety validation for CI. */
import { assertRepoSafety, assertNoSecretsInFiles } from '../live/repoGuard.ts';

const guard = assertRepoSafety(process.cwd());
if (!guard.ok) {
  console.error('Repository safety failed:');
  for (const e of guard.errors) console.error(' - ' + e);
  process.exit(1);
}
const secrets = assertNoSecretsInFiles(process.cwd(), ['scripts', 'shared', '.github']);
if (secrets.length > 0) {
  console.error('Possible secrets in tracked files:');
  for (const s of secrets) console.error(' - ' + s);
  process.exit(1);
}
console.log('repository safety: ok');
