import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { BOT_DATASOURCE_PATH, MAX_MESSAGES } from '../../src/server/datasource/bot-datasource.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { SIGN_IN_MAIL_SUBJECT } from '../../src/server/mailbox/restricted.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { parseTaskBridge, SYNTHETIC_TASK_BRIDGE_JSON } from '../../src/server/tasks/bridge.js';
import { TaskServiceClient } from '../../src/server/tasks/client.js';
import { emptyLinkState, TaskLinkStore } from '../../src/server/tasks/links.js';
import { canonicalString, signRequest, verifySignature, type SignatureInput } from '../../src/server/tasks/signing.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { CHAIR, MEMBER, OTHER, register, ROLE_GENERAL_AFFAIRS, setup } from '../discord-auth/helpers.js';
import { ADM, COLLECTOR, CONTACT, ingest, OUTSIDE, rawMail, SPONSOR, testMailboxConfig } from '../mailbox/helpers.js';
import { ACTOR, BLUE, demoStore, metadata, RED } from '../rental/helpers.js';

// POST /v1/bot/datasource (../docs/contracts/bot-datasource.md): the signed, read-only view the Bot reads
// to answer /ask. Synthetic people, mail and items only.

const BODY = '{"sources":["rental","mailbox"]}';
const CLIENT = 'iyakusai-bot-datasource';
// The Bot's key in these tests: the 32 bytes 0x01..0x20 (also the key of the fixed vector below).
const BOT_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const MAIL_AT = { first: '2026-10-13T01:00:00.000Z', second: '2026-10-13T02:00:00.000Z', third: '2026-10-13T03:00:00.000Z' };
// Marks in the synthetic data that must never reach the Bot.
const BODY_MARK = 'BODY-SECRET-MARK';
const HTML_MARK = 'HTML-SECRET-MARK';
const FILE_MARK = 'secret-estimate.pdf';
const CC = 'cc-person@partner.example';
const NAMELESS = 'noname@partner.example';
const NAME_IS_ADDRESS = 'info@partner.example';
const STUDENT_IDS = { chair: '21111111', member: '21222222', other: '21333333' };

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let rental: ReturnType<typeof demoStore>;
let links: TaskLinkStore;
let ingestKey: Buffer;
let apps: FastifyInstance[];
let app: FastifyInstance;
const who = { chair: '', member: '', other: '' };
const messages: { first: string; second: string; third: string } = { first: '', second: '', third: '' };

interface Parts {
  key?: Buffer | null;
  rental?: boolean;
  mailbox?: boolean;
  tasks?: boolean;
}

async function build(parts: Parts = {}): Promise<FastifyInstance> {
  const config = testMailboxConfig(path.join(dir, 'mail'), {}, ingestKey);
  const built = await buildApp({
    store: new StateStore({ ...(await seedState()), users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    ...(parts.mailbox === false ? {} : { mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases) } }),
    ...(parts.rental === false ? {} : { rental: { store: rental.store, itemOrigin: null, webDir: null } }),
    ...(parts.tasks === false
      ? {}
      : { tasks: { client: new TaskServiceClient({ baseUrl: 'https://tasks.example.invalid', key: randomBytes(32), timeoutMs: 1_000 }), bridge: parseTaskBridge(SYNTHETIC_TASK_BRIDGE_JSON), links } }),
    botDatasourceKey: parts.key === undefined ? BOT_KEY : parts.key,
  });
  apps.push(built);
  return built;
}

