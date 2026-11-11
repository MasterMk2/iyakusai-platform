import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BulletinStore } from '../../src/server/bulletin/store.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { ADMIN, seedState, TEST_HOST, TEST_PORT } from '../helpers.js';

// The notice board over HTTP in the demo composition (persona cookie). Synthetic people and text only. The members
// with departments and the temporary-staff persona are added to the state for these tests.

const SOMU = 'u-somu';
const KAIKEI = 'u-kaikei';
const NAIMU = 'u-naimu';
const TEMP = 'u-temp-staff';
const TOKEN = 'tok-0123456789abcdef';

let dir: string;
let board: BulletinStore;
let app: FastifyInstance;
/** The server's clock: 2026-11-11 10:00 Japan time, moved by the tests. */
let now: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; json: any };

async function build(store: BulletinStore | null = board) {
  const seed = await seedState();
  seed.users.push(
    { id: SOMU, displayName: '合成 総務', roleLabel: '総務部', email: 'somu@example.invalid', canManageAccess: false },
    { id: KAIKEI, displayName: '合成 会計', roleLabel: '総務部・会計課', email: 'kaikei@example.invalid', canManageAccess: false },
    { id: NAIMU, displayName: '合成 内務', roleLabel: '内務部', email: 'naimu@example.invalid', canManageAccess: false },
    { id: TEMP, displayName: '合成 臨時', roleLabel: '臨時スタッフ', email: 'temp@example.invalid', canManageAccess: false },
  );
  app = await buildApp({ store: new StateStore(seed, null), listenPort: TEST_PORT, clock: () => new Date((now += 1000)).toISOString(), bulletin: store });
}

