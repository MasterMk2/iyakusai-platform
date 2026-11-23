import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { VaultCipher } from '../../src/server/vault/cipher.js';
import { VaultStore } from '../../src/server/vault/store.js';
import { ADMIN, seedState, TEST_HOST, TEST_PORT } from '../helpers.js';

// パスワード帳 over HTTP in the demo composition (persona cookie). Synthetic people, names and passwords only.

const SOMU = 'u-somu';
const KAIKEI = 'u-kaikei';
const NAIMU = 'u-naimu';
const TEMP = 'u-temp-staff';
const PASSWORD = 'Synthetic-Pass-1234';
const KEY = Buffer.from('0123456789abcdef0123456789abcdef-synthetic-test-key', 'utf8');

let dir: string;
let store: VaultStore;
let app: FastifyInstance;
/** The server's clock, moved by the tests. */
let now: number;
/** When each persona last typed the password (default: just now). */
let typedAt: Map<string, number>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; json: any };

async function build(opts: { off?: boolean; key?: Buffer } = {}) {
  const seed = await seedState();
  seed.users.push(
    { id: SOMU, displayName: '合成 総務', roleLabel: '総務部', email: 'somu@example.invalid', canManageAccess: false },
    { id: KAIKEI, displayName: '合成 会計', roleLabel: '総務部・会計課', email: 'kaikei@example.invalid', canManageAccess: false },
    { id: NAIMU, displayName: '合成 内務', roleLabel: '内務部', email: 'naimu@example.invalid', canManageAccess: false },
    { id: TEMP, displayName: '合成 臨時', roleLabel: '臨時スタッフ', email: 'temp@example.invalid', canManageAccess: false },
  );
  app = await buildApp({
    store: new StateStore(seed, null),
    listenPort: TEST_PORT,
    clock: () => new Date(now).toISOString(),
    vault: opts.off ? null : { store, cipher: new VaultCipher(opts.key ?? KEY), revealMinutes: 10, demoPasswordAt: (userId) => typedAt.get(userId) ?? now },
  });
}

