import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { committeeLineState } from '../../src/server/line/committee.js';
import { envelopeOf, eventIdOfKey, feedCursorKey, LineFeed, type FeedRecord } from '../../src/server/line/feed.js';
import { MessagingApiConnector, type Fetch } from '../../src/server/line/messaging-api.js';
import { loadLineConfig, validateLineConfig, type LineOaConfig } from '../../src/server/line/oa-config.js';
import { LineStore } from '../../src/server/line/store.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, ROLE_PLANNING, setup } from '../discord-auth/helpers.js';
import { testMailboxConfig } from './helpers.js';

// The committee's official LINE account in the unified app (2026-10-28): line.json, the feed from the existing
// receiver's /export, the Messaging API adapter against a fake LINE, and the routes in committee mode.
// Synthetic IDs, names and tokens only.

const PULL = 'pull-token-synthetic-0001';
const ACCESS = 'access-token-synthetic-0001';
const USER_A = `U${'a'.repeat(32)}`;
const USER_B = `U${'b'.repeat(32)}`;
const GROUP = `C${'c'.repeat(32)}`;
const DOC = { version: 1, account: { id: 'oa', name: '合成 公式LINE' }, receiver: { url: 'http://receiver.example.invalid:8788' } };

const lineConfig = (dataDir: string, changes: Record<string, unknown> = {}, send = false): LineOaConfig =>
  validateLineConfig({ ...DOC, ...(send ? { send: {} } : {}), ...changes }, dataDir, { pullToken: PULL, accessToken: send ? ACCESS : null });

let seq = 0;
/** One record as the receiver exports it, `ageSeconds` before `now`. */
function record(now: number, ageSeconds: number, changes: Record<string, unknown> = {}): FeedRecord {
  const at = now - ageSeconds * 1000;
  seq += 1;
  const day = new Date(at + 9 * 3_600_000).toISOString().slice(0, 10).replaceAll('-', '');
  return {
    _key: `ev:${day}:${String(at).padStart(15, '0')}:${String(seq % 100).padStart(2, '0')}:${seq.toString(16).padStart(8, '0')}`,
    received_at: new Date(at).toISOString(),
    event_type: 'message',
    timestamp: at,
    source_type: 'user',
    user_id: USER_A,
    display_name: '合成 太郎さん',
    message_type: 'text',
    message_id: String(500000 + seq),
    text: `合成のメッセージ ${seq}`,
    ...changes,
  };
}

/** The receiver's /export: records after the cursor, in key order, behind the pull token. */
function fakeReceiver(records: FeedRecord[], token = PULL) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const auth = new Headers(init.headers).get('authorization');
    calls.push({ url: input, auth });
    const url = new URL(input);
    if (url.pathname !== '/export') return new Response('not found', { status: 404 });
    if (auth !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
    const after = url.searchParams.get('after') ?? '';
    const limit = Number(url.searchParams.get('limit'));
    const rows = records.filter((r) => String(r._key) > after).sort((a, b) => String(a._key).localeCompare(String(b._key))).slice(0, limit);
    return new Response(rows.map((r) => JSON.stringify(r)).join('\n'), { status: 200 });
  };
  return { fetchImpl, calls };
}

