import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CalendarStore } from '../../src/server/calendar/store.js';
import { DayOfStore } from '../../src/server/dayof/store.js';
import { DecisionsStore } from '../../src/server/decisions/store.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { seedRentalDemo } from '../../src/server/rental/seed.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { diffDayOfPosts, type DayOfBoardResponse, type DayOfNoticesResponse } from '../../src/shared/dayof.js';
import { ADMIN, EDITOR_A, EDITOR_C, seedState, TEST_HOST, TEST_PORT, VIEWER_B } from '../helpers.js';

// The festival-day board over HTTP in the demo composition (persona cookie). Synthetic people, places and text only.
// Added to the demo personas: a temporary-staff account and two members whose roles name departments.

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TEMP = 'u-temp-staff';
const PLANNER = 'u-dept-planning';
const CLERK = 'u-dept-affairs';
const PERIOD = { startDate: '2026-11-07', endDate: '2026-11-08' };
/** 2026-11-07 10:00 JST, the first day of PERIOD. */
const DAY1 = '2026-11-07T01:00:00.000Z';

let dir: string;
let dayof: DayOfStore;
let decisions: DecisionsStore;
let calendar: CalendarStore;
let rental: RentalStore;
let app: FastifyInstance;
let now = DAY1;
let tick = 0;
/** Moves the clock; the next reading is exactly this moment, later ones a second apart. */
const at = (iso: string) => {
  now = iso;
  tick = 0;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; json: any; raw: string; headers: Record<string, unknown> };

async function build(options: { board?: boolean; register?: boolean; withRental?: boolean; withCalendar?: boolean } = {}) {
  const seed = await seedState();
  seed.users.push(
    { id: TEMP, displayName: '合成 臨時', roleLabel: '臨時スタッフ', email: 'temp@example.invalid', canManageAccess: false },
    { id: PLANNER, displayName: '合成 企画', roleLabel: '企画部・広報課', email: 'planner@example.invalid', canManageAccess: false },
    { id: CLERK, displayName: '合成 総務', roleLabel: '総務部', email: 'clerk@example.invalid', canManageAccess: false },
  );
  app = await buildApp({
    store: new StateStore(seed, null),
    listenPort: TEST_PORT,
    // Each request moves a second on, so the order of writes is the order of their times.
    clock: () => new Date(Date.parse(now) + tick++ * 1000).toISOString(),
    dayof: options.board === false ? null : dayof,
    decisions: options.register === false ? null : decisions,
    ...(options.withRental === false ? {} : { rental: { store: rental, itemOrigin: null, webDir: path.join(ROOT, 'src', 'rental-web') } }),
    ...(options.withCalendar === false ? {} : { calendar: { store: calendar, icalEnabled: false } }),
  });
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
  return { status: res.statusCode, json, raw: res.body, headers: res.headers };
}

let tokens = 0;
const token = () => `tok-${String(++tokens).padStart(16, '0')}`;
const notice = (over: Record<string, unknown> = {}) => ({ body: '合成の連絡', priority: 'normal', place: '', departments: [], staffVisible: false, clientToken: token(), ...over });

async function setPeriod(period: { startDate: string | null; endDate: string | null } = PERIOD, rules = '') {
  const admin = await call(ADMIN, 'GET', '/api/dayof/admin');
  const res = await call(ADMIN, 'PUT', '/api/dayof/admin/settings', { ...period, rules, expectedVersion: admin.json.settings.version });
  expect(res.status).toBe(200);
  return res;
}

async function post(userId: string, over: Record<string, unknown> = {}) {
  const res = await call(userId, 'POST', '/api/dayof/posts', notice(over));
  expect(res.status, res.raw).toBe(201);
  return res.json.post as { id: string; version: number };
}

