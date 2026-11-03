import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { committeeLineState } from '../../src/server/line/committee.js';
import { bearerMatches, DISCORD_LINE_CLIENT, ThreadMap } from '../../src/server/line/discord.js';
import type { FeedRecord } from '../../src/server/line/feed.js';
import { applyHistoryRows, historyArchiveId, LineHistoryImporter, parseHistoryRow } from '../../src/server/line/history.js';
import { MEDIA_TTL_MS, sniffImage } from '../../src/server/line/media.js';
import { MessagingApiConnector, type Fetch } from '../../src/server/line/messaging-api.js';
import { validateLineConfig } from '../../src/server/line/oa-config.js';
import { messagesOf } from '../../src/server/line/queries.js';
import { LineStore } from '../../src/server/line/store.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { signedHeaders } from '../../src/server/tasks/signing.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, ROLE_PLANNING, setup } from '../discord-auth/helpers.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { testMailboxConfig } from './helpers.js';

// Sending from the official LINE account, 2026-11-02: the account's own history file, images, broadcasts and
// replies from Discord threads through the Bot's internal routes. Synthetic IDs, names, keys and tokens only.

const PULL = 'pull-token-synthetic-0001';
const ACCESS = 'access-token-synthetic-0001';
const BOT_KEY = 'bot-key-synthetic-0123456789abcdef';
// A 32-byte key for the signed mode (hex; synthetic).
const SIGNED_KEY_HEX = '00112233445566778899aabbccddeeff0123456789abcdef0123456789abcdef';
const USER_A = `U${'a'.repeat(32)}`;
const USER_B = `U${'b'.repeat(32)}`;
const USER_C = `U${'c'.repeat(32)}`;
const GROUP = `C${'d'.repeat(32)}`;
const PROXY = '10.0.0.5';
const DOC = { version: 1, account: { id: 'oa', name: '合成 公式LINE' }, receiver: { url: 'http://receiver.example.invalid:8788' } };

/** The smallest bytes a JPEG check reads: SOI, a JFIF APP0, a baseline frame header of the given size, EOI. */
function jpeg(width: number, height: number, pad = 0): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.concat([Buffer.from([0xff, 0xd8, ...app0, ...sof]), Buffer.alloc(pad), Buffer.from([0xff, 0xd9])]);
}
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

let seq = 0;
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
    message_id: String(700000 + seq),
    text: `合成のメッセージ ${seq}`,
    ...changes,
  };
}

const historyRow = (key: number, changes: Record<string, unknown> = {}) => ({
  _key: `chatpro:${key.toString(16).padStart(24, '0')}`,
  ts_sec: '2026-07-08T10:58:33+09:00',
  direction: 'in',
  kind: 'text',
  content: '合成の旧履歴の本文',
  chat: '合成商店　合成 太郎',
  user_id: USER_A,
  staff: null,
  auto_reply: false,
  ...changes,
});

// ---- units

describe('line.json additions', () => {
  const cfg = (changes: Record<string, unknown>, discordKey: string | null = null) =>
    validateLineConfig({ ...DOC, send: {}, ...changes }, '/data/mail', { pullToken: PULL, accessToken: ACCESS, discordKey });

  it('reads history, discord and send.publicBaseUrl', () => {
    const c = cfg({ send: { publicBaseUrl: 'https://app.example.invalid/' }, history: { file: '/config/line-history.jsonl' }, discord: { enabled: true, keyFile: '/config/k', threadMapFile: '/config/threads.json' } }, BOT_KEY);
    expect(c.send?.publicBaseUrl).toBe('https://app.example.invalid');
    expect(c.history?.file).toBe(path.resolve('/config/line-history.jsonl'));
    expect(c.discord).toEqual({ auth: { mode: 'bearer', key: BOT_KEY }, threadMapFile: path.resolve('/config/threads.json') });
    expect(c.mediaDir).toBe(path.join('/data/mail', 'line-media'));
    expect(cfg({}).history).toBeNull();
    expect(cfg({}).discord).toBeNull();
    // Without enabled the routes do not exist (no key needed).
    expect(cfg({ discord: { threadMapFile: '/config/threads.json' } }).discord).toBeNull();
    // 2026-11-03: "signed" needs a 32-byte key; "bearer" (the default) takes the first version's key.
    expect(cfg({ send: {}, discord: { enabled: true, keyFile: '/config/k', threadMapFile: '/config/threads.json' } }, BOT_KEY).discord?.auth.mode).toBe('bearer');
    expect(cfg({ send: {}, discord: { enabled: true, keyFile: '/config/k', threadMapFile: '/config/threads.json', auth: 'signed' } }, SIGNED_KEY_HEX).discord?.auth).toMatchObject({ mode: 'signed' });
    expect(() => cfg({ send: {}, discord: { enabled: true, keyFile: '/config/k', threadMapFile: '/config/threads.json', auth: 'signed' } }, BOT_KEY)).toThrow(/32/);
    expect(() => cfg({ send: {}, discord: { enabled: true, keyFile: '/config/k', threadMapFile: '/config/threads.json', auth: 'token' } }, BOT_KEY)).toThrow(/auth/);
  });

  it('refuses an http or query public URL, discord without a key or without send, and unknown keys', () => {
    expect(() => cfg({ send: { publicBaseUrl: 'http://app.example.invalid' } })).toThrow(/publicBaseUrl/);
    expect(() => cfg({ send: { publicBaseUrl: 'https://app.example.invalid/?x=1' } })).toThrow(/publicBaseUrl/);
    expect(() => cfg({ discord: { enabled: true, keyFile: '/k', threadMapFile: '/t' } })).toThrow(/keyFile/);
    expect(() => validateLineConfig({ ...DOC, discord: { enabled: true, keyFile: '/k', threadMapFile: '/t' } }, '/d', { pullToken: PULL, accessToken: null, discordKey: BOT_KEY })).toThrow(/send/);
    expect(() => cfg({ history: { file: '/x', extra: 1 } })).toThrow(/不明な項目/);
    expect(() => cfg({ discord: { enabled: 'yes', threadMapFile: '/t' } })).toThrow(/enabled/);
  });
});

