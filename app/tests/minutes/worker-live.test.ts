import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { MEMBER, PASSWORD, register, setup, testConfig } from '../discord-auth/helpers.js';
import { seedState } from '../helpers.js';
import { testMailboxConfig } from '../mailbox/helpers.js';

// The real minutes worker (deploy/minutes-worker/minutes_worker.py) against the app listening on loopback, with
// the speech model and the Claude CLI replaced by stand-ins. Runs only with MINUTES_LIVE=1 and a Python 3
// (PYTHON, default "python3").

const live = process.env.MINUTES_LIVE === '1';
const PYTHON = process.env.PYTHON ?? 'python3';
const WORKER_DIR = path.resolve('deploy/minutes-worker');
const PORT = 17_911;
let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
const key = randomBytes(32);

beforeEach(async () => {
  if (!live) return;
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-minutes-live-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [MEMBER]: '合成 太郎' } }));
  ctx = setup({ config: testConfig() });
  // The worker signs with the wall clock.
  ctx.clock.now = Date.now();
  const base = testMailboxConfig(path.join(dir, 'mail'), {}, randomBytes(32));
  const config = { ...base, minutes: { workerKey: key, audioRetentionDays: 14, dataDir: base.dataDir } };
  mail = new MailboxStore(config.dataDir);
  const seed = await seedState();
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: PORT,
    staticDir: dir,
    clock: () => new Date().toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases) },
  });
  await app.listen({ host: '127.0.0.1', port: PORT });
});
afterEach(async () => {
  if (!live) return;
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

const host = `127.0.0.1:${PORT}`;
async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { body?: unknown; bytes?: Buffer; cookie?: string } = {}) {
  const res = await app.inject({
    method,
    url,
    headers: {
      host,
      ...(method !== 'GET' ? { origin: `http://${host}`, 'x-smm-csrf': '1' } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.bytes ? { 'content-type': 'application/octet-stream' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : options.bytes ? { payload: options.bytes } : {}),
  });
  return { status: res.statusCode, headers: res.headers, json: res.body ? (JSON.parse(res.body) as Record<string, any>) : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe.skipIf(!live)('the minutes worker, live', () => {
  it('transcribes and drafts a meeting through the signed routes', async () => {
    await register(ctx, MEMBER, '21000002', []);
    const login = await call('POST', '/api/auth/login', { body: { loginId: '21000002', password: PASSWORD } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const audio = randomBytes(5000);
    const opened = await call('POST', '/api/minutes/uploads', { cookie, body: { filename: 'r.webm', type: 'audio/webm', bytes: audio.length } });
    await call('PUT', `/api/minutes/uploads/${opened.json!.uploadId}?offset=0`, { cookie, bytes: audio });
    const created = await call('POST', '/api/minutes', { cookie, body: { uploadId: opened.json!.uploadId, title: '役員会', heldOn: '2026-11-02', visibility: 'members', viewers: [] } });
    expect(created.status).toBe(201);
    const id = created.json!.id as string;

    // Stand-ins: a faster_whisper module and a "claude" command that answer fixed text.
    const fake = path.join(dir, 'fake');
    rmSync(fake, { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(fake);
    writeFileSync(
      path.join(fake, 'faster_whisper.py'),
      [
        'import os',
        'class _S:',
        '    def __init__(s, a, b, t): s.start, s.end, s.text = a, b, t',
        'class _I:',
        '    duration = 310.0',
        'class WhisperModel:',
        '    def __init__(self, *a, **k): pass',
        '    def transcribe(self, path, **k):',
        '        assert os.path.getsize(path) == 5000, "audio size"',
        '        assert "医薬祭" in k["initial_prompt"]',
        "        return iter([_S(0, 4, 'それでは役員会を始めます。'), _S(300, 306, '協賛の依頼文は総務部が十一月二十日までに作る、ということで決定とします。')]), _I()",
      ].join('\n'),
    );
    const answer = JSON.stringify({ summary: '協賛の依頼を決めた。', decisions: [{ text: '依頼文は総務部が 11/20 まで', evidence: [{ at: 300, quote: '総務部が十一月二十日までに作る' }] }], todos: [], topics: [], carryOver: [], unclear: [] });
    writeFileSync(path.join(fake, 'claude_stub.py'), `import sys, json\nprompt = sys.stdin.read()\nassert '協賛の依頼文' in prompt\nprint(json.dumps({"type": "result", "subtype": "success", "result": ${JSON.stringify(answer)}}))\n`);
    const isWin = process.platform === 'win32';
    const stub = path.join(fake, isWin ? 'claude.cmd' : 'claude');
    writeFileSync(stub, isWin ? `@"${PYTHON}" "${path.join(fake, 'claude_stub.py')}"\r\n` : `#!/bin/sh\nexec "${PYTHON}" "${path.join(fake, 'claude_stub.py')}"\n`, { mode: 0o755 });
    const keyFile = path.join(dir, 'worker.key');
    writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });

    const env = { ...process.env, PYTHONPATH: `${fake}${path.delimiter}${WORKER_DIR}`, MINUTES_APP_URL: `http://${host}`, MINUTES_KEY_FILE: keyFile, CLAUDE_COMMAND: stub, WHISPER_DEVICE: 'cpu' };
    for (const stage of ['transcribe', 'summarize']) {
      // Not spawnSync: the app answering the worker runs in this process.
      const run = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(PYTHON, [path.join(WORKER_DIR, 'minutes_worker.py'), '--once'], { env: { ...env, MINUTES_STAGES: stage, PYTHONIOENCODING: 'utf-8' } });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        const timer = setTimeout(() => child.kill(), 60_000);
        child.on('close', (status) => {
          clearTimeout(timer);
          resolve({ status, stderr });
        });
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).not.toContain('Traceback');
    }

    const detail = (await call('GET', `/api/minutes/${id}`, { cookie })).json!;
    expect(detail.stage).toBe('draft');
    expect(detail.transcript).toMatchObject({ durationSec: 310, model: 'large-v3' });
    expect(detail.draft.decisions[0].evidence[0]).toMatchObject({ at: 300, verified: true });
    expect(detail.body).toContain('依頼文は総務部が 11/20 まで');
  }, 120_000);
});