const board = async (userId: string) => (await call(userId, 'GET', '/api/dayof/board')).json as DayOfBoardResponse;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-dayof-http-'));
  dayof = new DayOfStore(path.join(dir, 'mailbox'));
  decisions = new DecisionsStore(path.join(dir, 'mailbox'));
  calendar = new CalendarStore(path.join(dir, 'mailbox'));
  rental = new RentalStore(path.join(dir, 'rental'), { demo: true });
  seedRentalDemo(rental);
  now = DAY1;
  tick = 0;
});
afterEach(async () => {
  await app?.close();
  dayof.close();
  decisions.close();
  calendar.close();
  rental.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('access', () => {
  it('needs a sign-in; temporary staff read only the notices', async () => {
    await build();
    await setPeriod();
    expect((await call(null, 'GET', '/api/dayof/board')).status).toBe(401);
    expect((await call(null, 'GET', '/api/dayof/notices')).status).toBe(401);
    expect((await call(TEMP, 'GET', '/api/dayof/board')).status).toBe(403);
    expect((await call(TEMP, 'POST', '/api/dayof/posts', notice())).status).toBe(403);
    expect((await call(TEMP, 'POST', '/api/dayof/decisions', { title: '合成', place: '', departments: ['planning'], clientToken: token() })).status).toBe(403);
    expect((await call(TEMP, 'GET', '/api/dayof/admin')).status).toBe(403);
    expect((await call(TEMP, 'GET', '/api/dayof/notices')).json).toMatchObject({ active: true, staff: true, posts: [] });
  });

  it('does not exist on a server without the board file', async () => {
    await build({ board: false });
    expect((await call(EDITOR_A, 'GET', '/api/dayof/board')).status).toBe(404);
    expect((await call(EDITOR_A, 'GET', '/api/dayof/notices')).status).toBe(404);
  });

  it('lets only the access administrators read and change the settings', async () => {
    await build();
    expect((await call(EDITOR_A, 'GET', '/api/dayof/admin')).status).toBe(403);
    expect((await call(EDITOR_A, 'PUT', '/api/dayof/admin/settings', { ...PERIOD, rules: '', expectedVersion: 1 })).status).toBe(403);
    expect((await call(EDITOR_A, 'PUT', '/api/dayof/admin/posters', { userId: EDITOR_C, on: true })).status).toBe(403);
    const admin = await call(ADMIN, 'GET', '/api/dayof/admin');
    expect(admin.status).toBe(200);
    // Temporary staff are not offered as posters, and their role is not a department.
    expect(admin.json.people.map((p: { id: string }) => p.id)).not.toContain(TEMP);
    expect(admin.json.departments).toEqual(expect.arrayContaining(['企画部', '広報課', '総務部']));
    expect(admin.json.departments).not.toContain('臨時スタッフ');
  });
});

describe('the period', () => {
  it('shows nothing outside the period and turns on at 00:00 JST of its first day, off after its last', async () => {
    await build();
    let b = await board(EDITOR_A);
    expect(b).toMatchObject({ active: false, period: null, posts: [], decisions: null, events: null, supplies: null, rules: '' });
    await setPeriod(PERIOD, '本部長が決める\n物品は物品課');
    at('2026-11-06T14:59:59.000Z'); // 23:59:59 JST the day before
    b = await board(EDITOR_A);
    expect(b).toMatchObject({ active: false, today: '2026-11-06', rules: '' });
    at('2026-11-06T15:00:00.000Z');
    b = await board(EDITOR_A);
    expect(b).toMatchObject({ active: true, today: '2026-11-07', day: { index: 1, total: 2 }, rules: '本部長が決める\n物品は物品課' });
    at('2026-11-08T14:00:00.000Z');
    expect(await board(EDITOR_A)).toMatchObject({ active: true, today: '2026-11-08', day: { index: 2, total: 2 } });
    at('2026-11-08T15:00:00.000Z');
    expect(await board(EDITOR_A)).toMatchObject({ active: false, today: '2026-11-09' });
    expect((await call(TEMP, 'GET', '/api/dayof/notices')).json).toMatchObject({ active: false, posts: [] });
  });

  it('refuses a new notice and a decision outside the period', async () => {
    await build();
    expect((await call(ADMIN, 'POST', '/api/dayof/posts', notice())).status).toBe(409);
    expect((await call(EDITOR_A, 'POST', '/api/dayof/decisions', { title: '合成', place: '', departments: ['planning'], clientToken: token() })).status).toBe(409);
  });

  it('checks the period an administrator saves, and refuses an old version', async () => {
    await build();
    const put = (body: Record<string, unknown>) => call(ADMIN, 'PUT', '/api/dayof/admin/settings', { rules: '', expectedVersion: 1, ...body });
    expect((await put({ startDate: '2026-11-07', endDate: null })).status).toBe(422);
    expect((await put({ startDate: '2026-11-08', endDate: '2026-11-07' })).status).toBe(422);
    expect((await put({ startDate: '2026-11-01', endDate: '2026-11-15' })).status).toBe(422);
    expect((await put({ startDate: '2026-11-07', endDate: '2026-11-07', rules: 'あ'.repeat(801) })).status).toBe(422);
    expect((await put({ startDate: '2026-11-07', endDate: '2026-11-07', rules: '制御\u0007文字' })).status).toBe(422);
    const saved = await put({ ...PERIOD, rules: '本部が決める\r\n' });
    expect(saved.json.settings).toMatchObject({ ...PERIOD, rules: '本部が決める', version: 2, updatedByName: 'デモ管理者' });
    expect((await put({ startDate: null, endDate: null })).status).toBe(409);
    // Both empty turns the period off.
    expect((await put({ startDate: '', endDate: '', expectedVersion: 2 })).json.settings).toMatchObject({ startDate: null, endDate: null, version: 3 });
  });
});

describe('who may post', () => {
  it('is only the access administrators by default, then the people and departments they choose', async () => {
    await build();
    await setPeriod();
    expect((await board(ADMIN)).canPost).toBe(true);
    expect((await board(EDITOR_A)).canPost).toBe(false);
    expect((await call(EDITOR_A, 'POST', '/api/dayof/posts', notice())).status).toBe(403);
    await post(ADMIN);

    expect((await call(ADMIN, 'PUT', '/api/dayof/admin/posters', { userId: EDITOR_A, on: true })).json.posters.users).toEqual([EDITOR_A]);
    expect((await board(EDITOR_A)).canPost).toBe(true);
    await post(EDITOR_A);
    expect((await call(EDITOR_C, 'POST', '/api/dayof/posts', notice())).status).toBe(403);

    // A department: everyone whose role names it, nobody else.
    expect((await call(ADMIN, 'PUT', '/api/dayof/admin/posters', { department: '企画部', on: true })).status).toBe(200);
    await post(PLANNER);
    expect((await call(CLERK, 'POST', '/api/dayof/posts', notice())).status).toBe(403);
    // A department nobody has, an unknown account and temporary staff cannot be made posters.
    expect((await call(ADMIN, 'PUT', '/api/dayof/admin/posters', { department: '存在しない部', on: true })).status).toBe(422);
    expect((await call(ADMIN, 'PUT', '/api/dayof/admin/posters', { userId: 'u-nobody', on: true })).status).toBe(422);
    expect((await call(ADMIN, 'PUT', '/api/dayof/admin/posters', { userId: TEMP, on: true })).status).toBe(422);

    await call(ADMIN, 'PUT', '/api/dayof/admin/posters', { department: '企画部', on: false });
    await call(ADMIN, 'PUT', '/api/dayof/admin/posters', { userId: EDITOR_A, on: false });
    expect((await call(PLANNER, 'POST', '/api/dayof/posts', notice())).status).toBe(403);
    expect((await call(EDITOR_A, 'POST', '/api/dayof/posts', notice())).status).toBe(403);
    const history = (await call(ADMIN, 'GET', '/api/dayof/admin')).json.history.map((h: { detail: string }) => h.detail);
    expect(history).toEqual(['編集担当Aを発信者から外した', '企画部（部局）を発信者から外した', '企画部（部局）を発信者にした', '編集担当Aを発信者にした', '期間 2026-11-07〜2026-11-08・決め方 なし']);
  });

  it('lets any poster mark a notice 済, and only its poster or an administrator correct or withdraw it', async () => {
    await build();
    await setPeriod();
    await call(ADMIN, 'PUT', '/api/dayof/admin/posters', { userId: EDITOR_A, on: true });
    await call(ADMIN, 'PUT', '/api/dayof/admin/posters', { userId: EDITOR_C, on: true });
    const p = await post(EDITOR_A, { body: '正門のテントを畳みます' });
    const asC = (await board(EDITOR_C)).posts.find((x) => x.id === p.id)!;
    expect(asC.canEdit).toBe(false);
    expect((await board(ADMIN)).posts.find((x) => x.id === p.id)!.canEdit).toBe(true);
    const edit = { body: '正門のテントは 15 時に畳みます', priority: 'important', place: '正門', departments: [], staffVisible: false };
    expect((await call(EDITOR_C, 'PUT', `/api/dayof/posts/${p.id}`, { ...edit, expectedVersion: 1 })).status).toBe(403);
    expect((await call(EDITOR_C, 'POST', `/api/dayof/posts/${p.id}/withdraw`, { expectedVersion: 1 })).status).toBe(403);
    const edited = await call(ADMIN, 'PUT', `/api/dayof/posts/${p.id}`, { ...edit, expectedVersion: 1 });
    expect(edited.json.post).toMatchObject({ version: 2, edited: true, priority: 'important', authorName: '編集担当A' });
    expect((await call(EDITOR_A, 'PUT', `/api/dayof/posts/${p.id}`, { ...edit, body: '古い版から', expectedVersion: 1 })).status).toBe(409);
    const resolved = await call(EDITOR_C, 'POST', `/api/dayof/posts/${p.id}/resolve`, { expectedVersion: 2 });
    expect(resolved.json.post).toMatchObject({ status: 'resolved', resolvedByName: '編集担当C' });
    expect((await call(EDITOR_C, 'POST', `/api/dayof/posts/${p.id}/reopen`, { expectedVersion: 3 })).json.post.status).toBe('open');
    expect((await call(EDITOR_A, 'POST', `/api/dayof/posts/${p.id}/withdraw`, { expectedVersion: 4 })).json.post.status).toBe('withdrawn');
    // Withdrawn notices leave the board; the posters see them apart, to put them back.
    expect((await board(VIEWER_B)).posts.map((x) => x.id)).not.toContain(p.id);
    expect((await board(VIEWER_B)).withdrawn).toEqual([]);
    expect((await board(EDITOR_C)).withdrawn.map((x) => x.id)).toEqual([p.id]);
    expect((await call(EDITOR_A, 'POST', `/api/dayof/posts/${p.id}/restore`, { expectedVersion: 5 })).json.post.status).toBe('open');
    expect((await call(EDITOR_A, 'POST', `/api/dayof/posts/${p.id}/delete`, { expectedVersion: 6 })).status).toBe(400);
    expect((await call(EDITOR_A, 'POST', '/api/dayof/posts/dp_0000000000000000/resolve', { expectedVersion: 1 })).status).toBe(404);
  });

  it('refuses 済 and 未解決に戻す to a member who is not a poster', async () => {
    await build();
    await setPeriod();
    const p = await post(ADMIN, { body: '受付の列を二つに分けます' });
    expect((await call(VIEWER_B, 'POST', `/api/dayof/posts/${p.id}/resolve`, { expectedVersion: 1 })).status).toBe(403);
    expect((await call(ADMIN, 'POST', `/api/dayof/posts/${p.id}/resolve`, { expectedVersion: 1 })).status).toBe(200);
    expect((await call(VIEWER_B, 'POST', `/api/dayof/posts/${p.id}/reopen`, { expectedVersion: 2 })).status).toBe(403);
    expect((await call(VIEWER_B, 'POST', `/api/dayof/posts/${p.id}/withdraw`, { expectedVersion: 2 })).status).toBe(403);
    expect(dayof.get(p.id)).toMatchObject({ status: 'resolved', version: 2 });
  });

  it('refuses a correction based on the version read before someone else corrected it, keeping that correction', async () => {
    await build();
    await setPeriod();
    const p = await post(ADMIN, { body: '14 時に正門のテントを畳みます' });
    // Two administrators open the correction form on version 1.
    const seenByA = (await board(ADMIN)).posts.find((x) => x.id === p.id)!;
    expect(seenByA.version).toBe(1);
    const edit = (body: string, expectedVersion: number) => ({ body, priority: 'normal', place: '', departments: [], staffVisible: false, expectedVersion });
    const byB = await call(ADMIN, 'PUT', `/api/dayof/posts/${p.id}`, edit('15 時に正門のテントを畳みます', 1));
    expect(byB.json.post.version).toBe(2);
    // The first form saves later with the version it began from, even though the board now reads version 2.
    expect((await board(ADMIN)).posts.find((x) => x.id === p.id)!.version).toBe(2);
    const late = await call(ADMIN, 'PUT', `/api/dayof/posts/${p.id}`, edit('13 時に正門のテントを畳みます', seenByA.version));
    expect(late.status).toBe(409);
    expect(dayof.get(p.id)!.input.body).toBe('15 時に正門のテントを畳みます');
    // Resolved by someone else meanwhile: a correction from that version is refused too.
    await call(ADMIN, 'POST', `/api/dayof/posts/${p.id}/resolve`, { expectedVersion: 2 });
    expect((await call(ADMIN, 'PUT', `/api/dayof/posts/${p.id}`, edit('直したい', 2))).status).toBe(409);
    expect((await call(ADMIN, 'PUT', `/api/dayof/posts/${p.id}`, edit('直したい', 3))).status).toBe(409);
    expect(dayof.get(p.id)).toMatchObject({ status: 'resolved', input: { body: '15 時に正門のテントを畳みます' } });
  });

  it('checks the text, and answers a retried post once', async () => {
    await build();
    await setPeriod();
    expect((await call(ADMIN, 'POST', '/api/dayof/posts', notice({ body: '   ' }))).status).toBe(422);
    expect((await call(ADMIN, 'POST', '/api/dayof/posts', notice({ body: 'あ'.repeat(301) }))).status).toBe(422);
    expect((await call(ADMIN, 'POST', '/api/dayof/posts', notice({ body: Array(9).fill('行').join('\n') }))).status).toBe(422);
    // What the schema refuses is a malformed request (400); what is refused after trimming is a field to fix (422).
    expect((await call(ADMIN, 'POST', '/api/dayof/posts', notice({ place: '改行\nあり' }))).status).toBe(400);
    expect((await call(ADMIN, 'POST', '/api/dayof/posts', notice({ priority: 'panic' }))).status).toBe(400);
    expect((await call(ADMIN, 'POST', '/api/dayof/posts', notice({ clientToken: 'short' }))).status).toBe(400);
    const body = notice({ body: '  合成の連絡\r\n2 行目  ', departments: ['企画部', '企画部 '] });
    const first = await call(ADMIN, 'POST', '/api/dayof/posts', body);
    expect(first.status).toBe(201);
    expect(first.json.post).toMatchObject({ body: '合成の連絡\n2 行目', departments: ['企画部'] });
    const again = await call(ADMIN, 'POST', '/api/dayof/posts', body);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ replayed: true, post: { id: first.json.post.id } });
    expect(dayof.count()).toBe(1);
  });
});

