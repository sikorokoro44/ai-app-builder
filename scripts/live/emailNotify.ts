/**
 * The notification email, and the gate that decides what may be declared.
 *
 * Three rules govern every email this module produces:
 *
 *   1. COMPLETE may only be declared when the same gates that produced
 *      `COMPLETED` in `shared/state.ts` pass here too: the full evidence chain,
 *      the finished cloud build, the verified APK and icon, the created release,
 *      and a public HTTPS download whose bytes were fetched and matched. The
 *      gate is the completion gate from `markComplete.ts`, not a second,
 *      weaker copy of it.
 *   2. A failed run is reported as FAILED, and an unfinished or unverifiable
 *      run is reported as WAITING. Neither can be upgraded by wording.
 *   3. Each distinct notification is sent at most once. The dedupe key
 *      (fingerprint) is recorded in the live state, which is committed to the
 *      repository, so a resumed run cannot re-send what an earlier attempt
 *      already delivered.
 *
 * The SMTP dialogue is implemented here against Node's own `net`/`tls` so the
 * builder gains no runtime dependency and no paid service. Credentials arrive
 * from the environment and are never printed, logged, or written to disk: only
 * a masked recipient (`u***@domain`) reaches the state file or stdout.
 */

import { createConnection, type Socket } from 'net';
import { connect as tlsConnect } from 'tls';
import { createHash } from 'crypto';
import type { LiveState, EmailSentRecord } from '../../shared/state.ts';
import { assertStateTruthfulAndComplete } from './lifecycleGate.ts';
import { assertLifecycleEvidence, missingStages } from './evidenceChain.ts';
import { enrichWithProgress } from '../../shared/stateWithProgressImpl2.ts';

export type NotificationKind = 'COMPLETE' | 'FAILED' | 'WAITING';

export type { EmailSentRecord };

export interface NotificationDecision {
  kind: NotificationKind;
  subject: string;
  text: string;
  /** Stable identity of this notification, for send-once deduplication. */
  fingerprint: string;
  /**
   * Why the run is not COMPLETE, empty when it is. Present for WAITING states
   * whose `projectState` claims COMPLETED, so a state that lost its evidence
   * says exactly what is missing instead of silently downgrading.
   */
  gateErrors: string[];
  /** What the run has proven so far, in chain order. */
  evidenceThrough: string;
  missing: string[];
}

/**
 * The completion gate, as errors instead of an exception.
 *
 * Deliberately the same two assertions `markComplete.ts` runs: a second,
 * independently written gate would eventually disagree with the state machine,
 * and the email is exactly where that disagreement would become a false claim.
 */