describe('image checks', () => {
  it('reads the type and size from the bytes, never from the name', () => {
    expect(sniffImage(jpeg(2048, 1536))).toEqual({ type: 'image/jpeg', width: 2048, height: 1536 });
    expect(sniffImage(png(800, 600))).toEqual({ type: 'image/png', width: 800, height: 600 });
    // Disguised: HTML, a GIF and an SVG, whatever they are called.
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a\x01\x00\x01\x00'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    // A JPEG start with no frame header before the scan is not accepted either.
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]))).toBeNull();
  });

  it('compares the Bot key in constant time and only as a bearer', () => {
    expect(bearerMatches(`Bearer ${BOT_KEY}`, BOT_KEY)).toBe(true);
    expect(bearerMatches(`Bearer ${BOT_KEY}x`, BOT_KEY)).toBe(false);
    expect(bearerMatches(BOT_KEY, BOT_KEY)).toBe(false);
    expect(bearerMatches(undefined, BOT_KEY)).toBe(false);
  });
});

describe('the Messaging API adapter, images and multicast', () => {
  it('sends the text then the image in one push, and multicasts with its own retry key', async () => {
    const seen: { url: string; body: unknown; key: string | null }[] = [];
    const c = new MessagingApiConnector(ACCESS, 'https://api.example.invalid', async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('x-line-retry-key') });
      return new Response('{}', { status: 200, headers: { 'x-line-request-id': 'req-1' } });
    });
    const image = { originalUrl: 'https://app.example.invalid/line-media/a.jpg', previewUrl: 'https://app.example.invalid/line-media/b.jpg' };
    await c.push({ retryKey: 'k1', accountId: 'oa', to: USER_A, targetType: 'user', text: '合成', image });
    expect(seen[0]!.body).toEqual({ to: USER_A, messages: [{ type: 'text', text: '合成' }, { type: 'image', originalContentUrl: image.originalUrl, previewImageUrl: image.previewUrl }] });
    expect(await c.multicast({ retryKey: 'k2', accountId: 'oa', to: [USER_A, USER_B], text: '一斉' })).toMatchObject({ kind: 'accepted' });
    expect(seen[1]).toEqual({ url: 'https://api.example.invalid/v2/bot/message/multicast', body: { to: [USER_A, USER_B], messages: [{ type: 'text', text: '一斉' }] }, key: 'k2' });
    expect(await c.multicast({ retryKey: 'k3', accountId: 'oa', to: Array.from({ length: 501 }, () => USER_A), text: 'x' })).toMatchObject({ kind: 'rejected' });
    expect(seen).toHaveLength(2);
  });

  it("asks for a user's profile: 200 reachable, 404 not, anything else unknown", async () => {
    const at = (status: number) => new MessagingApiConnector(ACCESS, 'https://api.example.invalid', async () => new Response('{}', { status }));
    expect(await at(200).profileReachable(USER_A)).toBe(true);
    expect(await at(404).profileReachable(USER_A)).toBe(false);
    expect(await at(500).profileReachable(USER_A)).toBeNull();
    expect(await at(200).profileReachable('C' + 'a'.repeat(32))).toBeNull();
    expect(await new MessagingApiConnector(ACCESS, 'https://api.example.invalid', () => Promise.reject(new Error('x'))).profileReachable(USER_A)).toBeNull();
  });
});

