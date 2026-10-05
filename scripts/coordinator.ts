#!/usr/bin/env node
/**
 * Run the twenty-agent fleet.
 *
 *   node --experimental-strip-types scripts/coordinator.ts "<idea>"
 *   BUILDER_IDEA="<idea>" node --experimental-strip-types scripts/coordinator.ts
 *   node --experimental-strip-types scripts/coordinator.ts --resume <runId>
 *   node --experimental-strip-types scripts/coordinator.ts --pre-cloud
 *   node --experimental-strip-types scripts/coordinator.ts --requests
 *
 * The last flags matter: `--pre-cloud` runs everything that does not need
 * GitHub or a network, which is what a local check should use; `--resume`
 * continues a stopped run without redoing verified work; and `--requests` lists
 * the runs that have been asked for but not yet delivered.
 *
 * A new idea always starts from an empty state. A checkout of main carries the
 * state and evidence of whatever ran last, and a run that inherited them would
 * be reporting another app's proof as its own.
 */
import { inspectRun, resumeRun, startNewRun } from './agents/recovery.ts';
import { listRuns } from './agents/recovery.ts';
import { listRequests, openRequests } from './live/runRequests.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? '' : argv[at + 1] ?? '';
};

if (flag('help')) {
  console.log(`Usage:
  scripts/coordinator.ts "<idea>"              run the fleet for an idea
  scripts/coordinator.ts --pre-cloud           same, stopping before GitHub
  scripts/coordinator.ts --resume [runId]      continue a stopped run
  scripts/coordinator.ts --status [runId]      print what a run has proven
  scripts/coordinator.ts --runs                list the runs on disk
  scripts/coordinator.ts --requests            list the run requests on record`);
  process.exit(0);
}

if (flag('runs')) {
  const runs = listRuns();
  if (!runs.length) console.log('No runs recorded yet.');
  for (const run of runs) {
    console.log(`${run.current ? '*' : ' '} ${run.runId}  ${run.agentsCompleted}/${run.agentsTotal} agents  ${run.projectState}  evidence ${run.evidenceThrough}  ${run.idea}`);
  }
  process.exit(0);
}

if (flag('requests')) {
  const requests = listRequests();
  if (!requests.length) console.log('No run requests recorded.');
  for (const r of requests) {
    const runs = r.dispatches.map((d) => d.runId || d.outcome).join(', ') || 'not dispatched';
    console.log(`${r.state === 'delivered' ? ' ' : '*'} ${r.requestId}  ${r.state}  ${runs}  ${r.idea}`);
  }
  console.log(`\n${openRequests().length} request(s) still open.`);
  process.exit(0);
}

if (flag('status')) {
  const inspection = inspectRun(value('status') || undefined);
  console.log(`run ${inspection.runId} — ${inspection.idea}`);
  console.log(`  project state  ${inspection.projectState}`);
  console.log(`  agents         ${inspection.completedAgents.length}/${inspection.completedAgents.length + inspection.pendingAgents.length + inspection.failedAgents.length} complete`);
  console.log(`  evidence       ${inspection.evidence.join(' > ') || 'none'}`);
  if (inspection.missingEvidence.length) console.log(`  missing        ${inspection.missingEvidence.join(', ')}`);
  for (const failure of inspection.failedAgents) console.log(`  failed         ${failure.agentId}: ${failure.errors.join('; ')}`);
  process.exit(inspection.runComplete ? 0 : 1);
}

const options = {
  mode: flag('pre-cloud') ? ('pre-cloud' as const) : ('full' as const),
  maxConcurrency: Number(value('concurrency') || process.env.BUILDER_AGENT_CONCURRENCY || 4)
};

const report = flag('resume')
  ? await resumeRun(value('resume') || undefined, options)
  : await startNewRun(
      argv.filter((a) => !a.startsWith('--') && a !== value('resume') && a !== value('concurrency')).join(' '),
      options
    );

console.log('');
console.log(`run ${report.runId} ${report.status}`);
console.log(`  idea        ${report.idea}`);
console.log(`  agents      ${report.agents.filter((a) => a.status === 'completed').length} completed, ${report.agents.filter((a) => a.status === 'failed').length} failed, ${report.agents.filter((a) => a.status === 'skipped').length} skipped`);
console.log(`  state       ${report.projectState}`);
console.log(`  evidence    ${report.evidenceStages.join(' > ') || 'none'}`);
if (report.apkSha256) console.log(`  apk         sha256 ${report.apkSha256}`);
if (report.downloadUrl) console.log(`  download    ${report.downloadUrl}`);
for (const failure of report.failures) console.log(`  failed      ${failure.agent}: ${failure.error}`);

process.exit(report.status === 'completed' ? 0 : 1);
