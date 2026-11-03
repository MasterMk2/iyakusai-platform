import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import type { MailTransport, SmtpEnvelope } from '../../src/server/mailbox/smtp.js';
import { SmtpError } from '../../src/server/mailbox/smtp.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { OrganizationsStore } from '../../src/server/organizations/store.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, setup, testConfig } from '../discord-auth/helpers.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { DOMAIN, testMailboxConfig } from '../mailbox/helpers.js';

// Organizations (団体の台帳) over HTTP, with the contacts they link to and the sending service recording instead of
// sending. Synthetic names and reserved .example addresses only.

const ARCHIVE = `archive@${DOMAIN}`;
const SEND = { smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpUser: `taro@${DOMAIN}`, smtpPasswordFile: '/not/read/in/tests', fromName: '合成 医学薬学祭実行委員会', mailboxes: ['contact', 'sponsorship'] };
const ROLE_STAFF = '1000000000000002099';
const ORIGIN = `http://${TEST_HOST}`;
// Every sign-in hashes the password (slow on purpose), and some tests sign in several people.
vi.setConfig({ testTimeout: 90_000 });

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
const sent: { envelope: SmtpEnvelope; raw: Buffer }[] = [];
/** Test hook: may throw for one message to act as the mail server refusing or losing it. */
let onSend: ((envelope: SmtpEnvelope) => void) | null = null;

const recording: MailTransport = {
  async send(envelope, raw) {
    onSend?.(envelope);
    sent.push({ envelope, raw });
  },
};

async function build(changes: Record<string, unknown> = {}) {
  const config = testMailboxConfig(path.join(dir, 'mail'), { draftBccAddress: ARCHIVE, send: SEND, ...changes }, randomBytes(32), 'abcdabcdabcdabcd');
  mail = new MailboxStore(config.dataDir);
  const seed = await seedState();
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases), transport: recording },
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-orgs-http-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup({ config: testConfig({ departmentRoleIds: { [ROLE_STAFF]: '臨時スタッフ', [ROLE_GENERAL_AFFAIRS]: '総務部' } }) });
  sent.length = 0;
  onSend = null;
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, options: { body?: unknown; cookie?: string } = {}): Promise<{ status: number; json: any }> {
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
  return { status: res.statusCode, json };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

async function signIn(uid: string, studentId: string, roles: string[] = []) {
  const { initialLoginId } = await register(ctx, uid, studentId, roles);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: TEST_HOST, origin: ORIGIN, 'x-smm-csrf': '1', 'content-type': 'application/json' },
    payload: JSON.stringify({ loginId: studentId, password: PASSWORD }),
  });
  expect(res.statusCode).toBe(200);
  return { cookie: cookieOf(res.headers['set-cookie']), id: initialLoginId };
}

async function grantSend(chairCookie: string, userId: string, mailboxId = 'sponsorship') {
  const res = await call('PUT', '/api/mail/admin/access', { cookie: chairCookie, body: { userId, mailboxId, send: true } });
  expect(res.status).toBe(200);
}

const organization = (changes: Record<string, unknown> = {}) => ({
  kind: 'sponsor',
  fiscalYear: 2026,
  name: '合成商事株式会社',
  department: '渉外課',
  ownerId: null,
  contactId: null,
  status: '依頼前',
  amountYen: 300_000,
  content: '広告（大）',
  nextAction: '依頼状を送る',
  nextDue: '2026-11-30',
  notes: '',
  ...changes,
});

const contactBody = (name: string, address: string) => ({
  category: 'external',
  organization: `${name}の会社`,
  section: '',
  name,
  nameKana: '',
  emails: [{ label: '', address }],
  phones: [],
  postalCode: '',
  address: '',
  tags: [],
  notes: '',
});

async function contactId(cookie: string, name: string, address: string): Promise<string> {
  const res = await call('POST', '/api/contacts', { cookie, body: contactBody(name, address) });
  expect(res.status).toBe(201);
  return res.json.contact.id as string;
}

