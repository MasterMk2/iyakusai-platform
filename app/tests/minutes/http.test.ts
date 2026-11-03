import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { WORKER_CLIENT, WORKER_PATHS } from '../../src/server/minutes/routes.js';
import { AUDIO_DIR, MINUTES_FILE } from '../../src/server/minutes/store.js';
import { signedHeaders } from '../../src/server/tasks/signing.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, setup, testConfig } from '../discord-auth/helpers.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { testMailboxConfig } from '../mailbox/helpers.js';

// Meeting minutes inside the unified app (Discord login), over HTTP on loopback: the browser routes and the
// signed worker routes. Synthetic names and a few bytes standing in for a recording.

const ROLE_STAFF = '1000000000000002099';
const THIRD = '1000000000000001004';
let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
let workerKey: Buffer;
const ORIGIN = `http://${TEST_HOST}`;

async function build(options: { minutes?: boolean } = {}) {
  const base = testMailboxConfig(path.join(dir, 'mail'), {}, randomBytes(32));
  const config = options.minutes === false ? base : { ...base, minutes: { workerKey, audioRetentionDays: 14, dataDir: base.dataDir } };
  mail = new MailboxStore(config.dataDir);
  const seed = await seedState();
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases) },
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-minutes-http-'));
  workerKey = randomBytes(32);
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子', [THIRD]: '合成 次郎' } }));
  ctx = setup({ config: testConfig({ departmentRoleIds: { [ROLE_STAFF]: '臨時スタッフ' } }) });
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

