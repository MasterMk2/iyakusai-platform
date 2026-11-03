import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_FILE, CalendarStore } from '../../src/server/calendar/store.js';
import { newIcalToken, tokenHash } from '../../src/server/calendar/ical.js';
import type { CalendarEventInput } from '../../src/shared/calendar.js';

// The calendar store against a real SQLite file: versions, conflicts, history, the yearly list and the
// subscription table. Synthetic data only.

let dir: string;
let store: CalendarStore;
const NOW = '2026-11-03T01:00:00.000Z';
const LATER = '2026-11-03T02:00:00.000Z';

const input = (over: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  title: '（例）締切',
  kind: 'deadline',
  date: '2026-11-20',
  time: null,
  departments: ['企画部'],
  memo: '',
  yearly: false,
  remindDays: [3],
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-calendar-store-'));
  store = new CalendarStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('events', () => {
  it('creates an event at version 1 with a history row, and reads it back', () => {
    const row = store.create(input(), 'u-a', NOW);
    expect(row.version).toBe(1);
    expect(row.id).toMatch(/^ev_[0-9a-f]{16}$/);
    expect(store.get(row.id)?.data.title).toBe('（例）締切');
    expect(store.history(row.id)).toEqual([{ at: NOW, actorId: 'u-a', action: 'created', changed: [] }]);
  });

  it('bumps the version on a change and lists the changed fields', () => {
    const row = store.create(input(), 'u-a', NOW);
    const updated = store.update(row.id, 1, input({ title: '（例）締切（変更）', memo: '追加' }), 'u-b', LATER);
    expect(updated).not.toBe('conflict');
    expect(updated && typeof updated === 'object' ? updated.version : 0).toBe(2);
    const history = store.history(row.id);
    expect(history[0]).toEqual({ at: LATER, actorId: 'u-b', action: 'updated', changed: ['title', 'memo'] });
    expect(history[1]?.action).toBe('created');
  });

  it('refuses a save with an old version, so a second editor never overwrites silently', () => {
    const row = store.create(input(), 'u-a', NOW);
    store.update(row.id, 1, input({ title: '先の変更' }), 'u-b', LATER);
    expect(store.update(row.id, 1, input({ title: '後の変更' }), 'u-c', LATER)).toBe('conflict');
    expect(store.get(row.id)?.data.title).toBe('先の変更');
  });

  it('keeps the version when nothing changed', () => {
    const row = store.create(input(), 'u-a', NOW);
    const same = store.update(row.id, 1, input(), 'u-b', LATER);
    expect(same && typeof same === 'object' ? same.version : 0).toBe(1);
    expect(store.history(row.id)).toHaveLength(1);
  });

  it('takes a save of the content already stored as saved, whatever old version it was made from', () => {
    const row = store.create(input(), 'u-a', NOW);
    expect(store.update(row.id, 1, input({ title: '変更' }), 'u-b', LATER)).not.toBe('conflict');
    const resent = store.update(row.id, 1, input({ title: '変更' }), 'u-b', LATER);
    expect(resent && typeof resent === 'object' ? resent.version : 0).toBe(2);
    expect(store.history(row.id)).toHaveLength(2);
    expect(store.update(row.id, 1, input({ title: '別の内容' }), 'u-c', LATER)).toBe('conflict');
  });

  it('answers a resent create with the event the first send made, and makes nothing new', () => {
    const first = store.createOnce('req-0123456789abcdef', 'u-a', input(), NOW);
    expect(first.kind).toBe('created');
    const again = store.createOnce('req-0123456789abcdef', 'u-a', input(), LATER);
    expect(again.kind).toBe('replayed');
    if (first.kind === 'created' && again.kind === 'replayed') expect(again.row.id).toBe(first.row.id);
    expect(store.range('2026-11-01', '2026-11-30')).toHaveLength(1);
    // Another person's ID is their own request.
    expect(store.createOnce('req-0123456789abcdef', 'u-b', input(), LATER).kind).toBe('created');
  });

  it('does not make a deleted event again, and forgets a request ID after a day', () => {
    const first = store.createOnce('req-fedcba9876543210', 'u-a', input(), NOW);
    if (first.kind !== 'created') throw new Error('first create should be made');
    store.delete(first.row.id, 1, 'u-a', LATER);
    expect(store.createOnce('req-fedcba9876543210', 'u-a', input(), LATER).kind).toBe('gone');
    expect(store.count()).toBe(0);
    // A day later the ID is old: the same ID is a new request again.
    const later = store.createOnce('req-fedcba9876543210', 'u-a', input(), '2026-11-04T02:00:00.000Z');
    expect(later.kind).toBe('created');
  });

  it('keeps the event as it was before a delete, so a mistake can be put back by hand', () => {
    const row = store.create(input({ title: '消す予定' }), 'u-a', NOW);
    expect(store.delete(row.id, 1, 'u-a', LATER)).toBe('deleted');
    expect(store.get(row.id)).toBeNull();
    const deleted = store.history(row.id)[0]!;
    expect(deleted.action).toBe('deleted');
    expect(store.delete(row.id, 1, 'u-a', LATER)).toBeNull();
  });

  it('lists the events of a date range in date and time order', () => {
    store.create(input({ title: '後', date: '2026-11-10', time: '18:00' }), 'u-a', NOW);
    store.create(input({ title: '先', date: '2026-11-10', time: '09:00' }), 'u-a', NOW);
    store.create(input({ title: '範囲外', date: '2026-12-01' }), 'u-a', NOW);
    expect(store.range('2026-11-01', '2026-11-30').map((r) => r.data.title)).toEqual(['先', '後']);
  });

  it('lists the yearly events in month and day order, whatever the year', () => {
    store.create(input({ title: '五月', date: '2025-05-02', yearly: true }), 'u-a', NOW);
    store.create(input({ title: '四月', date: '2026-04-01', yearly: true }), 'u-a', NOW);
    store.create(input({ title: '毎年でない', date: '2026-04-02', yearly: false }), 'u-a', NOW);
    expect(store.yearly().map((r) => r.data.title)).toEqual(['四月', '五月']);
  });

  it('gives the departments in use, without repeats', () => {
    store.create(input({ departments: ['企画部', '総務部'] }), 'u-a', NOW);
    store.create(input({ departments: ['企画部'] }), 'u-a', NOW);
    expect(store.departmentNames()).toEqual(['企画部', '総務部']);
  });

  it('keeps the copy source of an event it was copied from', () => {
    const original = store.create(input({ yearly: true }), 'u-a', NOW);
    const copy = store.create(input({ date: '2027-11-20', yearly: true }), 'u-a', LATER, original.id);
    expect(copy.copiedFrom).toBe(original.id);
  });
});

describe('subscriptions', () => {
  it('stores only the hash of the secret, and a new one replaces the old', () => {
    const first = newIcalToken();
    store.putSubscription('u-a', tokenHash(first), NOW);
    expect(store.subscriptionUser(tokenHash(first))).toBe('u-a');
    const second = newIcalToken();
    store.putSubscription('u-a', tokenHash(second), LATER);
    expect(store.subscriptionUser(tokenHash(first))).toBeNull();
    expect(store.subscriptionUser(tokenHash(second))).toBe('u-a');
    expect(store.subscription('u-a')).toEqual({ createdAt: NOW, rotatedAt: LATER });
  });

  it('never writes the token itself into the file', () => {
    const token = newIcalToken();
    store.putSubscription('u-a', tokenHash(token), NOW);
    store.close();
    const bytes = readFileSync(path.join(dir, CALENDAR_FILE));
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    store = new CalendarStore(dir);
  });

  it('stops the URL when the subscription is removed', () => {
    const token = newIcalToken();
    store.putSubscription('u-a', tokenHash(token), NOW);
    expect(store.removeSubscription('u-a')).toBe(true);
    expect(store.subscriptionUser(tokenHash(token))).toBeNull();
    expect(store.removeSubscription('u-a')).toBe(false);
  });
});