describe('the history file (contract A)', () => {
  const cfg = validateLineConfig({ ...DOC, history: { file: '/x.jsonl' } }, '/d', { pullToken: PULL, accessToken: null });

  it('parses only rows of the contract form', () => {
    expect(parseHistoryRow(historyRow(1))).toMatchObject({ key: `chatpro:${'1'.padStart(24, '0')}`, sentAt: '2026-07-08T01:58:33.000Z', direction: 'in', userId: USER_A });
    expect(parseHistoryRow(historyRow(1, { _key: 'other:1' }))).toBeNull();
    expect(parseHistoryRow(historyRow(1, { ts_sec: '2026-07-08 10:58:33' }))).toBeNull();
    expect(parseHistoryRow(historyRow(1, { user_id: 'someone' }))).toBeNull();
    expect(parseHistoryRow(historyRow(1, { direction: 'sideways' }))).toBeNull();
    expect(parseHistoryRow(historyRow(1, { direction: 'out', staff: '合成 花子' }))?.staff).toBe('合成 花子');
  });

  it('puts rows with a user ID in that conversation, the rest in a read-only archive, each key once', () => {
    const state = committeeLineState(null, cfg);
    expect(state.accounts.map((a) => [a.id, a.kind, a.outbound])).toEqual([
      ['oa', 'official_account', 'disabled'],
      [historyArchiveId('oa'), 'legacy_archive', 'disabled'],
    ]);
    const rows = [historyRow(1), historyRow(2, { direction: 'out', staff: '合成 花子', content: '合成の返事' }), historyRow(3, { user_id: null, chat: '合成 結び付かない人' }), historyRow(4, { kind: 'image', content: '[写真]' })];
    const first = applyHistoryRows(state, 'oa', rows, '2026-11-02T00:00:00.000Z');
    expect(first).toMatchObject({ imported: 4, duplicates: 0 });
    const again = applyHistoryRows(state, 'oa', [...rows, { broken: true }], '2026-11-02T00:01:00.000Z');
    expect(again).toMatchObject({ imported: 0, duplicates: 4, rejected: 1 });
    const userConv = state.conversations.find((c) => c.target.kind === 'messaging_api')!;
    expect(userConv).toMatchObject({ accountId: 'oa', title: '合成商店　合成 太郎', target: { type: 'user', id: USER_A } });
    // History never makes anyone sendable.
    expect(userConv.eligibility).toMatchObject({ relation: 'unknown', lastUserMessageAt: null });
    const archive = state.conversations.find((c) => c.target.kind === 'legacy_chat')!;
    expect(archive.accountId).toBe(historyArchiveId('oa'));
    expect(state.messages.find((m) => m.direction === 'outbound_legacy')).toMatchObject({ senderLabel: '合成 花子', history: { staff: '合成 花子', autoReply: false }, provenance: { source: 'oa_history' } });
    expect(state.messages.find((m) => m.externalMessageId.endsWith('4'))?.content).toEqual({ kind: 'unsupported', mediaType: 'image' });
  });

  it('hides a history row the webhook already shows (same text, within 2 minutes), not one further apart', () => {
    const state = committeeLineState(null, cfg);
    applyHistoryRows(state, 'oa', [historyRow(1, { ts_sec: '2026-10-30T10:00:00+09:00', content: '同じ本文' }), historyRow(2, { ts_sec: '2026-10-30T10:10:00+09:00', content: '同じ本文' })], '2026-11-02T00:00:00.000Z');
    const conv = state.conversations[0]!;
    state.messages.push({
      id: 'lm_feed000000000001',
      accountId: 'oa',
      conversationId: conv.id,
      externalMessageId: '1',
      direction: 'inbound',
      senderLabel: '合成 太郎さん',
      sentAt: '2026-10-30T01:01:30.000Z',
      importedAt: '2026-10-30T01:02:00.000Z',
      content: { kind: 'text', text: '同じ本文' },
      fingerprint: 'x',
      provenance: { source: 'event_feed', batchId: 'b', cursor: 'c' },
    });
    const shown = messagesOf(state, conv);
    expect(shown.map((m) => [m.provenance.source, m.sentAt])).toEqual([
      ['event_feed', '2026-10-30T01:01:30.000Z'],
      ['oa_history', '2026-10-30T01:10:00.000Z'],
    ]);
  });

  it('reads the file again only when it changed', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'iyakusai-line-history-'));
    try {
      const file = path.join(d, 'h.jsonl');
      writeFileSync(file, `${JSON.stringify(historyRow(1))}\n`);
      const store = new LineStore(committeeLineState(null, cfg), null);
      const importer = new LineHistoryImporter({ store, accountId: 'oa', file, pollSeconds: 30 });
      importer.poll();
      expect(store.current.messages).toHaveLength(1);
      const spy = vi.spyOn(store, 'transact');
      importer.poll();
      expect(spy).not.toHaveBeenCalled();
      writeFileSync(file, `${JSON.stringify(historyRow(1))}\n${JSON.stringify(historyRow(2))}\n`);
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      importer.poll();
      expect(store.current.messages).toHaveLength(2);
      expect(importer.status.lastReport).toMatchObject({ imported: 1, duplicates: 1 });
      rmSync(file);
      importer.poll();
      expect(importer.status.lastError).toMatch(/見つかりません/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('reads the thread map (contract B) and re-reads it when it changes', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'iyakusai-line-threads-'));
    try {
      const file = path.join(d, 'threads.json');
      const map = new ThreadMap(file);
      expect(map.lookup('123')).toBeNull();
      writeFileSync(file, JSON.stringify({ version: 1, generatedAt: '2026-11-02T22:00:00+09:00', threads: { '123': { sourceType: 'user', sourceId: USER_A, orgId: 'oa_x', orgName: '合成商店' }, '124': { sourceType: 'user', sourceId: 'bad' } } }));
      expect(map.lookup('123')).toEqual({ target: { kind: 'messaging_api', type: 'user', id: USER_A }, orgName: '合成商店' });
      expect(map.lookup('124')).toBeNull();
      writeFileSync(file, '{broken');
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      expect(map.lookup('123')).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---- the routes, in the committee mailbox

const ORIGIN = `http://${TEST_HOST}`;
let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
let records: FeedRecord[];
let pushes: { to: string; messages: { type: string; text?: string; originalContentUrl?: string; previewImageUrl?: string }[]; retryKey: string | null }[];
let multicasts: { to: string[]; messages: { type: string; text?: string; originalContentUrl?: string }[]; retryKey: string | null }[];
let lineUsed: number;
/** LINE's answer to a profile request, per user (default 200), and who was asked. */
let profiles: Record<string, number>;
let profileAsked: string[];

const network: Fetch = async (input, init) => {
  const url = new URL(input);
  if (url.host === 'receiver.example.invalid:8788') {
    const after = url.searchParams.get('after') ?? '';
    const rows = records.filter((r) => String(r._key) > after).sort((a, b) => String(a._key).localeCompare(String(b._key)));
    return new Response(rows.map((r) => JSON.stringify(r)).join('\n'), { status: 200 });
  }
  if (new Headers(init.headers).get('authorization') !== `Bearer ${ACCESS}`) return new Response('{}', { status: 401 });
  if (url.pathname === '/v2/bot/message/push') {
    const body = JSON.parse(String(init.body)) as { to: string; messages: never[] };
    pushes.push({ to: body.to, messages: body.messages, retryKey: new Headers(init.headers).get('x-line-retry-key') });
    return new Response('{}', { status: 200, headers: { 'x-line-request-id': `req-${pushes.length}` } });
  }
  if (url.pathname === '/v2/bot/message/multicast') {
    const body = JSON.parse(String(init.body)) as { to: string[]; messages: never[] };
    multicasts.push({ to: body.to, messages: body.messages, retryKey: new Headers(init.headers).get('x-line-retry-key') });
    return new Response('{}', { status: 200, headers: { 'x-line-request-id': `mreq-${multicasts.length}` } });
  }
  if (url.pathname.startsWith('/v2/bot/profile/')) {
    const id = url.pathname.slice('/v2/bot/profile/'.length);
    profileAsked.push(id);
    return new Response('{}', { status: profiles[id] ?? 200 });
  }
  if (url.pathname === '/v2/bot/message/quota') return Response.json({ type: 'limited', value: 200 });
  if (url.pathname === '/v2/bot/message/quota/consumption') return Response.json({ totalUsage: lineUsed });
  return new Response('{}', { status: 404 });
};

interface BuildOptions {
  send?: Record<string, unknown>;
  history?: boolean;
  discord?: boolean;
  discordAuth?: 'bearer' | 'signed';
  publicOrigin?: string;
}

async function build(o: BuildOptions = {}) {
  const config = testMailboxConfig(path.join(dir, 'mail'));
  mkdirSync(config.dataDir, { recursive: true });
  config.line = validateLineConfig(
    {
      ...DOC,
      send: { apiBase: 'https://api.example.invalid', ...o.send },
      ...(o.history ? { history: { file: path.join(dir, 'history.jsonl') } } : {}),
      ...(o.discord ? { discord: { enabled: true, keyFile: path.join(dir, 'bot.key'), threadMapFile: path.join(dir, 'threads.json'), ...(o.discordAuth ? { auth: o.discordAuth } : {}) } } : {}),
    },
    config.dataDir,
    { pullToken: PULL, accessToken: ACCESS, discordKey: o.discord ? (o.discordAuth === 'signed' ? SIGNED_KEY_HEX : BOT_KEY) : null },
  );
  mail = new MailboxStore(config.dataDir);
  const seed = await seedState();
  const publicOrigin = o.publicOrigin ?? 'https://app.example.invalid';
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin, publicHost: new URL(publicOrigin).host, trustedProxies: new Set([PROXY]) },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set([PROXY]) },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases), lineFetch: network },
  });
  return config;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-line-send-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup();
  pushes = [];
  multicasts = [];
  lineUsed = 0;
  records = [];
  profiles = {};
  profileAsked = [];
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

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
  let json: Json = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  return { status: res.statusCode, json, headers: res.headers, raw: res.rawPayload };
}

