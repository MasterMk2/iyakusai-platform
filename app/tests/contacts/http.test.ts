import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContactsStore, CONTACTS_FILE } from '../../src/server/contacts/store.js';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, setup, testConfig } from '../discord-auth/helpers.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { testMailboxConfig } from '../mailbox/helpers.js';

// Committee contacts inside the unified app (Discord login), over HTTP on loopback. Synthetic names and
// reserved .example addresses only.

const ROLE_STAFF = '1000000000000002099';
let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
const ORIGIN = `http://${TEST_HOST}`;

async function build(options: { mailChanges?: Record<string, unknown> } = {}) {
  const config = testMailboxConfig(path.join(dir, 'mail'), options.mailChanges ?? {}, randomBytes(32));
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

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-contacts-http-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup({ config: testConfig({ departmentRoleIds: { [ROLE_STAFF]: '臨時スタッフ' } }) });
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, options: { body?: unknown; cookie?: string } = {}) {
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
  return { status: res.statusCode, headers: res.headers, json: json as any, body: res.body };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

async function signIn(uid: string, studentId: string, roles: string[] = []) {
  await register(ctx, uid, studentId, roles);
  const login = await call('POST', '/api/auth/login', { body: { loginId: studentId, password: PASSWORD } });
  expect(login.status).toBe(200);
  return cookieOf(login.headers['set-cookie']);
}

const sponsor = {
  category: 'external',
  organization: '株式会社合成商事',
  section: '営業部',
  name: '合成 一郎',
  nameKana: 'ごうせい いちろう',
  emails: [{ label: '', address: 'ichiro@partner.example' }],
  phones: [{ label: '代表', number: '076-000-0001' }],
  postalCode: '9300000',
  address: '合成県合成市1-1',
  tags: ['協賛'],
  notes: '',
};

describe('a contacts file that cannot be opened', () => {
  it('turns off the contacts only; the mailbox still works', async () => {
    const folder = path.join(dir, 'mail');
    const broken = new ContactsStore(folder);
    broken.db.prepare("UPDATE meta SET value='99' WHERE key='schema'").run();
    broken.close();
    await build();
    const member = await signIn(MEMBER, '21000002');
    expect((await call('GET', '/api/mailboxes', { cookie: member })).status).toBe(200);
    const res = await call('GET', '/api/contacts', { cookie: member });
    expect(res.status).toBe(503);
    expect(res.json.error).toBe('contacts_unavailable');
    expect((await call('GET', '/api/contacts')).status).toBe(401);
  });
});

describe('committee contacts', () => {
  beforeEach(() => build());

  it('lets a member add, find, open and edit a contact, keeping who changed what', async () => {
    const member = await signIn(MEMBER, '21000002');
    const created = await call('POST', '/api/contacts', { cookie: member, body: sponsor });
    expect(created.status).toBe(201);
    const id = created.json.contact.id as string;
    expect(created.json.contact).toMatchObject({ postalCode: '930-0000', version: 1, createdByName: '合成 太郎', source: '' });
    expect(created.json.canAdminister).toBe(false);
    expect(existsSync(path.join(dir, 'mail', CONTACTS_FILE))).toBe(true);

    // Found by reading (katakana), by the digits of the number, by the address, by the company without 株式会社.
    for (const q of ['ゴウセイ', '0760000001', 'ichiro@', '合成商事', '合成一郎']) {
      const list = await call('GET', `/api/contacts?q=${encodeURIComponent(q)}`, { cookie: member });
      expect(list.json.items.map((i: { id: string }) => i.id), q).toEqual([id]);
    }
    const list = await call('GET', '/api/contacts', { cookie: member });
    expect(list.json).toMatchObject({ total: 1, counts: { all: 1, external: 1, member: 0 }, tags: [{ tag: '協賛', count: 1 }] });
    expect(list.json.items[0]).toMatchObject({ email: 'ichiro@partner.example', phone: { label: '代表', number: '076-000-0001' } });

    const other = await signIn(OTHER, '21000003');
    const edited = await call('PUT', `/api/contacts/${id}`, { cookie: other, body: { expectedVersion: 1, contact: { ...sponsor, section: '総務部', tags: ['協賛', '2026'] } } });
    expect(edited.status).toBe(200);
    expect(edited.json.contact).toMatchObject({ version: 2, section: '総務部', updatedByName: '合成 花子' });
    expect(edited.json.history.map((h: { action: string; changed: string[] }) => [h.action, h.changed])).toEqual([
      ['updated', ['section', 'tags']],
      ['created', []],
    ]);

    // Saving over someone else's change is refused; nothing changes.
    const stale = await call('PUT', `/api/contacts/${id}`, { cookie: member, body: { expectedVersion: 1, contact: { ...sponsor, name: '上書き' } } });
    expect(stale.status).toBe(409);
    expect((await call('GET', `/api/contacts/${id}`, { cookie: member })).json.contact.name).toBe('合成 一郎');
  });

  it('answers a wrong field with its name and keeps the list as it was', async () => {
    const member = await signIn(MEMBER, '21000002');
    const res = await call('POST', '/api/contacts', { cookie: member, body: { ...sponsor, emails: [{ label: '', address: 'not-an-address' }] } });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: 'validation', details: { field: 'emails.0' } });
    expect((await call('GET', '/api/contacts', { cookie: member })).json.total).toBe(0);
  });

  it('offers addresses for the mail form and tells which senders are known', async () => {
    const member = await signIn(MEMBER, '21000002');
    await call('POST', '/api/contacts', { cookie: member, body: { ...sponsor, emails: [{ label: '', address: 'ichiro@partner.example' }, { label: '請求書', address: 'billing@partner.example' }] } });
    await call('POST', '/api/contacts', { cookie: member, body: { category: 'committee', organization: '合成委員会 渉外課', emails: [{ label: '', address: 'sales@committee.example' }] } });
    const suggest = await call('GET', `/api/contacts/suggest?q=${encodeURIComponent('ごうせい')}`, { cookie: member });
    expect(suggest.json.map((s: { address: string; name: string; label: string }) => [s.name, s.address, s.label])).toEqual([
      ['合成 一郎', 'ichiro@partner.example', ''],
      ['合成 一郎', 'billing@partner.example', '請求書'],
    ]);
    // An address that starts with the typed text comes first.
    const byAddress = await call('GET', '/api/contacts/suggest?q=bill', { cookie: member });
    expect(byAddress.json.map((s: { address: string }) => s.address)).toEqual(['billing@partner.example']);
    const known = await call('GET', `/api/contacts/by-address?addresses=${encodeURIComponent('ICHIRO@partner.example,stranger@partner.example')}`, { cookie: member });
    expect(known.json).toEqual([{ address: 'ichiro@partner.example', contactId: expect.stringMatching(/^ct_/), name: '合成 一郎' }]);
    // A sender that is not an address (it happens in received mail) is left out, not refused.
    const mixed = await call('GET', `/api/contacts/by-address?addresses=${encodeURIComponent('bad,ichiro@partner.example')}`, { cookie: member });
    expect(mixed.status).toBe(200);
    expect(mixed.json.map((m: { address: string }) => m.address)).toEqual(['ichiro@partner.example']);
  });

  it('keeps delete, import and export for access administrators', async () => {
    const member = await signIn(MEMBER, '21000002');
    const chair = await signIn(CHAIR, '21000001');
    const created = (await call('POST', '/api/contacts', { cookie: member, body: sponsor })).json.contact;

    expect((await call('DELETE', `/api/contacts/${created.id}?expectedVersion=1`, { cookie: member })).status).toBe(403);
    expect((await call('POST', '/api/contacts/import', { cookie: member, body: { contacts: [sponsor], dryRun: true } })).status).toBe(403);
    expect((await call('GET', '/api/contacts/export.csv', { cookie: member })).status).toBe(403);

    expect((await call('DELETE', `/api/contacts/${created.id}?expectedVersion=9`, { cookie: chair })).status).toBe(409);
    expect((await call('DELETE', `/api/contacts/${created.id}?expectedVersion=1`, { cookie: chair })).status).toBe(204);
    expect((await call('GET', `/api/contacts/${created.id}`, { cookie: member })).status).toBe(404);
  });

  it('imports a checked list once: a dry run first, repeats and known addresses left out, wrong rows reported', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await call('POST', '/api/contacts', { cookie: chair, body: sponsor });
    const list = [
      { ...sponsor, name: '別名', source: '協賛マスター 12行目' }, // same address as the stored one
      { category: 'exhibitor', organization: '合成サークル', name: '', emails: [], phones: [{ label: '代表者', number: '090-0000-0002' }], source: '出展団体一覧 3行目' },
      { category: 'exhibitor', organization: '合成サークル', name: '', source: '別の資料' }, // repeat within the list
      { category: 'external', organization: '', name: '' }, // neither name nor organization
      { category: 'committee', organization: '合成委員会 会計課', emails: [{ label: '', address: 'kaikei@committee.example' }], source: '委員会アドレス一覧' },
    ];
    const dry = await call('POST', '/api/contacts/import', { cookie: chair, body: { contacts: list, dryRun: true } });
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({ dryRun: true, added: 2 });
    expect(dry.json.duplicates.map((d: { index: number }) => d.index)).toEqual([0, 2]);
    expect(dry.json.invalid.map((d: { index: number }) => d.index)).toEqual([3]);
    expect((await call('GET', '/api/contacts', { cookie: chair })).json.total).toBe(1);

    const real = await call('POST', '/api/contacts/import', { cookie: chair, body: { contacts: list, dryRun: false } });
    expect(real.json).toMatchObject({ dryRun: false, added: 2 });
    const after = await call('GET', '/api/contacts?category=exhibitor', { cookie: chair });
    expect(after.json.items).toHaveLength(1);
    const detail = await call('GET', `/api/contacts/${after.json.items[0].id}`, { cookie: chair });
    expect(detail.json.contact.source).toBe('出展団体一覧 3行目');
    expect(detail.json.history.map((h: { action: string }) => h.action)).toEqual(['imported']);
    // Importing the same list again adds nothing.
    expect((await call('POST', '/api/contacts/import', { cookie: chair, body: { contacts: list, dryRun: false } })).json.added).toBe(0);
  });

  it('exports a spreadsheet that never runs a formula', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await call('POST', '/api/contacts', { cookie: chair, body: { ...sponsor, notes: '=HYPERLINK("http://example.invalid")', phones: [{ label: '', number: '+81 76 000 0001' }] } });
    const res = await call('GET', '/api/contacts/export.csv', { cookie: chair });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(res.body.startsWith('\ufeff"種類","組織・団体"')).toBe(true);
    expect(res.body).toContain(`"'=HYPERLINK(""http://example.invalid"")"`);
    expect(res.body).toContain(`"'+81 76 000 0001"`);
  });

  it('refuses long lists before reading them, and characters that disguise a name', async () => {
    const member = await signIn(MEMBER, '21000002');
    const many = Array.from({ length: 1000 }, (_, i) => ({ label: '', number: `090-0000-${String(i).padStart(4, '0')}` }));
    const started = Date.now();
    const long = await call('POST', '/api/contacts', { cookie: member, body: { ...sponsor, phones: many } });
    expect(long.status).toBe(422);
    expect(long.json.details).toEqual({ field: 'phones' });
    expect(Date.now() - started).toBeLessThan(1000);
    const disguised = await call('POST', '/api/contacts', { cookie: member, body: { ...sponsor, name: '合成\u202e郎一' } });
    expect(disguised.status).toBe(422);
    expect(disguised.json.details).toEqual({ field: 'name' });
    expect((await call('POST', '/api/contacts/import', { body: { contacts: [sponsor], dryRun: true } })).status).toBe(401);
  });

  it('refuses people who are not signed in and temporary staff', async () => {
    expect((await call('GET', '/api/contacts')).status).toBe(401);
    const staff = await signIn(OTHER, '21000003', [ROLE_STAFF]);
    expect((await call('GET', '/api/contacts', { cookie: staff })).status).toBe(403);
    expect((await call('POST', '/api/contacts', { cookie: staff, body: sponsor })).status).toBe(403);
  });

  it('opens even when mail would need the password again (contacts hold no mail)', async () => {
    await app.close();
    mail.close();
    await build({ mailChanges: { previewDiscordUserIds: [CHAIR] } });
    const member = await signIn(MEMBER, '21000002');
    expect((await call('GET', '/api/mailboxes', { cookie: member })).json).toEqual([]);
    expect((await call('GET', '/api/contacts', { cookie: member })).status).toBe(200);
  });
});