describe('line.json', () => {
  it('reads the account, the receiver and sending, with defaults', () => {
    const c = lineConfig('/data/mailbox', {}, true);
    expect(c.account).toEqual({ id: 'oa', name: '合成 公式LINE', botUserId: null });
    expect(c.receiver).toEqual({ url: 'http://receiver.example.invalid:8788', pullToken: PULL, pollSeconds: 30, settleSeconds: 60 });
    expect(c.send).toEqual({ accessToken: ACCESS, monthlyLimit: 200, allowGroups: false, apiBase: 'https://api.line.me' });
    expect(c.dataFile).toBe(path.join('/data/mailbox', 'line-state.json'));
    expect(lineConfig('/d').send).toBeNull();
  });

  it('refuses unknown keys, a receiver URL with a path or credentials, and sending without a token', () => {
    expect(() => lineConfig('/d', { token: 'x' })).toThrow(/不明な項目/);
    expect(() => lineConfig('/d', { receiver: { url: 'http://r.example.invalid/export' } })).toThrow(/receiver.url/);
    expect(() => lineConfig('/d', { receiver: { url: 'http://u:p@r.example.invalid' } })).toThrow(/receiver.url/);
    expect(() => lineConfig('/d', { receiver: { url: 'file:///etc/passwd' } })).toThrow(/receiver.url/);
    expect(() => lineConfig('/d', { account: { id: 'OA', name: 'x' } })).toThrow(/account.id/);
    expect(() => lineConfig('/d', { send: { apiBase: 'http://api.line.me' } }, true)).toThrow(/apiBase/);
    expect(() => lineConfig('/d', { send: { monthlyLimit: 0 } }, true)).toThrow(/monthlyLimit/);
    expect(() => validateLineConfig({ ...DOC, send: {} }, '/d', { pullToken: PULL, accessToken: null })).toThrow(/accessTokenFile/);
  });

  it('is off without the file, and reads the token files beside it', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'iyakusai-line-config-'));
    try {
      const mailConfig = path.join(d, 'mailbox.json');
      expect(loadLineConfig(mailConfig, path.join(d, 'data'))).toBeNull();
      writeFileSync(path.join(d, 'pull.token'), `${String.fromCharCode(0xfeff)}${PULL}\n`, { mode: 0o600 });
      writeFileSync(path.join(d, 'access.token'), `${ACCESS}\n`, { mode: 0o600 });
      writeFileSync(path.join(d, 'line.json'), JSON.stringify({ ...DOC, receiver: { ...DOC.receiver, pullTokenFile: path.join(d, 'pull.token') } }));
      expect(loadLineConfig(mailConfig, path.join(d, 'data'))).toMatchObject({ receiver: { pullToken: PULL }, send: null });
      writeFileSync(path.join(d, 'line.json'), JSON.stringify({ ...DOC, receiver: { ...DOC.receiver, pullTokenFile: path.join(d, 'pull.token') }, send: { accessTokenFile: path.join(d, 'access.token') } }));
      expect(loadLineConfig(mailConfig, path.join(d, 'data'))?.send?.accessToken).toBe(ACCESS);
      writeFileSync(path.join(d, 'pull.token'), 'short', { mode: 0o600 });
      expect(() => loadLineConfig(mailConfig, path.join(d, 'data'))).toThrow(/正しい形/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('turns off LINE only when line.json cannot be used: the mailbox still starts', async () => {
    const { parseMailboxConfig } = await import('../../src/server/mailbox/config.js');
    const d = mkdtempSync(path.join(tmpdir(), 'iyakusai-line-broken-'));
    try {
      const keyFile = path.join(d, 'mail-ingest.key');
      writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
      const file = path.join(d, 'mailbox.json');
      writeFileSync(file, JSON.stringify({ version: 1, mailboxes: [{ id: 'taro', name: '共用', address: 'taro@committee.example', catchAll: true }], ingestKeyFile: keyFile }));
      writeFileSync(path.join(d, 'line.json'), JSON.stringify({ ...DOC, receiver: { ...DOC.receiver, pullTokenFile: path.join(d, 'missing.token') } }));
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const c = parseMailboxConfig({ SMM_MAIL_DIR: path.join(d, 'data'), SMM_MAIL_CONFIG: file }, true);
      expect(c?.mailboxes.map((m) => m.id)).toEqual(['taro']);
      expect(c?.line).toBeNull();
      expect(errors.mock.calls.flat().join(' ')).toMatch(/公式LINE は無効のまま/);
      errors.mockRestore();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('the receiver feed', () => {
  const NOW = Date.parse('2026-10-28T03:00:00.000Z');
  const cfg = lineConfig('/unused');
  const account = { id: 'oa', destination: committeeLineState(null, cfg).accounts[0]!.destination! };

  it('turns records into envelopes and passes over what the inbox does not show', () => {
    const r = record(NOW, 120);
    const env = envelopeOf(r, account);
    expect(env).toMatchObject({ schema: 'line-event/v1', accountId: 'oa', type: 'message', source: { type: 'user', userId: USER_A }, senderLabel: '合成 太郎さん', targetLabel: '合成 太郎さん', message: { type: 'text', text: r.text } });
    expect(env?.webhookEventId).toBe(eventIdOfKey(String(r._key)));
    expect(eventIdOfKey(String(r._key))).toMatch(/^[0-9A-Z]{26}$/);
    expect(envelopeOf(record(NOW, 120, { source_type: 'group', group_id: GROUP }), account)).toMatchObject({ source: { type: 'group', groupId: GROUP, userId: USER_A } });
    expect(envelopeOf(record(NOW, 120, { source_type: 'group', group_id: GROUP }), account)).not.toHaveProperty('targetLabel');
    expect(envelopeOf(record(NOW, 120, { event_type: 'postback' }), account)).toBeNull();
    expect(envelopeOf(record(NOW, 120, { error: 'bad body' }), account)).toBeNull();
    expect(envelopeOf(record(NOW, 120, { user_id: 'not-an-id' }), account)).toBeNull();
    expect(envelopeOf(record(NOW, 120, { event_type: 'unsend' }), account)).toMatchObject({ type: 'unsend', unsend: { messageId: expect.any(String) } });
  });

  it('imports settled records once, holds the newest ones, and keeps its own cursor', async () => {
    const records = [record(NOW, 300), record(NOW, 200, { event_type: 'postback' }), record(NOW, 120, { user_id: USER_B, display_name: '合成 花子さん' }), record(NOW, 10)];
    const { fetchImpl, calls } = fakeReceiver(records);
    const store = new LineStore(committeeLineState(null, cfg), null);
    const feed = new LineFeed({ store, account, receiver: cfg.receiver, fetch: fetchImpl, now: () => NOW });
    await feed.poll();
    expect(feed.status).toMatchObject({ lastError: null, imported: 2 });
    expect(calls[0]).toEqual({ url: 'http://receiver.example.invalid:8788/export?after=&limit=200', auth: `Bearer ${PULL}` });
    expect(store.current.messages).toHaveLength(2);
    expect(new Set(store.current.conversations.map((c) => c.title))).toEqual(new Set(['合成 花子さん', '合成 太郎さん']));
    // The record 10 seconds old waits (its display name may still be coming).
    expect(store.current.feed.cursors[feedCursorKey('oa')]).toBe(records[2]!._key);

    await feed.poll();
    expect(store.current.messages).toHaveLength(2);
    const later = new LineFeed({ store, account, receiver: cfg.receiver, fetch: fetchImpl, now: () => NOW + 120_000 });
    await later.poll();
    expect(store.current.messages).toHaveLength(3);
    expect(store.current.feed.cursors[feedCursorKey('oa')]).toBe(records[3]!._key);
  });

  it('stops before a record it cannot place, and reports only a category on errors', async () => {
    const good = record(NOW, 300);
    // Sorts right after the good record, but is not of the receiver's form.
    const { fetchImpl } = fakeReceiver([good, { _key: `${String(good._key)}x`, received_at: new Date(NOW - 200_000).toISOString() }, record(NOW, 120)]);
    const store = new LineStore(committeeLineState(null, cfg), null);
    const feed = new LineFeed({ store, account, receiver: cfg.receiver, fetch: fetchImpl, now: () => NOW });
    await feed.poll();
    expect(store.current.messages).toHaveLength(1);
    expect(store.current.feed.cursors[feedCursorKey('oa')]).toBe(good._key);
    expect(feed.status.lastError).toMatch(/形が想定と違う/);

    const wrong = fakeReceiver([record(NOW, 300)], 'another-token-0000000');
    const refused = new LineFeed({ store: new LineStore(committeeLineState(null, cfg), null), account, receiver: cfg.receiver, fetch: wrong.fetchImpl, now: () => NOW });
    await refused.poll();
    expect(refused.status.lastError).toMatch(/トークン/);
    expect(refused.status.lastError).not.toContain(PULL);
    const down = new LineFeed({ store: new LineStore(committeeLineState(null, cfg), null), account, receiver: cfg.receiver, fetch: () => Promise.reject(new TypeError('fetch failed')), now: () => NOW });
    await down.poll();
    expect(down.status).toMatchObject({ lastError: '受け口に接続できませんでした', lastSuccessAt: null });
  });
});

describe('the Messaging API adapter', () => {
  const push = { to: USER_A, text: '合成の返信', retryKey: '123e4567-e89b-42d3-a456-426614174000' } as Parameters<MessagingApiConnector['push']>[0];
  const answer = (status: number, headers: Record<string, string> = {}, body = '{}') => new MessagingApiConnector(ACCESS, 'https://api.example.invalid', async () => new Response(body, { status, headers }));

  it('sends one text message with the retry key and the token only in Authorization', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const c = new MessagingApiConnector(ACCESS, 'https://api.example.invalid', async (url, init) => {
      seen.push({ url, init });
      return new Response('{}', { status: 200, headers: { 'x-line-request-id': 'req-1' } });
    });
    expect(await c.push(push)).toEqual({ kind: 'accepted', requestId: 'req-1' });
    const h = new Headers(seen[0]!.init.headers);
    expect(seen[0]!.url).toBe('https://api.example.invalid/v2/bot/message/push');
    expect(h.get('authorization')).toBe(`Bearer ${ACCESS}`);
    expect(h.get('x-line-retry-key')).toBe(push.retryKey);
    expect(seen[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ to: USER_A, messages: [{ type: 'text', text: '合成の返信' }] });
  });

  it('maps LINE answers to outcomes', async () => {
    expect(await answer(409, { 'x-line-accepted-request-id': 'req-0' }).push(push)).toEqual({ kind: 'accepted_duplicate', acceptedRequestId: 'req-0' });
    expect(await answer(409).push(push)).toMatchObject({ kind: 'rejected', reason: 'invalid' });
    expect(await answer(500).push(push)).toEqual({ kind: 'unknown', reason: 'server_error' });
    expect(await answer(429, {}, '{"message":"You have reached your monthly limit."}').push(push)).toMatchObject({ kind: 'rejected', reason: 'rate_limited', retryAfterSeconds: 3600 });
    expect(await answer(429, {}, '{"message":"The API rate limit has been exceeded."}').push(push)).toMatchObject({ reason: 'rate_limited', retryAfterSeconds: 60 });
    expect(await answer(401).push(push)).toMatchObject({ reason: 'not_configured' });
    expect(await answer(403).push(push)).toMatchObject({ reason: 'permission_denied' });
    expect(await answer(400).push(push)).toMatchObject({ reason: 'invalid' });
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(await new MessagingApiConnector(ACCESS, 'https://a.example.invalid', () => Promise.reject(refused)).push(push)).toEqual({ kind: 'not_sent' });
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(await new MessagingApiConnector(ACCESS, 'https://a.example.invalid', () => Promise.reject(timeout)).push(push)).toEqual({ kind: 'unknown', reason: 'timeout' });
  });

  it('reads the quota and a group member count, and nothing from a malformed ID', async () => {
    const calls: string[] = [];
    const c = new MessagingApiConnector(ACCESS, 'https://a.example.invalid', async (url) => {
      calls.push(url);
      if (url.endsWith('/quota')) return Response.json({ type: 'limited', value: 200 });
      if (url.endsWith('/quota/consumption')) return Response.json({ totalUsage: 12 });
      return Response.json({ count: 4 });
    });
    expect(await c.quota()).toEqual({ limit: 200, used: 12 });
    expect(await c.memberCount({ type: 'group', id: GROUP })).toBe(4);
    expect(await c.memberCount({ type: 'group', id: '../quota' })).toBeNull();
    expect(calls.filter((u) => u.includes('members'))).toEqual([`https://a.example.invalid/v2/bot/group/${GROUP}/members/count`]);
  });
});

// ---- the routes, in the committee mailbox

const ORIGIN = `http://${TEST_HOST}`;
let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
let records: FeedRecord[];
let pushes: { to: string; text: string; retryKey: string | null }[];
let lineUsed: number;
let members: number;
let refuseNextPush: boolean;

/** The receiver and LINE behind one fetch. */
const network: Fetch = async (input, init) => {
  const url = new URL(input);
  if (url.host === 'receiver.example.invalid:8788') return fakeReceiver(records).fetchImpl(input, init);
  if (url.origin !== 'https://api.example.invalid' || new Headers(init.headers).get('authorization') !== `Bearer ${ACCESS}`) return new Response('{}', { status: 401 });
  if (url.pathname === '/v2/bot/message/push') {
    if (refuseNextPush) {
      refuseNextPush = false;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }
    const body = JSON.parse(String(init.body)) as { to: string; messages: { text: string }[] };
    pushes.push({ to: body.to, text: body.messages[0]!.text, retryKey: new Headers(init.headers).get('x-line-retry-key') });
    return new Response('{}', { status: 200, headers: { 'x-line-request-id': `req-${pushes.length}` } });
  }
  if (url.pathname === '/v2/bot/message/quota') return Response.json({ type: 'limited', value: 200 });
  if (url.pathname === '/v2/bot/message/quota/consumption') return Response.json({ totalUsage: lineUsed });
  if (url.pathname === `/v2/bot/group/${GROUP}/members/count`) return Response.json({ count: members });
  return new Response('{}', { status: 404 });
};

async function build(line: Record<string, unknown> | null, send = true) {
  const config = testMailboxConfig(path.join(dir, 'mail'));
  mkdirSync(config.dataDir, { recursive: true });
  config.line = line ? lineConfig(config.dataDir, { ...line, ...(send ? { send: { apiBase: 'https://api.example.invalid', ...(line.send as object) } } : {}) }, send) : null;
  mail = new MailboxStore(config.dataDir);
  const seed = await seedState();
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases), lineFetch: network },
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-line-committee-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup();
  pushes = [];
  lineUsed = 0;
  members = 3;
  refuseNextPush = false;
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, options: { body?: unknown; cookie?: string } = {}) {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(method !== 'GET' ? { origin: ORIGIN, 'x-smm-csrf': '1' } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, json: json as any };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

async function signIn(uid: string, studentId: string, roles: string[] = []) {
  const { initialLoginId } = await register(ctx, uid, studentId, roles);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: TEST_HOST, origin: ORIGIN, 'x-smm-csrf': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ loginId: studentId, password: PASSWORD }) });
  expect(res.statusCode).toBe(200);
  return { cookie: cookieOf(res.headers['set-cookie']), id: initialLoginId };
}