export function completionGateErrors(s: LiveState): string[] {
  const errors: string[] = [];
  const view = enrichWithProgress(s as any) as any;
  try {
    assertStateTruthfulAndComplete({
      ...view,
      featureGate: view.featureGate,
      apkSha256: view.apkSha256,
      requestId: view.request?.requestId
    });
  } catch (e: any) {
    errors.push(String(e.message || e));
  }
  try {
    assertLifecycleEvidence({
      projectState: view.projectState,
      overallProgressPct: view.overallProgressPct,
      currentStagePct: view.currentStagePct,
      // Both gates dereference these without a guard; a half-written state has
      // to arrive here as an ordinary "missing" problem, not a TypeError.
      cloudBuild: view.cloudBuild || { status: 'not recorded' },
      apkVerification: view.apkVerification,
      iconVerification: view.icon?.status,
      apkPath: view.apkPath,
      apkSha256: view.apkSha256,
      apkPackageId: view.apkPackageId,
      release: view.release || { status: 'not recorded' },
      finalDownloadUrl: view.finalDownloadUrl,
      evidence: view.evidence,
      publicDownloadVerified: view.evidence?.publicDownloadVerified,
      featureGate: view.featureGate,
      requestId: view.request?.requestId
    });
  } catch (e: any) {
    errors.push(String(e.message || e));
  }
  const missing = missingStages(s);
  if (missing.length > 0) errors.push(`missing evidence stages: ${missing.join(', ')}`);
  return errors;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function notificationFingerprint(s: LiveState, kind: NotificationKind): string {
  const stages = (s.evidence?.stages || []).map((st) => st.stage).join('>');
  const url = s.finalDownloadUrl || s.release?.assetUrl || '';
  return sha256([
    kind,
    s.projectState,
    stages,
    s.apkSha256 || '',
    s.cloudBuild?.runId || '',
    url
  ].join('|'));
}

function evidenceLine(s: LiveState): string {
  const stages = (s.evidence?.stages || []).map((st) => st.stage);
  return stages.length ? stages.join(' > ') : 'none';
}

function runUrl(s: LiveState): string {
  const runId = s.cloudBuild?.runId;
  const repo = s.release?.repo || process.env.GITHUB_REPOSITORY || '';
  if (!runId || !repo) return '';
  return `https://github.com/${repo}/actions/runs/${runId}`;
}

function ascii(text: string): string {
  // RFC 5322 header text without the SMTPUTF8 extension has to be ASCII. The
  // body is sent as 8-bit UTF-8, which every SMTP server the builder is meant
  // to use accepts; the subject line is transliterated rather than risking a
  // rejected header.
  return text.replace(/[^\x20-\x7E]/g, '?');
}

/**
 * What may be declared for this state right now.
 *
 * The kind is derived from evidence alone. A state whose `projectState` says
 * COMPLETED but whose gate fails becomes WAITING with the gate errors attached
 * - the truthful answer for "the label claims done, the proof is missing".
 */
export function decideNotification(s: LiveState): NotificationDecision {
  const gateErrors = completionGateErrors(s);
  const missing = missingStages(s);
  const idea = s.idea || '(no idea recorded)';
  const evidenceThrough = evidenceLine(s);
  const fingerprint = notificationFingerprint(s, gateErrors.length === 0 ? 'COMPLETE' : s.projectState === 'FAILED' ? 'FAILED' : 'WAITING');

  if (gateErrors.length === 0) {
    const url = s.finalDownloadUrl || s.release?.assetUrl || '';
    const run = runUrl(s);
    const subject = `APK ready and verified: ${idea}`;
    const lines = [
      'The AI App Builder finished and the delivery was verified end to end.',
      '',
      `App idea: ${idea}`,
      'State: COMPLETED (full evidence chain)',
      `APK sha256: ${s.apkSha256}`,
      `Package: ${s.apkPackageId}`,
      s.release.tag ? `Release: ${s.release.tag}` : '',
      `Public download: ${url}`,
      'The public URL was fetched over HTTPS and returned these exact bytes.',
      run ? `Cloud build run: ${run}` : '',
      '',
      `Evidence: ${evidenceThrough}`
    ].filter((l) => l !== '');
    return {
      kind: 'COMPLETE',
      subject,
      text: lines.join('\n'),
      fingerprint,
      gateErrors,
      evidenceThrough,
      missing
    };
  }

  if (s.projectState === 'FAILED') {
    const reasons = [
      s.cloudBuild?.failedReason,
      s.release?.failedReason,
      s.latestActivity
    ].filter(Boolean).join('; ') || 'no reason recorded';
    const subject = `Build FAILED: ${idea}`;
    const text = [
      'The AI App Builder reported a FAILED run. This is a failure report, not a delivery.',
      '',
      `App idea: ${idea}`,
      'State: FAILED',
      `Reason: ${reasons}`,
      `Evidence reached: ${evidenceThrough}`,
      `Missing evidence: ${missing.length ? missing.join(', ') : 'none'}`,
      '',
      'No APK or download link is being claimed.'
    ].join('\n');
    return { kind: 'FAILED', subject, text, fingerprint, gateErrors, evidenceThrough, missing };
  }

  const claimingDone = s.projectState === 'COMPLETED';
  const subject = claimingDone
    ? `WAITING: completion claim for "${idea}" cannot be verified`
    : `WAITING: ${idea} (${s.projectState})`;
  const lines = [
    'The AI App Builder has NOT delivered an app. This is a WAITING report.',
    '',
    `App idea: ${idea}`,
    `State: ${s.projectState}`,
    `Evidence reached: ${evidenceThrough}`,
    `Missing evidence: ${missing.length ? missing.join(', ') : 'none'}`,
    `Activity: ${s.latestActivity}`,
    s.cloudBuild?.status ? `Cloud build: ${s.cloudBuild.status}` : ''
  ].filter((l) => l !== '');
  if (claimingDone) {
    lines.push('', 'The state claims COMPLETED but the verification gates refused it:');
    for (const err of gateErrors.slice(0, 6)) lines.push(` - ${err.split('\n')[0]}`);
  }
  return { kind: 'WAITING', subject, text: lines.join('\n'), fingerprint, gateErrors, evidenceThrough, missing };
}

/** Has this exact notification already been delivered and recorded? */
export function alreadySent(s: LiveState, fingerprint: string): EmailSentRecord | null {
  const sent = s.email?.sent || [];
  return sent.find((r) => r.fingerprint === fingerprint) || null;
}

/** Records a delivered notification. Newest first, capped so the state file stays small. */
export function recordSent(s: LiveState, rec: EmailSentRecord): void {
  const sent = (s.email?.sent || []).filter((r) => r.fingerprint !== rec.fingerprint);
  sent.unshift(rec);
  s.email = { ...(s.email || {}), sent: sent.slice(0, 20) };
}

/** `alice@example.org` -> `a***@example.org`. Nothing else about the address survives. */
export function maskAddress(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return '***';
  const user = address.slice(0, at);
  const domain = address.slice(at + 1);
  return `${user[0]}***@${domain}`;
}

export type SmtpSecurity = 'starttls' | 'implicit' | 'none';

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user?: string;
  pass?: string;
  from: string;
  to: string;
  timeoutMs: number;
}