/** The Bot's call over the internal network (or, with `remote`, through the proxy). */
interface SignedCall {
  nonce?: string;
  now?: number;
  path?: string;
  key?: string;
}

/** svc-auth/v1 headers of the signed mode (2026-11-03), over the path and the bytes of the body like the Bot host's other calls. */
function signedCall(url: string, payload: string, o: SignedCall): Record<string, string> {
  const key = Buffer.from(o.key ?? SIGNED_KEY_HEX, 'hex');
  const input = { client: DISCORD_LINE_CLIENT, method: 'POST', path: o.path ?? url, body: payload, actor: '', now: o.now ?? ctx.clock.now };
  const headers = signedHeaders(key, input);
  if (o.nonce) {
    // A chosen nonce (to replay it): sign again with that nonce.
    const canonical = ['svc-auth/v1', input.client, 'POST', input.path, headers['x-svc-timestamp'], o.nonce, '', createHash('sha256').update(payload, 'utf8').digest('hex')].join('\n');
    headers['x-svc-nonce'] = o.nonce;
    headers['x-svc-signature'] = createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
  }
  return headers;
}

async function bot(url: string, body: unknown, options: { key?: string | null; remote?: string; signed?: SignedCall } = {}) {
  const key = options.key === undefined ? BOT_KEY : options.key;
  const payload = JSON.stringify(body);
  const res = await app.inject({
    method: 'POST',
    url,
    remoteAddress: options.remote ?? '172.18.0.4',
    headers: { host: 'iyakusai-app:8080', 'content-type': 'application/json', ...(key && !options.signed ? { authorization: `Bearer ${key}` } : {}), ...(options.signed ? signedCall(url, payload, options.signed) : {}) },
    payload,
  });
  return { status: res.statusCode, json: res.json() as Json };
}

