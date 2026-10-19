import './isolate.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState } from '../shared/state.ts';
import { ProjectStates } from '../shared/types.ts';
import { recordStage, LifecycleStages } from '../scripts/live/evidenceChain.ts';
import { writeState, readState, initStateStore } from '../scripts/live/stateStore.ts';
import {
  decideNotification, emailConfigFromEnv, maskAddress, recordSent, alreadySent,
  notificationFingerprint, redactSecrets, sendEmail
} from '../scripts/live/emailNotify.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A state that passes every completion gate, field by field. */
function completeState(): any {
  const s: any = createInitialState();
  s.idea = 'watering reminder for the plants';
  s.projectState = ProjectStates.COMPLETED;
  s.overallProgressPct = 100;
  s.apkPath = '.builder/artifacts/app-release.apk';
  s.apkSha256 = 'a'.repeat(64);
  s.apkPackageId = 'com.builder.waterplants';
  s.apkVerification = 'passed';
  s.icon = { status: 'passed' };
  s.cloudBuild = {
    state: 'succeeded',
    stage: 'RELEASE',
    status: 'passed',
    output: [],
    runId: '37687931599',
    finishedAt: new Date().toISOString()
  };
  s.release = {
    status: 'created',
    assetName: 'app-release.apk',
    assetUrl: `https://github.com/sikorokoro44/ai-app-builder/releases/download/build-7/app-release.apk`,
    assetSha256: s.apkSha256,
    repo: 'sikorokoro44/ai-app-builder',
    tag: 'build-7'
  };
  s.finalDownloadUrl = s.release.assetUrl;
  s.latestActivity = 'public download verified';
  for (const stage of LifecycleStages) recordStage(s, stage, `${stage} proved`);
  s.evidence = { ...s.evidence, publicDownloadVerified: true };
  return s;
}

interface FakeSmtp {
  port: number;
  messages: string[];
  authLines: string[];
  close(): Promise<void>;
}

function startFakeSmtp(opts: { authOk?: boolean } = {}): Promise<FakeSmtp> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    const authLines: string[] = [];
    const server = createServer((sock) => {
      let buf = '';
      let data = '';
      let inData = false;
      // A client that finishes and closes can reset the connection while this
      // handler is mid-write; without a listener that becomes an uncaught
      // exception and takes the whole test file down.
      sock.on('error', () => { /* the dialogue is over; nothing to recover */ });
      sock.write('220 fake ESMTP ready\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        for (;;) {
          const nl = buf.indexOf('\r\n');
          if (nl === -1) break;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              messages.push(data);
              data = '';
              sock.write('250 2.0.0 queued\r\n');
            } else {
              data += `${line}\n`;
            }
            continue;
          }
          const upper = line.split(' ')[0].toUpperCase();
          if (upper === 'EHLO') sock.write('250-fake greets you\r\n250 AUTH PLAIN\r\n');
          else if (upper === 'AUTH') {
            authLines.push(line);
            sock.write(opts.authOk === false ? '535 5.7.8 bad credentials\r\n' : '235 2.7.0 accepted\r\n');
          } else if (upper === 'MAIL') sock.write('250 2.1.0 sender ok\r\n');
          else if (upper === 'RCPT') sock.write('250 2.1.5 recipient ok\r\n');
          else if (upper === 'DATA') { inData = true; sock.write('354 send it\r\n'); }
          else if (upper === 'QUIT') { sock.write('221 2.0.0 bye\r\n'); sock.end(); }
          else sock.write('500 unknown\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        port,
        messages,
        authLines,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

function smtpEnv(port: number, security = 'none'): Record<string, string> {
  return {
    BUILDER_EMAIL_TO: 'owner@kernel.example',
    BUILDER_SMTP_HOST: '127.0.0.1',
    BUILDER_SMTP_PORT: String(port),
    BUILDER_SMTP_SECURITY: security,
    BUILDER_SMTP_FROM: 'builder@kernel.example',
    BUILDER_SMTP_USER: 'builder',
    BUILDER_SMTP_PASS: 'sup3r-secret-pass'
  };
}

/**
 * Runs the CLI as a child process, asynchronously. It must not block the test's
 * event loop: the fake SMTP server runs in this same process, and a synchronous
 * spawn would freeze it, so the child could connect but never receive its
 * greeting — a deadlock that looked exactly like a slow server.
 */
function runCli(env: Record<string, string>, args: string[] = []): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--experimental-strip-types', join('scripts', 'notifyEmail.ts'), ...args], {
      cwd: REPO,
      encoding: 'utf-8',
      env: { ...process.env, ...env }
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as any).code === 'number' ? (error as any).code : (error ? 1 : 0);
      resolve({ code, out: stdout || '', err: stderr || '' });
    });
  });
}