type Res = { status: number; headers: Record<string, unknown>; json: any; body: string; raw: Buffer }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, options: { body?: unknown; bytes?: Buffer; cookie?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(method !== 'GET' ? { origin: ORIGIN, 'x-smm-csrf': '1' } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.bytes ? { 'content-type': 'application/octet-stream' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : options.bytes ? { payload: options.bytes } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  return { status: res.statusCode, headers: res.headers, json, body: res.body, raw: res.rawPayload };
}

/** The worker's signed POST (no browser Origin, no cookie). */
async function worker(pathName: string, payload: unknown, key = workerKey): Promise<Res> {
  const body = JSON.stringify(payload);
  const res = await app.inject({
    method: 'POST',
    url: pathName,
    headers: { host: TEST_HOST, 'content-type': 'application/json', ...signedHeaders(key, { client: WORKER_CLIENT, method: 'POST', path: pathName, body, now: ctx.clock.now }) },
    payload: body,
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // audio
  }
  return { status: res.statusCode, headers: res.headers, json, body: res.body, raw: res.rawPayload };
}

const cookieOf = (setCookie: unknown) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

async function signIn(uid: string, studentId: string, roles: string[] = []) {
  await register(ctx, uid, studentId, roles);
  const login = await call('POST', '/api/auth/login', { body: { loginId: studentId, password: PASSWORD } });
  expect(login.status).toBe(200);
  return cookieOf(login.headers['set-cookie']);
}

/** Uploads `audio` in pieces of `piece` bytes (the server's own size is 8 MB; smaller pieces test the joins). */
async function upload(cookie: string, audio: Buffer, fields: Record<string, unknown>, piece = 7) {
  const opened = await call('POST', '/api/minutes/uploads', { cookie, body: { filename: 'recording.webm', type: 'audio/webm', bytes: audio.length } });
  expect(opened.status).toBe(201);
  const uploadId = opened.json.uploadId as string;
  for (let offset = 0; offset < audio.length; offset += piece) {
    const res = await call('PUT', `/api/minutes/uploads/${uploadId}?offset=${offset}`, { cookie, bytes: audio.subarray(offset, offset + piece) });
    expect(res.status).toBe(200);
  }
  return call('POST', '/api/minutes', { cookie, body: { uploadId, ...fields } });
}

const audio = Buffer.from('synthetic-webm-bytes-for-the-minutes-test');
const segments = [
  { start: 0, end: 4, text: 'それでは定例の役員会を始めます。' },
  { start: 300, end: 306, text: '協賛の依頼文は総務部が十一月二十日までに作る、ということで決定とします。' },
];

describe('meeting minutes', () => {
  it('are not there when minutes.json is absent', async () => {
    await build({ minutes: false });
    const member = await signIn(MEMBER, '21000002');
    const off = await call('GET', '/api/minutes/meta', { cookie: member });
    expect(off.status).toBe(404);
    expect(String(off.headers['permissions-policy'])).toContain('microphone=()');
    expect((await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).status).toBe(404);
  });

  it('go from a recording to confirmed minutes: upload, transcription, draft, correction, confirmation', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const chosen = await signIn(OTHER, '21000003');
    const outsider = await signIn(THIRD, '21000004');

    const meta = await call('GET', '/api/minutes/meta', { cookie: recorder });
    expect(meta.status).toBe(200);
    // The app's pages may use the microphone (and a shared tab's sound) once the minutes are on.
    expect(String(meta.headers['permissions-policy'])).toContain('microphone=(self)');
    expect(String(meta.headers['permissions-policy'])).toContain('display-capture=(self)');
    expect(meta.json).toMatchObject({ enabled: true, audioRetentionDays: 14 });
    const otherId = meta.json.people.find((p: { name: string }) => p.name === '合成 花子').id as string;

    const created = await upload(recorder, audio, { title: '役員会\n## 偽の見出し', heldOn: '2026-11-02', visibility: 'selected', viewers: [otherId] });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(created.json.title).toBe('役員会 ## 偽の見出し');
    expect(created.json).toMatchObject({ stage: 'transcribe_wait', createdByName: '合成 太郎', viewers: [{ name: '合成 花子' }], can: { listen: true, delete: true } });
    const files = readdirSync(path.join(dir, 'mail', AUDIO_DIR));
    expect(files).toEqual([`${id}.webm`]);
    expect(existsSync(path.join(dir, 'mail', MINUTES_FILE))).toBe(true);

    // Only the recorder and the chosen see it; to anyone else it does not exist.
    expect((await call('GET', '/api/minutes', { cookie: chosen })).json.items.map((m: { id: string }) => m.id)).toEqual([id]);
    expect((await call('GET', '/api/minutes', { cookie: outsider })).json.items).toEqual([]);
    expect((await call('GET', `/api/minutes/${id}`, { cookie: outsider })).status).toBe(404);
    // The chosen reads it but does not play the audio (recorder, confirmer and access administrators do).
    expect((await call('GET', `/api/minutes/${id}`, { cookie: chosen })).json.can).toMatchObject({ listen: false, delete: false });
    expect((await call('GET', `/api/minutes/${id}/audio`, { cookie: chosen })).status).toBe(403);
    const played = await call('GET', `/api/minutes/${id}/audio`, { cookie: recorder, headers: { range: 'bytes=0-8' } });
    expect(played.status).toBe(206);
    expect(played.headers['content-range']).toBe(`bytes 0-8/${audio.length}`);
    expect(played.raw).toEqual(audio.subarray(0, 9));

    // The worker: unsigned or wrongly signed requests learn nothing.
    expect((await worker(WORKER_PATHS.claim, { stages: ['transcribe'] }, randomBytes(32))).status).toBe(401);
    expect((await call('POST', WORKER_PATHS.claim, { body: { stages: ['transcribe'] } })).status).toBe(401);

    const claim = await worker(WORKER_PATHS.claim, { stages: ['transcribe', 'summarize'] });
    expect(claim.status).toBe(200);
    const job = claim.json.job;
    expect(job).toMatchObject({ id, stage: 'transcribe', audio: { ext: 'webm', bytes: audio.length, sha256: createHash('sha256').update(audio).digest('hex') } });
    expect(job.glossary).toEqual(expect.arrayContaining(['医薬祭', '合成 太郎']));
    const fetched = await worker(WORKER_PATHS.audio, { id, leaseToken: job.leaseToken });
    expect(fetched.status).toBe(200);
    expect(fetched.raw).toEqual(audio);
    expect((await worker(WORKER_PATHS.audio, { id, leaseToken: 'x'.repeat(24) })).status).toBe(409);

    const done = await worker(WORKER_PATHS.result, { id, leaseToken: job.leaseToken, stage: 'transcribe', transcript: { segments, durationSec: 310, model: 'large-v3' } });
    expect(done.status).toBe(200);
    expect((await call('GET', `/api/minutes/${id}`, { cookie: recorder })).json.stage).toBe('summarize_wait');

    const claim2 = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    expect(claim2).toMatchObject({ id, stage: 'summarize', audio: null, transcript: { segments } });
    const drafted = await worker(WORKER_PATHS.result, {
      id,
      leaseToken: claim2.leaseToken,
      stage: 'summarize',
      draft: {
        summary: '協賛の依頼について決めた。',
        decisions: [{ text: '協賛の依頼文は総務部が 11/20 までに作る', evidence: [{ at: 301, quote: '総務部が十一月二十日までに作る' }] }],
        todos: [{ text: '協賛の依頼文を作る', assignee: '', due: '11/20', department: '総務部', evidence: [{ at: 0, quote: '体育館は使えない' }] }],
      },
    });
    expect(drafted.status).toBe(200);

    const draft = (await call('GET', `/api/minutes/${id}`, { cookie: chosen })).json;
    expect(draft).toMatchObject({ stage: 'draft', version: 2, can: { edit: true, confirm: true } });
    expect(draft.draft.decisions[0].evidence[0]).toMatchObject({ verified: true });
    expect(draft.draft.todos[0].evidence[0]).toMatchObject({ verified: false });
    expect(draft.body).toContain('## 決定事項');
    expect(draft.body).toContain('（00:05:01）');
    expect(draft.body).toContain('要確認');

    // The chosen corrects and confirms; a stale version is refused.
    expect((await call('PUT', `/api/minutes/${id}/body`, { cookie: chosen, body: { expectedVersion: 1, body: 'x' } })).status).toBe(409);
    const edited = await call('PUT', `/api/minutes/${id}/body`, { cookie: chosen, body: { expectedVersion: 2, body: `${draft.body}\n出席者: 合成 太郎、合成 花子\n` } });
    expect(edited.status).toBe(200);
    const confirmed = await call('POST', `/api/minutes/${id}/confirm`, { cookie: chosen, body: { expectedVersion: 3 } });
    expect(confirmed.status).toBe(200);
    // Confirming does not open the audio to the confirmer (only the recorder and access administrators play it).
    expect(confirmed.json).toMatchObject({ stage: 'confirmed', confirmedByName: '合成 花子', can: { edit: false, listen: false } });
    expect((await call('GET', `/api/minutes/${id}/audio`, { cookie: chosen })).status).toBe(403);
    expect(confirmed.json.audio.deletesAt).toBe(new Date(ctx.clock.now + 14 * 86_400_000).toISOString());
    expect((await call('PUT', `/api/minutes/${id}/body`, { cookie: chosen, body: { expectedVersion: 4, body: 'x' } })).status).toBe(409);

    const md = await call('GET', `/api/minutes/${id}/export.md`, { cookie: chosen });
    expect(md.status).toBe(200);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.body).toContain('確定: 合成 花子');
    expect(md.body).toContain('出席者: 合成 太郎、合成 花子');
    expect(String(md.headers['content-disposition'])).not.toMatch(/filename\*=[^;]*'[^']*'[^;]*'/);

    // Late answers of the worker change nothing.
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: claim2.leaseToken, stage: 'summarize', error: '遅れた' })).status).toBe(409);
  });

  it('deletes the audio 14 days after confirmation', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const id = (await upload(recorder, audio, { title: '部会', heldOn: '2026-11-02', visibility: 'members', viewers: [] })).json.id as string;
    const t = (await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job;
    await worker(WORKER_PATHS.result, { id, leaseToken: t.leaseToken, stage: 'transcribe', transcript: { segments, durationSec: 310, model: 'small' } });
    const s = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    await worker(WORKER_PATHS.result, { id, leaseToken: s.leaseToken, stage: 'summarize', draft: {} });
    expect((await call('POST', `/api/minutes/${id}/confirm`, { cookie: recorder, body: { expectedVersion: 2 } })).status).toBe(200);
    await app.close();
    mail.close();

    ctx.clock.now += 15 * 86_400_000;
    await build();
    const again = await signIn(MEMBER, '21000002');
    const detail = (await call('GET', `/api/minutes/${id}`, { cookie: again })).json;
    expect(detail.audio).toMatchObject({ present: false, deletedAt: new Date(ctx.clock.now).toISOString() });
    expect(detail.can.listen).toBe(false);
    expect(readdirSync(path.join(dir, 'mail', AUDIO_DIR))).toEqual([]);
    expect(detail.transcript.segments).toHaveLength(2);
  });

  it('take pieces only in order, refuse temporary staff, and let only the recorder delete', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const opened = await call('POST', '/api/minutes/uploads', { cookie: recorder, body: { filename: 'a.exe', type: 'application/x-msdownload', bytes: 10 } });
    expect(opened.status).toBe(422);
    const ok = (await call('POST', '/api/minutes/uploads', { cookie: recorder, body: { filename: 'a.m4a', type: '', bytes: 10 } })).json.uploadId as string;
    const wrong = await call('PUT', `/api/minutes/uploads/${ok}?offset=5`, { cookie: recorder, bytes: Buffer.alloc(5) });
    expect(wrong.status).toBe(409);
    expect(wrong.json.received).toBe(0);
    expect((await call('POST', '/api/minutes', { cookie: recorder, body: { uploadId: ok, title: 't', heldOn: '2026-11-02', visibility: 'members', viewers: [] } })).status).toBe(422);
    expect((await call('PUT', `/api/minutes/uploads/${ok}?offset=0`, { cookie: recorder, bytes: Buffer.alloc(11) })).status).toBe(422);

    const staff = await signIn(OTHER, '21000003', [ROLE_STAFF]);
    expect((await call('GET', '/api/minutes', { cookie: staff })).status).toBe(403);
    expect((await call('GET', '/api/minutes')).status).toBe(401);

    const member = await signIn(THIRD, '21000004');
    const id = (await upload(recorder, audio, { title: '部会', heldOn: '2026-11-02', visibility: 'members', viewers: [] })).json.id as string;
    expect((await call('DELETE', `/api/minutes/${id}?expectedVersion=1`, { cookie: member })).status).toBe(403);
    expect((await call('DELETE', `/api/minutes/${id}?expectedVersion=1`, { cookie: recorder })).status).toBe(204);
    expect((await call('GET', `/api/minutes/${id}`, { cookie: recorder })).status).toBe(404);
    expect(readdirSync(path.join(dir, 'mail', AUDIO_DIR)).filter((f) => f.startsWith(id))).toEqual([]);
  });

  it('refuse an unnamed worker before reading its body, and say when a result is too large', async () => {
    await build();
    const big = Buffer.alloc(17 * 1024 * 1024, 0x20);
    const anon = await app.inject({ method: 'POST', url: WORKER_PATHS.result, headers: { host: TEST_HOST, 'content-type': 'application/json' }, payload: big });
    expect(anon.statusCode).toBe(401);
    const named = await app.inject({
      method: 'POST',
      url: WORKER_PATHS.result,
      headers: { host: TEST_HOST, 'content-type': 'application/json', 'x-svc-client': WORKER_CLIENT, 'x-svc-timestamp': String(ctx.clock.now) },
      payload: big,
    });
    expect(named.statusCode).toBe(413);
  });

  it('check the sign-in before reading a piece, and cap the unconfirmed meetings of one person', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const opened = (await call('POST', '/api/minutes/uploads', { cookie: recorder, body: { filename: 'a.webm', type: 'audio/webm', bytes: 3 } })).json.uploadId as string;
    expect((await call('PUT', `/api/minutes/uploads/${opened}?offset=0`, { bytes: Buffer.alloc(3) })).status).toBe(401);
    for (let i = 0; i < 10; i++) expect((await upload(recorder, audio, { title: `会議${i}`, heldOn: '2026-11-02', visibility: 'members', viewers: [] })).status).toBe(201);
    const refused = await call('POST', '/api/minutes/uploads', { cookie: recorder, body: { filename: 'a.webm', type: 'audio/webm', bytes: 3 } });
    expect(refused.status).toBe(409);
    expect(refused.json.message).toContain('確定していない議事録が 10 件');
  });
});
