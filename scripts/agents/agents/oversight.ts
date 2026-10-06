/**
 * Agents 19-20: the oversight wave.
 *
 * The failure diagnostician runs on every build, not only on failures: it
 * reports on the health of what was produced and classifies anything that went
 * wrong, so a green run still carries a diagnosis. The integration supervisor is
 * the only agent allowed to close a run, and it closes it through the proven
 * completion gate after checking all twenty agents actually did their work.
 */

import { classifyFailure, isTransientFailure, type Classification } from '../../live/failureClassifier.ts';
import { validateGeneratedProject } from '../../live/projectValidator.ts';
import { assertLifecycleEvidence, missingStages, hasStage } from '../../live/evidenceChain.ts';
import { rejectFakeReleaseUrl, isValidHttpsUrl } from '../../live/releaseVerifier.ts';
import { assertTruthful } from '../../live/stateValidator.ts';
import type { AgentSpec } from '../../../shared/agentTypes.ts';
import { readLedger, readAgentStatus, isAgentComplete } from '../artifacts.ts';
import { AGENT_IDS } from '../agentIds.ts';
import { ok, invalid, fail, planFrom } from './common.ts';

export interface DiagnosisArtifact {
  healthy: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  classifications: Classification[];
  observedFailures: { stage: string; class: string; transient: boolean; reason: string }[];
  recovery: string[];
}

export const failureDiagnosticianAgent: AgentSpec<void, DiagnosisArtifact> = {
  id: 'failure-diagnostician',
  index: 19,
  name: 'Failure Diagnostician',
  role: 'Health analysis and classification',
  responsibility: 'Report on the health of the produced app and classify every failure signal, whether or not anything has actually gone wrong.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'validation', description: 'Validation report', producedBy: 'quality-auditor' },
      { kind: 'build', description: 'Verified APK', producedBy: 'build-verifier', optional: true }
    ],
    outputs: [{ kind: 'diagnosis', description: 'Health checks, failure classifications and recovery advice' }],
    requiredOutputFields: ['healthy', 'checks', 'classifications', 'observedFailures', 'recovery']
  },
  tools: ['validateGeneratedProject', 'classifyFailure', 'isTransientFailure'],
  dependsOn: ['quality-auditor'],
  entersState: 'TESTING',
  ownedPaths: [],
  completionCriteria: [
    'Every health check reports a pass or fail with a reason.',
    'Any observed failure is classified and marked transient or deterministic.',
    'The report is produced on a healthy build too, not only on failure.'
  ],
  failurePolicy: { retryable: true, maxAttempts: 2, repairable: false, maxRepairs: 0, onExhausted: 'rollback' },
  describe: (out) =>
    out
      ? `${out.checks.filter((c) => c.ok).length}/${out.checks.length} health checks passed, ${out.observedFailures.length} observed failure(s)`
      : null,
  async execute(ctx) {
    const plan = planFrom(ctx);
    const state = await ctx.mutate((s) => s);
    const checks: DiagnosisArtifact['checks'] = [];

    const validation = validateGeneratedProject(ctx.projectRoot, plan.idea);
    checks.push({
      name: 'generated-project',
      ok: validation.valid,
      detail: validation.valid ? `valid ${validation.packageId}` : validation.errors[0]
    });

    const ledger = readLedger(ctx.runId);
    const failedAgents = ledger.filter((e) => e.status === 'failed');
    checks.push({
      name: 'agent-ledger',
      ok: failedAgents.length === 0,
      detail: failedAgents.length ? `failed: ${failedAgents.map((f) => f.agentId).join(', ')}` : `${ledger.length} agents recorded`
    });

    const failedState = state.projectState === 'FAILED' || state.projectState === 'REPAIRING';
    checks.push({
      name: 'project-state',
      ok: !failedState,
      detail: failedState ? `run is ${state.projectState}` : `run is ${state.projectState}`
    });

    const buildRecorded = !!state.cloudBuild.runId;
    const buildFailed = buildRecorded && state.cloudBuild.conclusion && state.cloudBuild.conclusion !== 'success';
    checks.push({
      name: 'cloud-build',
      ok: buildRecorded ? !buildFailed : true,
      detail: buildRecorded
        ? `run ${state.cloudBuild.runId} concluded ${state.cloudBuild.conclusion}`
        : 'no cloud run recorded yet'
    });

    const logs: string[] = [...(state.buildLogs ?? []), state.cloudBuild.failedReason ?? ''].filter(Boolean);
    const classifications = logs.length ? [classifyFailure(logs)] : [];
    const observedFailures = logs.length
      ? [{
        stage: state.cloudBuild.stage || 'CLOUD_BUILD',
        class: state.cloudBuild.failureClass || classifications[0].klass,
        transient: isTransientFailure((state.cloudBuild.failureClass as Classification['klass']) || classifications[0].klass),
        reason: state.cloudBuild.failedReason || classifications[0].matched[0] || 'no diagnostic captured'
      }]
      : [];

    const out: DiagnosisArtifact = {
      healthy: checks.every((c) => c.ok),
      checks,
      classifications,
      observedFailures,
      recovery: observedFailures.length
        ? observedFailures[0].transient
          ? ['retry the same commit: the failure was transient']
          : ['repair the owning agent, then invalidate the evidence from that stage']
        : ['no recovery needed']
    };
    ctx.publish('diagnosis', out);
    ctx.activity(out.healthy ? 'health analysis: all checks passed' : `health analysis: ${checks.filter((c) => !c.ok).length} check(s) failing`);
    ctx.log(`diagnosis: ${out.healthy ? 'healthy' : 'degraded'} (${checks.filter((c) => c.ok).length}/${checks.length} checks passed)`);
    return out;
  },
  validate(out) {
    const errors: string[] = [];
    if (!out) return invalid(['the diagnostician produced no report']);
    if (!Array.isArray(out.checks) || out.checks.length < 3) errors.push('too few health checks were run');
    for (const check of out.checks) {
      if (typeof check.ok !== 'boolean') errors.push(`check ${check.name} has no verdict`);
      if (!check.detail) errors.push(`check ${check.name} has no detail`);
    }
    if (typeof out.healthy !== 'boolean') errors.push('no overall health verdict');
    if (!Array.isArray(out.recovery) || out.recovery.length === 0) errors.push('no recovery guidance');
    for (const failure of out.observedFailures) {
      if (!failure.class) errors.push('an observed failure has no class');
      if (typeof failure.transient !== 'boolean') errors.push('an observed failure was not marked transient or deterministic');
    }
    return errors.length ? invalid(errors) : ok();
  }
};