async function upload(cookie: string, files: { original?: Buffer; preview?: Buffer }, accountId = 'oa') {
  const boundary = '----synthetic-boundary-0001';
  const parts: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="accountId"\r\n\r\n${accountId}\r\n`)];
  for (const [name, buf] of Object.entries(files)) {
    // Declared as JPEG whatever the bytes are: the server looks at the bytes.
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), buf!, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const res = await app.inject({
    method: 'POST',
    url: '/api/line/media',
    headers: { host: TEST_HOST, origin: ORIGIN, 'x-smm-csrf': '1', cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  });
  return { status: res.statusCode, json: res.json() as Json };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

async function signIn(uid: string, studentId: string, roles: string[] = []) {
  const { initialLoginId } = await register(ctx, uid, studentId, roles);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: TEST_HOST, origin: ORIGIN, 'x-smm-csrf': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ loginId: studentId, password: PASSWORD }) });
  expect(res.statusCode).toBe(200);
  return { cookie: cookieOf(res.headers['set-cookie']), id: initialLoginId };
}

async function lineItems(cookie: string, count: number, accountId?: string) {
  return vi.waitFor(
    async () => {
      const items = (await call('GET', `/api/inbox?source=line${accountId ? `&lineAccountId=${accountId}` : ''}`, { cookie })).json.items as { conversationId: string; title: string; targetType: string }[];
      expect(items).toHaveLength(count);
      return items;
    },
    { timeout: 4000, interval: 100 },
  );
}

const grantSend = (chair: { cookie: string }, userId: string) => call('PUT', '/api/line/admin/access', { cookie: chair.cookie, body: { userId, mailboxId: 'oa', send: true } });

async function reply(cookie: string, conversationId: string, text: string, imageId: string | null = null) {
  const draft = await call('PUT', `/api/line/conversations/${conversationId}/reply/draft`, { cookie, body: { body: text, expectedVersion: null, imageId } });
  if (draft.status !== 200) return { draft, preview: null, sent: null };
  const preview = await call('POST', `/api/line/conversations/${conversationId}/reply/preview`, { cookie, body: { draftId: draft.json.id, draftVersion: draft.json.version } });
  if (preview.status !== 200) return { draft, preview, sent: null };
  const sent = await call('POST', `/api/line/conversations/${conversationId}/reply/send`, {
    cookie,
    body: { consentId: preview.json.consentId, operationId: crypto.randomUUID(), draftId: draft.json.id, draftVersion: draft.json.version, body: preview.json.body },
  });
  return { draft, preview, sent };
}

describe('history in the committee inbox', () => {
  it('shows history rows marked as such, with the sending member, in the person\'s conversation and a read-only archive', async () => {
    const now = ctx.clock.now;
    writeFileSync(
      path.join(dir, 'history.jsonl'),
      [historyRow(1, { content: '旧履歴の問い合わせ' }), historyRow(2, { direction: 'out', staff: '合成 花子', content: '旧履歴の返事', ts_sec: '2026-07-08T11:05:00+09:00' }), historyRow(3, { user_id: null, chat: '合成 結び付かない人' })].map((r) => JSON.stringify(r)).join('\n'),
    );
    records = [record(now, 600, { event_type: 'follow', message_type: undefined, message_id: undefined })];
    await build({ history: true });
    const chair = await signIn(CHAIR, '21000001');
    await grantSend(chair, chair.id);
    const items = await lineItems(chair.cookie, 2);
    const accounts = (await call('GET', '/api/line/accounts', { cookie: chair.cookie })).json as { id: string; kind: string; canReply: boolean; sending: string }[];
    expect(accounts.map((a) => [a.id, a.kind, a.sending])).toEqual([
      ['oa', 'official_account', 'live'],
      [historyArchiveId('oa'), 'legacy_archive', 'none'],
    ]);
    const person = items.find((i) => i.targetType === 'user')!;
    // The follow event comes through the receiver a moment after the history file was read.
    const detail = await vi.waitFor(
      async () => {
        const d = (await call('GET', `/api/line/conversations/${person.conversationId}`, { cookie: chair.cookie })).json;
        expect(d.reply.available).toBe(true);
        return d;
      },
      { timeout: 4000, interval: 100 },
    );
    expect(detail.messages).toEqual([
      expect.objectContaining({ provenance: 'oa_history', direction: 'inbound', content: { kind: 'text', text: '旧履歴の問い合わせ' } }),
      expect.objectContaining({ provenance: 'oa_history', direction: 'outbound_legacy', history: { staff: '合成 花子', autoReply: false } }),
    ]);
    // The conversation itself can still be replied to (the person followed the account).
    expect(detail.reply).toMatchObject({ available: true });
    const archive = items.find((i) => i.targetType === 'legacy_chat')!;
    expect((await call('GET', `/api/line/conversations/${archive.conversationId}`, { cookie: chair.cookie })).json.reply).toMatchObject({ available: false });
    expect((await call('PUT', `/api/line/conversations/${archive.conversationId}/reply/draft`, { cookie: chair.cookie, body: { body: 'x', expectedVersion: null } })).status).toBe(403);
  });
});

describe('images', () => {
  async function ready(o: BuildOptions = {}) {
    const now = ctx.clock.now;
    records = [record(now, 600)];
    const config = await build(o);
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002', [ROLE_PLANNING]);
    await grantSend(chair, chair.id);
    const [item] = await lineItems(chair.cookie, 1);
    return { chair, member, conversationId: item!.conversationId, config };
  }

  it('takes JPEG/PNG checked by their bytes from senders only, and serves them without sign-in for 7 days', async () => {
    const { chair, member, conversationId, config } = await ready({ send: { publicBaseUrl: 'https://media.example.invalid' } });
    // Not a sender: refused before anything is kept.
    expect((await upload(member.cookie, { original: jpeg(1600, 1200), preview: jpeg(800, 600) })).status).toBe(403);
    // Disguised: called .jpg and declared image/jpeg, but HTML inside.
    const fake = await upload(chair.cookie, { original: Buffer.from('<html><body>not an image</body></html>'), preview: jpeg(800, 600) });
    expect(fake.status).toBe(422);
    expect(fake.json.message).toMatch(/JPEG か PNG/);
    expect((await upload(chair.cookie, { original: jpeg(1600, 1200), preview: jpeg(1600, 1200) })).json.message).toMatch(/1024 px/);
    expect((await upload(chair.cookie, { original: jpeg(1600, 1200), preview: jpeg(800, 600, 1024 * 1024) })).json.message).toMatch(/1 MB/);
    expect(existsSync(config.line!.mediaDir) ? readdirSync(config.line!.mediaDir) : []).toEqual([]);

    const up = await upload(chair.cookie, { original: jpeg(1600, 1200), preview: png(800, 600) });
    expect(up.status).toBe(201);
    expect(up.json.previewUrl).toMatch(/^\/line-media\/[0-9a-f]{64}\.png$/);

    // Public, typed by the checked bytes, no sign-in, cacheable.
    const got = await app.inject({ method: 'GET', url: up.json.previewUrl, headers: { host: TEST_HOST } });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['cache-control']).toMatch(/^public, max-age=86400/);
    expect(got.rawPayload.equals(png(800, 600))).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/line-media/${'0'.repeat(64)}.jpg`, headers: { host: TEST_HOST } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/line-media/..%2Fline-state.json', headers: { host: TEST_HOST } })).statusCode).toBe(404);

    // A reply with the image: one push, the text then the image, at the configured public URL.
    const sent = await reply(chair.cookie, conversationId, '合成の返信と画像', up.json.id);
    expect(sent.preview?.json.image).toEqual({ previewUrl: up.json.previewUrl });
    expect(sent.sent?.json.outbox).toMatchObject({ status: 'accepted', image: { previewUrl: up.json.previewUrl } });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.messages).toEqual([
      { type: 'text', text: '合成の返信と画像' },
      { type: 'image', originalContentUrl: expect.stringMatching(/^https:\/\/media\.example\.invalid\/line-media\/[0-9a-f]{64}\.jpg$/), previewImageUrl: `https://media.example.invalid${up.json.previewUrl}` },
    ]);
    // One message per recipient, image or not.
    expect((await call('GET', '/api/line/admin/access', { cookie: chair.cookie })).status).toBe(200);

    // Someone else's image cannot be attached.
    await grantSend(chair, member.id);
    expect((await call('PUT', `/api/line/conversations/${conversationId}/reply/draft`, { cookie: member.cookie, body: { body: 'x', expectedVersion: null, imageId: up.json.id } })).status).toBe(404);

    // After 7 days: not served, and the files are gone.
    ctx.clock.now += MEDIA_TTL_MS + 1000;
    expect((await app.inject({ method: 'GET', url: up.json.previewUrl, headers: { host: TEST_HOST } })).statusCode).toBe(404);
    expect(readdirSync(config.line!.mediaDir)).toEqual([]);
  });

  it('refuses an expired image at confirmation', async () => {
    const { chair, conversationId } = await ready();
    const up = await upload(chair.cookie, { original: jpeg(1000, 800), preview: jpeg(500, 400) });
    const draft = await call('PUT', `/api/line/conversations/${conversationId}/reply/draft`, { cookie: chair.cookie, body: { body: '合成', expectedVersion: null, imageId: up.json.id } });
    expect(draft.status).toBe(200);
    ctx.clock.now += MEDIA_TTL_MS;
    // A new sign-in: the old session may have run out while the clock moved a week.
    const again = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: TEST_HOST, origin: ORIGIN, 'x-smm-csrf': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ loginId: '21000001', password: PASSWORD }) });
    const cookie = cookieOf(again.headers['set-cookie']);
    const preview = await call('POST', `/api/line/conversations/${conversationId}/reply/preview`, { cookie, body: { draftId: draft.json.id, draftVersion: 1 } });
    expect(preview.status).toBe(422);
    expect(preview.json.message).toMatch(/7 日/);
    expect(pushes).toHaveLength(0);
  });

  it('has no image route without an https public address', async () => {
    const { chair, conversationId } = await ready({ publicOrigin: 'http://app.example.invalid' });
    // No such route (Fastify answers 415 to a multipart body it has no parser for, 404 otherwise).
    expect([404, 415]).toContain((await upload(chair.cookie, { original: jpeg(100, 100), preview: jpeg(100, 100) })).status);
    const detail = (await call('GET', `/api/line/conversations/${conversationId}`, { cookie: chair.cookie })).json;
    expect(detail.reply.imagesEnabled).toBe(false);
    expect((await call('PUT', `/api/line/conversations/${conversationId}/reply/draft`, { cookie: chair.cookie, body: { body: 'x', expectedVersion: null, imageId: 'lmd_0000000000000000' } })).json.message).toMatch(/画像を送れません/);
  });
});

