import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FreeBusyError, type CalendarFreeBusy, type FreeBusySource } from '../../src/server/availability/google.js';
import type { AvailabilityService } from '../../src/server/availability/service.js';
import { AvailabilityStore } from '../../src/server/availability/store.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';

// Free/busy over HTTP in the demo composition (persona cookie), with a stand-in for Google. Synthetic people and
// calendars only. The server's clock is 2026-11-20 10:00 Japan time unless a test moves it.

const OWNER = 'u-owner';
const BOARD = 'u-board';
const NAIMU = 'u-naimu';
const OTHER = 'u-other';
const TEMP = 'u-temp-staff';
const CAL = 'owner@example.invalid';

class FakeGoogle implements FreeBusySource {
  shared = new Set<string>([CAL, 'other@example.invalid']);
  busy = new Map<string, { start: number; end: number }[]>();
  fail = false;
  calls = 0;
  async query(ids: readonly string[], timeMin: string, timeMax: string): Promise<Map<string, CalendarFreeBusy>> {
    this.calls += 1;
    if (this.fail) throw new FreeBusyError('server');
    const lo = Date.parse(timeMin);
    const hi = Date.parse(timeMax);
    return new Map(ids.map((id) => [id, this.shared.has(id) ? { kind: 'ok', busy: (this.busy.get(id) ?? []).filter((p) => p.end > lo && p.start < hi) } : { kind: 'not_shared' }]));
  }
  add(id: string, startIso: string, endIso: string) {
    this.busy.set(id, [...(this.busy.get(id) ?? []), { start: Date.parse(startIso), end: Date.parse(endIso) }]);
  }
}

let dir: string;
let store: AvailabilityStore;
let google: FakeGoogle;
let app: FastifyInstance;
let stateStore: StateStore;
let service: AvailabilityService;
let now: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; json: any; text: string };