export interface EmailConfigResult {
  ok: boolean;
  config?: SmtpConfig;
  /** Names of the missing environment variables. Never their values. */
  missing: string[];
}

/**
 * Reads the notification configuration from the environment.
 *
 * Nothing is invented: a missing address, host or sender is reported by name
 * so the caller can state exactly what configuration is owed. A password is
 * only required when a username is given, because the two only make sense
 * together.
 */
export function emailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmailConfigResult {
  const missing: string[] = [];
  const to = env.BUILDER_EMAIL_TO || '';
  const host = env.BUILDER_SMTP_HOST || '';
  const from = env.BUILDER_SMTP_FROM || '';
  const user = env.BUILDER_SMTP_USER || '';
  const pass = env.BUILDER_SMTP_PASS || '';
  if (!to) missing.push('BUILDER_EMAIL_TO');
  if (!host) missing.push('BUILDER_SMTP_HOST');
  if (!from) missing.push('BUILDER_SMTP_FROM');
  if (user && !pass) missing.push('BUILDER_SMTP_PASS');
  if (missing.length > 0) return { ok: false, missing };

  const port = Number(env.BUILDER_SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, missing: ['BUILDER_SMTP_PORT (not a valid TCP port)'] };
  }
  const securityRaw = (env.BUILDER_SMTP_SECURITY || 'starttls').toLowerCase();
  const security: SmtpSecurity =
    securityRaw === 'implicit' || securityRaw === 'none' ? securityRaw : 'starttls';
  const timeoutMs = Number(env.BUILDER_SMTP_TIMEOUT_MS || 30_000);
  return {
    ok: true,
    config: {
      host,
      port,
      security,
      user: user || undefined,
      pass: pass || undefined,
      from,
      to,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000
    },
    missing: []
  };
}

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  /** Protocol-level detail. Any credential material is redacted before it gets here. */
  error?: string;
}

/** Removes any occurrence of the configured password from text bound for a log. */
export function redactSecrets(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[redacted]');
    try {
      out = out.split(Buffer.from(secret).toString('base64')).join('[redacted]');
    } catch { /* encoding failed; the raw split above already ran */ }
  }
  return out;
}