describe('a user not confirmed as a friend', () => {
  it('can be replied to with a notice; LINE is asked about the profile first, and no profile closes the reply', async () => {
    const now = ctx.clock.now;
    // Messaged 8 days ago and no follow event: a friend from before the receiver ran, or not.
    records = [record(now, 8 * 86_400), record(now, 600, { user_id: USER_B, display_name: '合成 花子さん' })];
    await build();
    const chair = await signIn(CHAIR, '21000001');
    await grantSend(chair, chair.id);
    const items = await lineItems(chair.cookie, 2);
    const old = items.find((i) => i.title === '合成 太郎さん')!.conversationId;
    const recent = items.find((i) => i.title === '合成 花子さん')!.conversationId;

    expect((await call('GET', `/api/line/conversations/${old}`, { cookie: chair.cookie })).json.reply.available).toBe(true);
    const first = await reply(chair.cookie, old, '合成の返信');
    expect(first.preview!.json.notices[0]).toContain('友だちかどうかは確かめられません');
    expect(first.sent!.status).toBe(200);
    expect(profileAsked).toEqual([USER_A]);
    // A recent sender is not asked and gets no notice.
    const second = await reply(chair.cookie, recent, '合成の返信');
    expect(second.preview!.json.notices.join()).not.toContain('友だちかどうか');
    expect(profileAsked).toEqual([USER_A]);

    // LINE returns no profile (blocked or deleted): refused, and the reply closes.
    profiles[USER_A] = 404;
    const third = await reply(chair.cookie, old, '届かない返信');
    expect(third.preview!.status).toBe(422);
    expect(third.preview!.json.message).toContain('プロフィールを返さなかった');
    expect((await call('GET', `/api/line/conversations/${old}`, { cookie: chair.cookie })).json.reply).toMatchObject({ available: false, reason: expect.stringContaining('プロフィール') });
    expect(pushes.map((x) => x.to)).toEqual([USER_A, USER_B]);
  });
});