async function call(userId: string | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Res> {
  const res = await app.inject({
    method,
    url,
    headers: { host: TEST_HOST, ...(method !== 'GET' ? { origin: `http://${TEST_HOST}`, 'x-smm-csrf': '1' } : {}), ...(userId ? { cookie: `${SESSION_COOKIE}=${userId}` } : {}) },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  return { status: res.statusCode, json };
}

let tokens = 0;
const token = () => `tok-synthetic-${String(++tokens).padStart(6, '0')}`;
const newSection = async (name = '合成の区分') => (await call(ADMIN, 'POST', '/api/vault/sections', { name, note: '' })).json.section;
const grant = async (actor: string, sectionId: string, kind: 'user' | 'department', target: string, role: string | null) => {
  const members = (await call(actor, 'GET', `/api/vault/sections/${sectionId}/members`)).json;
  return call(actor, 'PUT', `/api/vault/sections/${sectionId}/members`, { kind, target, role, expectedVersion: members.section.version });
};
const addEntry = async (actor: string, sectionId: string, over: Record<string, unknown> = {}) =>
  call(actor, 'POST', '/api/vault/entries', { sectionId, name: '合成の管理画面', url: 'https://console.example.invalid', username: 'synthetic-admin', password: PASSWORD, notes: '合成のメモ', clientToken: token(), ...over });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-vault-http-'));
  store = new VaultStore(dir);
  now = Date.parse('2026-11-23T01:00:00.000Z');
  typedAt = new Map();
});
afterEach(async () => {
  await app?.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('access', () => {
  it('needs a sign-in; temporary staff and members on no section are refused', async () => {
    await build();
    expect((await call(null, 'GET', '/api/vault/meta')).status).toBe(401);
    expect((await call(TEMP, 'GET', '/api/vault/meta')).json).toMatchObject({ enabled: false, canOpen: false });
    expect((await call(TEMP, 'GET', '/api/vault/sections')).status).toBe(403);
    expect((await call(SOMU, 'GET', '/api/vault/meta')).json).toMatchObject({ enabled: true, canOpen: false, canAdminister: false });
    expect((await call(SOMU, 'GET', '/api/vault/sections')).status).toBe(403);
    expect((await call(ADMIN, 'GET', '/api/vault/meta')).json).toMatchObject({ enabled: true, canOpen: true, canAdminister: true, revealMinutes: 10 });
  });

  it('without the password book only the meta route exists, and it says it is off', async () => {
    await build({ off: true });
    expect((await call(ADMIN, 'GET', '/api/vault/meta')).json).toMatchObject({ enabled: false });
    expect((await call(ADMIN, 'GET', '/api/vault/sections')).status).toBe(404);
    expect((await call(ADMIN, 'GET', '/api/vault/entries')).status).toBe(404);
  });

  it('only access administrators make sections; the maker is its first manager', async () => {
    await build();
    expect((await call(SOMU, 'POST', '/api/vault/sections', { name: '合成', note: '' })).status).toBe(403);
    const section = await newSection('システム（合成）');
    expect(section).toMatchObject({ name: 'システム（合成）', myRole: 'manage', canManage: true, entryCount: 0, lastPrintedAt: null });
    expect((await call(ADMIN, 'POST', '/api/vault/sections', { name: 'システム（合成）', note: '' })).status).toBe(409);
  });

  it('a section opens for its departments and its named members, with the stronger role winning', async () => {
    await build();
    const s = await newSection();
    expect((await grant(ADMIN, s.id, 'department', '総務部', 'view')).status).toBe(200);
    expect((await grant(ADMIN, s.id, 'user', KAIKEI, 'edit')).status).toBe(200);
    // 総務部 sees it through the department; 会計 holds both and gets 編集する; 内務部 is not on it.
    expect((await call(SOMU, 'GET', '/api/vault/sections')).json.sections.map((x: { myRole: string }) => x.myRole)).toEqual(['view']);
    expect((await call(KAIKEI, 'GET', '/api/vault/sections')).json.sections.map((x: { myRole: string }) => x.myRole)).toEqual(['edit']);
    expect((await call(NAIMU, 'GET', '/api/vault/sections')).status).toBe(403);
    const members = (await call(SOMU, 'GET', `/api/vault/sections/${s.id}/members`)).json;
    const opener = (id: string) => members.openers.find((o: { id: string }) => o.id === id);
    expect(opener(KAIKEI)).toMatchObject({ role: 'edit', via: ['総務部', '個人の指定'] });
    expect(opener(SOMU)).toMatchObject({ role: 'view', via: ['総務部'] });
    expect(opener(NAIMU)).toBeUndefined();
    expect(members.choices.departments).toEqual(expect.arrayContaining(['総務部', '会計課', '内務部']));
    expect(members.choices.departments).not.toContain('臨時スタッフ');
  });

  it('refuses unknown people and departments, and changing who opens a section without 管理する', async () => {
    await build();
    const s = await newSection();
    expect((await grant(ADMIN, s.id, 'department', '存在しない部', 'view')).status).toBe(422);
    expect((await grant(ADMIN, s.id, 'user', TEMP, 'view')).status).toBe(422);
    await grant(ADMIN, s.id, 'user', SOMU, 'edit');
    expect((await grant(SOMU, s.id, 'user', NAIMU, 'view')).status).toBe(403);
    // Someone on no section does not learn that it exists.
    expect((await call(NAIMU, 'PUT', `/api/vault/sections/${s.id}/members`, { kind: 'user', target: NAIMU, role: 'view', expectedVersion: 1 })).status).toBe(404);
  });

  it('keeps at least one manager named in person', async () => {
    await build();
    const s = await newSection();
    await grant(ADMIN, s.id, 'department', '総務部', 'manage');
    // A department's 管理する does not count: someone named in person must keep it.
    expect((await grant(ADMIN, s.id, 'user', ADMIN, null)).status).toBe(409);
    await grant(ADMIN, s.id, 'user', NAIMU, 'manage');
    expect((await grant(ADMIN, s.id, 'user', ADMIN, null)).status).toBe(200);
    expect((await grant(NAIMU, s.id, 'user', NAIMU, 'edit')).status).toBe(409);
  });

  it('an access administrator who left a section sees its name and members, never its values', async () => {
    await build();
    const s = await newSection();
    await grant(ADMIN, s.id, 'user', SOMU, 'manage');
    const created = (await addEntry(SOMU, s.id)).json.entry;
    await grant(ADMIN, s.id, 'user', ADMIN, null);
    const sections = (await call(ADMIN, 'GET', '/api/vault/sections')).json.sections;
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ myRole: null, canManage: true, entryCount: 1 });
    expect((await call(ADMIN, 'GET', '/api/vault/entries')).json.entries).toEqual([]);
    expect((await call(ADMIN, 'POST', `/api/vault/entries/${created.id}/reveal`, { field: 'password', purpose: 'show' })).status).toBe(404);
    // The section is known to them (it is in their list), so the print is refused rather than hidden.
    expect((await call(ADMIN, 'POST', `/api/vault/sections/${s.id}/print`, {})).status).toBe(403);
    // The record says what happened, not to which entry.
    const record = await call(ADMIN, 'GET', `/api/vault/sections/${s.id}/events`);
    expect(record.status).toBe(200);
    expect(record.json.events.find((e: { action: string }) => e.action === 'entry_created')).toMatchObject({ entryName: '（項目）' });
    expect(JSON.stringify(record.json)).not.toContain('合成の管理画面');
    // Putting themselves back is a recorded change.
    expect((await grant(ADMIN, s.id, 'user', ADMIN, 'view')).status).toBe(200);
    const events = (await call(SOMU, 'GET', `/api/vault/sections/${s.id}/events`)).json.events;
    expect(events[0]).toMatchObject({ action: 'member_set', actorName: 'デモ管理者' });
  });
});

describe('entries', () => {
  it('lists names, addresses and IDs only; a password leaves one at a time, recorded first', async () => {
    await build();
    const s = await newSection();
    await grant(ADMIN, s.id, 'user', SOMU, 'view');
    const created = (await addEntry(ADMIN, s.id)).json.entry;
    const list = await call(SOMU, 'GET', '/api/vault/entries');
    expect(list.status).toBe(200);
    expect(list.json.entries).toEqual([expect.objectContaining({ id: created.id, name: '合成の管理画面', username: 'synthetic-admin', hasPassword: true, hasNotes: true })]);
    expect(JSON.stringify(list.json)).not.toContain(PASSWORD);
    expect(JSON.stringify(list.json)).not.toContain('合成のメモ');
    const shown = await call(SOMU, 'POST', `/api/vault/entries/${created.id}/reveal`, { field: 'password', purpose: 'copy' });
    expect(shown.json).toEqual({ field: 'password', value: PASSWORD });
    expect((await call(SOMU, 'POST', `/api/vault/entries/${created.id}/reveal`, { field: 'notes', purpose: 'show' })).json.value).toBe('合成のメモ');
    const events = store.events(s.id);
    expect(events.slice(0, 2).map((e) => [e.action, e.actorId, e.detail.field])).toEqual([
      ['revealed', SOMU, 'notes'],
      ['copied', SOMU, 'password'],
    ]);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    // The record is for managers: a viewer cannot read it.
    expect((await call(SOMU, 'GET', `/api/vault/sections/${s.id}/events`)).status).toBe(403);
    const forManager = (await call(ADMIN, 'GET', `/api/vault/sections/${s.id}/events`)).json.events;
    expect(forManager[0]).toMatchObject({ action: 'revealed', actorName: '合成 総務', entryName: '合成の管理画面', detail: 'メモ' });
  });

  it('needs 編集する to add, change and remove; a member of another section does not see the entry', async () => {
    await build();
    const s = await newSection();
    const other = await newSection('別の区分（合成）');
    await grant(ADMIN, s.id, 'user', SOMU, 'view');
    await grant(ADMIN, other.id, 'user', NAIMU, 'edit');
    expect((await addEntry(SOMU, s.id)).status).toBe(403);
    const created = (await addEntry(ADMIN, s.id)).json.entry;
    expect((await call(SOMU, 'DELETE', `/api/vault/entries/${created.id}?expectedVersion=1`)).status).toBe(403);
    expect((await call(NAIMU, 'POST', `/api/vault/entries/${created.id}/reveal`, { field: 'password', purpose: 'show' })).status).toBe(404);
    expect((await call(NAIMU, 'GET', '/api/vault/entries')).json.entries).toEqual([]);
  });

  it('a retried save returns the first entry; another content under the same token is refused', async () => {
    await build();
    const s = await newSection();
    const body = { sectionId: s.id, name: '合成', url: '', username: '', password: 'p', notes: '', clientToken: 'tok-synthetic-replay-01' };
    expect((await call(ADMIN, 'POST', '/api/vault/entries', body)).status).toBe(201);
    const again = await call(ADMIN, 'POST', '/api/vault/entries', body);
    expect(again.status).toBe(200);
    expect(again.json.replayed).toBe(true);
    expect((await call(ADMIN, 'POST', '/api/vault/entries', { ...body, password: 'q' })).status).toBe(409);
    expect(store.entryCount(s.id)).toBe(1);
  });

  it('a change keeps the password when it is not sent, names the changed fields, and refuses a stale version', async () => {
    await build();
    const s = await newSection();
    const created = (await addEntry(ADMIN, s.id)).json.entry;
    const changed = await call(ADMIN, 'PUT', `/api/vault/entries/${created.id}`, { sectionId: s.id, name: '合成の管理画面（新）', url: 'https://console.example.invalid', username: 'synthetic-admin', password: null, notes: null, expectedVersion: 1 });
    expect(changed.status).toBe(200);
    expect(changed.json.entry).toMatchObject({ name: '合成の管理画面（新）', version: 2 });
    expect((await call(ADMIN, 'POST', `/api/vault/entries/${created.id}/reveal`, { field: 'password', purpose: 'show' })).json.value).toBe(PASSWORD);
    expect(store.events(s.id).find((e) => e.action === 'entry_updated')?.detail.changed).toEqual(['name']);
    expect((await call(ADMIN, 'PUT', `/api/vault/entries/${created.id}`, { sectionId: s.id, name: 'x', url: '', username: '', password: 'new', notes: null, expectedVersion: 1 })).status).toBe(409);
  });

  it('moves an entry to another section the person can edit, sealed again for it', async () => {
    await build();
    const a = await newSection('A（合成）');
    const b = await newSection('B（合成）');
    const created = (await addEntry(ADMIN, a.id)).json.entry;
    const moved = await call(ADMIN, 'PUT', `/api/vault/entries/${created.id}`, { sectionId: b.id, name: '合成の管理画面', url: 'https://console.example.invalid', username: 'synthetic-admin', password: null, notes: null, expectedVersion: 1 });
    expect(moved.json.entry.sectionId).toBe(b.id);
    expect((await call(ADMIN, 'POST', `/api/vault/entries/${created.id}/reveal`, { field: 'password', purpose: 'show' })).json.value).toBe(PASSWORD);
    expect(store.printState(a.id).changesSincePrint).toBe(2);
    expect(store.printState(b.id).changesSincePrint).toBe(1);
  });

  it('a section with entries cannot be removed; an empty one can', async () => {
    await build();
    const s = await newSection();
    const created = (await addEntry(ADMIN, s.id)).json.entry;
    expect((await call(ADMIN, 'DELETE', `/api/vault/sections/${s.id}?expectedVersion=${s.version}`)).status).toBe(409);
    expect((await call(ADMIN, 'DELETE', `/api/vault/entries/${created.id}?expectedVersion=1`)).status).toBe(200);
    expect((await call(ADMIN, 'DELETE', `/api/vault/sections/${s.id}?expectedVersion=${s.version}`)).status).toBe(200);
    expect(store.sections()).toEqual([]);
  });
});

describe('the password typed again', () => {
  it('entries, values, prints and changes need the password typed within the window; names of sections do not', async () => {
    await build();
    const s = await newSection();
    const created = (await addEntry(ADMIN, s.id)).json.entry;
    typedAt.set(ADMIN, now - 11 * 60_000);
    expect((await call(ADMIN, 'GET', '/api/vault/meta')).json.freshUntil).toBeNull();
    expect((await call(ADMIN, 'GET', '/api/vault/sections')).status).toBe(200);
    for (const [method, url, body] of [
      ['GET', '/api/vault/entries', undefined],
      ['POST', `/api/vault/entries/${created.id}/reveal`, { field: 'password', purpose: 'show' }],
      ['POST', `/api/vault/sections/${s.id}/print`, {}],
      ['POST', '/api/vault/entries', { sectionId: s.id, name: '合成', url: '', username: '', password: '', notes: '', clientToken: token() }],
      ['PUT', `/api/vault/sections/${s.id}/members`, { kind: 'user', target: SOMU, role: 'view', expectedVersion: s.version }],
    ] as const) {
      const res = await call(ADMIN, method, url, body);
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.json.error).toBe('vault_reauth_required');
    }
    // The record still opens past the window, without the entries' names.
    const record = (await call(ADMIN, 'GET', `/api/vault/sections/${s.id}/events`)).json;
    expect(JSON.stringify(record)).not.toContain('合成の管理画面');
    typedAt.set(ADMIN, now - 9 * 60_000);
    expect((await call(ADMIN, 'GET', '/api/vault/meta')).json.freshUntil).toBe(new Date(now + 60_000).toISOString());
    expect((await call(ADMIN, 'GET', '/api/vault/entries')).status).toBe(200);
  });

  it('a card sign-in (no password time) always types it first', async () => {
    await build();
    await newSection();
    typedAt.set(ADMIN, 0);
    expect((await call(ADMIN, 'GET', '/api/vault/entries')).status).toBe(401);
  });
});