const raw = (o: { messageId: string; from?: string; to: string; cc?: string; subject: string; date: string; attachments?: boolean }) =>
  rawMail({
    messageId: o.messageId,
    ...(o.from ? { from: o.from } : {}),
    to: o.to,
    ...(o.cc ? { cc: o.cc } : {}),
    subject: o.subject,
    date: o.date,
    text: `${BODY_MARK} ${o.subject} の本文です。`,
    html: `<p>${HTML_MARK}</p>`,
    ...(o.attachments ? { attachments: [{ filename: FILE_MARK, contentType: 'application/pdf', content: randomBytes(64) }] } : {}),
  });

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-bot-datasource-'));
  // OTHER is deliberately not on the roster: the app would show their student ID as the name.
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎' } }));
  ctx = setup();
  ingestKey = randomBytes(32);
  apps = [];
  mail = new MailboxStore(path.join(dir, 'mail'));
  rental = demoStore();
  links = new TaskLinkStore(emptyLinkState(), null);
  app = await build();

  who.chair = (await register(ctx, CHAIR, STUDENT_IDS.chair, [ROLE_GENERAL_AFFAIRS])).initialLoginId;
  who.member = (await register(ctx, MEMBER, STUDENT_IDS.member)).initialLoginId;
  who.other = (await register(ctx, OTHER, STUDENT_IDS.other)).initialLoginId;

  // Mail: three messages, the first in two mailboxes (sponsorship forwards to adm) with a Cc, an attachment and an HTML part.
  const put = (id: string, at: string, mailRaw: Buffer) => ingest(app, ingestKey, TEST_HOST, mailRaw, { id, at: Date.parse(at), now: ctx.clock.now });
  await put('g-1', MAIL_AT.first, raw({ messageId: 'm1@partner.example', to: SPONSOR, cc: CC, subject: '協賛のお問い合わせ', date: 'Tue, 13 Oct 2026 10:00:00 +0900', attachments: true }));
  await put('g-2', MAIL_AT.second, raw({ messageId: 'm2@partner.example', from: `<${NAMELESS}>`, to: CONTACT, subject: '会場使用のご相談', date: 'Tue, 13 Oct 2026 11:00:00 +0900' }));
  await put('g-3', MAIL_AT.third, raw({ messageId: 'm3@partner.example', from: `"${NAME_IS_ADDRESS}" <${NAME_IS_ADDRESS}>`, to: ADM, subject: '備品のお見積もり', date: 'Tue, 13 Oct 2026 12:00:00 +0900' }));
  const idOf = (subject: string) => (mail.db.prepare('SELECT id FROM messages WHERE subject = ?').get(subject) as { id: string }).id;
  messages.first = idOf('協賛のお問い合わせ');
  messages.second = idOf('会場使用のご相談');
  messages.third = idOf('備品のお見積もり');

  // Handling: the first is in progress with the chair, labels and two notes (the second by someone not on the roster);
  // the second is done, assigned to someone not on the roster.
  const at = new Date(ctx.clock.now).toISOString();
  expect(mail.updateTriage(messages.first, 1, { status: 'in_progress', assigneeId: who.chair, labels: ['協賛', '見積'] }, [], who.chair, at)).toBe(true);
  mail.addNote(messages.first, who.chair, 'NOTE-ONE 見積書を確認済み', '2026-10-13T04:00:00.000Z');
  mail.addNote(messages.first, who.other, 'NOTE-TWO 返信待ち', '2026-10-13T05:00:00.000Z');
  expect(mail.updateTriage(messages.second, 1, { status: 'done', assigneeId: who.other, labels: [] }, [], who.member, at)).toBe(true);
  // Tasks made from mail: two for the first message; a LINE link and a link to a message that is not stored are not shown.
  const link = (n: number, kind: 'mail' | 'line', id: string, taskId: string) => ({ id: `tl_${n}`, taskId, workspaceId: 'ws', source: { kind, id }, createdBy: who.chair, createdAt: at });
  links.replace({
    ...emptyLinkState(),
    links: [link(1, 'mail', messages.first, 'task-12'), link(2, 'line', messages.first, 'task-99'), link(3, 'mail', messages.first, 'task-15'), link(4, 'mail', 'rc_ffffffffffffffff', 'task-77'), link(5, 'mail', messages.first, 'task-12')],
    seq: 5,
  });

  // Rental: a damaged lend with a note, a lend-and-return with a note, and a planned item with its label URL.
  const group = rental.store.createBorrower('合成 模擬店B').borrower;
  rental.store.submit(metadata({ item_code: 'IY-000123', item_version: 0, borrower: '試用 模擬店A', condition: 'damage', note: 'LENT-NOTE 脚に傷' }), [RED, BLUE], ACTOR);
  rental.store.submit(metadata({ item_code: 'IY-000124', item_version: 0, borrower: '試用 模擬店B' }), [RED, BLUE], ACTOR);
  rental.store.submit(metadata({ item_code: 'IY-000124', item_version: 1, action: 'return', borrower: '', condition: 'damage', note: 'RETURN-NOTE 天板割れ' }), [], ACTOR);
  rental.store.preassign([{ code: 'IY-100001', name: '合成 机', url: 'https://rental.example.jp/i/IY-100001', borrower_id: group.id, borrower_name: group.name }], ACTOR);
});