describe('what a notification may declare', () => {  test('a fresh state reports WAITING, never a delivery', () => {
    const d = decideNotification(createInitialState());
    assert.strictEqual(d.kind, 'WAITING');
    assert.match(d.subject, /^WAITING/);
    assert.match(d.text, /has NOT delivered/);
    assert.doesNotMatch(d.text, /APK ready/);
  });

  test('a FAILED state is reported as a failure, not as a delivery', () => {
    const s: any = createInitialState();
    s.projectState = ProjectStates.FAILED;
    s.idea = 'notes app';
    s.latestActivity = 'cloud build failed: unresolved reference';
    const d = decideNotification(s);
    assert.strictEqual(d.kind, 'FAILED');
    assert.match(d.text, /not a delivery/);
    assert.match(d.text, /unresolved reference/);
  });

  test('COMPLETE is only declared when every gate passes', () => {
    const d = decideNotification(completeState());
    assert.deepStrictEqual(d.gateErrors, []);
    assert.strictEqual(d.kind, 'COMPLETE');
    assert.match(d.text, /verified end to end/);
    assert.match(d.text, /github\.com\/sikorokoro44/);
  });

  test('a COMPLETED label whose evidence is incomplete is downgraded to WAITING', () => {
    const s = completeState();
    s.evidence.stages = s.evidence.stages.filter((st: any) => st.stage !== 'FINAL_VERIFY');
    const d = decideNotification(s);
    assert.strictEqual(d.kind, 'WAITING');
    assert.ok(d.gateErrors.length > 0, 'the gate must say why it refused the claim');
    assert.match(d.subject, /cannot be verified/);
    assert.match(d.text, /FINAL_VERIFY/);
  });

  test('a fabricated download URL can never produce COMPLETE', () => {
    const s = completeState();
    s.finalDownloadUrl = 'https://example.com/app.apk';
    s.release.assetUrl = 'https://example.com/app.apk';
    const d = decideNotification(s);
    assert.notStrictEqual(d.kind, 'COMPLETE');
    assert.match(d.gateErrors.join('\n'), /fabricated|Fake/i);
  });

  test('the COMPLETE text states the checksum, package and evidence chain', () => {
    const d = decideNotification(completeState());
    assert.match(d.text, /a{64}/);
    assert.match(d.text, /com\.builder\.waterplants/);
    assert.match(d.text, /IDEA > ANALYZE/);
  });
});

describe('the notification configuration is read by name, never invented', () => {
  test('missing variables are reported as names, not defaults', () => {
    const cfg = emailConfigFromEnv({});
    assert.strictEqual(cfg.ok, false);
    assert.deepStrictEqual(cfg.missing, ['BUILDER_EMAIL_TO', 'BUILDER_SMTP_HOST', 'BUILDER_SMTP_FROM']);
  });

  test('a username without a password names the password as the missing piece', () => {
    const cfg = emailConfigFromEnv({ BUILDER_EMAIL_TO: 'a@b.example', BUILDER_SMTP_HOST: 'smtp.example', BUILDER_SMTP_FROM: 'a@b.example', BUILDER_SMTP_USER: 'a' });
    assert.strictEqual(cfg.ok, false);
    assert.deepStrictEqual(cfg.missing, ['BUILDER_SMTP_PASS']);
  });

  test('a complete configuration is accepted with sane defaults', () => {
    const cfg = emailConfigFromEnv({ BUILDER_EMAIL_TO: 'a@b.example', BUILDER_SMTP_HOST: 'smtp.example', BUILDER_SMTP_FROM: 'a@b.example' });
    assert.strictEqual(cfg.ok, true);
    assert.strictEqual(cfg.config!.port, 587);
    assert.strictEqual(cfg.config!.security, 'starttls');
  });

  test('a nonsense port is refused rather than silently defaulted', () => {
    const cfg = emailConfigFromEnv({ BUILDER_EMAIL_TO: 'a@b.example', BUILDER_SMTP_HOST: 'smtp.example', BUILDER_SMTP_FROM: 'a@b.example', BUILDER_SMTP_PORT: 'imap' });
    assert.strictEqual(cfg.ok, false);
    assert.match(cfg.missing.join(','), /BUILDER_SMTP_PORT/);
  });
});