describe('the paper copy', () => {
  it('hands out the whole section once, recorded with its edition; later changes count as out of date', async () => {
    await build();
    const s = await newSection();
    await addEntry(ADMIN, s.id);
    await addEntry(ADMIN, s.id, { name: '合成のドメイン', password: 'Synthetic-Pass-5678' });
    expect(store.printState(s.id)).toEqual({ lastPrintedAt: null, changesSincePrint: 2 });
    const printed = await call(ADMIN, 'POST', `/api/vault/sections/${s.id}/print`, {});
    expect(printed.status).toBe(200);
    expect(printed.json.edition).toMatch(/^[0-9A-F]{6}$/);
    expect(printed.json.entries.map((e: { name: string; password: string }) => [e.name, e.password])).toEqual([
      ['合成のドメイン', 'Synthetic-Pass-5678'],
      ['合成の管理画面', PASSWORD],
    ]);
    expect(store.printState(s.id)).toEqual({ lastPrintedAt: new Date(now).toISOString(), changesSincePrint: 0 });
    await addEntry(ADMIN, s.id, { name: '合成の 3 件目' });
    const summary = (await call(ADMIN, 'GET', '/api/vault/sections')).json.sections[0];
    expect(summary.changesSincePrint).toBe(1);
    const again = (await call(ADMIN, 'POST', `/api/vault/sections/${s.id}/print`, {})).json;
    expect(again.edition).not.toBe(printed.json.edition);
  });
});