describe('the board', () => {
  it('pins open 至急 notices first, newest first, and puts today’s resolved ones last', async () => {
    await build();
    await setPeriod();
    const normal = await post(ADMIN, { body: '通常の連絡' });
    const urgent1 = await post(ADMIN, { body: '至急 1', priority: 'urgent' });
    const important = await post(ADMIN, { body: '重要の連絡', priority: 'important' });
    const urgent2 = await post(ADMIN, { body: '至急 2', priority: 'urgent' });
    const later = await post(ADMIN, { body: 'あとの通常' });
    await call(ADMIN, 'POST', `/api/dayof/posts/${urgent1.id}/resolve`, { expectedVersion: 1 });
    const b = await board(VIEWER_B);
    expect(b.posts.map((p) => p.id)).toEqual([urgent2.id, later.id, important.id, normal.id, urgent1.id]);
    expect(b.posts.at(-1)).toMatchObject({ status: 'resolved', resolvedByName: 'デモ管理者' });
    expect(b.posts[0]).toMatchObject({ authorName: 'デモ管理者', canEdit: false });
    expect(b.canPost).toBe(false);
    expect(b.departmentChoices).toEqual([]);
  });

  it('does not carry the open notices of an earlier period into the next one, for members or temporary staff', async () => {
    await build();
    // A trial period on 2026-11-01 leaves an open 至急 shown to temporary staff.
    at('2026-11-01T01:00:00.000Z');
    await setPeriod({ startDate: '2026-11-01', endDate: '2026-11-01' });
    const trial = await post(ADMIN, { body: '試しの至急', priority: 'urgent', staffVisible: true });
    expect((await board(EDITOR_A)).posts.map((x) => x.id)).toEqual([trial.id]);
    // The festival period: the trial notice is not on the board nor on the rental screen.
    at(DAY1);
    await setPeriod();
    const festival = await post(ADMIN, { body: '本番の連絡', staffVisible: true });
    expect((await board(EDITOR_A)).posts.map((x) => x.id)).toEqual([festival.id]);
    expect(((await call(TEMP, 'GET', '/api/dayof/notices')).json as DayOfNoticesResponse).posts.map((x) => x.id)).toEqual([festival.id]);
    expect(((await call(VIEWER_B, 'GET', '/api/dayof/notices')).json as DayOfNoticesResponse).posts.map((x) => x.id)).toEqual([festival.id]);
    // It is still in the file, as it was.
    expect(dayof.get(trial.id)).toMatchObject({ status: 'open' });
  });

  it('keeps an open notice from an earlier day and drops one resolved on an earlier day', async () => {
    await build();
    await setPeriod();
    const stays = await post(ADMIN, { body: '初日からの連絡' });
    const done = await post(ADMIN, { body: '初日に済んだ連絡' });
    await call(ADMIN, 'POST', `/api/dayof/posts/${done.id}/resolve`, { expectedVersion: 1 });
    at('2026-11-07T23:00:00.000Z'); // 2026-11-08 08:00 JST
    const ids = (await board(EDITOR_A)).posts.map((p) => p.id);
    expect(ids).toEqual([stays.id]);
  });

  it('reports a new 至急 between two refreshes through its revision and the notices', async () => {
    await build();
    await setPeriod();
    await post(ADMIN, { body: '通常の連絡' });
    const before = await board(VIEWER_B);
    expect((await board(VIEWER_B)).revision).toBe(before.revision);
    const urgent = await post(ADMIN, { body: '至急の連絡', priority: 'urgent' });
    const after = await board(VIEWER_B);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(diffDayOfPosts(before.posts, after.posts)).toMatchObject({ newUrgent: [urgent.id], added: [urgent.id], removed: [] });
    await call(ADMIN, 'POST', `/api/dayof/posts/${urgent.id}/resolve`, { expectedVersion: 1 });
    const third = await board(VIEWER_B);
    expect(diffDayOfPosts(after.posts, third.posts)).toMatchObject({ newUrgent: [], changed: [urgent.id] });
  });

  it('shows the counts of lent items to people with a rental permission only', async () => {
    await build();
    await setPeriod();
    const withPermission = await board(EDITOR_A);
    expect(withPermission.supplies).toEqual({ cardsOut: expect.any(Number), unitsOut: expect.any(Number), groupsOpen: expect.any(Number) });
    expect((await board(VIEWER_B)).supplies).toBeNull();
    await app.close();
    await build({ withRental: false });
    expect((await board(EDITOR_A)).supplies).toBeNull();
  });

  it('lists today’s events from the calendar, yearly ones included', async () => {
    await build();
    await setPeriod();
    const event = (over: Record<string, unknown>) => ({ title: '合成の予定', kind: 'event', date: '2026-11-07', time: null, departments: [], memo: '', yearly: false, remindDays: [], ...over });
    calendar.create(event({ title: '開会式', time: '09:30' }) as never, ADMIN, DAY1);
    calendar.create(event({ title: '終日の受付' }) as never, ADMIN, DAY1);
    calendar.create(event({ title: '明日の片付け', date: '2026-11-08' }) as never, ADMIN, DAY1);
    calendar.create(event({ title: '毎年の点検', date: '2025-11-07', yearly: true }) as never, ADMIN, DAY1);
    const titles = (await board(VIEWER_B)).events!.map((e) => e.title);
    expect(titles).toEqual(expect.arrayContaining(['開会式', '終日の受付', '毎年の点検']));
    expect(titles).not.toContain('明日の片付け');
    await app.close();
    await build({ withCalendar: false });
    expect((await board(VIEWER_B)).events).toBeNull();
  });
});

