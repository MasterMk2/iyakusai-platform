import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newIcalToken, tokenHash } from '../../src/server/calendar/ical.js';
import { CalendarStore } from '../../src/server/calendar/store.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { ADMIN, EDITOR_A, seedState, TEST_HOST, TEST_PORT, VIEWER_B } from '../helpers.js';

// The calendar API in the demo composition, over HTTP on loopback with synthetic personas. The iCal feed is
// checked without a cookie and without an Origin, as a calendar app fetches it. Synthetic data only.

const NOW = '2026-11-03T01:00:00.000Z';
const ORIGIN = `http://${TEST_HOST}`;

let dir: string;
let calendar: CalendarStore;
let app: FastifyInstance;

async function build(icalEnabled = true, now = NOW, withCalendar = true) {
  if (withCalendar) calendar = new CalendarStore(dir);
  app = await buildApp({
    store: new StateStore(await seedState(), null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => now,
    calendar: withCalendar ? { store: calendar, icalEnabled } : null,
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-calendar-http-'));
});
afterEach(async () => {
  await app?.close();
  calendar?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, options: { as?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const user = options.as === undefined ? EDITOR_A : options.as;
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(method !== 'GET' ? { origin: ORIGIN, 'x-smm-csrf': '1', 'sec-fetch-site': 'same-origin' } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(user ? { cookie: `smm_demo_persona=${user}` } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON (the feed)
  }
  return { status: res.statusCode, json, text: res.body, headers: res.headers };
}

const eventBody = (over: Record<string, unknown> = {}) => ({
  title: '（例）会場の仮予約',
  kind: 'procedure',
  date: '2026-11-05',
  time: null,
  departments: [],
  memo: '非公開の内容らしきメモ',
  yearly: false,
  remindDays: [3],
  ...over,
});

describe('calendar events over HTTP', () => {
  beforeEach(async () => {
    await build();
  });

  it('refuses the calendar to a request with no sign-in', async () => {
    expect((await call('GET', '/api/calendar/events?from=2026-11-01&to=2026-11-30', { as: null })).status).toBe(401);
  });

  it('creates, reads, changes and refuses a stale change', async () => {
    const created = await call('POST', '/api/calendar/events', { body: eventBody() });
    expect(created.status).toBe(201);
    const id = (created.json as { event: { id: string; version: number } }).event.id;
    expect((created.json as { event: { version: number } }).event.version).toBe(1);

    const detail = await call('GET', `/api/calendar/events/${id}`);
    expect(detail.status).toBe(200);
    expect((detail.json as { history: unknown[] }).history).toHaveLength(1);

    const changed = await call('PUT', `/api/calendar/events/${id}`, { body: { expectedVersion: 1, event: eventBody({ title: '変更後' }) } });
    expect(changed.status).toBe(200);
    expect((changed.json as { event: { version: number } }).event.version).toBe(2);

    const stale = await call('PUT', `/api/calendar/events/${id}`, { body: { expectedVersion: 1, event: eventBody({ title: '古い版' }) } });
    expect(stale.status).toBe(409);
  });

  it('refuses an invalid event with the field and a message for the screen', async () => {
    const res = await call('POST', '/api/calendar/events', { body: eventBody({ date: '2026-02-30' }) });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: 'validation' });
  });

  it('lets only the maker or an access administrator delete an event', async () => {
    const id = ((await call('POST', '/api/calendar/events', { body: eventBody() })).json as { event: { id: string } }).event.id;
    expect((await call('DELETE', `/api/calendar/events/${id}?expectedVersion=1`, { as: VIEWER_B })).status).toBe(403);
    expect((await call('DELETE', `/api/calendar/events/${id}?expectedVersion=1`, { as: ADMIN })).status).toBe(204);
    expect((await call('GET', `/api/calendar/events/${id}`)).status).toBe(404);
  });

  it('lists the events of a range with the departments in use and the reader\'s own', async () => {
    await call('POST', '/api/calendar/events', { body: eventBody({ departments: ['渉外部'] }) });
    const res = await call('GET', '/api/calendar/events?from=2026-11-01&to=2026-11-30');
    expect(res.status).toBe(200);
    const body = res.json as { events: { title: string }[]; departments: string[]; myDepartments: string[] };
    expect(body.events.map((e) => e.title)).toEqual(['（例）会場の仮予約']);
    expect(body.departments).toContain('渉外部');
    expect(Array.isArray(body.myDepartments)).toBe(true);
    expect((await call('GET', '/api/calendar/events?from=2026-11-30&to=2026-11-01')).status).toBe(422);
    expect((await call('GET', '/api/calendar/events?from=2026-01-01&to=2027-12-31')).status).toBe(422);
  });

  it('shows a yearly event on its date in the other years, and lists the yearly schedule by year', async () => {
    await call('POST', '/api/calendar/events', { body: eventBody({ title: '（例）年間の会場', date: '2026-04-01', yearly: true }) });
    const shown = await call('GET', '/api/calendar/events?from=2027-03-25&to=2027-04-05');
    const events = (shown.json as { events: { title: string; date: string; occurrence: boolean }[] }).events;
    expect(events).toEqual([expect.objectContaining({ title: '（例）年間の会場', date: '2027-04-01', occurrence: true })]);
    const yearly = await call('GET', '/api/calendar/yearly?year=2029');
    expect((yearly.json as { items: { occurrence: string }[] }).items.map((i) => i.occurrence)).toEqual(['2029-04-01']);
  });

  it('gives the home reminders of events whose window has begun, and says the tasks are off', async () => {
    await call('POST', '/api/calendar/events', { body: eventBody({ date: '2026-11-05', remindDays: [3] }) });
    await call('POST', '/api/calendar/events', { body: eventBody({ title: '遠い', date: '2026-12-20', remindDays: [3] }) });
    const res = await call('GET', '/api/calendar/upcoming');
    expect(res.json).toEqual({ items: [expect.objectContaining({ kind: 'event', title: '（例）会場の仮予約', daysLeft: 2 })], tasks: 'off' });
  });

  it('keeps a resent create (the same request ID) to one event, per person, and checks the ID', async () => {
    const url = '/api/calendar/events?requestId=req-0123456789abcdef';
    const first = await call('POST', url, { body: eventBody({ title: '（例）二重送信の確かめ' }) });
    expect(first.status).toBe(201);
    const id = (first.json as { event: { id: string } }).event.id;
    const resent = await call('POST', url, { body: eventBody({ title: '（例）二重送信の確かめ' }) });
    expect(resent.status).toBe(200);
    expect((resent.json as { event: { id: string } }).event.id).toBe(id);
    const listed = await call('GET', '/api/calendar/events?from=2026-11-01&to=2026-11-30');
    expect((listed.json as { events: { title: string }[] }).events.filter((e) => e.title === '（例）二重送信の確かめ')).toHaveLength(1);
    // The same ID from another person is another request.
    expect((await call('POST', url, { as: VIEWER_B, body: eventBody({ title: '（例）別の人' }) })).status).toBe(201);
    // Without an ID every send makes an event, as before; a malformed ID is refused.
    expect((await call('POST', '/api/calendar/events', { body: eventBody() })).status).toBe(201);
    expect((await call('POST', '/api/calendar/events?requestId=short', { body: eventBody() })).status).toBe(400);
  });

  it('does not make a deleted event again when its create is resent', async () => {
    const url = '/api/calendar/events?requestId=req-fedcba9876543210';
    const id = ((await call('POST', url, { body: eventBody() })).json as { event: { id: string } }).event.id;
    expect((await call('DELETE', `/api/calendar/events/${id}?expectedVersion=1`)).status).toBe(204);
    expect((await call('POST', url, { body: eventBody() })).status).toBe(404);
  });

  it('treats a resent save of the content already stored as saved, and still refuses a stale save with other content', async () => {
    const id = ((await call('POST', '/api/calendar/events', { body: eventBody() })).json as { event: { id: string } }).event.id;
    expect((await call('PUT', `/api/calendar/events/${id}`, { body: { expectedVersion: 1, event: eventBody({ title: '変更後' }) } })).status).toBe(200);
    // The first answer was lost, so the same save goes again with the version it was made from.
    const resent = await call('PUT', `/api/calendar/events/${id}`, { body: { expectedVersion: 1, event: eventBody({ title: '変更後' }) } });
    expect(resent.status).toBe(200);
    expect(resent.json).toMatchObject({ event: { version: 2 } });
    expect((resent.json as { history: unknown[] }).history).toHaveLength(2);
    expect((await call('PUT', `/api/calendar/events/${id}`, { body: { expectedVersion: 1, event: eventBody({ title: '別の人の変更' }) } })).status).toBe(409);
  });

  it('gives an occurrence the date it holds, so a change to it starts from that date (the leap day stays)', async () => {
    const id = ((await call('POST', '/api/calendar/events', { body: eventBody({ title: '（例）閏年の予定', date: '2028-02-29', yearly: true }) })).json as { event: { id: string } }).event.id;
    const shown = await call('GET', '/api/calendar/events?from=2029-02-01&to=2029-03-10');
    const occurrence = (shown.json as { events: { id: string; date: string; occurrence: boolean; baseDate: string }[] }).events.find((e) => e.id === id);
    expect(occurrence).toMatchObject({ date: '2029-02-28', occurrence: true, baseDate: '2028-02-29' });
    const yearly = await call('GET', '/api/calendar/yearly?year=2032');
    expect((yearly.json as { items: { event: { baseDate: string }; occurrence: string }[] }).items[0]).toMatchObject({ occurrence: '2032-02-29', event: { baseDate: '2028-02-29' } });
  });
});

describe('home reminders across the year end', () => {
  beforeEach(async () => {
    // JST 2026-12-25 10:00: the window (60 days) reaches into January 2027.
    await build(true, '2026-12-25T01:00:00.000Z');
  });

  it('looks at the yearly events of next year too, when the window crosses the year end', async () => {
    await call('POST', '/api/calendar/events', { body: eventBody({ title: '（例）毎年の締切', date: '2026-01-03', yearly: true, remindDays: [14, 3] }) });
    const res = await call('GET', '/api/calendar/upcoming');
    expect((res.json as { items: unknown[] }).items).toEqual([expect.objectContaining({ kind: 'event', title: '（例）毎年の締切', date: '2027-01-03', daysLeft: 9 })]);
  });
});

describe('when this server cannot open the calendar file', () => {
  beforeEach(async () => {
    await build(true, NOW, false);
  });

  it('answers the calendar 503 with the code the home screen hides on, and the rest of the app still answers', async () => {
    const res = await call('GET', '/api/calendar/upcoming');
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ error: 'calendar_unavailable' });
    expect((await call('GET', '/api/session')).status).toBe(200);
  });
});

describe('personal iCal subscription', () => {
  beforeEach(async () => {
    await build();
  });

  it('issues a secret URL once a person asks, and the feed answers without a cookie or an Origin', async () => {
    await call('POST', '/api/calendar/events', { body: eventBody({ title: '（例）全体の行事', date: '2026-11-10', time: '18:00', departments: [], remindDays: [] }) });
    const issued = await call('POST', '/api/calendar/subscription', { body: {} });
    expect(issued.status).toBe(200);
    const issuedPath = (issued.json as { path: string }).path;
    expect(issuedPath).toMatch(/^\/api\/calendar\/ical\/[A-Za-z0-9_-]{43}\.ics$/);
    const feed = await app.inject({ method: 'GET', url: issuedPath, headers: { host: TEST_HOST } });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toContain('text/calendar');
    expect(feed.body).toContain('SUMMARY:（例）全体の行事');
    // All day, whatever time the event has: a time never leaves the server.
    expect(feed.body).toContain('DTSTART;VALUE=DATE:20261110\r\nDTEND;VALUE=DATE:20261111');
    expect(feed.body).not.toMatch(/DTSTART:\d{8}T/);
    expect(feed.body).not.toContain('非公開');
  });

  it('answers the same 404 for an unknown token, a stopped feed and a feed whose owner has left', async () => {
    const unknown = await app.inject({ method: 'GET', url: `/api/calendar/ical/${newIcalToken()}.ics`, headers: { host: TEST_HOST } });
    const gone = newIcalToken();
    calendar.putSubscription('u-who-left', tokenHash(gone), NOW);
    const left = await app.inject({ method: 'GET', url: `/api/calendar/ical/${gone}.ics`, headers: { host: TEST_HOST } });
    const garbage = await app.inject({ method: 'GET', url: '/api/calendar/ical/not-a-token.ics', headers: { host: TEST_HOST } });
    for (const res of [unknown, left, garbage]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(unknown.body);
    }
  });

  it('stops the old URL when a new one is made, and stops all of them when removed', async () => {
    const first = (await call('POST', '/api/calendar/subscription', { body: {} })).json as { path: string };
    const second = (await call('POST', '/api/calendar/subscription', { body: {} })).json as { path: string };
    expect((await app.inject({ method: 'GET', url: first.path, headers: { host: TEST_HOST } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: second.path, headers: { host: TEST_HOST } })).statusCode).toBe(200);
    expect((await call('DELETE', '/api/calendar/subscription')).status).toBe(204);
    expect((await app.inject({ method: 'GET', url: second.path, headers: { host: TEST_HOST } })).statusCode).toBe(404);
    expect((await call('GET', '/api/calendar/subscription')).json).toMatchObject({ available: true, subscribed: false });
  });

  it('limits unknown tokens per address, and never refuses a valid feed', async () => {
    const valid = (await call('POST', '/api/calendar/subscription', { body: {} })).json as { path: string };
    let limited = 0;
    for (let i = 0; i < 25; i += 1) {
      const res = await app.inject({ method: 'GET', url: `/api/calendar/ical/${newIcalToken()}.ics`, headers: { host: TEST_HOST } });
      if (res.statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: valid.path, headers: { host: TEST_HOST } })).statusCode).toBe(200);
  });
});

describe('when the iCal feed is switched off', () => {
  beforeEach(async () => {
    await build(false);
  });

  it('answers 404 to the feed, hides the subscription as unavailable, and refuses to issue one', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/calendar/ical/${newIcalToken()}.ics`, headers: { host: TEST_HOST } });
    expect(res.statusCode).toBe(404);
    expect((await call('GET', '/api/calendar/subscription')).json).toMatchObject({ available: false });
    expect((await call('POST', '/api/calendar/subscription', { body: {} })).status).toBe(404);
  });
});