/** Waits for the feed's first pass (it starts a second after the app). */
async function lineItems(cookie: string, count: number) {
  return vi.waitFor(
    async () => {
      const items = (await call('GET', '/api/inbox?source=line', { cookie })).json.items as { conversationId: string; title: string; targetType: string }[];
      expect(items).toHaveLength(count);
      return items;
    },
    { timeout: 4000, interval: 100 },
  );
}

async function sendReply(cookie: string, conversationId: string, text: string) {
  const draft = await call('PUT', `/api/line/conversations/${conversationId}/reply/draft`, { cookie, body: { body: text, expectedVersion: null } });
  expect(draft.status).toBe(200);
  const preview = await call('POST', `/api/line/conversations/${conversationId}/reply/preview`, { cookie, body: { draftId: draft.json.id, draftVersion: draft.json.version } });
  if (preview.status !== 200) return { preview, sent: null };
  const sent = await call('POST', `/api/line/conversations/${conversationId}/reply/send`, {
    cookie,
    body: { consentId: preview.json.consentId, operationId: crypto.randomUUID(), draftId: draft.json.id, draftVersion: draft.json.version, body: preview.json.body },
  });
  return { preview, sent };
}

describe('the official LINE account in the committee inbox', () => {
  it('is off without line.json', async () => {
    await build(null);
    const chair = await signIn(CHAIR, '21000001');
    const inbox = await call('GET', '/api/inbox', { cookie: chair.cookie });
    expect(inbox.json).toMatchObject({ lineEnabled: false, counts: { line: 0 } });
    expect((await call('GET', '/api/line/accounts', { cookie: chair.cookie })).status).toBe(404);
  });

  it('shows received messages to every member, lets them sort them, and keeps notes and sending for granted people', async () => {
    const now = ctx.clock.now;
    records = [record(now, 600), record(now, 500, { user_id: USER_B, display_name: '合成 花子さん' })];
    await build({}, true);
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002', [ROLE_PLANNING]);
    const other = await signIn(OTHER, '21000003', [ROLE_GENERAL_AFFAIRS]);

    const items = await lineItems(member.cookie, 2);
    expect((await call('GET', '/api/inbox', { cookie: member.cookie })).json).toMatchObject({ lineEnabled: true, counts: { line: 2 } });
    const taro = items.find((i) => i.title === '合成 太郎さん')!;
    const detail = (await call('GET', `/api/line/conversations/${taro.conversationId}`, { cookie: member.cookie })).json;
    expect(detail).toMatchObject({ access: 'read', canTriage: true, sending: 'live', reply: { canReply: false, available: false } });
    expect(JSON.stringify(detail)).not.toContain(USER_A);
    expect((await call('GET', '/api/line/accounts', { cookie: member.cookie })).json).toEqual([expect.objectContaining({ id: 'oa', sending: 'live', canReply: false })]);

    // Status by anyone; a note needs the edit grant; the grant screen is the access manager's.
    expect((await call('PATCH', `/api/line/conversations/${taro.conversationId}/triage`, { cookie: member.cookie, body: { expectedVersion: 1, status: 'in_progress' } })).status).toBe(200);
    expect((await call('POST', `/api/line/conversations/${taro.conversationId}/notes`, { cookie: member.cookie, body: { body: '合成のメモ' } })).status).toBe(403);
    expect((await call('GET', '/api/line/admin/access', { cookie: member.cookie })).status).toBe(403);
    const access = (await call('GET', '/api/line/admin/access', { cookie: chair.cookie })).json;
    expect(access).toMatchObject({ mailboxes: [{ id: 'oa', name: '合成 公式LINE', address: '公式LINE' }], sendable: ['oa'], grants: [], sendGrants: [], departmentGrants: [] });
    expect(access.departments).toEqual(expect.arrayContaining(['企画部', '総務部']));

    expect((await call('PUT', '/api/line/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'oa', edit: true } })).status).toBe(200);
    expect((await call('POST', `/api/line/conversations/${taro.conversationId}/notes`, { cookie: member.cookie, body: { body: '合成のメモ' } })).status).toBe(201);
    // The edit grant is not a send grant.
    expect((await call('PUT', `/api/line/conversations/${taro.conversationId}/reply/draft`, { cookie: member.cookie, body: { body: 'x', expectedVersion: null } })).status).toBe(403);

    // Sending by department: 企画部 can send, 総務部 cannot.
    const granted = await call('PUT', '/api/line/admin/access', { cookie: chair.cookie, body: { department: '企画部', mailboxId: 'oa', send: true } });
    expect(granted.json.departmentGrants).toEqual([{ department: '企画部', mailboxId: 'oa', kind: 'send' }]);
    const draftByOther = await call('PUT', `/api/line/conversations/${taro.conversationId}/reply/draft`, { cookie: other.cookie, body: { body: 'x', expectedVersion: null } });
    expect(draftByOther.status).toBe(403);

    lineUsed = 7;
    const { preview, sent } = await sendReply(member.cookie, taro.conversationId, '合成の返信です。');
    expect(preview.json).toMatchObject({ mock: false, method: 'push', billableRecipients: 1 });
    expect(preview.json.notices.join('\n')).toMatch(/取り消すことはできません/);
    expect(preview.json.notices.join('\n')).toMatch(/0 通、上限は 200 通/);
    expect(preview.json.notices.join('\n')).toMatch(/LINE 側の今月の通数：7 通／上限 200 通/);
    expect(sent?.json.outbox).toMatchObject({ status: 'accepted', mock: false });
    expect(pushes).toEqual([{ to: USER_A, text: '合成の返信です。', retryKey: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    expect(JSON.stringify(sent?.json)).not.toContain(ACCESS);
  });

  it('stops at the monthly limit, counting a group once per member', async () => {
    const now = ctx.clock.now;
    records = [record(now, 600), record(now, 590, { event_type: 'join', source_type: 'group', group_id: GROUP, user_id: undefined, message_id: undefined }), record(now, 500, { source_type: 'group', group_id: GROUP })];
    await build({ send: { monthlyLimit: 3, allowGroups: true } }, true);
    const chair = await signIn(CHAIR, '21000001');
    await call('PUT', '/api/line/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'oa', send: true } });
    const items = await lineItems(chair.cookie, 2);
    const one = items.find((i) => i.targetType === 'user')!;
    const group = items.find((i) => i.targetType === 'group')!;

    // The group's member count is unknown until the preview reads it; the draft can still be written.
    expect((await call('GET', `/api/line/conversations/${group.conversationId}`, { cookie: chair.cookie })).json.reply).toMatchObject({ available: true, reason: null });
    members = 3;
    const toGroup = await sendReply(chair.cookie, group.conversationId, '全員への合成の連絡');
    expect(toGroup.preview.json).toMatchObject({ billableRecipients: 3, target: { type: 'group', memberCount: 3 } });
    expect(toGroup.sent?.json.outbox.status).toBe('accepted');

    const refused = await sendReply(chair.cookie, one.conversationId, '合成の返信');
    expect(refused.preview.status).toBe(422);
    expect(refused.preview.json.message).toMatch(/上限（3 通）/);
    expect(pushes).toHaveLength(1);
  });

  it('counts a failed send again when it is retried', async () => {
    const now = ctx.clock.now;
    records = [record(now, 600), record(now, 500, { user_id: USER_B, display_name: '合成 花子さん' })];
    await build({ send: { monthlyLimit: 1 } }, true);
    const chair = await signIn(CHAIR, '21000001');
    await call('PUT', '/api/line/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'oa', send: true } });
    const items = await lineItems(chair.cookie, 2);
    refuseNextPush = true;
    const first = await sendReply(chair.cookie, items[0]!.conversationId, '届かなかった合成の返信');
    expect(first.sent?.json.outbox).toMatchObject({ status: 'failed', retryable: true });
    expect((await sendReply(chair.cookie, items[1]!.conversationId, '届いた合成の返信')).sent?.json.outbox.status).toBe('accepted');
    const retry = await call('POST', `/api/line/outbox/${first.sent?.json.outbox.id}/retry`, { cookie: chair.cookie, body: { expectedAttempts: 1 } });
    expect(retry.status).toBe(422);
    expect(retry.json.message).toMatch(/上限（1 通）/);
    expect(pushes).toHaveLength(1);
  });

  it('keeps groups read-only unless line.json allows them, and refuses send grants without sending', async () => {
    const now = ctx.clock.now;
    records = [record(now, 500, { source_type: 'group', group_id: GROUP })];
    await build({}, true);
    const chair = await signIn(CHAIR, '21000001');
    await call('PUT', '/api/line/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'oa', send: true } });
    const [group] = await lineItems(chair.cookie, 1);
    const detail = (await call('GET', `/api/line/conversations/${group!.conversationId}`, { cookie: chair.cookie })).json;
    expect(detail.reply).toMatchObject({ available: false, reason: expect.stringMatching(/設定で止めています/) });
    expect((await call('PUT', `/api/line/conversations/${group!.conversationId}/reply/draft`, { cookie: chair.cookie, body: { body: 'x', expectedVersion: null } })).status).toBe(422);
    expect(pushes).toHaveLength(0);
  });

  it('is read-only without "send": no send grants, nothing reaches LINE', async () => {
    records = [record(ctx.clock.now, 500)];
    await build({}, false);
    const chair = await signIn(CHAIR, '21000001');
    expect((await call('PUT', '/api/line/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'oa', send: true } })).status).toBe(422);
    expect((await call('GET', '/api/line/admin/access', { cookie: chair.cookie })).json.sendable).toBeNull();
    const [item] = await lineItems(chair.cookie, 1);
    expect((await call('GET', `/api/line/conversations/${item!.conversationId}`, { cookie: chair.cookie })).json).toMatchObject({ sending: 'none', access: 'read', reply: { available: false } });
    expect(pushes).toHaveLength(0);
  });
});