describe('temporary staff', () => {
  it('read only the open notices marked for them, with 本部 instead of names', async () => {
    await build();
    await setPeriod();
    const shown = await post(ADMIN, { body: '正門のテントを畳みます', priority: 'urgent', staffVisible: true, place: '正門' });
    await post(ADMIN, { body: '委員だけの連絡' });
    const resolved = await post(ADMIN, { body: '済んだ連絡', staffVisible: true });
    await call(ADMIN, 'POST', `/api/dayof/posts/${resolved.id}/resolve`, { expectedVersion: 1 });
    const staff = (await call(TEMP, 'GET', '/api/dayof/notices')).json as DayOfNoticesResponse;
    expect(staff.posts.map((p) => p.id)).toEqual([shown.id]);
    expect(staff.posts[0]).toMatchObject({ authorName: '本部', resolvedByName: null, canEdit: false, place: '正門' });
    expect(JSON.stringify(staff)).not.toContain('デモ管理者');
    // Members read every open notice on the same route, with the names.
    const member = (await call(VIEWER_B, 'GET', '/api/dayof/notices')).json as DayOfNoticesResponse;
    expect(member.staff).toBe(false);
    expect(member.posts).toHaveLength(2);
    expect(member.posts[0]!.authorName).toBe('デモ管理者');
  });

  it('see the notices on the rental screen, which loads its own script and style', async () => {
    await build();
    const html = readFileSync(path.join(ROOT, 'src', 'rental-web', 'index.html'), 'utf8');
    expect(html).toContain('id="dayof-notices"');
    const page = await call(null, 'GET', '/rental');
    expect(page.raw).toContain('/rental/dayof.js');
    expect(page.raw).toContain('/rental/dayof.css');
    const script = await call(null, 'GET', '/rental/dayof.js');
    expect(script.status).toBe(200);
    expect(String(script.headers['content-type'])).toMatch(/javascript/);
    expect(script.raw).toContain('/api/dayof/notices');
    // Notice text is set as text, never parsed as markup.
    expect(script.raw).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect((await call(null, 'GET', '/rental/dayof.css')).status).toBe(200);
  });
});

