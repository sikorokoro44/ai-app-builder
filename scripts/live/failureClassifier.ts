export type FailureClass =
  | 'source_code'
  | 'dependency'
  | 'workflow_config'
  | 'infrastructure_transient'
  | 'artifact'
  | 'unknown';

export const FAILURE_CLASSES: FailureClass[] = [
  'source_code',
  'dependency',
  'workflow_config',
  'infrastructure_transient',
  'artifact',
  'unknown'
];

export interface Classification {
  klass: FailureClass;
  confidence: number;
  matched: string[];
}

const TRANSIENT_SIGNALS = [
  /service unavailable/i,
  /\b50[234]\b/,
  /connection reset/i,
  /connection refused/i,
  /econnreset/i,
  /etimedout/i,
  /temporary failure in name resolution/i,
  /could not resolve host/i,
  /network is unreachable/i,
  /rate limit exceeded/i,
  /secondary rate limit/i,
  /abuse detection/i,
  /timed? ?out/i,
  /timeout/i,
  /the operation was canceled/i,
  /runner.*lost communication/i,
  /no space left on device/i,
  /job was not started because.*recently cancelled/i,
  /received request to deprovision/i,
  /job runner has received a shutdown signal/i,
  /the hosted runner .* was lost/i,
  /losing the communication with the runner/i,
  /unexpected http status.*50[0-9]/i,
  /please try again/i
];

const DEPENDENCY_SIGNALS = [
  /could not (find|resolve|download) /i,
  /could not resolve all (files|artifacts|dependencies)/i,
  /failed to (resolve|download) (dependency|artifact|module)/i,
  /unresolved dependency/i,
  /no cached version of /i,
  /could not find .*\.(aar|jar|pom|klib)/i,
  /plugin \[id:.*\] was not found/i,
  /requires (android )?sdk platform/i,
  /unsupported class file major version/i,
  /dependency resolution/i,
  /no versions of .* available for offline mode/i,
  /execution failed for task .*dependencies/i,
  /failed to find target with hash string/i,
  /failed to install target sdk/i,
  /failed to find build tools/i,
  /failed to install the following sdk components/i,
  /failed to find aapt2/i,
  /could not determine the dependencies of task/i,
  /failed to transform/i,
  /build tools revision .* is corrupted/i,
  /metadata .* not found/i
];

const WORKFLOW_SIGNALS = [
  /workflow was cancelled/i,
  /unable to resolve action/i,
  /invalid workflow file/i,
  /\.ya?ml.*(syntax|error|line \d+)/i,
  /error in workflow file/i,
  /this request has been automatically failed because it uses a deprecated/i,
  /the workflow is not valid/i,
  /unable to process file .*action\.ya?ml/i,
  /permissions are not (sufficient|configured)/i,
  /secret .* not found/i,
  /environment .* not found/i,
  /if: condition/i,
  /startup_failure/i,
  /invalid job name/i,
  /this action requires node/i,
  /input required and not supplied/i,
  /required input not provided/i,
  /resource not accessible by integration/i,
  /no workflow permission/i,
  /job .* was not allowed to run/i,
  /the job was not started because the recent workflow/i,
  /refusing to run because the workflow file has syntax errors/i,
  /unable to resolve the action/i,
  // JVM heap exhaustion on the runner is a build-configuration problem, not a
  // transient blip: retrying the same job with the same Gradle jvmargs fails
  // identically, so it must not be classified as retryable.
  /java\.lang\.outofmemoryerror/i,
  /java heap space/i,
  /gc overhead limit exceeded/i,
  /could not reserve enough space for object heap/i,
  /unable to create native thread/i,
  /kotlin daemon.*(crashed|terminated unexpectedly)/i
];

const ARTIFACT_SIGNALS = [
  /no files were found with the provided path/i,
  /no artifacts were found/i,
  /artifact.*upload failed/i,
  /failed to upload artifact/i,
  /unable to find any artifact/i,
  /no artifact matching/i,
  /artifact.*not found/i,
  /no apk/i,
  /apk.*not found/i,
  /release asset/i,
  /failed to create release/i,
  /\bgh release\b.*failed/i,
  /tag.*already exists/i,
  /validation failed.*tag already exists/i,
  /failed to createartifact/i,
  /received non-retryable error.*artifact/i,
  /zip file is empty or not a valid zip/i,
  /failed to upload.*artifact/i
];