async function build(on = true) {
  const seed = await seedState();
  seed.users.push(
    { id: OWNER, displayName: '合成 持ち主', roleLabel: '総務部', email: 'owner@example.invalid', canManageAccess: false },
    { id: BOARD, displayName: '合成 役員', roleLabel: '役員会・総務部', email: 'board@example.invalid', canManageAccess: false },
    { id: NAIMU, displayName: '合成 内務', roleLabel: '内務部', email: 'naimu@example.invalid', canManageAccess: false },
    { id: OTHER, displayName: '合成 ほか', roleLabel: '内務部', email: 'other@example.invalid', canManageAccess: false },
    { id: TEMP, displayName: '合成 臨時', roleLabel: '臨時スタッフ', email: 'temp@example.invalid', canManageAccess: false },
  );
  stateStore = new StateStore(seed, null);
  app = await buildApp({
    store: stateStore,
    listenPort: TEST_PORT,
    clock: () => new Date(now).toISOString(),
    availability: on ? { store, source: google, serviceAccount: 'iyakusai-test@test-project.iam.gserviceaccount.com', refreshMinutes: 15, horizonDays: 42, autoRefresh: false, onService: (s) => (service = s) } : null,
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
  return { status: res.statusCode, json, text: res.body };
}

const audience = (over: Record<string, unknown> = {}) => ({ everyone: false, departments: ['役員会'], people: [], ...over });
const list = (userId: string, from = '2026-11-20', to = '2026-12-05') => call(userId, 'GET', `/api/availability?from=${from}&to=${to}`);

/** Connects OWNER's calendar through the check (the fake puts the event at the given time). */
async function connect(userId = OWNER, calendarId = CAL, choices: { audience?: unknown; detail?: string } = {}) {
  const started = await call(userId, 'POST', '/api/availability/me/challenge', { calendarId, audience: choices.audience ?? audience(), detail: choices.detail ?? 'blocks' });
  expect(started.status).toBe(200);
  const slot = started.json.challenge as { date: string; start: string; end: string };
  google.add(calendarId, `${slot.date}T${slot.start}:00+09:00`, `${slot.date}T${slot.end}:00+09:00`);
  const done = await call(userId, 'POST', '/api/availability/me/verify', {});
  // The member may delete the check's event afterwards; the tests' own events come after.
  google.busy.delete(calendarId);
  return done;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-availability-http-'));
  store = new AvailabilityStore(dir);
  google = new FakeGoogle();
  now = Date.parse('2026-11-20T01:00:00.000Z');
});
afterEach(async () => {
  await app?.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('access', () => {
  it('needs a sign-in; temporary staff are refused', async () => {
    await build();
    expect((await call(null, 'GET', '/api/availability/me')).status).toBe(401);
    expect((await list(TEMP)).status).toBe(403);
    expect((await call(TEMP, 'POST', '/api/availability/me/challenge', { calendarId: CAL, audience: audience(), detail: 'parts' })).status).toBe(403);
  });

  it('is off without the feature: the screens hide it and the changes answer 404', async () => {
    await build(false);
    expect((await call(OWNER, 'GET', '/api/availability/me')).json).toMatchObject({ enabled: false, connection: null });
    expect((await list(OWNER)).json).toMatchObject({ enabled: false, people: [] });
    expect((await call(OWNER, 'POST', '/api/availability/me/challenge', { calendarId: CAL, audience: audience(), detail: 'parts' })).status).toBe(404);
    expect((await call(OWNER, 'DELETE', '/api/availability/me')).status).toBe(404);
  });
});

describe('connecting', () => {
  it('needs the calendar shared with the account first', async () => {
    await build();
    google.shared.delete(CAL);
    const res = await call(OWNER, 'POST', '/api/availability/me/challenge', { calendarId: CAL, audience: audience(), detail: 'parts' });
    expect(res.status).toBe(422);
    expect(res.json.message).toContain('iyakusai-test@test-project.iam.gserviceaccount.com');
    expect(store.challenge(OWNER)).toBeNull();
  });

  it('gives a free time two days ahead in the early morning, and connects only once that time is busy', async () => {
    await build();
    const started = await call(OWNER, 'POST', '/api/availability/me/challenge', { calendarId: ' Owner@Example.invalid ', audience: audience(), detail: 'parts' });
    expect(started.status).toBe(200);
    const slot = started.json.challenge;
    expect(slot).toMatchObject({ calendarId: CAL, date: '2026-11-22' });
    expect(slot.start >= '03:00' && slot.start <= '04:59').toBe(true);
    expect(started.json.connection).toBeNull();

    const early = await call(OWNER, 'POST', '/api/availability/me/verify', {});
    expect(early.status).toBe(422);
    expect(early.json.message).toContain('予定が見つかりません');
    expect(store.connection(OWNER)).toBeNull();

    // An event that only touches the time is not enough: the whole time must be busy.
    google.add(CAL, `${slot.date}T${slot.start}:00+09:00`, `${slot.date}T${slot.start}:30+09:00`);
    expect((await call(OWNER, 'POST', '/api/availability/me/verify', {})).status).toBe(422);

    google.add(CAL, `${slot.date}T${slot.start}:00+09:00`, `${slot.date}T${slot.end}:00+09:00`);
    const done = await call(OWNER, 'POST', '/api/availability/me/verify', {});
    expect(done.status).toBe(200);
    expect(done.json.connection).toMatchObject({ calendarId: CAL, detail: 'parts', audience: { everyone: false, departments: ['役員会'], people: [] }, state: 'ok' });
    expect(done.json.challenge).toBeNull();
  });

  it('lets one member connect one calendar; another member cannot take it', async () => {
    await build();
    expect((await connect()).status).toBe(200);
    const res = await call(OTHER, 'POST', '/api/availability/me/challenge', { calendarId: CAL, audience: audience(), detail: 'parts' });
    expect(res.status).toBe(409);
  });

  it('keeps the chosen audience to people and departments that exist, never the owner', async () => {
    await build();
    await connect(OWNER, CAL, { audience: { everyone: false, departments: ['役員会', '存在しない部局'], people: [OWNER, NAIMU, 'u-nobody'] } });
    expect(store.connection(OWNER)!.audience).toEqual({ everyone: false, departments: ['役員会'], people: [NAIMU] });
  });

  it('drops a check that is a week old', async () => {
    await build();
    await call(OWNER, 'POST', '/api/availability/me/challenge', { calendarId: CAL, audience: audience(), detail: 'parts' });
    now += 8 * 86_400_000;
    expect((await call(OWNER, 'GET', '/api/availability/me')).json.challenge).toBeNull();
    expect((await call(OWNER, 'POST', '/api/availability/me/verify', {})).status).toBe(404);
  });
});

describe('seeing', () => {
  it('shows the busy periods to the chosen audience only, and never the calendar ID to others', async () => {
    await build();
    await connect();
    google.add(CAL, '2026-11-21T14:00:00+09:00', '2026-11-21T16:00:00+09:00');
    google.add(CAL, '2026-11-23T00:00:00+09:00', '2026-11-24T00:00:00+09:00');
    await readAll();
    const svc = (await call(OWNER, 'GET', '/api/availability/me')).json;
    expect(svc.connection.state).toBe('ok');

    const board = await list(BOARD);
    expect(board.status).toBe(200);
    const person = board.json.people.find((p: { userId: string }) => p.userId === OWNER);
    expect(person).toMatchObject({ displayName: '合成 持ち主', self: false, detail: 'blocks', state: 'ok' });
    const day21 = person.days.find((d: { date: string }) => d.date === '2026-11-21');
    expect(day21).toEqual({ date: '2026-11-21', parts: ['pm'], blocks: [{ start: '14:00', end: '16:00' }] });
    expect(person.days.find((d: { date: string }) => d.date === '2026-11-23')).toMatchObject({ blocks: [{ start: '00:00', end: '24:00' }] });
    expect(board.text).not.toContain(CAL);

    expect((await list(NAIMU)).json.people).toEqual([]);
    const self = (await list(OWNER)).json.people;
    expect(self).toHaveLength(1);
    expect(self[0]).toMatchObject({ self: true });
  });

  it('sends no times to anyone when the owner shares parts of the day only', async () => {
    await build();
    await connect(OWNER, CAL, { detail: 'parts', audience: audience({ everyone: true }) });
    google.add(CAL, '2026-11-21T14:00:00+09:00', '2026-11-21T16:00:00+09:00');
    await call(OWNER, 'PUT', '/api/availability/me', { audience: audience({ everyone: true }), detail: 'parts' });
    // the change of settings does not read Google; the next read does
    await readAll();
    for (const viewer of [NAIMU, OWNER]) {
      const res = await list(viewer);
      expect(res.json.people[0].days).toEqual([{ date: '2026-11-21', parts: ['pm'] }]);
      expect(res.text).not.toContain('14:00');
    }
  });

  it('follows a change of audience at once', async () => {
    await build();
    await connect();
    expect((await list(NAIMU)).json.people).toHaveLength(0);
    expect((await call(OWNER, 'PUT', '/api/availability/me', { audience: audience({ departments: [], people: [NAIMU] }), detail: 'parts' })).status).toBe(200);
    expect((await list(NAIMU)).json.people).toHaveLength(1);
    expect((await list(BOARD)).json.people).toHaveLength(0);
  });

  it('shows nothing (not free) once the sharing is removed in Google', async () => {
    await build();
    await connect(OWNER, CAL, { audience: audience({ everyone: true }) });
    google.add(CAL, '2026-11-21T14:00:00+09:00', '2026-11-21T16:00:00+09:00');
    await readAll();
    expect((await list(NAIMU)).json.people[0].days).toHaveLength(1);
    google.shared.delete(CAL);
    await readAll();
    const person = (await list(NAIMU)).json.people[0];
    expect(person).toMatchObject({ state: 'not_shared', days: [] });
    expect((await call(OWNER, 'GET', '/api/availability/me')).json.connection.state).toBe('not_shared');
  });

  it('keeps the last good periods as stale when Google fails, then drops them', async () => {
    await build();
    await connect(OWNER, CAL, { audience: audience({ everyone: true }) });
    google.add(CAL, '2026-11-21T14:00:00+09:00', '2026-11-21T16:00:00+09:00');
    await readAll();
    google.fail = true;
    now += 20 * 60_000;
    await readAll();
    expect((await list(NAIMU)).json.people[0]).toMatchObject({ state: 'stale' });
    expect((await list(NAIMU)).json.people[0].days).toHaveLength(1);
    now += 13 * 3600_000;
    expect((await list(NAIMU)).json.people[0]).toMatchObject({ state: 'error', days: [] });
  });

  it('stops at once on disconnect, and the record keeps no busy periods', async () => {
    await build();
    await connect(OWNER, CAL, { audience: audience({ everyone: true }) });
    google.add(CAL, '2026-11-21T14:00:00+09:00', '2026-11-21T16:00:00+09:00');
    await readAll();
    const dump = JSON.stringify(store.db.prepare('SELECT * FROM connections').all()) + JSON.stringify(store.db.prepare('SELECT * FROM challenges').all());
    expect(dump).not.toContain('2026-11-21');
    const res = await call(OWNER, 'DELETE', '/api/availability/me');
    expect(res.json.connection).toBeNull();
    expect((await list(NAIMU)).json.people).toEqual([]);
    expect(store.connection(OWNER)).toBeNull();
  });

  it('neither reads nor shows a member whose login was stopped', async () => {
    await build();
    await connect(OWNER, CAL, { audience: audience({ everyone: true }) });
    google.add(CAL, '2026-11-21T14:00:00+09:00', '2026-11-21T16:00:00+09:00');
    await readAll();
    expect((await list(NAIMU)).json.people).toHaveLength(1);
    stateStore.current.users.find((u) => u.id === OWNER)!.disabled = true;
    const calls = google.calls;
    await readAll();
    expect(google.calls).toBe(calls); // nobody left to read: Google is not asked
    expect((await list(NAIMU)).json.people).toEqual([]);
  });

  it('keeps the asked days within today and the days read, and refuses too long a range', async () => {
    await build();
    await connect(OWNER, CAL, { audience: audience({ everyone: true }) });
    google.add(CAL, '2026-11-19T14:00:00+09:00', '2026-11-19T16:00:00+09:00');
    await readAll();
    const res = await list(NAIMU, '2026-11-01', '2026-12-31');
    expect(res.json.coveredTo).toBe('2026-12-31');
    expect(res.json.people[0].days).toEqual([]);
    expect((await list(NAIMU, '2026-11-01', '2027-02-01')).status).toBe(422);
  });
});

/** Every connected calendar read once, as the timer does every refreshMinutes. */
const readAll = () => service.refreshAll();