describe('at rest', () => {
  it('the file holds no name, ID, password or note in the clear', async () => {
    await build();
    const s = await newSection();
    await addEntry(ADMIN, s.id);
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(path.join(dir, 'vault.sqlite3'));
    for (const plain of [PASSWORD, '合成のメモ', '合成の管理画面', 'synthetic-admin', 'console.example.invalid']) {
      expect(bytes.includes(Buffer.from(plain, 'utf8')), plain).toBe(false);
    }
  });

  it('an entry moved to another section by hand, or opened with another key, is not shown', async () => {
    await build();
    const a = await newSection('A（合成）');
    const b = await newSection('B（合成）');
    const created = (await addEntry(ADMIN, a.id)).json.entry;
    store.db.prepare('UPDATE entries SET section_id=? WHERE id=?').run(b.id, created.id);
    const list = (await call(ADMIN, 'GET', '/api/vault/entries')).json;
    expect(list).toMatchObject({ entries: [], unreadable: 1 });
    expect((await call(ADMIN, 'POST', `/api/vault/entries/${created.id}/reveal`, { field: 'password', purpose: 'show' })).status).toBe(500);
    store.db.prepare('UPDATE entries SET section_id=? WHERE id=?').run(a.id, created.id);
    await app.close();
    await build({ key: Buffer.from('another-synthetic-key-of-enough-length-0000', 'utf8') });
    expect((await call(ADMIN, 'GET', '/api/vault/entries')).json).toMatchObject({ entries: [], unreadable: 1 });
  });
});