afterEach(async () => {
  for (const a of apps) await a.close();
  mail.close();
  rental.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  body?: string;
  key?: Buffer;
  client?: string;
  actor?: string;
  at?: number;
  nonce?: string;
  /** Request URL, also what is signed (default: the route). */
  url?: string;
  contentType?: string;
  headers?: Record<string, string | string[]>;
  on?: FastifyInstance;
}

async function post(o: Call = {}) {
  const body = o.body ?? BODY;
  const url = o.url ?? BOT_DATASOURCE_PATH;
  const timestamp = String(o.at ?? ctx.clock.now);
  const nonce = o.nonce ?? randomBytes(18).toString('base64url');
  const client = o.client ?? CLIENT;
  const actor = o.actor ?? '';
  const signature = signRequest(o.key ?? BOT_KEY, { client, method: 'POST', path: url, timestamp, nonce, actor, body });
  const res = await (o.on ?? app).inject({
    method: 'POST',
    url,
    headers: {
      host: TEST_HOST,
      'content-type': o.contentType ?? 'application/json',
      'x-svc-client': client,
      'x-svc-timestamp': timestamp,
      'x-svc-nonce': nonce,
      'x-svc-signature': signature,
      ...(actor ? { 'x-svc-actor': actor } : {}),
      ...o.headers,
    },
    payload: body,
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, json: json as any, text: res.body, headers: res.headers };
}

const REJECTED = { error: 'rejected' };
const expectRejected = async (o: Call) => {
  const res = await post(o);
  expect(res.status).toBe(401);
  expect(res.json).toEqual(REJECTED);
};

describe('the response', () => {
  it('has the contract shape for both sources', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const json = res.json;
    expect(Object.keys(json)).toEqual(['version', 'generatedAt', 'rental', 'mailbox']);
    expect(json.version).toBe(1);
    expect(json.generatedAt).toBe(new Date(ctx.clock.now).toISOString());

    // Rental: the ledger's own summary and items, unchanged.
    expect(Object.keys(json.rental)).toEqual(['summary', 'items']);
    expect(json.rental.summary).toEqual(rental.store.summary());
    expect(json.rental.items).toEqual(rental.store.overview().items);
    const byCode = Object.fromEntries((json.rental.items as { code: string }[]).map((i) => [i.code, i]));
    expect(byCode['IY-000123']).toMatchObject({ phase: 'loaned', group: { name: '試用 模擬店A' }, lent_condition: 'damage', lent_note: 'LENT-NOTE 脚に傷' });
    expect(byCode['IY-000124']).toMatchObject({ phase: 'review', return_condition: 'damage', return_note: 'RETURN-NOTE 天板割れ' });
    expect(byCode['IY-100001']).toMatchObject({ phase: 'planned', group: { name: '合成 模擬店B' } });
    expect(Object.keys(json.rental.items[0]).sort()).toEqual(
      ['code', 'name', 'status', 'phase', 'group', 'lent_at', 'lent_condition', 'lent_note', 'lent_photo_skip', 'returned_at', 'return_condition', 'return_note'].sort(),
    );

    // Mailbox: configured mailboxes in order with counts only, then messages newest received first.
    expect(Object.keys(json.mailbox)).toEqual(['mailboxes', 'messages']);
    expect(json.mailbox.mailboxes).toEqual([
      { id: 'contact', name: '問い合わせ', threads: 1, unhandled: 0 },
      { id: 'sponsorship', name: '協賛', threads: 1, unhandled: 0 },
      { id: 'adm', name: '大学窓口', threads: 2, unhandled: 1 },
      { id: 'taro', name: '委員会共用', threads: 0, unhandled: 0 },
    ]);
    const thread = (id: string) => (mail.db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(id) as { thread_id: string }).thread_id;
    expect((json.mailbox.messages as { id: string }[]).map((m) => m.id)).toEqual([messages.third, messages.second, messages.first]);
    expect(json.mailbox.messages[2]).toEqual({
      id: messages.first,
      threadId: thread(messages.first),
      mailboxIds: ['sponsorship', 'adm'],
      subject: '協賛のお問い合わせ',
      fromName: '取引先 担当',
      sentAt: '2026-10-13T01:00:00.000Z',
      receivedAt: MAIL_AT.first,
      status: 'in_progress',
      assignee: '合成 委員長',
      labels: ['協賛', '見積'],
      attachments: 1,
      notes: [
        { author: '合成 委員長', at: '2026-10-13T04:00:00.000Z', body: 'NOTE-ONE 見積書を確認済み' },
        { author: '（不明）', at: '2026-10-13T05:00:00.000Z', body: 'NOTE-TWO 返信待ち' },
      ],
      taskIds: ['task-12', 'task-15'],
    });
    expect(json.mailbox.messages[1]).toMatchObject({ id: messages.second, mailboxIds: ['contact'], status: 'done', assignee: '（不明）', labels: [], attachments: 0, notes: [], taskIds: [] });
    expect(json.mailbox.messages[0]).toMatchObject({ id: messages.third, mailboxIds: ['adm'], status: 'unhandled', assignee: null });
    for (const m of json.mailbox.messages) {
      expect(Object.keys(m).sort()).toEqual(['assignee', 'attachments', 'fromName', 'id', 'labels', 'mailboxIds', 'notes', 'receivedAt', 'sentAt', 'status', 'subject', 'taskIds', 'threadId'].sort());
      for (const n of m.notes) expect(Object.keys(n).sort()).toEqual(['at', 'author', 'body']);
    }
  });

  it('answers only the requested sources and null for the rest', async () => {
    const rentalOnly = (await post({ body: '{"sources":["rental"]}' })).json;
    expect(rentalOnly.rental.items).toHaveLength(3);
    expect(rentalOnly.mailbox).toBeNull();
    const mailboxOnly = (await post({ body: '{"sources":["mailbox"]}' })).json;
    expect(mailboxOnly.rental).toBeNull();
    expect(mailboxOnly.mailbox.messages).toHaveLength(3);
    // Order in the request does not matter.
    expect((await post({ body: '{"sources":["mailbox","rental"]}' })).json.rental).not.toBeNull();
  });

  it('answers null for a source the app has not configured, and no task ids without the task gateway', async () => {
    const noRental = await post({ on: await build({ rental: false }) });
    expect(noRental.status).toBe(200);
    expect(noRental.json.rental).toBeNull();
    expect(noRental.json.mailbox.messages).toHaveLength(3);
    const noMailbox = await post({ on: await build({ mailbox: false, tasks: false }) });
    expect(noMailbox.json.mailbox).toBeNull();
    expect(noMailbox.json.rental.items).toHaveLength(3);
    const noTasks = await post({ on: await build({ tasks: false }) });
    expect(noTasks.json.mailbox.messages.map((m: { taskIds: string[] }) => m.taskIds)).toEqual([[], [], []]);
    const neither = await post({ on: await build({ rental: false, mailbox: false }) });
    expect(neither.json).toMatchObject({ version: 1, rental: null, mailbox: null });
  });

  it('carries what the Bot needs and nothing it must not have', async () => {
    const { text } = await post();
    // Present: subjects, names, state, notes, task ids, labels, item notes.
    for (const wanted of ['協賛のお問い合わせ', '会場使用のご相談', '備品のお見積もり', '取引先 担当', '合成 委員長', 'in_progress', 'NOTE-ONE', 'NOTE-TWO', 'task-12', 'task-15', '見積', 'LENT-NOTE', 'RETURN-NOTE']) {
      expect(text, wanted).toContain(wanted);
    }
    // Absent: addresses (sender, To, Cc, committee mailboxes, a display name that is an address), bodies, attachment names,
    // account / Discord / student IDs, other task links, staff and the label URL of the ledger, photos.
    const secrets = [
      '@', OUTSIDE, CC, NAMELESS, NAME_IS_ADDRESS, SPONSOR, CONTACT, ADM, COLLECTOR, 'committee.example', 'partner.example',
      BODY_MARK, HTML_MARK, 'の本文です', FILE_MARK, 'pdf',
      who.chair, who.member, who.other, CHAIR, MEMBER, OTHER, ...Object.values(STUDENT_IDS),
      'task-99', 'task-77', '試用スタッフ', 'rental.example.jp', 'photos/', '.jpg',
      'from_address', 'to_json', 'cc_json', 'assignee_id', 'author_id', 'actor',
    ];
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
  });

  it('shows a roster name only, never the student ID or login ID the app falls back to', async () => {
    const { json, text } = await post();
    // The app itself would call this account by its student ID.
    expect(text).not.toContain(STUDENT_IDS.other);
    expect(json.mailbox.messages[1].assignee).toBe('（不明）');
    expect(json.mailbox.messages[2].notes[1].author).toBe('（不明）');
  });

  it('leaves out the sender when the display name is missing or is itself an address', async () => {
    const { json } = await post();
    expect(json.mailbox.messages.map((m: { fromName: string | null }) => m.fromName)).toEqual([null, null, '取引先 担当']);
    // The mail parser may keep an address as the name; it is not passed on.
    mail.db.prepare('UPDATE messages SET from_name = ? WHERE id = ?').run(`${NAME_IS_ADDRESS} 広報`, messages.first);
    const again = await post();
    expect(again.json.mailbox.messages[2].fromName).toBeNull();
    expect(again.text).not.toContain('@');
  });

  it('reads the newest messages up to the limit, with their notes and links', () => {
    const all = ['contact', 'sponsorship', 'adm', 'taro'];
    const two = mail.handlingOverview(all, 2);
    expect(two.messages.map((m) => m.id)).toEqual([messages.third, messages.second]);
    expect(two.notes.size).toBe(0);
    expect(mail.handlingOverview(all, MAX_MESSAGES).messages).toHaveLength(3);
    expect(mail.handlingOverview(['taro'], 10).messages).toEqual([]);
    expect(mail.handlingOverview(['adm'], 10).messages.map((m) => m.id)).toEqual([messages.third, messages.first]);
    // Only the handling columns are selected.
    expect(Object.keys(two.messages[0]!).sort()).toEqual(['assignee_id', 'attachments', 'from_name', 'id', 'labels_json', 'received_at', 'sent_at', 'sign_in', 'status', 'subject', 'thread_id']);
  });

  it('never gives the subject of sign-in mail', async () => {
    const code = 'Your verification code is 482913';
    mail.db.prepare('UPDATE messages SET subject = ? WHERE id = ?').run(code, messages.second);
    const { json, text } = await post();
    expect(text).not.toContain('482913');
    expect(json.mailbox.messages.find((m: { id: string }) => m.id === messages.second).subject).toBe(SIGN_IN_MAIL_SUBJECT);
    expect(json.mailbox.messages.find((m: { id: string }) => m.id === messages.first).subject).toBe('協賛のお問い合わせ');
  });
});

describe('signing', () => {
  // The Bot signs in Python; this vector was computed there independently (hmac + hashlib) and is fixed here.
  const VECTOR: SignatureInput = {
    client: CLIENT,
    method: 'POST',
    path: '/v1/bot/datasource',
    timestamp: '1760000000000',
    nonce: 'nnnnnnnnnnnnnnnnnnnnnnnn',
    actor: '',
    body: '{"sources":["rental","mailbox"]}',
  };
  const VECTOR_KEY_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
  const VECTOR_CANONICAL =
    'svc-auth/v1\niyakusai-bot-datasource\nPOST\n/v1/bot/datasource\n1760000000000\nnnnnnnnnnnnnnnnnnnnnnnnn\n\n8962692c944f29decb115f42c087205a40295112e1922fbd095e1a7d2ec5a428';
  const VECTOR_SIGNATURE = '0723d4a85ab16e9f32c44dfbc6ea9d429af6755f93cb2d162b397efed83f18ee';

  it('computes the fixed vector exactly as the Bot side does', () => {
    expect(BOT_KEY.toString('hex')).toBe(VECTOR_KEY_HEX);
    expect(canonicalString(VECTOR)).toBe(VECTOR_CANONICAL);
    expect(signRequest(BOT_KEY, VECTOR)).toBe(VECTOR_SIGNATURE);
    expect(verifySignature(BOT_KEY, VECTOR, VECTOR_SIGNATURE)).toBe(true);
  });

  it('accepts the fixed vector over HTTP (clock 1760000000000)', async () => {
    expect(ctx.clock.now).toBe(1_760_000_000_000);
    const res = await app.inject({
      method: 'POST',
      url: VECTOR.path,
      headers: {
        host: TEST_HOST,
        'content-type': 'application/json',
        'x-svc-client': VECTOR.client,
        'x-svc-timestamp': VECTOR.timestamp,
        'x-svc-nonce': VECTOR.nonce,
        'x-svc-signature': VECTOR_SIGNATURE,
      },
      payload: VECTOR.body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(1);
  });
});

describe('rejection (always the same 401)', () => {
  it('refuses a wrong key, including every other key the app holds', async () => {
    await expectRejected({ key: randomBytes(32) });
    await expectRejected({ key: ctx.config.bridgeKey });
    await expectRejected({ key: ctx.config.pepper });
    await expectRejected({ key: ingestKey });
  });

  it('refuses another client, an actor and altered or missing parts', async () => {
    await expectRejected({ client: 'iyakusai-bot' });
    await expectRejected({ client: 'mail-collector' });
    await expectRejected({ actor: 'someone' });
    await expectRejected({ headers: { 'x-svc-signature': '0'.repeat(64) } });
    await expectRejected({ headers: { 'x-svc-signature': 'not hex' } });
    await expectRejected({ headers: { 'x-svc-nonce': 'short' } });
    await expectRejected({ headers: { 'x-svc-timestamp': '1760000000' } });
    await expectRejected({ url: `${BOT_DATASOURCE_PATH}?x=1` });
    // Unsigned.
    const res = await app.inject({
      method: 'POST',
      url: BOT_DATASOURCE_PATH,
      headers: { host: TEST_HOST, 'content-type': 'application/json' },
      payload: BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(REJECTED);
  });

  it('refuses a body that differs from what was signed', async () => {
    const nonce = randomBytes(18).toString('base64url');
    const signature = signRequest(BOT_KEY, { client: CLIENT, method: 'POST', path: BOT_DATASOURCE_PATH, timestamp: String(ctx.clock.now), nonce, actor: '', body: BODY });
    const res = await post({ body: '{"sources":["mailbox"]}', nonce, headers: { 'x-svc-signature': signature } });
    expect(res.status).toBe(401);
    expect(res.json).toEqual(REJECTED);
  });

  it('accepts a clock difference of 30 seconds either way and refuses 31', async () => {
    expect((await post({ at: ctx.clock.now - 30_000 })).status).toBe(200);
    expect((await post({ at: ctx.clock.now + 30_000 })).status).toBe(200);
    await expectRejected({ at: ctx.clock.now - 31_000 });
    await expectRejected({ at: ctx.clock.now + 31_000 });
  });

  it('accepts a nonce once', async () => {
    const nonce = 'once-only-nonce-0123456789ab';
    expect((await post({ nonce })).status).toBe(200);
    await expectRejected({ nonce });
    expect((await post({ nonce: 'another-nonce-0123456789abc' })).status).toBe(200);
  });

  it('remembers at most 1024 nonces, and forgets them once their time has passed', async () => {
    for (let i = 0; i < 1024; i += 1) {
      const res = await post({ body: '{"sources":["rental"]}', nonce: `fill-${String(i).padStart(6, '0')}-0123456789abcdef` });
      expect(res.status).toBe(200);
    }
    await expectRejected({ nonce: 'one-too-many-0123456789abcdef' });
    // 61 seconds later every earlier nonce is past the accepted time window.
    ctx.clock.now += 61_000;
    expect((await post({ nonce: 'one-too-many-0123456789abcdef' })).status).toBe(200);
  });

  it('does not let unsigned requests use up the nonce memory', async () => {
    for (let i = 0; i < 1100; i += 1) {
      const res = await post({ key: randomBytes(32), nonce: `stranger-${String(i).padStart(6, '0')}-0123456789ab` });
      expect(res.status).toBe(401);
    }
    expect((await post()).status).toBe(200);
  });

  it('refuses a browser Origin, a duplicated x-svc header and any unknown x-svc header', async () => {
    await expectRejected({ headers: { origin: 'https://app.example.invalid' } });
    await expectRejected({ headers: { origin: 'null' } });
    await expectRejected({ headers: { 'x-svc-nonce': ['dup-nonce-0123456789abcdefg', 'dup-nonce-0123456789abcdefg'] } });
    await expectRejected({ headers: { 'x-svc-client': [CLIENT, CLIENT] } });
    await expectRejected({ headers: { 'x-svc-extra': '1' } });
    // The same request without the extras is fine, so the refusals above are about the extras.
    expect((await post()).status).toBe(200);
  });

  it('refuses a body that is not exactly {"sources":[...]} with one or two distinct known sources', async () => {
    for (const body of [
      '{"sources":["rental"],"extra":1}',
      '{"sources":["rental"],"sources2":[]}',
      '{"sources":["tasks"]}',
      '{"sources":["rental","files"]}',
      '{"sources":["rental","rental"]}',
      '{"sources":["mailbox","mailbox"]}',
      '{"sources":[]}',
      '{"sources":["rental","mailbox","rental"]}',
      '{"sources":"rental"}',
      '{"sources":[1]}',
      '{"sources":[null]}',
      '{"sources":[["rental"]]}',
      '{}',
      '[]',
      '["rental"]',
      '"rental"',
      'null',
      'not json',
      '',
    ]) {
      await expectRejected({ body });
    }
  });

  it('refuses a body over 1 KB, another content type and an empty request alike', async () => {
    await expectRejected({ body: `{"sources":["rental"],"pad":"${'x'.repeat(2_000)}"}` });
    await expectRejected({ contentType: 'text/plain' });
    await expectRejected({ contentType: 'application/x-www-form-urlencoded' });
    const empty = await app.inject({ method: 'POST', url: BOT_DATASOURCE_PATH, headers: { host: TEST_HOST } });
    expect(empty.statusCode).toBe(401);
    expect(empty.json()).toEqual(REJECTED);
  });

  it('serves nothing but POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) expect((await app.inject({ method, url: BOT_DATASOURCE_PATH, headers: { host: TEST_HOST } })).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('when no key is set', () => {
  it('has no such route (404) and a request signed with any key is not answered', async () => {
    const off = await build({ key: null });
    for (const key of [BOT_KEY, ctx.config.bridgeKey]) {
      const res = await post({ on: off, key });
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('rental');
    }
    expect((await off.inject({ method: 'GET', url: BOT_DATASOURCE_PATH, headers: { host: TEST_HOST } })).statusCode).toBe(404);
  });
});