describe('broadcast', () => {
  async function ready(send: Record<string, unknown> = {}) {
    const now = ctx.clock.now;
    records = [
      record(now, 700),
      record(now, 650, { user_id: USER_B, display_name: '合成 花子さん' }),
      record(now, 600, { user_id: USER_C, display_name: '合成 次郎さん' }),
      record(now, 590, { user_id: USER_C, display_name: '合成 次郎さん', event_type: 'unfollow', message_type: undefined, message_id: undefined }),
      record(now, 550, { source_type: 'group', group_id: GROUP }),
    ];
    await build({ send: { allowGroups: true, ...send } });
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002', [ROLE_PLANNING]);
    await grantSend(chair, chair.id);
    const items = await lineItems(chair.cookie, 4);
    return { chair, member, items };
  }

  it('lists 1:1 conversations that have not unfollowed, needs the send grant, and sends one multicast with a record per person', async () => {
    const { chair, member, items } = await ready();
    expect((await call('GET', '/api/line/accounts/oa/broadcast', { cookie: member.cookie })).status).toBe(403);
    const options = (await call('GET', '/api/line/accounts/oa/broadcast', { cookie: chair.cookie })).json;
    expect(options.recipients.map((r: Json) => r.title).sort()).toEqual(['合成 太郎さん', '合成 花子さん']);
    expect(JSON.stringify(options)).not.toContain(USER_A);
    expect(options).toMatchObject({ monthUsed: 0, monthlyLimit: 200, imagesEnabled: true, mock: false });

    const unfollowed = items.find((i) => i.title === '合成 次郎さん')!;
    expect((await call('POST', '/api/line/accounts/oa/broadcast/preview', { cookie: chair.cookie, body: { recipients: [unfollowed.conversationId], body: 'x', imageId: null } })).status).toBe(422);
    expect((await call('POST', '/api/line/accounts/oa/broadcast/preview', { cookie: member.cookie, body: { recipients: 'all', body: 'x', imageId: null } })).status).toBe(403);

    lineUsed = 40;
    const preview = await call('POST', '/api/line/accounts/oa/broadcast/preview', { cookie: chair.cookie, body: { recipients: 'all', body: '合成の一斉連絡', imageId: null } });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ count: 2, monthUsed: 0, monthlyLimit: 200, lineUsage: 40, lineLimit: 200 });
    expect(preview.json.notices.join('\n')).toMatch(/取り消すことはできません/);
    // Another person cannot use this confirmation.
    await grantSend(chair, member.id);
    expect((await call('POST', '/api/line/broadcast/send', { cookie: member.cookie, body: { consentId: preview.json.consentId, operationId: crypto.randomUUID(), body: '合成の一斉連絡' } })).status).toBe(409);

    const sent = await call('POST', '/api/line/broadcast/send', { cookie: chair.cookie, body: { consentId: preview.json.consentId, operationId: crypto.randomUUID(), body: '合成の一斉連絡' } });
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ count: 2, statuses: { accepted: 2 } });
    expect(multicasts).toHaveLength(1);
    expect(multicasts[0]!.to.sort()).toEqual([USER_A, USER_B].sort());
    expect(multicasts[0]!.retryKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(pushes).toHaveLength(0);

    for (const title of ['合成 太郎さん', '合成 花子さん']) {
      const c = items.find((i) => i.title === title)!;
      const detail = (await call('GET', `/api/line/conversations/${c.conversationId}`, { cookie: chair.cookie })).json;
      expect(detail.outbox).toHaveLength(1);
      expect(detail.outbox[0]).toMatchObject({ status: 'accepted', billableRecipients: 1, broadcastId: sent.json.broadcastId, retryable: false });
    }
    // The month now counts two.
    expect((await call('GET', '/api/line/accounts/oa/broadcast', { cookie: chair.cookie })).json.monthUsed).toBe(2);
    // Used once only.
    expect((await call('POST', '/api/line/broadcast/send', { cookie: chair.cookie, body: { consentId: preview.json.consentId, operationId: crypto.randomUUID(), body: '合成の一斉連絡' } })).status).toBe(409);
    expect(multicasts).toHaveLength(1);
  });

  it('stops at the monthly limits (the app\'s and LINE\'s) and when the confirmation has expired', async () => {
    const { chair } = await ready({ monthlyLimit: 1 });
    const over = await call('POST', '/api/line/accounts/oa/broadcast/preview', { cookie: chair.cookie, body: { recipients: 'all', body: 'x', imageId: null } });
    expect(over.status).toBe(422);
    expect(over.json.message).toMatch(/上限（1 通）/);
    await app.close();
    mail.close();

    ctx = setup();
    const again = await ready();
    lineUsed = 199;
    const line = await call('POST', '/api/line/accounts/oa/broadcast/preview', { cookie: again.chair.cookie, body: { recipients: 'all', body: 'x', imageId: null } });
    expect(line.status).toBe(422);
    expect(line.json.message).toMatch(/LINE 側の今月の通数の上限/);
    lineUsed = 10;
    const ok = await call('POST', '/api/line/accounts/oa/broadcast/preview', { cookie: again.chair.cookie, body: { recipients: 'all', body: 'x', imageId: null } });
    expect(ok.status).toBe(200);
    ctx.clock.now += 5 * 60 * 1000 + 1;
    expect((await call('POST', '/api/line/broadcast/send', { cookie: again.chair.cookie, body: { consentId: ok.json.consentId, operationId: crypto.randomUUID(), body: 'x' } })).status).toBe(409);
    expect(multicasts).toHaveLength(0);
  });

  it('refuses a one-person retry of a broadcast', async () => {
    const { chair, items } = await ready();
    const preview = await call('POST', '/api/line/accounts/oa/broadcast/preview', { cookie: chair.cookie, body: { recipients: [items.find((i) => i.title === '合成 太郎さん')!.conversationId], body: 'x', imageId: null } });
    const sent = await call('POST', '/api/line/broadcast/send', { cookie: chair.cookie, body: { consentId: preview.json.consentId, operationId: crypto.randomUUID(), body: 'x' } });
    const c = items.find((i) => i.title === '合成 太郎さん')!;
    const outbox = (await call('GET', `/api/line/conversations/${c.conversationId}`, { cookie: chair.cookie })).json.outbox[0];
    expect(outbox.broadcastId).toBe(sent.json.broadcastId);
    const retry = await call('POST', `/api/line/outbox/${outbox.id}/retry`, { cookie: chair.cookie, body: { expectedAttempts: 1 } });
    expect(retry.status).toBe(409);
  });
});