describe('send-once bookkeeping', () => {
  test('a recorded fingerprint is recognised as already sent', () => {
    const s = completeState();
    const fp = notificationFingerprint(s, 'COMPLETE');
    assert.strictEqual(alreadySent(s, fp), null);
    recordSent(s, { kind: 'COMPLETE', fingerprint: fp, at: new Date().toISOString(), toMasked: 'o***@kernel.example', subject: 'x' });
    assert.ok(alreadySent(s, fp));
  });

  test('the record list is capped so the state file cannot grow without bound', () => {
    const s = completeState();
    for (let i = 0; i < 40; i++) {
      recordSent(s, { kind: 'WAITING', fingerprint: `fp-${i}`, at: new Date().toISOString(), toMasked: 'o***@kernel.example', subject: 'x' });
    }
    assert.strictEqual(s.email.sent.length, 20);
    assert.strictEqual(s.email.sent[0].fingerprint, 'fp-39', 'newest first');
  });

  test('a different declaration has a different fingerprint', () => {
    const a = completeState();
    const b = completeState();
    b.idea = 'another idea';
    b.apkSha256 = 'b'.repeat(64);
    assert.notStrictEqual(notificationFingerprint(a, 'COMPLETE'), notificationFingerprint(b, 'COMPLETE'));
  });

  test('the same verified build has one fingerprint, so a resume cannot re-send it', () => {
    // A resumed run re-reads the same state: same idea, same APK bytes, same
    // cloud run, same public URL. Only the incidental timestamps differ. The
    // fingerprint must ignore those, or every resume would mail again.
    const first = completeState();
    const resumed = completeState();
    resumed.cloudBuild.finishedAt = new Date(Date.now() + 60_000).toISOString();
    resumed.release.verifiedAt = new Date(Date.now() + 60_000).toISOString();
    resumed.latestActivity = 'resumed and re-verified';
    assert.strictEqual(
      notificationFingerprint(first, 'COMPLETE'),
      notificationFingerprint(resumed, 'COMPLETE')
    );
  });

  test('a delivery and a failure for the same build are distinct notifications', () => {
    const s = completeState();
    assert.notStrictEqual(notificationFingerprint(s, 'COMPLETE'), notificationFingerprint(s, 'FAILED'));
    assert.notStrictEqual(notificationFingerprint(s, 'FAILED'), notificationFingerprint(s, 'WAITING'));
  });

  test('the recipient is stored masked', () => {
    assert.strictEqual(maskAddress('alice@example.org'), 'a***@example.org');
    assert.strictEqual(maskAddress('not-an-address'), '***');
  });
});

describe('redaction', () => {
  test('a password and its base64 form are removed from log text', () => {
    const text = `try raw sup3r-secret and b64 ${Buffer.from('sup3r-secret').toString('base64')}`;
    const out = redactSecrets(text, ['sup3r-secret']);
    assert.doesNotMatch(out, /sup3r-secret/);
    assert.doesNotMatch(out, new RegExp(Buffer.from('sup3r-secret').toString('base64')));
    assert.match(out, /\[redacted\]/);
  });
});