describe('organizations: the list, the rules, the permissions', () => {
  beforeEach(() => build());

  it('lets a member add, read and edit an organization, keeping its history; a stale save is refused', async () => {
    const member = await signIn(MEMBER, '21000002');
    const other = await signIn(OTHER, '21000003');
    const created = await call('POST', '/api/organizations', { cookie: member.cookie, body: organization() });
    expect(created.status).toBe(201);
    const id = created.json.org.id as string;
    expect(created.json.org).toMatchObject({ kind: 'sponsor', status: '依頼前', version: 1, createdByName: '合成 太郎' });
    expect(created.json.canAdminister).toBe(false);

    const list = await call('GET', '/api/organizations?fiscalYear=2026', { cookie: member.cookie });
    expect(list.json).toMatchObject({ total: 1, statusCounts: { 依頼前: 1 } });
    expect(list.json.items[0]).toMatchObject({ name: '合成商事株式会社', amountYen: 300_000, nextDue: '2026-11-30' });

    // Search finds the company in several forms and the content; another year finds nothing.
    for (const q of ['商事', '合成商事', '広告']) {
      expect((await call('GET', `/api/organizations?q=${encodeURIComponent(q)}&fiscalYear=2026`, { cookie: member.cookie })).json.total, q).toBe(1);
    }
    expect((await call('GET', '/api/organizations?fiscalYear=2025', { cookie: member.cookie })).json.total).toBe(0);

    const edited = await call('PUT', `/api/organizations/${id}`, { cookie: other.cookie, body: { expectedVersion: 1, organization: organization({ status: '依頼済み', amountYen: 500_000 }) } });
    expect(edited.status).toBe(200);
    expect(edited.json.org).toMatchObject({ version: 2, status: '依頼済み', updatedByName: '合成 花子' });
    expect(edited.json.history.map((h: { action: string; changed: string[] }) => [h.action, h.changed])).toEqual([
      ['updated', ['状態', '金額']],
      ['created', []],
    ]);

    const stale = await call('PUT', `/api/organizations/${id}`, { cookie: member.cookie, body: { expectedVersion: 1, organization: organization({ name: '上書き' }) } });
    expect(stale.status).toBe(409);
    expect((await call('GET', `/api/organizations/${id}`, { cookie: member.cookie })).json.org.name).toBe('合成商事株式会社');
  });

  it('answers a wrong field with its name, and keeps the list as it was', async () => {
    const member = await signIn(MEMBER, '21000002');
    const bad = await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ status: '申込' }) });
    expect(bad.status).toBe(422);
    expect(bad.json).toMatchObject({ error: 'validation', details: { field: 'status' } });
    expect((await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ ownerId: 'no-such-member' }) })).status).toBe(422);
    expect((await call('GET', '/api/organizations', { cookie: member.cookie })).json.total).toBe(0);
  });

  it('refuses temporary staff and people who are not signed in', async () => {
    const staff = await signIn('1000000000000001050', '21000050', [ROLE_STAFF]);
    expect((await call('GET', '/api/organizations', { cookie: staff.cookie })).status).toBe(403);
    expect((await call('GET', '/api/organizations')).status).toBe(401);
  });

  it('links an organization to a contact, showing the contact name and address; the link must exist', async () => {
    const member = await signIn(MEMBER, '21000002');
    const contact = await contactId(member.cookie, '合成 一郎', 'ichiro@partner.example');
    const created = await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ contactId: contact }) });
    expect(created.json.org).toMatchObject({ contactId: contact, contactName: '合成 一郎', contactEmail: 'ichiro@partner.example' });
    expect((await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ contactId: 'ct_0000000000000099' }) })).status).toBe(422);
    const listed = await call('GET', '/api/organizations', { cookie: member.cookie });
    expect(listed.json.items[0].contactEmail).toBe('ichiro@partner.example');
  });

  it('lets only administrators delete, and puts an earlier state back as one more change', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    const id = (await call('POST', '/api/organizations', { cookie: member.cookie, body: organization() })).json.org.id as string;
    await call('PUT', `/api/organizations/${id}`, { cookie: member.cookie, body: { expectedVersion: 1, organization: organization({ status: '依頼済み' }) } });
    const detail = await call('GET', `/api/organizations/${id}`, { cookie: member.cookie });
    const update = detail.json.history.find((h: { action: string }) => h.action === 'updated');
    expect(update.canRevert).toBe(true);

    const reverted = await call('POST', `/api/organizations/${id}/revert`, { cookie: member.cookie, body: { expectedVersion: 2, historyId: update.id } });
    expect(reverted.status).toBe(200);
    expect(reverted.json.org).toMatchObject({ version: 3, status: '依頼前' });
    expect(reverted.json.history[0].action).toBe('reverted');

    expect((await call('DELETE', `/api/organizations/${id}?expectedVersion=3`, { cookie: member.cookie })).status).toBe(403);
    expect((await call('DELETE', `/api/organizations/${id}?expectedVersion=3`, { cookie: chair.cookie })).status).toBe(204);
    expect((await call('GET', `/api/organizations/${id}`, { cookie: member.cookie })).status).toBe(404);
  });

  it('keeps the mail templates: placeholders checked on save, a stale save refused, deleting for administrators', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    expect((await call('POST', '/api/organizations/templates', { cookie: member.cookie, body: { name: '請求', subject: '{団体名}', body: '{住所}' } })).status).toBe(422);
    const made = await call('POST', '/api/organizations/templates', { cookie: member.cookie, body: { name: '請求', subject: '請求書のご案内（{団体名}）', body: '{担当者名} 様\n{金額}' } });
    expect(made.status).toBe(201);
    const id = made.json.id as string;
    expect((await call('GET', '/api/organizations/templates', { cookie: member.cookie })).json).toEqual([expect.objectContaining({ id, name: '請求', version: 1 })]);
    expect((await call('PUT', `/api/organizations/templates/${id}`, { cookie: member.cookie, body: { expectedVersion: 9, template: { name: '請求', subject: '件名', body: '本文' } } })).status).toBe(409);
    expect((await call('DELETE', `/api/organizations/templates/${id}`, { cookie: member.cookie })).status).toBe(403);
    expect((await call('DELETE', `/api/organizations/templates/${id}`, { cookie: chair.cookie })).status).toBe(204);
  });

  it('imports a sheet: the dry run shows what would happen and changes nothing; the commit writes it; a blank cell keeps the value', async () => {
    const member = await signIn(MEMBER, '21000002');
    await contactId(member.cookie, '合成 一郎', 'ichiro@partner.example');
    const header = { name: 0, kind: 1, amountYen: 2, contactEmail: 3, status: 4, nextDue: 5 };
    const rows = [
      ['合成商事株式会社', '協賛', '¥500,000', 'ichiro@partner.example', '依頼済み', '2026-11-20'],
      ['合成サークル', '出展団体', '', '', '申込', ''],
      ['合成商事株式会社', '協賛', '', '', '', ''],
      ['', '協賛', '', '', '', ''],
      ['合成協会', '不明な種別', '', '', '', ''],
      ['合成協会2', '協賛', '約10万', '', '', ''],
    ];
    const dry = await call('POST', '/api/organizations/import', { cookie: member.cookie, body: { dryRun: true, fiscalYear: 2026, defaultKind: 'sponsor', mapping: header, rows } });
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({ dryRun: true, create: 2, update: 0, skip: 4 });
    expect(dry.json.rows.map((r: { action: string }) => r.action)).toEqual(['create', 'create', 'skip', 'skip', 'skip', 'skip']);
    expect(dry.json.rows[2].message).toContain('2 行目');
    expect(dry.json.rows[3].message).toContain('団体名がありません');
    expect(dry.json.rows[4].message).toContain('種別');
    expect(dry.json.rows[5].message).toContain('金額');
    expect((await call('GET', '/api/organizations', { cookie: member.cookie })).json.total).toBe(0);

    const committed = await call('POST', '/api/organizations/import', { cookie: member.cookie, body: { dryRun: false, fiscalYear: 2026, defaultKind: 'sponsor', mapping: header, rows, planToken: dry.json.planToken } });
    expect(committed.json).toMatchObject({ dryRun: false, create: 2 });
    const listed = await call('GET', '/api/organizations?fiscalYear=2026', { cookie: member.cookie });
    expect(listed.json.total).toBe(2);
    const sponsor = listed.json.items.find((i: { name: string }) => i.name === '合成商事株式会社');
    expect(sponsor).toMatchObject({ amountYen: 500_000, status: '依頼済み', nextDue: '2026-11-20', contactEmail: 'ichiro@partner.example' });
    expect(listed.json.items.find((i: { name: string }) => i.name === '合成サークル')).toMatchObject({ kind: 'exhibitor', status: '申込' });

    // The same name and year is an update; blank cells keep what is there; the same content again is a skip.
    const paid = [['合成商事株式会社', '', '', '', '入金済み', '']];
    const paidDry = await call('POST', '/api/organizations/import', { cookie: member.cookie, body: { dryRun: true, fiscalYear: 2026, defaultKind: 'sponsor', mapping: header, rows: paid } });
    const updated = await call('POST', '/api/organizations/import', { cookie: member.cookie, body: { dryRun: false, fiscalYear: 2026, defaultKind: 'sponsor', mapping: header, rows: paid, planToken: paidDry.json.planToken } });
    expect(updated.json).toMatchObject({ update: 1, skip: 0, rows: [{ action: 'update', message: '状態' }] });
    const after = (await call('GET', '/api/organizations?fiscalYear=2026&q=' + encodeURIComponent('合成商事'), { cookie: member.cookie })).json.items[0];
    expect(after).toMatchObject({ amountYen: 500_000, status: '入金済み', contactEmail: 'ichiro@partner.example', nextDue: '2026-11-20' });
    const sameDry = await call('POST', '/api/organizations/import', { cookie: member.cookie, body: { dryRun: true, fiscalYear: 2026, defaultKind: 'sponsor', mapping: header, rows: paid } });
    const same = await call('POST', '/api/organizations/import', { cookie: member.cookie, body: { dryRun: false, fiscalYear: 2026, defaultKind: 'sponsor', mapping: header, rows: paid, planToken: sameDry.json.planToken } });
    expect(same.json).toMatchObject({ update: 0, skip: 1 });
    expect(same.json.rows[0].message).toContain('変更はありません');
  });
});