function dotStuff(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/**
 * A minimal SMTP client.
 *
 * Speaks EHLO, optional STARTTLS, optional AUTH PLAIN, MAIL/RCPT/DATA/QUIT and
 * checks every response code. It refuses to claim success on anything but a
 * 250 after DATA: a server that accepted the dialogue but rejected the message
 * must not be able to turn a bounced notification into a recorded send.
 */
export async function sendEmail(cfg: SmtpConfig, msg: EmailMessage): Promise<SendResult> {
  const deadline = Date.now() + cfg.timeoutMs;
  let socket: Socket;
  try {
    socket = await openSocket(cfg);
  } catch (e) {
    return { ok: false, error: redactSecrets(`connect to ${cfg.host}:${cfg.port} failed: ${errMsg(e)}`, [cfg.pass]) };
  }

  let pending: { resolve: (line: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let buffer = '';
  // Lines that arrived before anyone asked for them. Two replies in one TCP
  // segment are normal; the second one must survive until the next read.
  const queued: string[] = [];
  let lastError: Error | null = null;

  // A server may send its 220 greeting in the same tick it accepts the
  // connection, before this function can attach a listener to the returned
  // socket. Bytes emitted with no `data` listener are dropped, which is how a
  // fast server's greeting turned every send into "SMTP timeout waiting for
  // greeting". The socket buffers from the moment it connects into `early`, and
  // the dialogue replays that buffer before reading from the wire.
  const early: Buffer[] = [];
  const onEarlyData = (chunk: Buffer) => early.push(chunk);
  socket.on('data', onEarlyData);

  const settle = (fn: (w: NonNullable<typeof pending>) => void) => {
    const p = pending;
    pending = null;
    if (p) {
      clearTimeout(p.timer);
      fn(p);
    }
  };
  const onChunk = (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (pending) settle((w) => w.resolve(line));
      else queued.push(line);
    }
  };
  const onSocketError = (err: Error) => {
    lastError = err;
    settle((w) => w.reject(err));
  };
  const attach = (s: Socket) => {
    s.on('data', onChunk);
    s.on('error', onSocketError);
  };
  const detach = (s: Socket) => {
    s.removeListener('data', onChunk);
    s.removeListener('error', onSocketError);
  };
  // Stop buffering into `early` and hand whatever arrived to the dialogue before
  // any further byte is read, so an early greeting is not lost.
  socket.removeListener('data', onEarlyData);
  attach(socket);
  for (const chunk of early) onChunk(chunk);

  const readLine = (what: string): Promise<string> => {
    if (lastError) return Promise.reject(lastError);
    const next = queued.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve, reject) => {
      if (pending) {
        reject(new Error(`internal: overlapping SMTP reads while waiting for ${what}`));
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new Error(`SMTP timeout waiting for ${what}`));
        return;
      }
      const timer = setTimeout(() => {
        pending = null;
        reject(new Error(`SMTP timeout waiting for ${what}`));
      }, remaining);
      if (typeof timer.unref === 'function') timer.unref();
      pending = { resolve, reject, timer };
    });
  };

  /**
   * One SMTP reply: continuation lines repeat the code with `-` in the fourth
   * position and end at the first line with a space there; only the final
   * code decides acceptance.
   */
  const readReply = async (expect: number[], what: string): Promise<string> => {
    let line = await readLine(what);
    while (line.length >= 4 && line[3] === '-') {
      line = await readLine(what);
    }
    const code = Number(line.slice(0, 3));
    if (!expect.includes(code)) {
      throw new Error(`SMTP ${what} answered "${line}", expected ${expect.join('/')}`);
    }
    return line;
  };

  try {
    await readReply([220], 'greeting');
    socket.write('EHLO builder.local\r\n');
    await readReply([250], 'EHLO');

    if (cfg.security === 'starttls') {
      socket.write('STARTTLS\r\n');
      await readReply([220], 'STARTTLS');
      // The raw socket must stop emitting before TLS takes it over, or its
      // encrypted records would be parsed here as SMTP lines.
      const plain = socket;
      detach(plain);
      const upgraded = await new Promise<Socket>((resolve, reject) => {
        const s = tlsConnect({ socket: plain, servername: cfg.host }, () => resolve(s));
        s.once('error', reject);
      });
      socket = upgraded;
      attach(socket);
      socket.write('EHLO builder.local\r\n');
      await readReply([250], 'EHLO after STARTTLS');
    }

    if (cfg.user) {
      const token = Buffer.from(`\0${cfg.user}\0${cfg.pass || ''}`).toString('base64');
      socket.write(`AUTH PLAIN ${token}\r\n`);
      await readReply([235], 'AUTH');
    }

    socket.write(`MAIL FROM:<${cfg.from}>\r\n`);
    await readReply([250], 'MAIL FROM');
    socket.write(`RCPT TO:<${msg.to}>\r\n`);
    await readReply([250, 251], 'RCPT TO');
    socket.write('DATA\r\n');
    await readReply([354], 'DATA');
    const body = [
      `From: ${msg.from}`,
      `To: ${msg.to}`,
      `Subject: ${ascii(msg.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      dotStuff(msg.text),
      '.'
    ].join('\r\n');
    socket.write(`${body}\r\n`);
    await readReply([250], 'message acceptance');
    socket.write('QUIT\r\n');
    try { socket.end(); } catch { /* already closing */ }
    return { ok: true };
  } catch (e) {
    try { socket.destroy(); } catch { /* already destroyed */ }
    return { ok: false, error: redactSecrets(errMsg(e), [cfg.pass, cfg.user]) };
  } finally {
    detach(socket);
    settle((w) => w.reject(new Error('SMTP dialogue ended')));
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function openSocket(cfg: SmtpConfig): Promise<Socket> {
  if (cfg.security === 'implicit') {
    return new Promise<Socket>((resolve, reject) => {
      const s = tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(s));
      s.once('error', reject);
    });
  }
  return new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.once('error', reject);
  });
}