describe('the SMTP dialogue', () => {
  test('a message is delivered, authenticated, and the envelope is what was asked for', async () => {
    const server = await startFakeSmtp();
    try {
      const res = await sendEmail({
        host: '127.0.0.1', port: server.port, security: 'none',
        user: 'builder', pass: 'sup3r-secret-pass',
        from: 'builder@kernel.example', to: 'owner@kernel.example', timeoutMs: 5000
      }, { to: 'owner@kernel.example', from: 'builder@kernel.example', subject: 'APK ready: plants', text: 'line one\n.dotted line' });
      assert.strictEqual(res.ok, true, res.error);
      assert.strictEqual(server.messages.length, 1);
      const msg = server.messages[0];
      assert.match(msg, /Subject: APK ready: plants/);
      assert.match(msg, /line one/);
      assert.match(msg, /\.dotted line/, 'a line starting with a dot must be transparently stuffed');
      assert.match(msg, /^From: builder@kernel\.example/m);
      assert.match(msg, /^To: owner@kernel\.example/m);
      const expected = `AUTH PLAIN ${Buffer.from('\0builder\0sup3r-secret-pass').toString('base64')}`;
      assert.ok(server.authLines.includes(expected), `server saw: ${server.authLines.join(' | ')}`);
    } finally {
      await server.close();
    }
  });

  test('a refused message is a failure, and the error never carries the password', async () => {
    const server = await startFakeSmtp({ authOk: false });
    try {
      const res = await sendEmail({
        host: '127.0.0.1', port: server.port, security: 'none',
        user: 'builder', pass: 'sup3r-secret-pass',
        from: 'builder@kernel.example', to: 'owner@kernel.example', timeoutMs: 5000
      }, { to: 'owner@kernel.example', from: 'builder@kernel.example', subject: 'x', text: 'y' });
      assert.strictEqual(res.ok, false);
      assert.doesNotMatch(String(res.error), /sup3r-secret-pass/);
      assert.match(String(res.error), /AUTH/);
    } finally {
      await server.close();
    }
  });

  test('an unreachable server is a failure, not a silent success', async () => {
    const res = await sendEmail({
      host: '127.0.0.1', port: 1, security: 'none',
      from: 'a@b.example', to: 'a@b.example', timeoutMs: 3000
    }, { to: 'a@b.example', from: 'a@b.example', subject: 'x', text: 'y' });
    assert.strictEqual(res.ok, false);
  });
});