const SOURCE_SIGNALS = [
  /compilation failed/i,
  /compilation error/i,
  /compile\w*kotlin failed/i,
  /cannot find symbol/i,
  /unresolved reference:/i,
  /e: .*:.*(expecting|unresolved|conflicting)/i,
  /syntax error/i,
  /error: (cannot|unable|unexpected|type|value)/i,
  /type mismatch/i,
  /incompatible types/i,
  /manifest merger failed/i,
  /uses-sdk:minSdkVersion \d+ cannot be smaller than/i,
  /duplicate (class|resource)/i,
  /package .* is not a file/i,
  /android\.xml: error/i,
  /aapt: error/i,
  /ld: error/i,
  /error: execution failed/i,
  /no value passed for parameter/i,
  /too many arguments/i,
  /not enough information to infer type/i
];

function score(signals: RegExp[], logs: string[]): { hits: string[]; count: number } {
  const hits: string[] = [];
  let count = 0;
  for (const line of logs) {
    for (const re of signals) {
      if (re.test(line)) {
        count++;
        if (hits.length < 6) hits.push(line.trim().slice(0, 240));
        break;
      }
    }
  }
  return { hits, count };
}

/**
 * Classifies why a cloud build failed. Transient infrastructure problems are the
 * only class worth retrying blindly; everything else needs a code/workflow fix.
 */
export function classifyFailure(logs: string[]): Classification {
  const lines = (logs || []).map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''));

  const dep = score(DEPENDENCY_SIGNALS, lines);
  const transient = score(TRANSIENT_SIGNALS, lines);
  const workflow = score(WORKFLOW_SIGNALS, lines);
  const artifact = score(ARTIFACT_SIGNALS, lines);
  const source = score(SOURCE_SIGNALS, lines);

  if (transient.count > 0 && transient.count >= source.count && transient.count >= dep.count) {
    return { klass: 'infrastructure_transient', confidence: Math.min(1, 0.5 + transient.count * 0.1), matched: transient.hits };
  }
  if (source.count > 0) {
    return { klass: 'source_code', confidence: Math.min(1, 0.6 + source.count * 0.1), matched: source.hits };
  }
  if (dep.count > 0) {
    return { klass: 'dependency', confidence: Math.min(1, 0.6 + dep.count * 0.1), matched: dep.hits };
  }
  if (artifact.count > 0) {
    return { klass: 'artifact', confidence: Math.min(1, 0.6 + artifact.count * 0.1), matched: artifact.hits };
  }
  if (workflow.count > 0) {
    return { klass: 'workflow_config', confidence: Math.min(1, 0.6 + workflow.count * 0.1), matched: workflow.hits };
  }
  return { klass: 'unknown', confidence: 0, matched: [] };
}

export function isTransientFailure(k: FailureClass): boolean {
  return k === 'infrastructure_transient';
}

/** Repair guidance per class: what an autonomous repair pass should do. */
export const REPAIR_PLAYBOOK: Record<FailureClass, string[]> = {
  source_code: [
    'Read the failing source file and the exact compiler diagnostic.',
    'Apply a minimal, targeted fix to the offending source or resources.',
    'Re-run validation before rebuilding.'
  ],
  dependency: [
    'Inspect coordinates/versions and repository declarations.',
    'Align the version with what the declared repositories actually serve.',
    'Regenerate the dependency block and re-validate.'
  ],
  workflow_config: [
    'Inspect the workflow YAML and the failing step.',
    'Correct permissions, secrets, action versions, or syntax.',
    'Re-validate the workflow before dispatching a new run.'
  ],
  infrastructure_transient: [
    'No source change needed.',
    'Retry the run with bounded exponential backoff.'
  ],
  artifact: [
    'Verify the build output path and artifact upload/download steps.',
    'Confirm the produced file is the real APK, not a placeholder.',
    'Re-run only the packaging/artifact stage.'
  ],
  unknown: [
    'Capture full failing-step logs before changing anything.',
    'Escalate rather than guess at a fix.'
  ]
};