describe('a decision on the spot', () => {
  it('goes into the decision register as decided today (Japan time) at 当日本部, for any committee member', async () => {
    await build();
    await setPeriod();
    at('2026-11-06T15:30:00.000Z'); // 00:30 JST on the first day
    const body = { title: '13 時の屋外ステージは体育館に移す', place: '屋外ステージ・体育館', departments: ['planning', 'somu'], clientToken: token() };
    const res = await call(VIEWER_B, 'POST', '/api/dayof/decisions', body);
    expect(res.status, res.raw).toBe(201);
    const row = decisions.get(res.json.decisionId)!;
    expect(row.input).toMatchObject({ title: body.title, decidedOn: '2026-11-07', venue: 'other', venueOther: '当日本部', departments: ['planning', 'somu'], body: '関係する場所・人：屋外ステージ・体育館' });
    expect(row.input.sources[0]).toMatchObject({ kind: 'manual', label: '当日の画面（当日本部）' });
    expect(row.status).toBe('active');
    // A retry after a lost answer records nothing more.
    const again = await call(VIEWER_B, 'POST', '/api/dayof/decisions', body);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ decisionId: res.json.decisionId, replayed: true });
    const b = await board(EDITOR_A);
    expect(b.decisions).toHaveLength(1);
    expect(b.decisions![0]).toMatchObject({ id: res.json.decisionId, venueLabel: '当日本部', status: 'active' });
    expect(b.decisionDepartments).toEqual(expect.arrayContaining(['planning', 'somu']));
  });

  it('lists today’s decisions newest first, those of other days left out', async () => {
    await build();
    await setPeriod();
    const record = async (title: string) => (await call(EDITOR_A, 'POST', '/api/dayof/decisions', { title, place: '', departments: ['planning'], clientToken: token() })).json.decisionId as string;
    const first = await record('先に決めたこと');
    const second = await record('あとで決めたこと');
    expect((await board(EDITOR_A)).decisions!.map((d) => d.id)).toEqual([second, first]);
    at('2026-11-07T23:00:00.000Z');
    expect((await board(EDITOR_A)).decisions).toEqual([]);
    expect(decisions.get(first)!.input.body).toBe('');
  });

  it('checks the fields as the register does, and is off without the register', async () => {
    await build();
    await setPeriod();
    const send = (over: Record<string, unknown>) => call(EDITOR_A, 'POST', '/api/dayof/decisions', { title: '合成', place: '', departments: ['planning'], clientToken: token(), ...over });
    expect((await send({ title: '' })).status).toBe(422);
    expect((await send({ title: '改行\nあり' })).status).toBe(400);
    expect((await send({ departments: [] })).status).toBe(400);
    expect((await send({ departments: ['企画部'] })).status).toBe(400);
    expect((await send({ venue: 'board' })).status).toBe(400);
    await app.close();
    await build({ register: false });
    expect((await board(EDITOR_A)).canDecide).toBe(false);
    expect((await board(EDITOR_A)).decisions).toBeNull();
    expect((await call(EDITOR_A, 'POST', '/api/dayof/decisions', { title: '合成', place: '', departments: ['planning'], clientToken: token() })).status).toBe(404);
  });
});
