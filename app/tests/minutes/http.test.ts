import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { DecisionsStore } from '../../src/server/decisions/store.js';
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

async function build(options: { minutes?: boolean; decisions?: DecisionsStore } = {}) {
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
    ...(options.decisions ? { decisions: options.decisions } : {}),
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

  it('let the recorder and access administrators change the title, the date and the readers afterwards', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const chosen = await signIn(OTHER, '21000003');
    const outsider = await signIn(THIRD, '21000004');
    const people = (await call('GET', '/api/minutes/meta', { cookie: recorder })).json.people as { id: string; name: string }[];
    const idOf = (name: string) => people.find((p) => p.name === name)!.id;
    const id = (await upload(recorder, audio, { title: '役員会', heldOn: '2026-11-02', visibility: 'selected', viewers: [idOf('合成 花子')] })).json.id as string;
    expect((await call('GET', `/api/minutes/${id}`, { cookie: recorder })).json.can.manage).toBe(true);
    expect((await call('GET', `/api/minutes/${id}`, { cookie: chosen })).json.can.manage).toBe(false);

    // A reader who is not the recorder may not change it; someone who cannot read it learns nothing.
    const settings = (over: Record<string, unknown> = {}) => ({ title: '役員会', heldOn: '2026-11-02', visibility: 'selected', viewers: [idOf('合成 花子')], ...over });
    expect((await call('PUT', `/api/minutes/${id}/settings`, { cookie: chosen, body: settings({ viewers: [] }) })).status).toBe(403);
    expect((await call('PUT', `/api/minutes/${id}/settings`, { cookie: outsider, body: settings({ visibility: 'members' }) })).status).toBe(404);
    expect((await call('PUT', `/api/minutes/${id}/settings`, { cookie: recorder, body: settings({ viewers: ['1000000000000009999'] }) })).status).toBe(422);
    expect((await call('PUT', `/api/minutes/${id}/settings`, { cookie: recorder, body: settings({ title: ' ' }) })).status).toBe(400);

    // The outsider is added and the chosen taken off: the change holds at once, in the list and the meeting.
    const changed = await call('PUT', `/api/minutes/${id}/settings`, { cookie: recorder, body: settings({ title: '臨時\n役員会', heldOn: '2026-11-03', viewers: [idOf('合成 次郎'), idOf('合成 太郎')] }) });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ title: '臨時 役員会', heldOn: '2026-11-03', visibility: 'selected', viewers: [{ name: '合成 次郎' }], version: 1 });
    expect((await call('GET', '/api/minutes', { cookie: outsider })).json.items.map((m: { id: string }) => m.id)).toEqual([id]);
    expect((await call('GET', `/api/minutes/${id}`, { cookie: chosen })).status).toBe(404);
    expect((await call('GET', '/api/minutes', { cookie: chosen })).json.items).toEqual([]);

    // Every member, then back; it changes while the worker holds it too, and the worker sees the new title.
    expect((await call('PUT', `/api/minutes/${id}/settings`, { cookie: recorder, body: settings({ visibility: 'members', viewers: [] }) })).status).toBe(200);
    expect((await call('GET', `/api/minutes/${id}`, { cookie: chosen })).status).toBe(200);
    const job = (await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job;
    expect(job.title).toBe('役員会');
    expect((await call('PUT', `/api/minutes/${id}/settings`, { cookie: recorder, body: settings({ title: '定例', viewers: [] }) })).status).toBe(200);
    expect((await call('GET', `/api/minutes/${id}`, { cookie: chosen })).status).toBe(404);
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: job.leaseToken, stage: 'transcribe', transcript: { segments, durationSec: 310, model: 'large-v3' } })).status).toBe(200);
    const s = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    expect(s.title).toBe('定例');

    // An access administrator changes another's meeting.
    const chair = await signIn(CHAIR, '21000001');
    const byChair = await call('PUT', `/api/minutes/${id}/settings`, { cookie: chair, body: settings({ title: '定例', visibility: 'members', viewers: [] }) });
    expect(byChair.status).toBe(200);
    expect(byChair.json.can.manage).toBe(true);
    expect((await call('GET', `/api/minutes/${id}`, { cookie: chosen })).status).toBe(200);
  });

  it('show how far the running stage has got, only from the worker that holds it, and only while it runs', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const outsider = await signIn(THIRD, '21000004');
    const id = (await upload(recorder, audio, { title: '長い役員会', heldOn: '2026-11-05', visibility: 'selected', viewers: [] })).json.id as string;
    const detailOf = async (cookie = recorder) => (await call('GET', `/api/minutes/${id}`, { cookie })).json;
    expect((await detailOf()).progress).toBeNull();

    const job = (await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job;
    const report = (body: Record<string, unknown>, key?: Buffer) => worker(WORKER_PATHS.progress, { id, leaseToken: job.leaseToken, stage: 'transcribe', ...body }, key);
    // Unsigned, of another lease or stage, or out of shape: refused, and nothing shows.
    expect((await report({ done: 0, total: 11_600 }, randomBytes(32))).status).toBe(401);
    expect((await call('POST', WORKER_PATHS.progress, { body: { id, leaseToken: job.leaseToken, stage: 'transcribe', done: 0, total: null } })).status).toBe(401);
    expect((await worker(WORKER_PATHS.progress, { id, leaseToken: 'x'.repeat(24), stage: 'transcribe', done: 0, total: 11_600 })).status).toBe(409);
    expect((await report({ stage: 'summarize', done: 0, total: 2 })).status).toBe(409);
    expect((await report({ done: -1, total: 11_600 })).status).toBe(400);
    expect((await detailOf()).progress).toBeNull();

    expect((await report({ done: 0, total: 11_600 })).status).toBe(200);
    expect((await detailOf()).progress).toEqual({ stage: 'transcribe', done: 0, total: 11_600, percent: 0, remainingSec: null, ageSec: 0 });
    // Ten minutes later, 2,320 of 11,600 seconds done: 20 %, and the rest at that pace takes 40 minutes.
    ctx.clock.now += 600_000;
    expect((await report({ done: 2_320, total: 11_600 })).status).toBe(200);
    expect((await detailOf()).progress).toEqual({ stage: 'transcribe', done: 2_320, total: 11_600, percent: 20, remainingSec: 2_400, ageSec: 0 });
    expect((await call('GET', '/api/minutes', { cookie: recorder })).json.items[0].progressPercent).toBe(20);
    // Someone not chosen learns nothing, as before.
    expect((await call('GET', `/api/minutes/${id}`, { cookie: outsider })).status).toBe(404);
    // A minute without a report: the time left counts down, and the age shows (the screen warns after ten minutes).
    ctx.clock.now += 60_000;
    expect((await detailOf()).progress).toMatchObject({ remainingSec: 2_340, ageSec: 60 });
    // An estimated length the worker runs past still shows below 100 %; without a length there is no percent.
    expect((await report({ done: 12_000, total: 11_600 })).status).toBe(200);
    expect((await detailOf()).progress).toMatchObject({ percent: 99 });
    expect((await report({ done: 3_000, total: null })).status).toBe(200);
    expect((await detailOf()).progress).toMatchObject({ total: null, percent: null, remainingSec: null });

    // Once the stage is done the report is gone, and a late one is refused.
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: job.leaseToken, stage: 'transcribe', transcript: { segments, durationSec: 11_600, model: 'large-v3' } })).status).toBe(200);
    expect((await detailOf()).progress).toBeNull();
    expect((await report({ done: 11_600, total: 11_600 })).status).toBe(409);

    // The summary counts its parts; a lease that ran out and was claimed again starts without the old report.
    const s = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    expect((await worker(WORKER_PATHS.progress, { id, leaseToken: s.leaseToken, stage: 'summarize', done: 1, total: 3 })).status).toBe(200);
    expect((await detailOf()).progress).toMatchObject({ stage: 'summarize', done: 1, total: 3, percent: 33 });
    ctx.clock.now += 46 * 60_000;
    const again = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    expect(again.leaseToken).not.toBe(s.leaseToken);
    expect((await detailOf()).progress).toBeNull();
  });

  it('take a recording of up to 2 GB and say the limit beyond it', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    expect((await call('GET', '/api/minutes/meta', { cookie: recorder })).json.maxAudioBytes).toBe(2 * 1024 ** 3);
    // (A file of exactly 2 GB is also checked against the disk's free space, which depends on the machine.)
    const refused = await call('POST', '/api/minutes/uploads', { cookie: recorder, body: { filename: 'long.wav', type: 'audio/wav', bytes: 2 * 1024 ** 3 + 1 } });
    expect(refused.status).toBe(422);
    expect(refused.json.message).toContain('2 GB まで');
  });

  it('keep a recording sent in part through a restart, and go on with it only for the same file', async () => {
    await build();
    let recorder = await signIn(MEMBER, '21000002');
    const opened = await call('POST', '/api/minutes/uploads', { cookie: recorder, body: { filename: 'meeting\n.m4a', type: 'audio/mp4', bytes: audio.length } });
    const uploadId = opened.json.uploadId as string;
    expect((await call('PUT', `/api/minutes/uploads/${uploadId}?offset=0`, { cookie: recorder, bytes: audio.subarray(0, 10) })).status).toBe(200);
    const listed = await call('GET', '/api/minutes/uploads', { cookie: recorder });
    expect(listed.json.items).toEqual([
      { uploadId, filename: 'meeting .m4a', bytes: audio.length, received: 10, openedAt: new Date(ctx.clock.now).toISOString(), expiresAt: new Date(ctx.clock.now + 86_400_000).toISOString() },
    ]);
    // Someone else neither sees it nor goes on with it.
    const other = await signIn(OTHER, '21000003');
    expect((await call('GET', '/api/minutes/uploads', { cookie: other })).json.items).toEqual([]);
    const head = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    expect((await call('POST', `/api/minutes/uploads/${uploadId}/resume`, { cookie: other, body: { bytes: audio.length, headBytes: 10, headSha256: head(audio.subarray(0, 10)) } })).status).toBe(404);

    // The app restarts: the part is still there, and the sender goes on with it.
    await app.close();
    mail.close();
    ctx.clock.now += 3_600_000;
    await build();
    recorder = await signIn(MEMBER, '21000002');
    expect((await call('GET', '/api/minutes/uploads', { cookie: recorder })).json.items).toMatchObject([{ uploadId, received: 10 }]);
    const resume = (body: Record<string, unknown>) => call('POST', `/api/minutes/uploads/${uploadId}/resume`, { cookie: recorder, body });
    // Another file of the same size, or of another size, is refused; a head measured short is told how much is held.
    const otherFile = Buffer.from(audio.map((b) => b ^ 1));
    expect((await resume({ bytes: audio.length, headBytes: 10, headSha256: head(otherFile.subarray(0, 10)) })).json).toMatchObject({ error: 'conflict' });
    expect((await resume({ bytes: audio.length + 1, headBytes: 10, headSha256: head(audio.subarray(0, 10)) })).status).toBe(409);
    expect((await resume({ bytes: audio.length, headBytes: 4, headSha256: head(audio.subarray(0, 4)) })).json).toMatchObject({ error: 'offset', received: 10 });
    const ok = await resume({ bytes: audio.length, headBytes: 10, headSha256: head(audio.subarray(0, 10)) });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ uploadId, received: 10 });

    expect((await call('PUT', `/api/minutes/uploads/${uploadId}?offset=10`, { cookie: recorder, bytes: audio.subarray(10) })).status).toBe(200);
    const created = await call('POST', '/api/minutes', { cookie: recorder, body: { uploadId, title: '役員会', heldOn: '2026-11-07', visibility: 'members', viewers: [] } });
    expect(created.status).toBe(201);
    expect(readdirSync(path.join(dir, 'mail', AUDIO_DIR))).toEqual([`${uploadId}.m4a`]);
    const claim = (await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job;
    expect(claim.audio.sha256).toBe(createHash('sha256').update(audio).digest('hex'));
    expect((await call('GET', '/api/minutes/uploads', { cookie: recorder })).json.items).toEqual([]);
  });

  it('drop a part a day after its last piece, and leftovers without their note', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const open = async () => {
      const id = (await call('POST', '/api/minutes/uploads', { cookie: recorder, body: { filename: 'a.webm', type: 'audio/webm', bytes: audio.length } })).json.uploadId as string;
      expect((await call('PUT', `/api/minutes/uploads/${id}?offset=0`, { cookie: recorder, bytes: audio.subarray(0, 5) })).status).toBe(200);
      return id;
    };
    const old = await open();
    ctx.clock.now += 20 * 3_600_000;
    const fresh = await open();
    const audioDir = path.join(dir, 'mail', AUDIO_DIR);
    writeFileSync(path.join(audioDir, 'mt_00000000000000ff.uploading'), 'stray');
    writeFileSync(path.join(audioDir, `${fresh}.uploading.json.next`), '{"id":');

    await app.close();
    mail.close();
    ctx.clock.now += 5 * 3_600_000;
    await build();
    const again = await signIn(MEMBER, '21000002');
    expect((await call('GET', '/api/minutes/uploads', { cookie: again })).json.items.map((i: { uploadId: string }) => i.uploadId)).toEqual([fresh]);
    expect(readdirSync(audioDir).sort()).toEqual([`${fresh}.uploading`, `${fresh}.uploading.json`]);
    expect(old).not.toBe(fresh);
  });

  it('keep the transcription with a worker that reports, however long it takes, and take it back from one that stopped', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const id = (await upload(recorder, audio, { title: '長い会議', heldOn: '2026-11-07', visibility: 'members', viewers: [] })).json.id as string;
    const job = (await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job;
    const report = (token: string, done: number) => worker(WORKER_PATHS.progress, { id, leaseToken: token, stage: 'transcribe', done, total: 40_000 });
    // Twelve hours of a slow machine, reporting all the while: the lease of eight hours never runs out.
    for (let h = 1; h <= 12; h++) {
      ctx.clock.now += 3_600_000;
      expect((await report(job.leaseToken, h * 3_000)).status).toBe(200);
      expect((await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job).toBeNull();
    }
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: job.leaseToken, stage: 'transcribe', transcript: { segments, durationSec: 40_000, model: 'large-v3' } })).status).toBe(200);

    // Another meeting whose worker stops reporting: taken back two hours after its last report (past the first eight).
    // (The sign-in of twelve hours ago has run out: signed in again.)
    const login = await call('POST', '/api/auth/login', { body: { loginId: '21000002', password: PASSWORD } });
    const id2 = (await upload(cookieOf(login.headers['set-cookie']), audio, { title: '止まった会議', heldOn: '2026-11-07', visibility: 'members', viewers: [] })).json.id as string;
    const job2 = (await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job;
    ctx.clock.now += 7 * 3_600_000;
    expect((await worker(WORKER_PATHS.progress, { id: id2, leaseToken: job2.leaseToken, stage: 'transcribe', done: 10, total: null })).status).toBe(200);
    ctx.clock.now += 2 * 3_600_000 - 60_000;
    expect((await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job).toBeNull();
    ctx.clock.now += 120_000;
    const taken = (await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job;
    expect(taken).toMatchObject({ id: id2, stage: 'transcribe' });
    expect(taken.leaseToken).not.toBe(job2.leaseToken);
    // A report of the old lease neither shows nor pushes the new one out.
    expect((await worker(WORKER_PATHS.progress, { id: id2, leaseToken: job2.leaseToken, stage: 'transcribe', done: 20, total: null })).status).toBe(409);
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

// Sending a draft back to the AI, listening again, and corrections after confirmation (2026-11-06).
describe('sending back, listening again and correcting confirmed minutes', { timeout: 30_000 }, () => {
  const measured = [
    { ...segments[0]!, confidence: { logprob: -0.1, noSpeech: 0.01, compression: 1.5, weak: [] } },
    // A wrong word the fixes of the committee's words leave as it is (共産 they fix).
    { ...segments[1]!, text: '強酸の依頼文は総務部が十一月二十日までに作る、ということで決定とします。', confidence: { logprob: -0.13, noSpeech: 0.5, compression: 1.5, weak: [{ start: 300, end: 300.5, word: '強酸', p: 0.18 }] } },
  ];

  it('the committee words the speech model writes wrong are fixed as the transcript comes in', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const id = (await upload(recorder, audio, { title: '役員会', heldOn: '2026-11-07', visibility: 'members', viewers: [] })).json.id as string;
    const t = (await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job;
    const heard = [
      { start: 0, end: 4, text: '共産の依頼について、障害課から報告をお願いします。', confidence: { logprob: -0.1, noSpeech: 0.01, compression: 1.5, weak: [{ start: 0, end: 0.4, word: '共', p: 0.3 }, { start: 0.4, end: 0.8, word: '産', p: 0.4 }, { start: 2, end: 2.5, word: '障害課', p: 0.2 }] } },
      { start: 5, end: 9, text: '模擬店の出店団体には、システム障害のことも伝えます。' },
    ];
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: t.leaseToken, stage: 'transcribe', transcript: { segments: heard, durationSec: 10, model: 'large-v3-turbo' } })).status).toBe(200);
    const got = (await call('GET', `/api/minutes/${id}`, { cookie: recorder })).json.transcript.segments;
    expect(got[0].text).toBe('協賛の依頼について、渉外課から報告をお願いします。');
    // 共 and 産 are no longer in the text, so they are not marked; 障害課 is marked as 渉外課.
    expect(got[0].confidence.weak).toEqual([{ start: 2, end: 2.5, word: '渉外課', p: 0.2 }]);
    expect(got[1].text).toBe(heard[1]!.text);
    // The summary works from the fixed text, and is told the committee's words.
    const s = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    expect(s.transcript.segments[0].text).toBe('協賛の依頼について、渉外課から報告をお願いします。');
    expect(s.glossary).toEqual(expect.arrayContaining(['協賛', '白パス', '創己祭']));
  });

  /** A meeting through transcription (with the speech model's confidence) to its first AI draft. */
  async function drafted(recorder: string, fields: Record<string, unknown>, decisions = ['協賛の依頼文は総務部が作る']): Promise<string> {
    const id = (await upload(recorder, audio, fields)).json.id as string;
    const t = (await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job;
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: t.leaseToken, stage: 'transcribe', transcript: { segments: measured, durationSec: 310, model: 'large-v3' } })).status).toBe(200);
    const s = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    const draft = { summary: '協賛の依頼について。', decisions: decisions.map((text) => ({ text, evidence: [{ at: 301, quote: '総務部が十一月二十日までに作る' }] })) };
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: s.leaseToken, stage: 'summarize', draft })).status).toBe(200);
    return id;
  }

  it('correct a segment after listening, send the draft back, and rework it with what people corrected', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const chosen = await signIn(OTHER, '21000003');
    const outsider = await signIn(THIRD, '21000004');
    const otherId = (await call('GET', '/api/minutes/meta', { cookie: recorder })).json.people.find((p: { name: string }) => p.name === '合成 花子').id as string;
    const id = await drafted(recorder, { title: '役員会', heldOn: '2026-11-06', visibility: 'selected', viewers: [otherId] });

    const first = (await call('GET', `/api/minutes/${id}`, { cookie: chosen })).json;
    expect(first.transcript.segments[1].confidence.weak).toEqual([{ start: 300, end: 300.5, word: '強酸', p: 0.18 }]);
    expect(first).toMatchObject({ stage: 'draft', version: 2, revising: false, reopened: false, bodyEdited: false, reviews: [], versions: [], can: { review: true, check: true, reopen: false, discard: false } });

    // Listening again: the reader corrects the text; someone who cannot read the meeting learns nothing.
    const fix = { expectedText: measured[1]!.text, text: '協賛の依頼文は総務部が十一月二十日までに作る、ということで決定とします。' };
    expect((await call('PUT', `/api/minutes/${id}/segments/1`, { cookie: outsider, body: fix })).status).toBe(404);
    const fixed = await call('PUT', `/api/minutes/${id}/segments/1`, { cookie: chosen, body: fix });
    expect(fixed.status).toBe(200);
    expect(fixed.json.transcript.segments[1]).toMatchObject({ text: fix.text, checked: { original: measured[1]!.text, byName: '合成 花子' } });
    expect(fixed.json.transcript.segments[1].checked.by).toBeUndefined();
    expect(fixed.json.version).toBe(2);
    expect((await call('PUT', `/api/minutes/${id}/segments/1`, { cookie: recorder, body: { ...fix, text: '別の直し' } })).status).toBe(409);
    expect((await call('PUT', `/api/minutes/${id}/segments/7`, { cookie: recorder, body: fix })).status).toBe(404);

    // The attendees written into the body are carried into the body the AI writes anew.
    const withAttendees = first.body.replace('（記入してください）', '合成 太郎、合成 花子');
    expect((await call('PUT', `/api/minutes/${id}/body`, { cookie: chosen, body: { expectedVersion: 2, body: withAttendees } })).status).toBe(200);
    expect((await call('POST', `/api/minutes/${id}/review`, { cookie: chosen, body: { expectedVersion: 2, comment: '期限を足して' } })).status).toBe(409);
    expect((await call('POST', `/api/minutes/${id}/review`, { cookie: chosen, body: { expectedVersion: 3, comment: '  ' } })).status).toBe(400);
    const sent = await call('POST', `/api/minutes/${id}/review`, { cookie: chosen, body: { expectedVersion: 3, comment: '決定事項に期限 11/20 を書いて' } });
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ stage: 'summarize_wait', revising: true, reviews: [{ status: 'pending', byName: '合成 花子', comment: '決定事項に期限 11/20 を書いて' }], can: { edit: false, review: false } });
    expect((await call('GET', '/api/minutes', { cookie: recorder })).json.items[0]).toMatchObject({ revising: true, reopened: false });
    expect((await call('POST', `/api/minutes/${id}/review`, { cookie: chosen, body: { expectedVersion: 4, comment: 'もう一つ' } })).json.message).toContain('AI が手直し中');

    // The worker gets the comment, the draft and the body, and the corrected text marked as checked (not by whom).
    const job = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    expect(job.review).toMatchObject({ comment: '決定事項に期限 11/20 を書いて', body: withAttendees, earlier: [], draft: { decisions: [{ text: '協賛の依頼文は総務部が作る' }] } });
    expect(job.transcript.segments[1]).toEqual({ start: 300, end: 306, text: fix.text, checked: true });
    expect(job.transcript.segments[0]).toEqual({ start: 0, end: 4, text: segments[0]!.text });
    const reworked = { summary: '協賛の依頼について。', decisions: [{ text: '協賛の依頼文は総務部が 11/20 までに作る', evidence: [{ at: 301, quote: '協賛の依頼文は総務部が' }] }] };
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: job.leaseToken, stage: 'summarize', draft: reworked, reviewId: job.review.id + 1, reply: 'x' })).status).toBe(200);
    // A reviewId that is not the pending comment: the draft stays, and the comment is marked failed.
    let after = (await call('GET', `/api/minutes/${id}`, { cookie: chosen })).json;
    expect(after).toMatchObject({ stage: 'draft', revising: false, reviews: [{ status: 'failed' }] });
    expect(after.draft.decisions[0].text).toBe('協賛の依頼文は総務部が作る');
    expect(after.reviews[0].error).toContain('処理役が古い版');

    const again = await call('POST', `/api/minutes/${id}/review`, { cookie: chosen, body: { expectedVersion: after.version, comment: '決定事項に期限 11/20 を書いて' } });
    expect(again.status).toBe(200);
    const job2 = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: job2.leaseToken, stage: 'summarize', draft: reworked, reviewId: job2.review.id, reply: '決定事項に期限を足しました。' })).status).toBe(200);
    after = (await call('GET', `/api/minutes/${id}`, { cookie: chosen })).json;
    expect(after).toMatchObject({ stage: 'draft', revising: false, bodyEdited: false, can: { review: true } });
    expect(after.reviews.map((r: { status: string }) => r.status)).toEqual(['failed', 'done']);
    expect(after.reviews[1].reply).toBe('決定事項に期限を足しました。');
    expect(after.draft.decisions[0]).toMatchObject({ text: '協賛の依頼文は総務部が 11/20 までに作る', evidence: [{ verified: true }] });
    expect(after.body).toContain('- 出席者: 合成 太郎、合成 花子');
    expect(after.body).toContain('11/20 までに作る');
    const before = await call('GET', `/api/minutes/${id}/reviews/${after.reviews[1].id}/body`, { cookie: chosen });
    expect(before.json.body).toBe(withAttendees);
    expect((await call('GET', `/api/minutes/${id}/reviews/${after.reviews[1].id}/body`, { cookie: outsider })).status).toBe(404);

    // A worker of before (no reviewId) writes a new draft without the comment: the draft is left as it was.
    await call('POST', `/api/minutes/${id}/review`, { cookie: recorder, body: { expectedVersion: after.version, comment: '要点を短く' } });
    const old = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: old.leaseToken, stage: 'summarize', draft: { summary: '別物' } })).status).toBe(200);
    const kept = (await call('GET', `/api/minutes/${id}`, { cookie: recorder })).json;
    expect(kept).toMatchObject({ stage: 'draft', draft: { summary: '協賛の依頼について。' } });
    expect(kept.reviews.at(-1)).toMatchObject({ status: 'failed', byName: '合成 太郎' });
  });

  it("the AI's guesses follow the first draft, after the meetings' own stages, and a guess confirmed as it was is marked", async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const id = await drafted(recorder, { title: '役員会', heldOn: '2026-11-10', visibility: 'members', viewers: [] });
    let m = (await call('GET', `/api/minutes/${id}`, { cookie: recorder })).json;
    // Segment 1 has a word the model was unsure of: it alone is queued.
    expect(m.suggest).toMatchObject({ status: 'wait', done: 0, total: 1, changed: 0, unchanged: 0, requestedByName: '下書きのあと自動' });
    expect(m.can).toMatchObject({ check: true, suggest: false });
    expect((await call('POST', `/api/minutes/${id}/suggest`, { cookie: recorder, body: {} })).json.message).toContain('作っているところ');

    // A worker asking for its own stages only (one of before) never gets a part of the guesses.
    expect((await worker(WORKER_PATHS.claim, { stages: ['transcribe', 'summarize'] })).json.job).toBeNull();
    // A meeting's stage comes first: a second meeting waiting for its summary is given before the guesses.
    const second = (await upload(recorder, audio, { title: '定例', heldOn: '2026-11-10', visibility: 'members', viewers: [] })).json.id as string;
    const t = (await worker(WORKER_PATHS.claim, { stages: ['transcribe'] })).json.job;
    await worker(WORKER_PATHS.result, { id: second, leaseToken: t.leaseToken, stage: 'transcribe', transcript: { segments: [segments[0]], durationSec: 5, model: 'large-v3' } });
    expect((await worker(WORKER_PATHS.claim, { stages: ['summarize', 'suggest'] })).json.job).toMatchObject({ id: second, stage: 'summarize' });

    const job = (await worker(WORKER_PATHS.claim, { stages: ['suggest'] })).json.job;
    expect(job).toMatchObject({ id, stage: 'suggest', audio: null, suggest: { targets: [1], hints: [], done: 0, total: 1 } });
    expect(job.transcript.segments[1]).toEqual({ start: 300, end: 306, text: measured[1]!.text });
    expect(job.glossary).toEqual(expect.arrayContaining(['協賛']));
    expect((await worker(WORKER_PATHS.progress, { id, leaseToken: job.leaseToken, stage: 'suggest', done: 0, total: 1 })).status).toBe(200);
    expect((await worker(WORKER_PATHS.progress, { id, leaseToken: 'x'.repeat(24), stage: 'suggest', done: 0, total: 1 })).status).toBe(409);
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: job.leaseToken, stage: 'suggest' })).status).toBe(400);
    // The guess is made one line, and the committee's words are fixed in it as in a transcript; a stale one is dropped.
    const guess = { index: 1, heard: measured[1]!.text, text: '共産の依頼文は総務部が十一月二十日までに作る、\nということで決定とします。' };
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: job.leaseToken, stage: 'suggest', suggestions: [guess, { index: 0, heard: '別の文', text: 'x' }] })).status).toBe(200);
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: job.leaseToken, stage: 'suggest', suggestions: [] })).status).toBe(409);

    m = (await call('GET', `/api/minutes/${id}`, { cookie: recorder })).json;
    const fixedGuess = '協賛の依頼文は総務部が十一月二十日までに作る、 ということで決定とします。';
    expect(m.transcript.segments[1].suggestion).toBe(fixedGuess);
    expect(m.transcript.segments[0].suggestion).toBeUndefined();
    expect(m.suggest).toMatchObject({ status: 'done', done: 1, total: 1, changed: 1, unchanged: 0 });
    expect(m.can.suggest).toBe(true);

    // Confirmed as the AI guessed it: marked, and the guess is no longer shown.
    const saved = await call('PUT', `/api/minutes/${id}/segments/1`, { cookie: recorder, body: { expectedText: measured[1]!.text, text: fixedGuess } });
    expect(saved.json.transcript.segments[1]).toMatchObject({ text: fixedGuess, checked: { original: measured[1]!.text, ai: true } });
    expect(saved.json.transcript.segments[1].suggestion).toBeUndefined();
    expect(saved.json.suggest).toMatchObject({ changed: 0, unchanged: 0 });
    // Nothing left to listen to again: no new guesses.
    expect((await call('POST', `/api/minutes/${id}/suggest`, { cookie: recorder, body: {} })).json.message).toContain('聞き直す文が残っていない');

    // A part the AI failed on is tried again; after the last attempt the failure is shown, and asking again goes on
    // from where it stopped.
    const third = await drafted(recorder, { title: '部会', heldOn: '2026-11-10', visibility: 'members', viewers: [] });
    for (let i = 0; i < 3; i++) {
      const part = (await worker(WORKER_PATHS.claim, { stages: ['suggest'] })).json.job;
      expect(part.id).toBe(third);
      expect((await worker(WORKER_PATHS.result, { id: third, leaseToken: part.leaseToken, stage: 'suggest', error: 'AI の案づくりに失敗しました: 時間切れ' })).status).toBe(200);
      if (i === 0) expect((await call('GET', `/api/minutes/${third}`, { cookie: recorder })).json.suggest).toMatchObject({ status: 'wait', error: null });
    }
    expect((await worker(WORKER_PATHS.claim, { stages: ['suggest'] })).json.job).toBeNull();
    m = (await call('GET', `/api/minutes/${third}`, { cookie: recorder })).json;
    expect(m.suggest).toMatchObject({ status: 'failed', error: 'AI の案づくりに失敗しました: 時間切れ', done: 0, total: 1 });
    const asked = await call('POST', `/api/minutes/${third}/suggest`, { cookie: recorder, body: {} });
    expect(asked.json.suggest).toMatchObject({ status: 'wait', requestedByName: '合成 太郎' });
  });

  it('correct confirmed minutes into the next version, and drop a correction', async () => {
    await build();
    const recorder = await signIn(MEMBER, '21000002');
    const member = await signIn(OTHER, '21000003');
    const id = await drafted(recorder, { title: '定例', heldOn: '2026-11-06', visibility: 'members', viewers: [] });
    const confirmed = (await call('POST', `/api/minutes/${id}/confirm`, { cookie: recorder, body: { expectedVersion: 2 } })).json;
    expect(confirmed).toMatchObject({ stage: 'confirmed', versions: [{ no: 1, confirmedByName: '合成 太郎', note: '' }], can: { reopen: true, review: false, check: false } });
    const deletesAt = confirmed.audio.deletesAt as string;

    // Any reader may start a correction; the minutes are a draft again, and the AI and listening again work.
    ctx.clock.now += 3 * 86_400_000;
    const reopened = await call('POST', `/api/minutes/${id}/reopen`, { cookie: member, body: { expectedVersion: confirmed.version } });
    expect(reopened.status).toBe(200);
    expect(reopened.json).toMatchObject({ stage: 'draft', reopened: true, confirmedByName: '合成 太郎', can: { edit: true, review: true, check: true, discard: true, reopen: false } });
    expect(reopened.json.audio.deletesAt).toBe(deletesAt);
    expect((await call('GET', '/api/minutes', { cookie: member })).json.items[0]).toMatchObject({ reopened: true });
    expect((await call('PUT', `/api/minutes/${id}/segments/0`, { cookie: member, body: { expectedText: segments[0]!.text, text: segments[0]!.text } })).status).toBe(200);
    const md = await call('GET', `/api/minutes/${id}/export.md`, { cookie: member });
    expect(md.body).toContain('訂正中（未確定）。確定している最新は第1版');

    const edited = await call('PUT', `/api/minutes/${id}/body`, { cookie: member, body: { expectedVersion: reopened.json.version, body: '# 定例\n\n訂正した本文\n' } });
    expect((await call('POST', `/api/minutes/${id}/confirm`, { cookie: member, body: { expectedVersion: edited.json.version } })).status).toBe(422);
    const second = await call('POST', `/api/minutes/${id}/confirm`, { cookie: member, body: { expectedVersion: edited.json.version, note: '本文の誤字を直した' } });
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ stage: 'confirmed', reopened: false, confirmedByName: '合成 花子', versions: [{ no: 1 }, { no: 2, note: '本文の誤字を直した', confirmedByName: '合成 花子' }] });
    expect(second.json.audio.deletesAt).toBe(deletesAt);
    const v2 = (await call('GET', `/api/minutes/${id}/versions/2`, { cookie: recorder })).json;
    expect(v2).toMatchObject({ no: 2, body: '# 定例\n\n訂正した本文\n', note: '本文の誤字を直した' });
    expect(v2.previousBody).toContain('## 決定事項');
    expect((await call('GET', `/api/minutes/${id}/versions/3`, { cookie: recorder })).status).toBe(404);
    const v1md = await call('GET', `/api/minutes/${id}/export.md?version=1`, { cookie: recorder });
    expect(v1md.body).toMatch(/確定: 合成 太郎 \S+（第1版）/);
    expect(v1md.body).toContain('## 決定事項');
    expect(decodeURIComponent(String(v1md.headers['content-disposition']))).toContain('_第1版.md');
    expect((await call('GET', `/api/minutes/${id}/export.md`, { cookie: recorder })).body).toMatch(/確定: 合成 花子 \S+（第2版）/);

    // Dropping a correction goes back to the last version, and only during a correction.
    expect((await call('POST', `/api/minutes/${id}/discard`, { cookie: recorder, body: { expectedVersion: second.json.version } })).status).toBe(409);
    const third = await call('POST', `/api/minutes/${id}/reopen`, { cookie: recorder, body: { expectedVersion: second.json.version } });
    await call('PUT', `/api/minutes/${id}/body`, { cookie: recorder, body: { expectedVersion: third.json.version, body: '捨てる本文' } });
    const latest = (await call('GET', `/api/minutes/${id}`, { cookie: recorder })).json;
    const dropped = await call('POST', `/api/minutes/${id}/discard`, { cookie: recorder, body: { expectedVersion: latest.version } });
    expect(dropped.status).toBe(200);
    expect(dropped.json).toMatchObject({ stage: 'confirmed', body: '# 定例\n\n訂正した本文\n', confirmedByName: '合成 花子', versions: [{ no: 1 }, { no: 2 }] });
  });
});