describe('organizations: batch mail', () => {
  beforeEach(() => build());

  /** A member with a send grant, one organization linked to a contact, and one without a contact. */
  async function setup2() {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await grantSend(chair.cookie, member.id);
    const contact = await contactId(member.cookie, '合成 一郎', 'ichiro@partner.example');
    const withContact = (await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ contactId: contact }) })).json.org.id as string;
    const without = (await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: '合成サークル' }) })).json.org.id as string;
    return { chair, member, withContact, without };
  }

  const batchBody = (organizationIds: string[], extra: Record<string, unknown> = {}) => ({
    clientToken: randomBytes(12).toString('base64url'),
    mailboxId: 'sponsorship',
    templateId: null,
    subject: '{団体名} 様 ご案内',
    body: '{担当者名} 様\n{団体名}の協賛について、ご案内します。',
    organizationIds,
    ...extra,
  });

  /** Sends until the screen would stop: nothing pending, or the hourly limit reached. */
  async function sendAll(cookie: string, batchId: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let last: { status: number; json: any } = { status: 0, json: null };
    for (let i = 0; i < 40; i += 1) {
      last = await call('POST', `/api/organizations/mail/batches/${batchId}/send`, { cookie, body: { includeFailed: false } });
      if (last.status !== 200 || last.json.stopped || last.json.batch.counts.pending === 0) break;
    }
    return last;
  }

  it('makes a draft that shows each message and why one is held back, then sends one message per address and notes it in the history', async () => {
    const { member, withContact, without } = await setup2();
    const draft = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: batchBody([withContact, without]) });
    expect(draft.status).toBe(201);
    expect(draft.json).toMatchObject({ status: 'draft', mailboxAddress: expect.stringContaining('@'), counts: { pending: 1, skipped: 1 } });
    expect(draft.json.items[0]).toMatchObject({ toAddress: 'ichiro@partner.example', subject: '合成商事株式会社 様 ご案内', status: 'pending' });
    expect(draft.json.items[0].body).toContain('合成 一郎 様\n合成商事株式会社の協賛について');
    expect(draft.json.items[1].skipReason).toContain('宛先がありません');
    expect(sent).toHaveLength(0);

    const result = await sendAll(member.cookie, draft.json.id);
    expect(result.json).toMatchObject({ stopped: false, batch: { status: 'done', counts: { sent: 1, skipped: 1 } } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.envelope.to).toContain('ichiro@partner.example');
    const detail = await call('GET', `/api/organizations/${withContact}`, { cookie: member.cookie });
    expect(detail.json.history.find((h: { action: string }) => h.action === 'mail_sent')).toMatchObject({ mail: { subject: '合成商事株式会社 様 ご案内', sent: 1 } });

    // Nothing is left to send: the same request again sends nothing.
    await sendAll(member.cookie, draft.json.id);
    expect(sent).toHaveLength(1);
  });

  it('holds back a message whose placeholder is empty, and warns about it', async () => {
    const { member, withContact } = await setup2();
    // An organization whose amount is not known yet: the 金額 placeholder has nothing to put in.
    const contact = (await call('GET', `/api/organizations/${withContact}`, { cookie: member.cookie })).json.org.contactId as string;
    const unknownAmount = (await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: '金額未定の会社', amountYen: null, contactId: contact }) })).json.org.id as string;
    const draft = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: batchBody([unknownAmount], { body: '{担当者名} 様\n金額: {金額}' }) });
    expect(draft.json.items[0].skipReason).toContain('差し込みが空です（{金額}）');
    expect(draft.json.counts).toMatchObject({ skipped: 1, pending: 0 });
    expect((await sendAll(member.cookie, draft.json.id)).json.batch.status).toBe('done');
    expect(sent).toHaveLength(0);
  });

  it('refuses a batch without a send grant, and a person outside the trial list gets no mail at all', async () => {
    const { member, withContact } = await setup2();
    const other = await signIn(OTHER, '21000003');
    expect((await call('POST', '/api/organizations/mail/batches', { cookie: other.cookie, body: batchBody([withContact], { mailboxId: 'contact' }) })).status).toBe(403);
    expect((await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: batchBody([withContact], { mailboxId: 'contact' }) })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('shows a batch and sends it only to the member who made it', async () => {
    const { member, withContact } = await setup2();
    const other = await signIn(OTHER, '21000003');
    const draft = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: batchBody([withContact]) });
    expect((await call('GET', `/api/organizations/mail/batches/${draft.json.id}`, { cookie: other.cookie })).status).toBe(404);
    expect((await call('POST', `/api/organizations/mail/batches/${draft.json.id}/send`, { cookie: other.cookie, body: { includeFailed: false } })).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it('never sends a message twice: the same draft is answered from its first creation, and a sent message is not sent again', async () => {
    const { member, withContact } = await setup2();
    const body = batchBody([withContact]);
    const first = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body });
    const again = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body });
    expect(again.json.id).toBe(first.json.id);
    await sendAll(member.cookie, first.json.id);
    expect(sent).toHaveLength(1);
    // A late second click on the same screen: the batch is done, nothing is sent.
    await call('POST', `/api/organizations/mail/batches/${first.json.id}/send`, { cookie: member.cookie, body: { includeFailed: true } });
    expect(sent).toHaveLength(1);
  });

  it('keeps a refused message for 再送 (it goes out then), and never sends one whose outcome is unknown', async () => {
    const { member, withContact } = await setup2();
    const contact2 = await contactId(member.cookie, '合成 二郎', 'jiro@partner.example');
    const second = (await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: '合成株式会社二', contactId: contact2 }) })).json.org.id as string;

    // The first address is refused by the mail server (nothing delivered); the second's outcome is unknown.
    onSend = (envelope) => {
      if (envelope.to.includes('ichiro@partner.example')) throw new SmtpError('recipient', 550, 'no', '宛先が受け付けられませんでした。');
      if (envelope.to.includes('jiro@partner.example')) throw new SmtpError('data', null, 'unknown', '接続が途中で切れました。');
    };
    const draft = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: batchBody([withContact, second]) });
    const first = await sendAll(member.cookie, draft.json.id);
    // A failed message can still be sent again, so the batch stays "partial" until 再送 is done.
    expect(first.json.batch).toMatchObject({ status: 'partial', counts: { failed: 1, unknown: 1 } });
    const failedItem = first.json.batch.items.find((i: { orgId: string }) => i.orgId === withContact);
    expect(failedItem).toMatchObject({ status: 'failed' });
    expect(sent).toHaveLength(0);

    // 再送 sends the refused one; the unknown one is still not sent again.
    onSend = null;
    const retry = await call('POST', `/api/organizations/mail/batches/${draft.json.id}/send`, { cookie: member.cookie, body: { includeFailed: true } });
    expect(retry.json.batch.counts).toMatchObject({ sent: 1, unknown: 1 });
    expect(sent.map((s) => s.envelope.to.includes('ichiro@partner.example'))).toEqual([true]);
    const again = await call('POST', `/api/organizations/mail/batches/${draft.json.id}/send`, { cookie: member.cookie, body: { includeFailed: true } });
    expect(again.json.batch.counts).toMatchObject({ sent: 1, unknown: 1 });
    expect(sent).toHaveLength(1);
  });

  it('stops at the hourly limit of sending and keeps the rest pending for a later request', async () => {
    const { member } = await setup2();
    const ids: string[] = [];
    for (let i = 0; i < 31; i += 1) {
      const contact = await contactId(member.cookie, `合成 担当${i}`, `person${i}@partner.example`);
      ids.push((await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: `合成団体${i}`, contactId: contact }) })).json.org.id as string);
    }
    const first = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: batchBody(ids.slice(0, 30)) });
    const done = await sendAll(member.cookie, first.json.id);
    expect(done.json).toMatchObject({ stopped: false, batch: { status: 'done', counts: { sent: 30 } } });

    const second = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: batchBody([ids[30]!]) });
    const limited = await call('POST', `/api/organizations/mail/batches/${second.json.id}/send`, { cookie: member.cookie, body: { includeFailed: false } });
    expect(limited.json).toMatchObject({ stopped: true, batch: { status: 'partial', counts: { pending: 1 } } });
    expect(limited.json.batch.notice).toContain('上限');
    expect(sent).toHaveLength(30);
    // The same request again while the limit still holds: nothing more goes out.
    await call('POST', `/api/organizations/mail/batches/${second.json.id}/send`, { cookie: member.cookie, body: { includeFailed: false } });
    expect(sent).toHaveLength(30);
  });
});