async function call(userId: string | null, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<Res> {
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

const draft = (over: Record<string, unknown> = {}) => ({ title: '合成のお知らせ', body: '合成の本文', important: false, departments: [], startsOn: null, endsOn: '2026-11-25', ...over });
const post = async (userId: string, over: Record<string, unknown> = {}, token = TOKEN) => (await call(userId, 'POST', '/api/bulletin', { ...draft(over), clientToken: token })).json.post;
const titles = async (userId: string, list = 'current') => (await call(userId, 'GET', `/api/bulletin?list=${list}`)).json.items.map((i: { title: string }) => i.title);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-bulletin-http-'));
  board = new BulletinStore(dir);
  now = Date.parse('2026-11-11T01:00:00.000Z');
});
afterEach(async () => {
  await app?.close();
  board.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('access', () => {
  it('needs a sign-in, and temporary staff are refused even for reading', async () => {
    await build();
    expect((await call(null, 'GET', '/api/bulletin')).status).toBe(401);
    expect((await call(null, 'GET', '/api/bulletin/meta')).status).toBe(401);
    expect((await call(TEMP, 'GET', '/api/bulletin')).status).toBe(403);
    expect((await call(TEMP, 'GET', '/api/bulletin/summary')).status).toBe(403);
    expect((await call(TEMP, 'POST', '/api/bulletin', { ...draft(), clientToken: TOKEN })).status).toBe(403);
    expect((await call(TEMP, 'GET', '/api/bulletin/meta')).json).toMatchObject({ enabled: false, canPost: false, departments: [] });
  });

  it('without the board only the meta route exists, and it says the board is off', async () => {
    await build(null);
    expect((await call(SOMU, 'GET', '/api/bulletin/meta')).json).toMatchObject({ enabled: false });
    expect((await call(SOMU, 'GET', '/api/bulletin')).status).toBe(404);
    expect((await call(SOMU, 'GET', '/api/bulletin/summary')).status).toBe(404);
  });

  it('offers the departments of the members in the organisation order, with today in Japan time', async () => {
    await build();
    const meta = (await call(KAIKEI, 'GET', '/api/bulletin/meta')).json;
    expect(meta).toMatchObject({ enabled: true, canPost: true, myDepartments: ['総務部', '会計課'], today: '2026-11-11' });
    const known = meta.departments.filter((d: string) => ['総務部', '会計課', '内務部'].includes(d));
    expect(known).toEqual(['総務部', '会計課', '内務部']);
    expect(meta.departments).not.toContain('臨時スタッフ');
  });
});

describe('who a notice is shown to', () => {
  it('a notice for everyone is new for every member but its writer, until they open it', async () => {
    await build();
    const made = await post(SOMU);
    expect(made).toMatchObject({ phase: 'current', unread: false, canEdit: true, targeted: true });

    const summary = (await call(NAIMU, 'GET', '/api/bulletin/summary')).json;
    expect(summary.unreadTotal).toBe(1);
    expect(summary.items[0]).toMatchObject({ id: made.id, unread: true, title: '合成のお知らせ', authorName: '合成 総務' });
    expect((await call(SOMU, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(0);

    expect((await call(NAIMU, 'POST', `/api/bulletin/${made.id}/read`, {})).json).toEqual({ unreadTotal: 0 });
    expect((await call(NAIMU, 'GET', '/api/bulletin/summary')).json).toEqual({ unreadTotal: 0, items: [] });
    expect((await call(NAIMU, 'GET', `/api/bulletin/${made.id}`)).json.post).toMatchObject({ unread: false, canEdit: false, readers: null });
    // The other member is not affected by that read.
    expect((await call(KAIKEI, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(1);
  });

  it('a notice for chosen departments is shown to their members, its writer and the access administrators only', async () => {
    await build();
    const made = await post(NAIMU, { title: '総務部向け', departments: ['総務部'] });
    expect(made).toMatchObject({ targeted: false, canEdit: true, unread: false });

    expect(await titles(SOMU)).toEqual(['総務部向け']);
    expect(await titles(KAIKEI)).toEqual(['総務部向け']);
    expect((await call(KAIKEI, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(1);

    // Another member of 内務部 (not the writer) is not shown it anywhere, and cannot open or mark it.
    const other = 'u-naimu-2';
    await app.close();
    const seed = await seedState();
    seed.users.push(
      { id: SOMU, displayName: '合成 総務', roleLabel: '総務部', email: 'somu@example.invalid', canManageAccess: false },
      { id: NAIMU, displayName: '合成 内務', roleLabel: '内務部', email: 'naimu@example.invalid', canManageAccess: false },
      { id: other, displayName: '合成 内務2', roleLabel: '内務部', email: 'naimu2@example.invalid', canManageAccess: false },
    );
    app = await buildApp({ store: new StateStore(seed, null), listenPort: TEST_PORT, clock: () => new Date((now += 1000)).toISOString(), bulletin: board });
    expect(await titles(other)).toEqual([]);
    expect((await call(other, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(0);
    expect((await call(other, 'GET', `/api/bulletin/${made.id}`)).status).toBe(404);
    expect((await call(other, 'POST', `/api/bulletin/${made.id}/read`, {})).status).toBe(404);
    expect((await call(other, 'PUT', `/api/bulletin/${made.id}`, { ...draft(), expectedVersion: 1, announce: false })).status).toBe(404);

    // The access administrator sees it (not as new: it is not for them) and may withdraw it.
    expect(await titles(ADMIN)).toEqual(['総務部向け']);
    expect((await call(ADMIN, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(0);
    expect((await call(ADMIN, 'GET', `/api/bulletin/${made.id}`)).json.post).toMatchObject({ targeted: false, canEdit: true, unread: false });
  });

  it('counts, for the writer, how many of the people it is for have opened it', async () => {
    await build();
    const made = await post(NAIMU, { departments: ['総務部'] });
    expect((await call(NAIMU, 'GET', `/api/bulletin/${made.id}`)).json.post.readers).toEqual({ read: 0, audience: 2 });
    await call(SOMU, 'POST', `/api/bulletin/${made.id}/read`, {});
    expect((await call(NAIMU, 'GET', `/api/bulletin/${made.id}`)).json.post.readers).toEqual({ read: 1, audience: 2 });
  });
});

describe('the days a notice is on the board', () => {
  it('a notice for later is shown to its writer only until its first day, then it is new for the others', async () => {
    await build();
    const made = await post(SOMU, { title: '来週から', startsOn: '2026-11-15', endsOn: '2026-11-20' });
    expect(made.phase).toBe('scheduled');
    expect(await titles(SOMU, 'scheduled')).toEqual(['来週から']);
    expect(await titles(SOMU)).toEqual([]);
    expect(await titles(NAIMU, 'scheduled')).toEqual([]);
    expect((await call(NAIMU, 'GET', `/api/bulletin/${made.id}`)).status).toBe(404);
    expect((await call(NAIMU, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(0);

    now = Date.parse('2026-11-14T15:00:00.000Z'); // 2026-11-15 00:00 in Japan
    expect(await titles(NAIMU)).toEqual(['来週から']);
    expect((await call(NAIMU, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(1);
  });

  it('after its last day a notice leaves the board and the home screen, and stays readable under 終了', async () => {
    await build();
    const made = await post(SOMU, { endsOn: '2026-11-12' });
    now = Date.parse('2026-11-12T14:00:00.000Z'); // 23:00 on the last day in Japan
    expect((await call(NAIMU, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(1);
    now = Date.parse('2026-11-12T15:00:00.000Z'); // the next day in Japan
    expect((await call(NAIMU, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(0);
    expect(await titles(NAIMU)).toEqual([]);
    expect(await titles(NAIMU, 'ended')).toEqual(['合成のお知らせ']);
    expect((await call(NAIMU, 'GET', `/api/bulletin/${made.id}`)).json.post).toMatchObject({ phase: 'ended', unread: false });
  });

  it('a notice without a last day stays, and 重要 comes first', async () => {
    await build();
    await post(SOMU, { title: '期限なし', endsOn: null }, 'tok-aaaaaaaaaaaaaaaa');
    await post(SOMU, { title: '重要なお知らせ', important: true }, 'tok-bbbbbbbbbbbbbbbb');
    await post(SOMU, { title: 'あとから', endsOn: '2026-11-30' }, 'tok-cccccccccccccccc');
    expect(await titles(NAIMU)).toEqual(['重要なお知らせ', 'あとから', '期限なし']);
    now = Date.parse('2027-03-01T00:00:00.000Z');
    expect(await titles(NAIMU)).toEqual(['期限なし']);
  });

  it('refuses days that cannot be: a last day before today or before the first day, and a day that does not exist', async () => {
    await build();
    for (const over of [{ endsOn: '2026-11-10' }, { startsOn: '2026-11-20', endsOn: '2026-11-19' }, { endsOn: '2026-02-30' }, { startsOn: '2026-13-01' }]) {
      const res = await call(SOMU, 'POST', '/api/bulletin', { ...draft(over), clientToken: TOKEN });
      expect(res.status, JSON.stringify(over)).toBe(422);
    }
    expect((await call(SOMU, 'POST', '/api/bulletin', { ...draft({ title: '   ' }), clientToken: TOKEN })).json).toMatchObject({ error: 'validation', details: { field: 'title' } });
    expect(board.count()).toBe(0);
  });
});

describe('writing and correcting', () => {
  it('a retried save with the same token makes one notice; other content under that token is refused', async () => {
    await build();
    const first = await call(SOMU, 'POST', '/api/bulletin', { ...draft(), clientToken: TOKEN });
    const again = await call(SOMU, 'POST', '/api/bulletin', { ...draft(), clientToken: TOKEN });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.json).toMatchObject({ replayed: true, post: { id: first.json.post.id } });
    expect((await call(SOMU, 'POST', '/api/bulletin', { ...draft({ title: '別の内容' }), clientToken: TOKEN })).status).toBe(409);
    expect(board.count()).toBe(1);
  });

  it('only the writer and the access administrators correct; a correction announced again is new for those who had read it', async () => {
    await build();
    const made = await post(SOMU);
    await call(NAIMU, 'POST', `/api/bulletin/${made.id}/read`, {});
    expect((await call(NAIMU, 'PUT', `/api/bulletin/${made.id}`, { ...draft({ title: '乗っ取り' }), expectedVersion: 1, announce: false })).status).toBe(403);

    const quiet = await call(SOMU, 'PUT', `/api/bulletin/${made.id}`, { ...draft({ body: '直した本文' }), expectedVersion: 1, announce: false });
    expect(quiet.json.post).toMatchObject({ version: 2, edited: true, body: '直した本文' });
    expect((await call(NAIMU, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(0);

    // A stale version is refused and nothing changes.
    expect((await call(SOMU, 'PUT', `/api/bulletin/${made.id}`, { ...draft({ title: '古い版から' }), expectedVersion: 1, announce: false })).status).toBe(409);

    const loud = await call(ADMIN, 'PUT', `/api/bulletin/${made.id}`, { ...draft({ body: '直した本文', endsOn: '2026-12-01' }), expectedVersion: 2, announce: true });
    expect(loud.json.post).toMatchObject({ version: 3, endsOn: '2026-12-01', updatedByName: 'デモ管理者' });
    expect((await call(NAIMU, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(1);
    // The writer did not make that correction, so it is new for them too.
    expect((await call(SOMU, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(1);
  });

  it('a withdrawn notice leaves the board for everyone else and can be put back as it was', async () => {
    await build();
    const made = await post(SOMU);
    expect((await call(NAIMU, 'POST', `/api/bulletin/${made.id}/withdraw`, { expectedVersion: 1 })).status).toBe(403);
    const gone = await call(SOMU, 'POST', `/api/bulletin/${made.id}/withdraw`, { expectedVersion: 1 });
    expect(gone.json.post).toMatchObject({ status: 'withdrawn', phase: 'withdrawn', version: 2 });
    expect(await titles(NAIMU)).toEqual([]);
    expect(await titles(NAIMU, 'ended')).toEqual([]);
    expect((await call(NAIMU, 'GET', `/api/bulletin/${made.id}`)).status).toBe(404);
    expect((await call(NAIMU, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(0);
    expect(await titles(SOMU, 'ended')).toEqual(['合成のお知らせ']);
    // A withdrawn notice is not corrected; it is put back first.
    expect((await call(SOMU, 'PUT', `/api/bulletin/${made.id}`, { ...draft({ title: '直す' }), expectedVersion: 2, announce: false })).status).toBe(409);

    const back = await call(SOMU, 'POST', `/api/bulletin/${made.id}/restore`, { expectedVersion: 2 });
    expect(back.json.post).toMatchObject({ status: 'open', phase: 'current', version: 3, endsOn: '2026-11-25' });
    expect((await call(NAIMU, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(1);
    expect(board.history(made.id).map((h) => h.action)).toEqual(['restored', 'withdrawn', 'created']);
  });

  it('read-all marks what is on the board for this person and nothing else', async () => {
    await build();
    await post(SOMU, { title: '全員へ' }, 'tok-aaaaaaaaaaaaaaaa');
    await post(SOMU, { title: '内務部へ', departments: ['内務部'] }, 'tok-bbbbbbbbbbbbbbbb');
    expect((await call(KAIKEI, 'GET', '/api/bulletin?list=current')).json).toMatchObject({ total: 1, unreadTotal: 1 });
    expect((await call(NAIMU, 'GET', '/api/bulletin?list=ended')).json).toMatchObject({ total: 0, unreadTotal: 2 });
    expect((await call(NAIMU, 'POST', '/api/bulletin/read-all', {})).json).toEqual({ unreadTotal: 0 });
    expect((await call(KAIKEI, 'GET', '/api/bulletin/summary')).json.unreadTotal).toBe(1);
  });
});
