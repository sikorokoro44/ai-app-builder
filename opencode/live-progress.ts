#!/usr/bin/env node
import { readState } from '../scripts/live/stateStore.ts';
import { buildLiveProgress, statusGlyph, statusWord } from '../shared/liveProgress.ts';
import type { LiveProgressView } from '../shared/liveProgress.ts';

/**
 * The user-facing live build view.
 *
 * It renders whatever `.builder/live/state.json` currently proves, then keeps
 * re-reading it so the screen advances on its own while the builder runs. There
 * is no local progress model here: every stage, percentage and failure on this
 * screen is read from authoritative state, so a restart resumes the view exactly
 * where the evidence says the run actually is.
 *
 * Flags:
 *   --once        render a single frame and exit (no polling loop)
 *   --interval N  poll interval in ms (default 1000)
 *   --quiet       drop the stage evidence lines, keep the stage list
 *   --json        print the projection as JSON instead of a screen
 */

function bar(pct: number, width = 28): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']';
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Some evidence strings carry a full presigned URL; the screen stays readable. */
function clip(text: string, width = 110): string {
  return text.length > width ? text.slice(0, width - 1) + '…' : text;
}

function formatBytes(size?: number): string | undefined {
  if (size === undefined) return undefined;
  return `${size} bytes`;
}

function renderLines(view: LiveProgressView, quiet: boolean): string[] {
  const lines: string[] = [];
  const stageWidth = Math.max(...view.stages.map((s) => s.stage.length));

  lines.push(`Build progress  ${bar(view.overallPct)} ${view.overallPct}%`);
  lines.push(`Status: ${view.status}   project state: ${view.projectState}`);
  if (view.currentStage) {
    const stagePct = view.currentStagePct === null ? '' : ` (${view.currentStagePct}%)`;
    lines.push(`Current stage: ${view.currentStage}${stagePct}`);
  } else {
    lines.push('Current stage: none, every link is proven');
  }
  lines.push(`Latest activity: ${view.latestActivity}`);
  lines.push('');

  for (const stage of view.stages) {
    const glyph = statusGlyph(stage.status);
    const word = pad(statusWord(stage.status), 9);
    let line = `  ${glyph} ${pad(stage.stage, stageWidth)}  ${word}`;
    if (!quiet && stage.evidence) line += `  ${clip(stage.evidence)}`;
    lines.push(line);
  }

  if (view.failure) {
    lines.push('');
    lines.push(`FAILED at ${view.failure.stage}: ${view.failure.reason}`);
    lines.push(`Recovery: ${view.failure.recoveryAction}`);
  }

  if (view.completed && view.verification) {
    const v = view.verification;
    lines.push('');
    lines.push('COMPLETED');
    lines.push(`  package: ${v.packageId || 'unknown'}`);
    lines.push(`  apk sha256: ${v.apkSha256 || 'unknown'}`);
    lines.push(`  cloud run: ${v.cloudRunId || 'unknown'} @ ${v.headSha || 'unknown head'}`);
    if (v.artifactSha256) {
      lines.push(`  artifact sha256: ${v.artifactSha256} (${formatBytes(v.artifactSize)})`);
    }
    lines.push(`  icon: ${v.iconStatus}`);
    if (v.iconManifestIcon) lines.push(`  manifest icon: ${v.iconManifestIcon}`);
    if (v.iconMatchedDensities) lines.push(`  densities: ${v.iconMatchedDensities.join(', ')}`);
    if (v.iconSimilarity !== undefined) {
      lines.push(`  icon similarity: ${v.iconSimilarity}`);
    }
    if (v.iconByteIdentical) lines.push('  icon pixels: byte identical to the generated source');
  }

  if (view.downloadReady && view.downloadUrl) {
    lines.push('');
    lines.push(`Download: ${view.downloadUrl}`);
  }

  return lines;
}

function frame(view: LiveProgressView, quiet: boolean): string {
  return renderLines(view, quiet).join('\n');
}

function parseFlags(argv: string[]): { once: boolean; interval: number; quiet: boolean; json: boolean } {
  let once = false;
  let quiet = false;
  let json = false;
  let interval = 1000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') once = true;
    else if (arg === '--quiet') quiet = true;
    else if (arg === '--json') json = true;
    else if (arg === '--interval') {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) interval = value;
    }
  }
  return { once, interval, quiet, json };
}

function main(): void {
  const { once, interval, quiet, json } = parseFlags(process.argv.slice(2));
  const out = process.stdout;

  const draw = (clear: boolean) => {
    // Each poll re-reads authoritative state; nothing is carried across frames.
    const view = buildLiveProgress(readState());
    if (json) {
      out.write(JSON.stringify(view, null, 2) + '\n');
    } else {
      if (clear && !once) out.write('\x1b[2J\x1b[H');
      out.write(frame(view, quiet) + '\n');
    }
    return view;
  };

  const first = draw(false);

  if (once || json) {
    process.exitCode = first.failure ? 1 : 0;
    return;
  }

  // Terminal states stop the loop; anything else keeps the view updating itself.
  const terminal = (v: LiveProgressView) => v.completed || !!v.failure || v.status === 'IDLE';
  if (terminal(first)) {
    process.exitCode = first.failure ? 1 : 0;
    return;
  }

  const timer = setInterval(() => {
    let view: LiveProgressView;
    try {
      view = draw(true);
    } catch (e) {
      out.write(`\nprogress read failed: ${(e as Error).message}\n`);
      process.exitCode = 1;
      clearInterval(timer);
      return;
    }
    if (terminal(view)) {
      clearInterval(timer);
      process.exitCode = view.failure ? 1 : 0;
    }
  }, interval);
}

main();