describe('organizations: the fixes of the review (2026-11-03)', () => {
  beforeEach(() => build());

  /** A member with a send grant, and `count` organizations, each linked to its own contact (synthetic addresses). */
  async function linkedOrgs(count: number) {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await grantSend(chair.cookie, member.id);
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const contact = await contactId(member.cookie, `合成 担当${i}`, `person${i}@partner.example`);
      ids.push((await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: `合成団体${i}`, contactId: contact }) })).json.org.id as string);
    }
    return { chair, member, ids };
  }

  const draftBody = (organizationIds: string[], extra: Record<string, unknown> = {}) => ({
    clientToken: randomBytes(12).toString('base64url'),
    mailboxId: 'sponsorship',
    templateId: null,
    subject: '{団体名} 様 ご案内',
    body: '{担当者名} 様\n{団体名}の協賛について、ご案内します。',
    organizationIds,
    ...extra,
  });

  /** Sends until nothing is pending (or the hourly limit or a stop ends it). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function sendAllOf(cookie: string, batchId: string): Promise<{ status: number; json: any }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let last: { status: number; json: any } = { status: 0, json: null };
    for (let i = 0; i < 40; i += 1) {
      last = await call('POST', `/api/organizations/mail/batches/${batchId}/send`, { cookie, body: { includeFailed: false } });
      if (last.status !== 200 || last.json.stopped || last.json.batch.counts.pending === 0) break;
    }
    return last;
  }

  /** A retry: each request walks forward from the last index it reached, so every failed message is tried once. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function retryAll(cookie: string, batchId: string): Promise<{ status: number; json: any }> {
    let cursor = -1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let last: { status: number; json: any } = { status: 0, json: null };
    for (let i = 0; i < 40; i += 1) {
      last = await call('POST', `/api/organizations/mail/batches/${batchId}/send`, { cookie, body: { includeFailed: true, afterIndex: cursor } });
      if (last.status !== 200 || last.json.stopped || last.json.lastIndex === null) break;
      cursor = last.json.lastIndex;
    }
    return last;
  }

  /** Uploads files as the screen does: a multipart form with the "attachments" field, once per file. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function upload(cookie: string, batchId: string, files: { name: string; type: string; content: Buffer }[]): Promise<{ status: number; json: any }> {
    const boundary = `b${randomBytes(8).toString('hex')}`;
    const parts: Buffer[] = [];
    for (const f of files) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachments"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`));
      parts.push(f.content);
      parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const res = await app.inject({
      method: 'POST',
      url: `/api/organizations/mail/batches/${batchId}/attachments`,
      headers: { host: TEST_HOST, origin: ORIGIN, 'x-smm-csrf': '1', cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    });
    return { status: res.statusCode, json: res.json() };
  }

  it('refuses temporary staff every write (POST, PUT, DELETE), not only reading', async () => {
    const member = await signIn(MEMBER, '21000002');
    const id = (await call('POST', '/api/organizations', { cookie: member.cookie, body: organization() })).json.org.id as string;
    const staff = await signIn('1000000000000001050', '21000050', [ROLE_STAFF]);
    expect((await call('POST', '/api/organizations', { cookie: staff.cookie, body: organization({ name: '別の団体' }) })).status).toBe(403);
    expect((await call('PUT', `/api/organizations/${id}`, { cookie: staff.cookie, body: { expectedVersion: 1, organization: organization({ status: '入金済み' }) } })).status).toBe(403);
    expect((await call('DELETE', `/api/organizations/${id}?expectedVersion=1`, { cookie: staff.cookie })).status).toBe(403);
    expect((await call('GET', `/api/organizations/${id}`, { cookie: member.cookie })).json.org.status).toBe('依頼前');
  });

  it('refuses a second organization with the same name and year (create and rename), and allows another year', async () => {
    const { member } = await linkedOrgs(0);
    expect((await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: '合成 同じ団体' }) })).status).toBe(201);
    // A full-width space and different spacing are the same name (the import's rule).
    const dup = await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: '合成　同じ団体' }) });
    expect(dup.status).toBe(409);
    expect(dup.json.message).toContain('同じ団体名');
    const other = await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: '合成 別の団体' }) });
    expect(other.status).toBe(201);
    const rename = await call('PUT', `/api/organizations/${other.json.org.id}`, { cookie: member.cookie, body: { expectedVersion: 1, organization: organization({ name: '合成 同じ団体' }) } });
    expect(rename.status).toBe(409);
    expect((await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: '合成 同じ団体', fiscalYear: 2025 }) })).status).toBe(201);
  });

  it('explains the limit of 30 organizations in one batch when 31 are chosen', async () => {
    const { member } = await linkedOrgs(0);
    const ids: string[] = [];
    for (let i = 0; i < 31; i += 1) ids.push((await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: `合成団体${i}` }) })).json.org.id as string);
    const res = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: draftBody(ids) });
    expect(res.status).toBe(422);
    expect(res.json.message).toContain('30 団体まで');
    expect(res.json.message).toContain('31');
  });

  it('keeps the row numbers of the sheet, and refuses a commit whose plan changed since the dry run', async () => {
    const { member } = await linkedOrgs(0);
    const body = { fiscalYear: 2026, defaultKind: 'sponsor', mapping: { name: 0, kind: 1 }, rows: [['合成A', '協賛'], ['合成B', '協賛']], lines: [2, 4] };
    const dry = await call('POST', '/api/organizations/import', { cookie: member.cookie, body: { ...body, dryRun: true } });
    expect(dry.status).toBe(200);
    expect(dry.json.rows.map((r: { line: number }) => r.line)).toEqual([2, 4]);
    expect(dry.json.planToken).toMatch(/^[0-9a-f]{64}$/);
    // 合成B is added in the meantime: the plan that was checked no longer holds.
    expect((await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: '合成B' }) })).status).toBe(201);
    const stale = await call('POST', '/api/organizations/import', { cookie: member.cookie, body: { ...body, dryRun: false, planToken: dry.json.planToken } });
    expect(stale.status).toBe(409);
    expect(stale.json.message).toContain('下見');
    // The line numbers must match the rows.
    expect((await call('POST', '/api/organizations/import', { cookie: member.cookie, body: { ...body, lines: [2], dryRun: true } })).status).toBe(422);
  });

  it('walks a retry past five messages that fail again, so the messages behind them are reached', async () => {
    const { member, ids } = await linkedOrgs(7);
    const failing = new Set(['person0@partner.example', 'person1@partner.example', 'person2@partner.example', 'person3@partner.example', 'person4@partner.example', 'person5@partner.example']);
    onSend = (envelope) => {
      if (envelope.to.some((a) => failing.has(a))) throw new SmtpError('recipient', 550, 'no', '宛先が受け付けられませんでした。');
    };
    const draft = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: draftBody(ids) });
    const first = await sendAllOf(member.cookie, draft.json.id);
    expect(first.json.batch.counts).toMatchObject({ failed: 6, sent: 1 });
    // The batch is open (partial) and listed for the screen to continue.
    const open = await call('GET', '/api/organizations/mail/batches', { cookie: member.cookie });
    expect(open.json.items.map((i: { id: string }) => i.id)).toContain(draft.json.id);
    // The sixth message now goes through; the first five fail again.
    failing.delete('person5@partner.example');
    const retried = await retryAll(member.cookie, draft.json.id);
    expect(retried.json.batch.counts).toMatchObject({ failed: 5, sent: 2 });
    expect(sent.some((s) => s.envelope.to.includes('person5@partner.example'))).toBe(true);
  });

  it('attaches the same files to every message of a draft; the files can be removed, and not changed once sending has begun', async () => {
    const { member, ids } = await linkedOrgs(2);
    const draft = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: draftBody(ids) });
    const batchId = draft.json.id as string;
    const added = await upload(member.cookie, batchId, [{ name: 'invoice.pdf', type: 'application/pdf', content: Buffer.from('%PDF-1.4 synthetic invoice') }]);
    expect(added.status).toBe(200);
    expect(added.json.attachments).toEqual([expect.objectContaining({ index: 0, filename: 'invoice.pdf' })]);
    // Eleven files in all is more than the limit of ten.
    const tooMany = await upload(member.cookie, batchId, Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.txt`, type: 'text/plain', content: Buffer.from('x') })));
    expect(tooMany.status).toBe(422);
    const removed = await call('DELETE', `/api/organizations/mail/batches/${batchId}/attachments/0`, { cookie: member.cookie });
    expect(removed.status).toBe(200);
    expect(removed.json.attachments).toEqual([]);
    await upload(member.cookie, batchId, [{ name: 'invoice.pdf', type: 'application/pdf', content: Buffer.from('%PDF-1.4 synthetic invoice') }]);

    const done = await sendAllOf(member.cookie, batchId);
    expect(done.json.batch.counts).toMatchObject({ sent: 2 });
    expect(sent).toHaveLength(2);
    for (const s of sent) expect(s.raw.toString('utf8')).toContain('invoice.pdf');
    // Sending has begun: the files cannot change any more.
    expect((await upload(member.cookie, batchId, [{ name: 'late.pdf', type: 'application/pdf', content: Buffer.from('x') }])).status).toBe(422);
  });

  it('holds back a message whose subject was sent to the organization before, and notes a different earlier subject', async () => {
    const { member, ids } = await linkedOrgs(1);
    const first = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: draftBody(ids) });
    await sendAllOf(member.cookie, first.json.id);
    const again = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: draftBody(ids) });
    expect(again.json.counts).toMatchObject({ pending: 0, skipped: 1 });
    expect(again.json.items[0].skipReason).toContain('同じ件名');
    const other = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: draftBody(ids, { subject: '別件 {団体名}' }) });
    expect(other.json.counts).toMatchObject({ pending: 1 });
    expect(other.json.items[0].warning).toContain('別の件名');
    expect(sent).toHaveLength(1);
  });

  it('keeps a message sent when its line in the history cannot be written', async () => {
    const { member, ids } = await linkedOrgs(1);
    const draft = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: draftBody(ids) });
    const spy = vi.spyOn(OrganizationsStore.prototype, 'recordMail').mockImplementation(() => {
      throw new Error('history unavailable');
    });
    try {
      const result = await sendAllOf(member.cookie, draft.json.id);
      expect(result.json.batch.counts).toMatchObject({ sent: 1, unknown: 0, failed: 0 });
      expect(sent).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('holds back a message whose subject is longer than the mail allows once the placeholders are filled in', async () => {
    const { member } = await linkedOrgs(0);
    const contact = await contactId(member.cookie, '合成 長文', 'long@partner.example');
    const org = (await call('POST', '/api/organizations', { cookie: member.cookie, body: organization({ name: '合成長文団体', contactId: contact, content: 'あ'.repeat(320) }) })).json.org.id as string;
    const draft = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: draftBody([org], { subject: '{協賛内容}', body: '本文です。' }) });
    expect(draft.json.counts).toMatchObject({ pending: 0, skipped: 1 });
    expect(draft.json.items[0].skipReason).toContain('件名が 300 字');
  });

  it('shows the sending entries only with mail access, and never the archive address', async () => {
    const { member } = await linkedOrgs(0);
    const meta = await call('GET', '/api/organizations/meta', { cookie: member.cookie });
    expect(meta.json.mail).toMatchObject({ enabled: true, readable: true });
    expect(meta.json.mail).not.toHaveProperty('bcc');
    expect(meta.json.limits).toMatchObject({ batch: 30, attachments: 10 });
    expect(JSON.stringify(meta.json)).not.toContain(ARCHIVE);
  });

  it('stops a batch from sending once the sender permission was taken away after the draft', async () => {
    const { chair, member, ids } = await linkedOrgs(1);
    const draft = await call('POST', '/api/organizations/mail/batches', { cookie: member.cookie, body: draftBody(ids) });
    const revoke = await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', send: false } });
    expect(revoke.status).toBe(200);
    const res = await call('POST', `/api/organizations/mail/batches/${draft.json.id}/send`, { cookie: member.cookie, body: { includeFailed: false } });
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});