describe('replies from Discord (contract C)', () => {
  const THREAD = '1300000000000000001';
  const writeThreads = (threads: Record<string, unknown>) => writeFileSync(path.join(dir, 'threads.json'), JSON.stringify({ version: 1, generatedAt: '2026-11-02T22:00:00+09:00', threads }));

  async function ready(send: Record<string, unknown> = {}) {
    const now = ctx.clock.now;
    records = [record(now, 600)];
    writeThreads({ [THREAD]: { sourceType: 'user', sourceId: USER_A, orgId: 'oa_synthetic_1', orgName: '合成商店' } });
    await build({ discord: true, send });
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002', [ROLE_PLANNING]);
    const other = await signIn(OTHER, '21000003', [ROLE_GENERAL_AFFAIRS]);
    await lineItems(chair.cookie, 1);
    return { chair, member, other };
  }

  it('answers 401 without the key, and 404 through the proxy whatever it carries', async () => {
    await ready();
    const body = { threadId: THREAD, discordUserId: CHAIR, text: '合成' };
    expect(await bot('/internal/line/discord/preview', body, { key: null })).toMatchObject({ status: 401, json: { ok: false, code: 'unauthorized' } });
    expect((await bot('/internal/line/discord/preview', body, { key: 'wrong-key-synthetic-00000000' })).status).toBe(401);
    expect((await bot('/internal/line/discord/preview', body, { remote: PROXY })).status).toBe(404);
    expect((await bot('/internal/line/discord/%70review', body, { remote: PROXY })).status).toBe(404);
    expect((await bot('/internal/line/discord/send', { consentId: 'x', discordUserId: CHAIR }, { remote: PROXY })).status).toBe(404);
    expect(pushes).toHaveLength(0);
  });

  it('with "signed", takes only a fresh svc-auth/v1 signature: no bearer key, no replay, no other path or time', async () => {
    const now = ctx.clock.now;
    records = [record(now, 600)];
    writeThreads({ [THREAD]: { sourceType: 'user', sourceId: USER_A, orgId: 'oa_synthetic_1', orgName: '合成商店' } });
    await build({ discord: true, discordAuth: 'signed' });
    const chair = await signIn(CHAIR, '21000001');
    await lineItems(chair.cookie, 1);
    // An unknown thread answers 404 only after the caller proved itself: it is the proof that the signature passed.
    const body = { threadId: '999', discordUserId: CHAIR, text: '合成' };
    expect((await bot('/internal/line/discord/preview', body, { key: SIGNED_KEY_HEX })).status).toBe(401);
    expect(await bot('/internal/line/discord/preview', body, { signed: { nonce: 'synthetic-nonce-0000000000000001' } })).toMatchObject({ status: 404, json: { code: 'unknown_thread' } });
    expect((await bot('/internal/line/discord/preview', body, { signed: { nonce: 'synthetic-nonce-0000000000000001' } })).status).toBe(401);
    expect((await bot('/internal/line/discord/preview', body, { signed: { now: now - 31_000 } })).status).toBe(401);
    expect((await bot('/internal/line/discord/preview', body, { signed: { path: '/internal/line/discord/send' } })).status).toBe(401);
    expect((await bot('/internal/line/discord/preview', body, { signed: { key: '00112233445566778899aabbccddeeff0123456789abcdef0123456789abcdee' } })).status).toBe(401);
    expect((await bot('/internal/line/discord/preview', body, { signed: {}, remote: PROXY })).status).toBe(404);
    expect(await bot('/internal/line/discord/preview', body, { signed: {} })).toMatchObject({ status: 404, json: { code: 'unknown_thread' } });
    expect(pushes).toHaveLength(0);
  });

  it('confirms and sends as the screen does: the member, the grant, the limits, the person only', async () => {
    const { chair, member, other } = await ready();
    expect(await bot('/internal/line/discord/preview', { threadId: '999', discordUserId: CHAIR, text: '合成' })).toMatchObject({ status: 404, json: { code: 'unknown_thread' } });
    expect(await bot('/internal/line/discord/preview', { threadId: THREAD, discordUserId: '1000000000000009999', text: '合成' })).toMatchObject({ status: 403, json: { code: 'unknown_member' } });
    expect(await bot('/internal/line/discord/preview', { threadId: THREAD, discordUserId: MEMBER, text: '合成' })).toMatchObject({ status: 403, json: { code: 'forbidden' } });
    await grantSend(chair, member.id);
    await grantSend(chair, other.id);
    expect(await bot('/internal/line/discord/preview', { threadId: THREAD, discordUserId: MEMBER, text: '   ' })).toMatchObject({ status: 400, json: { code: 'invalid' } });

    // The member's draft on the screen is not touched by a draft from Discord.
    const items = await lineItems(member.cookie, 1);
    await call('PUT', `/api/line/conversations/${items[0]!.conversationId}/reply/draft`, { cookie: member.cookie, body: { body: '画面の下書き', expectedVersion: null } });

    lineUsed = 40;
    const preview = await bot('/internal/line/discord/preview', { threadId: THREAD, discordUserId: MEMBER, text: '合成の Discord からの返信' });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ ok: true, orgName: '合成商店', recipients: 1, monthUsed: 0, monthlyLimit: 200, lineUsage: 40, lineLimit: 200 });
    expect(preview.json.consentId).toMatch(/^[A-Za-z0-9._~-]{1,64}$/);
    expect(preview.json.message).toBe('合成商店 に 1 通送ります（今月このアプリから 0/200 通、LINE 全体 40/200 通）。');

    expect(await bot('/internal/line/discord/send', { consentId: preview.json.consentId, discordUserId: OTHER })).toMatchObject({ status: 403, json: { code: 'forbidden' } });
    const sent = await bot('/internal/line/discord/send', { consentId: preview.json.consentId, discordUserId: MEMBER });
    expect(sent).toMatchObject({ status: 200, json: { ok: true, status: 'accepted', statusLabel: '受付済み', message: '合成商店 に送りました（LINE が受け付けました。届いた・読まれたの意味ではありません）。' } });
    expect(pushes).toEqual([{ to: USER_A, messages: [{ type: 'text', text: '合成の Discord からの返信' }], retryKey: expect.any(String) }]);
    expect(await bot('/internal/line/discord/send', { consentId: preview.json.consentId, discordUserId: MEMBER })).toMatchObject({ status: 409, json: { code: 'expired' } });

    const detail = (await call('GET', `/api/line/conversations/${items[0]!.conversationId}`, { cookie: member.cookie })).json;
    expect(detail.outbox[0]).toMatchObject({ actorName: '合成 太郎', via: 'discord', status: 'accepted' });
    expect(detail.reply.draft).toMatchObject({ body: '画面の下書き' });
    expect(pushes).toHaveLength(1);
  });

  it('refuses an expired confirmation and the monthly limit with the contract codes', async () => {
    const { chair } = await ready({ monthlyLimit: 1 });
    await grantSend(chair, chair.id);
    const preview = await bot('/internal/line/discord/preview', { threadId: THREAD, discordUserId: CHAIR, text: '合成 1' });
    expect(preview.status).toBe(200);
    ctx.clock.now += 5 * 60 * 1000 + 1;
    expect(await bot('/internal/line/discord/send', { consentId: preview.json.consentId, discordUserId: CHAIR })).toMatchObject({ status: 409, json: { code: 'expired' } });
    const second = await bot('/internal/line/discord/preview', { threadId: THREAD, discordUserId: CHAIR, text: '合成 2' });
    expect((await bot('/internal/line/discord/send', { consentId: second.json.consentId, discordUserId: CHAIR })).json.status).toBe('accepted');
    expect(await bot('/internal/line/discord/preview', { threadId: THREAD, discordUserId: CHAIR, text: '合成 3' })).toMatchObject({ status: 422, json: { code: 'quota' } });
    expect(pushes).toHaveLength(1);
  });

  it('has no internal routes without discord in line.json', async () => {
    records = [record(ctx.clock.now, 600)];
    await build({});
    expect((await bot('/internal/line/discord/preview', { threadId: THREAD, discordUserId: CHAIR, text: '合成' })).status).toBe(404);
  });
});