describe('the notifyEmail CLI', () => {
  test('reports missing configuration by name and exits 0', async () => {
    const clean = { ...process.env } as Record<string, string>;
    for (const key of Object.keys(clean)) {
      if (key.startsWith('BUILDER_SMTP') || key === 'BUILDER_EMAIL_TO') delete clean[key];
    }
    const res = await runCli(clean);
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /status=not_configured/);
    assert.match(res.out, /BUILDER_SMTP_HOST/);
    assert.match(res.out, /BUILDER_EMAIL_TO/);
  });

  test('dry-run prints the decision without sending and without the password', async () => {
    initStateStore();
    const s = readState();
    Object.assign(s, completeState(), { email: { sent: [] } });
    writeState(s, { allowUncheckedTransition: true, reason: 'test fixture' });

    const server = await startFakeSmtp();
    try {
      const res = await runCli(smtpEnv(server.port), ['--dry-run']);
      assert.strictEqual(res.code, 0, res.err);
      assert.match(res.out, /status=dry_run/);
      assert.match(res.out, /kind=COMPLETE/);
      assert.doesNotMatch(res.out, /sup3r-secret-pass/);
      assert.strictEqual(server.messages.length, 0, 'a dry run must not send');
    } finally {
      await server.close();
    }
  });

  test('a state that lost the public-download proof sends nothing, however complete it looks', async () => {
    initStateStore();
    const s = readState();
    const claimed = completeState();
    claimed.evidence = { ...claimed.evidence, publicDownloadVerified: false };
    Object.assign(s, claimed, { email: { sent: [] } });
    writeState(s, { allowUncheckedTransition: true, reason: 'test fixture' });

    const server = await startFakeSmtp();
    try {
      const res = await runCli(smtpEnv(server.port));
      assert.strictEqual(res.code, 0, res.err + res.out);
      assert.match(res.out, /status=sent/, 'the notifier still reports what it did');
      assert.match(res.out, /kind=WAITING/, 'no success mail may be sent without the download proof');
      assert.strictEqual(server.messages.length, 1);
      assert.doesNotMatch(server.messages[0], /APK ready and verified/);
      assert.match(server.messages[0], /has NOT delivered an app/);
      const recorded = readState();
      assert.strictEqual(recorded.email?.sent?.[0]?.kind, 'WAITING');
    } finally {
      await server.close();
    }
  });

  test('a failed run sends a failure notice that claims no APK', async () => {
    initStateStore();
    const s = readState();
    const failed: any = createInitialState();
    failed.idea = 'notes app';
    failed.projectState = ProjectStates.FAILED;
    failed.latestActivity = 'cloud build failed: unresolved reference CalculatorStore';
    Object.assign(s, failed, { email: { sent: [] } });
    writeState(s, { allowUncheckedTransition: true, reason: 'test fixture' });

    const server = await startFakeSmtp();
    try {
      const res = await runCli(smtpEnv(server.port));
      assert.strictEqual(res.code, 0, res.err + res.out);
      assert.match(res.out, /status=sent/);
      assert.match(res.out, /kind=FAILED/);
      assert.strictEqual(server.messages.length, 1);
      assert.match(server.messages[0], /Build FAILED/);
      assert.match(server.messages[0], /unresolved reference CalculatorStore/);
      assert.match(server.messages[0], /not a delivery/);
      assert.doesNotMatch(server.messages[0], /APK ready and verified/);
      const recorded = readState();
      assert.strictEqual(recorded.email?.sent?.[0]?.kind, 'FAILED');
    } finally {
      await server.close();
    }
  });

  test('a connectivity test authenticates and sends a labelled message without touching state', async () => {
    initStateStore();
    const s = readState();
    const claimed = completeState();
    Object.assign(s, claimed, { email: { sent: [] } });
    writeState(s, { allowUncheckedTransition: true, reason: 'test fixture' });
    const before = readFileSync(join(process.env.BUILDER_STATE_DIR!, 'state.json'), 'utf-8');

    const server = await startFakeSmtp();
    try {
      const res = await runCli(smtpEnv(server.port), ['--test-send']);
      assert.strictEqual(res.code, 0, res.err + res.out);
      assert.match(res.out, /status=sent mode=test_send/);
      assert.doesNotMatch(res.out, /sup3r-secret-pass/);
      assert.strictEqual(server.messages.length, 1);
      assert.match(server.messages[0], /Subject: \[TEST\]/, 'a test must be clearly identified as a test');
      assert.doesNotMatch(server.messages[0], /APK ready and verified/, 'a test must never claim an APK is ready');
      assert.match(server.messages[0], /not a delivery/);
      const after = readFileSync(join(process.env.BUILDER_STATE_DIR!, 'state.json'), 'utf-8');
      assert.strictEqual(after, before, 'a connectivity test must not read or write the live state');
    } finally {
      await server.close();
    }
  });

  test('a connectivity test with no configuration reports the names and sends nothing', async () => {
    const clean = { ...process.env } as Record<string, string>;
    for (const key of Object.keys(clean)) {
      if (key.startsWith('BUILDER_SMTP') || key === 'BUILDER_EMAIL_TO') delete clean[key];
    }
    const res = await runCli(clean, ['--test-send']);
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /status=not_configured/);
    assert.match(res.out, /BUILDER_SMTP_HOST/);
    assert.doesNotMatch(res.out, /status=sent/);
  });

  test('sends once and then reports the duplicate, never leaking the password', async () => {
    initStateStore();
    const s = readState();
    Object.assign(s, completeState(), { email: { sent: [] } });
    writeState(s, { allowUncheckedTransition: true, reason: 'test fixture' });

    const server = await startFakeSmtp();
    try {
      const first = await runCli(smtpEnv(server.port));
      assert.strictEqual(first.code, 0, first.err + first.out);
      assert.match(first.out, /status=sent/);
      assert.match(first.out, /kind=COMPLETE/);
      assert.doesNotMatch(first.out + first.err, /sup3r-secret-pass/);
      assert.strictEqual(server.messages.length, 1);

      const second = await runCli(smtpEnv(server.port));
      assert.strictEqual(second.code, 0, second.err + second.out);
      assert.match(second.out, /status=duplicate/);
      assert.strictEqual(server.messages.length, 1, 'the second invocation must not re-send');

      const recorded = readState();
      assert.strictEqual(recorded.email?.sent?.[0]?.kind, 'COMPLETE');
      assert.match(recorded.email!.sent![0].toMasked, /^o\*\*\*@/);
      const onDisk = readFileSync(join(process.env.BUILDER_STATE_DIR!, 'state.json'), 'utf-8');
      assert.doesNotMatch(onDisk, /sup3r-secret-pass/);
      assert.doesNotMatch(onDisk, /owner@kernel\.example/, 'the raw recipient must not be persisted');
    } finally {
      await server.close();
    }
  });
});