// Each case takes a meeting through the worker and signs in twice, which runs past 5 s on a busy machine.
describe('the decision register from confirmed minutes (Discord login)', { timeout: 20_000 }, () => {
  let decisions: DecisionsStore;
  beforeEach(() => {
    decisions = new DecisionsStore(path.join(dir, 'decisions'));
  });
  afterEach(() => {
    decisions.close();
  });

  /** A meeting taken through the worker to a draft whose decisions are the given texts. */
  async function draftWithItems(recorder: string, items: string[], fields: Record<string, unknown>): Promise<string> {
    const created = await upload(recorder, audio, fields);
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const transcribe = (await worker(WORKER_PATHS.claim, { stages: ['transcribe', 'summarize'] })).json.job;
    const done = await worker(WORKER_PATHS.result, { id, leaseToken: transcribe.leaseToken, stage: 'transcribe', transcript: { segments, durationSec: 310, model: 'large-v3' } });
    expect(done.status).toBe(200);
    const summarize = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    const drafted = await worker(WORKER_PATHS.result, {
      id,
      leaseToken: summarize.leaseToken,
      stage: 'summarize',
      draft: { summary: '決めた。', decisions: items.map((text) => ({ text, evidence: [{ at: 301, quote: '総務部が十一月二十日までに作る' }] })), todos: [] },
    });
    expect(drafted.status).toBe(200);
    return id;
  }

  it('registers chosen items of a confirmed, everyone-visible meeting as the server reads them, each once', async () => {
    await build({ decisions });
    const recorder = await signIn(MEMBER, '21000002');
    const member = await signIn(OTHER, '21000003');
    const ITEM = '協賛の依頼文は総務部が 11 月 20 日までに作る';
    const LONG = `${'あ'.repeat(100)}という決定が続く`;
    const id = await draftWithItems(recorder, [ITEM, LONG], { title: '役員会', heldOn: '2026-11-02', visibility: 'members', viewers: [] });
    const pick = (items: number[], departments = ['somu'], venue = 'board') => call('POST', `/api/minutes/${id}/decisions`, { cookie: recorder, body: { items, departments, venue } });

    // Not before the minutes are confirmed: the draft is the AI's text, and nothing is registered.
    expect((await pick([0])).status).toBe(409);
    expect(decisions.count()).toBe(0);

    expect((await call('POST', `/api/minutes/${id}/confirm`, { cookie: recorder, body: { expectedVersion: 2 } })).status).toBe(200);
    const first = await pick([0, 0]);
    expect(first.status).toBe(200);
    expect(first.json.results).toHaveLength(1);
    const made = first.json.results[0];
    expect(made).toMatchObject({ index: 0, replayed: false });
    expect(decisions.get(made.decisionId)!.input).toMatchObject({ title: ITEM, body: '', departments: ['somu'], decidedOn: '2026-11-02', venue: 'board' });
    expect(decisions.get(made.decisionId)!.input.sources).toEqual([expect.objectContaining({ kind: 'minutes', refId: id, label: '議事録：役員会' })]);

    // The same item again is the decision already made, whatever the departments the second time.
    const again = await pick([0], ['naimu'], 'regular');
    expect(again.json.results).toEqual([{ index: 0, decisionId: made.decisionId, replayed: true }]);
    expect(decisions.get(made.decisionId)!.input.departments).toEqual(['somu']);

    // The part of a long item beyond the title limit is kept in the body.
    const long = (await pick([1])).json.results[0];
    const longInput = decisions.get(long.decisionId)!.input;
    expect(longInput.title).toHaveLength(100);
    expect(longInput.title + longInput.body).toBe(LONG);
    expect(decisions.count()).toBe(2);

    // Every member reads them in the register; an item that is not in the draft is refused.
    const list = await call('GET', '/api/decisions', { cookie: member });
    expect(list.json.items.map((i: { title: string }) => i.title)).toEqual(expect.arrayContaining([ITEM]));
    expect((await pick([5])).status).toBe(422);
    expect(decisions.count()).toBe(2);
  });

  it('keeps the items registered from one draft apart from the items of a draft the AI reworked during a correction', async () => {
    await build({ decisions });
    const recorder = await signIn(MEMBER, '21000002');
    const id = await draftWithItems(recorder, ['最初の決定A', '最初の決定B'], { title: '役員会', heldOn: '2026-11-06', visibility: 'members', viewers: [] });
    const confirmed = (await call('POST', `/api/minutes/${id}/confirm`, { cookie: recorder, body: { expectedVersion: 2 } })).json;
    const pick = (items: number[]) => call('POST', `/api/minutes/${id}/decisions`, { cookie: recorder, body: { items, departments: ['somu'], venue: 'board' } });
    const a = (await pick([0])).json.results[0];

    const reopened = (await call('POST', `/api/minutes/${id}/reopen`, { cookie: recorder, body: { expectedVersion: confirmed.version } })).json;
    expect(reopened.registeredDecisions).toBe(1);
    await call('POST', `/api/minutes/${id}/review`, { cookie: recorder, body: { expectedVersion: reopened.version, comment: 'B を先に' } });
    const job = (await worker(WORKER_PATHS.claim, { stages: ['summarize'] })).json.job;
    const reworked = { decisions: [{ text: '直した決定B', evidence: [] }, { text: '最初の決定A', evidence: [] }] };
    expect((await worker(WORKER_PATHS.result, { id, leaseToken: job.leaseToken, stage: 'summarize', draft: reworked, reviewId: job.review.id, reply: '並べ替えた' })).status).toBe(200);
    const v = (await call('GET', `/api/minutes/${id}`, { cookie: recorder })).json.version as number;
    expect((await call('POST', `/api/minutes/${id}/confirm`, { cookie: recorder, body: { expectedVersion: v, note: 'B を直した' } })).status).toBe(200);

    // Item 0 is now another decision: it is registered anew, not answered by the decision of the first draft's item 0.
    const b = (await pick([0])).json.results[0];
    expect(b.replayed).toBe(false);
    expect(b.decisionId).not.toBe(a.decisionId);
    expect(decisions.get(b.decisionId)!.input.title).toBe('直した決定B');
    expect((await call('GET', `/api/minutes/${id}`, { cookie: recorder })).json.registeredDecisions).toBe(2);
  });

  it('refuses a meeting limited to chosen people, and temporary staff, in the register and in the minutes', async () => {
    await build({ decisions });
    const recorder = await signIn(MEMBER, '21000002');
    const staff = await signIn(OTHER, '21000003', [ROLE_STAFF]);
    const limited = await draftWithItems(recorder, ['限られた人だけの決定'], { title: '部会', heldOn: '2026-11-02', visibility: 'selected', viewers: [] });
    expect((await call('POST', `/api/minutes/${limited}/confirm`, { cookie: recorder, body: { expectedVersion: 2 } })).status).toBe(200);
    const refused = await call('POST', `/api/minutes/${limited}/decisions`, { cookie: recorder, body: { items: [0], departments: ['somu'], venue: 'board' } });
    expect(refused.status).toBe(403);
    expect(decisions.count()).toBe(0);

    // Temporary staff: no read and no write of the register (the Discord login's own check), and no registration.
    expect((await call('GET', '/api/decisions', { cookie: staff })).status).toBe(403);
    expect((await call('POST', '/api/decisions', { cookie: staff, body: {} })).status).toBe(403);
    expect((await call('POST', `/api/minutes/${limited}/decisions`, { cookie: staff, body: { items: [0], departments: ['somu'], venue: 'board' } })).status).toBe(403);
    expect(decisions.count()).toBe(0);
  });
});
