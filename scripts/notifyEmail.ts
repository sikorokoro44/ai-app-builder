/**
 * Sends the notification email for the current live state, once.
 *
 * The work is split into three phases around the state lock:
 *
 *   1. Locked and synchronous: read the state, run the gate, decide what may
 *      be declared, check the send-once record.
 *   2. Unlocked and asynchronous: the SMTP dialogue. Holding the cross-process
 *      state lock across a network round trip would stall every other writer
 *      for up to the lock timeout, and nothing else needs this state while the
 *      socket is open.
 *   3. Locked and synchronous again: re-read the state, re-check the record -
 *      a second notifier may have delivered the same email while this one was
 *      on the wire - then record the send.
 *
 * Statuses printed as `key=value` lines, one per outcome:
 *   sent | duplicate | not_configured | skipped | dry_run | failed
 *
 * Exit code is 0 for every outcome except an attempted send that failed (1),
 * so a missing configuration never turns a green build red. Configuration
 * problems are reported by variable name only; neither credentials nor the
 * recipient address are ever printed.
 */

import {
  withStateLock, readState, writeState
} from './live/stateStore.ts';
import {
  emailConfigFromEnv, maskAddress, decideNotification, alreadySent, recordSent,
  sendEmail, type NotificationDecision, type SmtpConfig, type EmailMessage
} from './live/emailNotify.ts';
import type { LiveState } from '../shared/state.ts';

interface Args {
  dryRun: boolean;
  force: boolean;
  kinds: string[] | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, force: false, kinds: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--kinds' && i + 1 < argv.length) {
      out.kinds = argv[++i].split(',').map((k) => k.trim().toUpperCase()).filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      console.log('usage: notifyEmail [--dry-run] [--force] [--kinds COMPLETE,FAILED,WAITING]');
      process.exit(0);
    }
  }
  return out;
}

interface DecisionView {
  decision: NotificationDecision;
  config: SmtpConfig | null;
  missing: string[];
  duplicate: { kind: string; fingerprint: string; at: string } | null;
  blocked: { reason: string } | null;
}

function decide(args: Args): DecisionView {
  return withStateLock(() => {
    const state = readState();
    const decision = decideNotification(state);
    const cfg = emailConfigFromEnv();
    const rec = alreadySent(state, decision.fingerprint);
    const blocked = !args.force && rec ? { reason: 'duplicate' } : null;
    return {
      decision,
      config: cfg.ok ? cfg.config || null : null,
      missing: cfg.missing,
      duplicate: blocked && rec ? { kind: rec.kind, fingerprint: rec.fingerprint, at: rec.at } : null,
      blocked
    };
  });
}

/**
 * Phase 3: record the send if nobody else recorded it while we were on the
 * wire. Returns false when another notifier won, which means this process's
 * email was a race duplicate - reported honestly, not hidden.
 */
function record(args: Args, decision: NotificationDecision, config: SmtpConfig): 'recorded' | 'already' {
  return withStateLock(() => {
    const state: LiveState = readState();
    if (alreadySent(state, decision.fingerprint) && !args.force) return 'already';
    recordSent(state, {
      kind: decision.kind,
      fingerprint: decision.fingerprint,
      at: new Date().toISOString(),
      toMasked: maskAddress(config.to),
      subject: decision.subject
    });
    writeState(state);
    return 'recorded';
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const view = decide(args);

  if (args.kinds && args.kinds.length > 0 && !args.kinds.includes(view.decision.kind)) {
    console.log(`status=skipped reason=kind_filtered kind=${view.decision.kind} filter=${args.kinds.join('|')}`);
    process.exit(0);
  }

  if (!view.config) {
    console.log(`status=not_configured missing=${view.missing.join(',')}`);
    process.exit(0);
  }

  if (view.blocked) {
    console.log(`status=duplicate kind=${view.duplicate!.kind} fingerprint=${view.duplicate!.fingerprint} first_sent=${view.duplicate!.at}`);
    process.exit(0);
  }

  if (args.dryRun) {
    console.log(`status=dry_run kind=${view.decision.kind} to_masked=${maskAddress(view.config.to)}`);
    console.log(`subject=${view.decision.subject}`);
    console.log(`fingerprint=${view.decision.fingerprint}`);
    console.log(`gate_errors=${view.decision.gateErrors.length}`);
    console.log(`missing_stages=${view.decision.missing.length}`);
    process.exit(0);
  }

  const msg: EmailMessage = {
    to: view.config.to,
    from: view.config.from,
    subject: view.decision.subject,
    text: view.decision.text
  };
  const res = await sendEmail(view.config, msg);
  if (!res.ok) {
    console.log(`status=failed kind=${view.decision.kind} error=${res.error}`);
    process.exit(1);
  }

  const outcome = record(args, view.decision, view.config);
  if (outcome === 'already') {
    console.log(`status=duplicate kind=${view.decision.kind} fingerprint=${view.decision.fingerprint} note=delivered_while_in_flight`);
    process.exit(0);
  }
  console.log(`status=sent kind=${view.decision.kind} fingerprint=${view.decision.fingerprint} to_masked=${maskAddress(view.config.to)}`);
  process.exit(0);
}

main().catch((e) => {
  console.log(`status=failed error=${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