export interface SupervisionArtifact {
  agents: { id: string; status: string; summary?: string; hasOutput: boolean }[];
  missingEvidence: string[];
  verifiedUrl: boolean;
  completed: boolean;
  progressPct: number;
}

export const integrationSupervisorAgent: AgentSpec<void, SupervisionArtifact> = {
  id: 'integration-supervisor',
  index: 20,
  name: 'Integration Supervisor',
  role: 'Cross-agent verification and completion',
  responsibility: 'Verify that all twenty agents really ran, that the evidence chain is complete, that the download is genuine, and only then close the run through the proven completion gate.',
  contract: {
    inputs: [
      { kind: 'plan', description: 'Build plan', producedBy: 'feature-planner' },
      { kind: 'diagnosis', description: 'Health report', producedBy: 'failure-diagnostician' },
      { kind: 'release', description: 'Release result', producedBy: 'release-publisher' }
    ],
    outputs: [{ kind: 'supervision', description: 'The verification of every agent and the completion decision' }],
    requiredOutputFields: ['agents', 'missingEvidence', 'verifiedUrl', 'completed', 'progressPct']
  },
  tools: ['readLedger', 'assertLifecycleEvidence', 'assertTruthful', 'markComplete.ts'],
  dependsOn: ['build-verifier', 'release-publisher', 'failure-diagnostician'],
  entersState: 'DOWNLOAD_READY',
  nextState: 'COMPLETED',
  ownedPaths: [],
  completionCriteria: [
    'All twenty agents have a completed ledger entry and a persisted output artifact.',
    'No evidence stage is missing.',
    'The public download URL is genuine and the state passes the truthfulness check.'
  ],
  failurePolicy: { retryable: false, maxAttempts: 1, repairable: false, maxRepairs: 0, onExhausted: 'fail' },
  async execute(ctx) {
    const ledger = readLedger(ctx.runId);
    const agents = AGENT_IDS.map((a) => {
      const entry = ledger.find((e) => e.agentId === a.id);
      const status = entry?.status || readAgentStatus(ctx.runId, a.id)?.status || 'pending';
      return { id: a.id, status, summary: entry?.summary, hasOutput: isAgentComplete(ctx.runId, a.id) };
    });
    // Not itself. This agent is `running` with no artifact for as long as it is
    // auditing, so counting its own entry here means it can never satisfy the
    // check it is performing — run 37402835314 failed on exactly that, seconds
    // after every other agent had passed. Its own completion is recorded when it
    // publishes, and `markComplete.ts` below re-checks the whole chain anyway.
    const notDone = agents.filter((a) => a.id !== 'integration-supervisor' && (a.status !== 'completed' || !a.hasOutput));
    const state = await ctx.mutate((s) => s);
    const missing = missingStages(state);
    const url = state.finalDownloadUrl || state.release.assetUrl || '';
    const verifiedUrl = !!url && isValidHttpsUrl(url) && !rejectFakeReleaseUrl(url) && !!state.evidence?.publicDownloadVerified;

    const problems: string[] = [];
    for (const agent of notDone) {
      problems.push(`${agent.id} did not complete (status ${agent.status}${agent.hasOutput ? '' : ', no output artifact'})`);
    }
    if (missing.length) problems.push(`missing evidence stages: ${missing.join(', ')}`);
    if (!verifiedUrl) problems.push('the public download is not verified');
    try {
      assertTruthful(state);
    } catch (e) {
      problems.push(`the state is not truthful: ${(e as Error).message}`);
    }
    if (problems.length) fail('integration-supervisor', problems[0], problems);

    if (!hasStage(state, 'FINAL_VERIFY')) problems.push('the download-ready gate was never reached');
    if (problems.length) fail('integration-supervisor', problems[0], problems);
    // Completion is the one step that must go through the proven gate, which
    // itself re-checks the whole evidence chain before it will move the state.
    ctx.runScriptOrThrow(['scripts/markComplete.ts']);
    const finished = await ctx.mutate((s) => s);
    const out: SupervisionArtifact = {
      agents,
      missingEvidence: missing,
      verifiedUrl,
      completed: finished.projectState === 'COMPLETED',
      progressPct: Number(finished.overallProgressPct ?? 0)
    };
    ctx.publish('supervision', out);
    ctx.activity(`verified ${agents.length} agents, closed the run`);
    ctx.log(`supervision: ${agents.length} agents verified, download ${verifiedUrl ? 'verified' : 'missing'}`);
    return out;
  },
  async validate(out, ctx) {
    const errors: string[] = [];
    if (!out) return invalid(['no supervision report']);
    if (out.agents.length !== 20) errors.push(`supervised ${out.agents.length} agents, not 20`);
    for (const agent of out.agents) {
      // Not itself, for the same reason as in execute: this snapshot was taken
      // while this agent was still running, so its own entry reads as unfinished
      // in the very report it is validating. Run 37404619109 got all twenty
      // agents verified, closed the run, and then failed here on itself.
      if (agent.id === 'integration-supervisor') continue;
      if (agent.status !== 'completed') errors.push(`${agent.id} is ${agent.status}`);
      if (!agent.hasOutput) errors.push(`${agent.id} published no output artifact`);
    }
    if (out.missingEvidence.length) errors.push(`evidence still missing: ${out.missingEvidence.join(', ')}`);
    if (!out.verifiedUrl) errors.push('the public download was not verified');
    if (!out.completed) errors.push('the supervisor did not record a completed run');
    if (out.progressPct !== 100) errors.push(`progress is ${out.progressPct}%, not 100`);
    const state = await ctx.mutate((s) => s);
    if (state.projectState !== 'COMPLETED') errors.push(`the run finished in ${state.projectState}`);
    if (Number(state.overallProgressPct) !== 100) errors.push(`the recorded progress is ${state.overallProgressPct}%, not 100`);
    return errors.length ? invalid(errors) : ok();
  }
};
