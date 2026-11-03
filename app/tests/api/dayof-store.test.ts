import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionsStore } from '../../src/server/decisions/store.js';
import { DomainError } from '../../src/server/domain/types.js';
import { seedDayOfDemo } from '../../src/server/dayof/seed.js';
import { DayOfStore } from '../../src/server/dayof/store.js';
import type { DayOfPostInput } from '../../src/shared/dayof.js';

// The festival-day board file (dayof.sqlite3): versions, history, the token of a retried post, the states of a notice
// and the revision the screens poll. Synthetic text only.

let dir: string;
let store: DayOfStore;

const input = (over: Partial<DayOfPostInput> = {}): DayOfPostInput => ({ body: '合成の連絡', priority: 'normal', place: '', departments: [], staffVisible: false, ...over });
const AT = (m: number) => new Date(Date.parse('2026-11-07T01:00:00.000Z') + m * 60_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-dayof-store-'));
  store = new DayOfStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('settings', () => {
  it('starts with no period, keeps the version for a save that changes nothing, and refuses an old version', () => {
    expect(store.settings()).toMatchObject({ startDate: null, endDate: null, rules: '', version: 1 });
    const saved = store.saveSettings({ startDate: '2026-11-07', endDate: '2026-11-08', rules: '本部が決める' }, 1, 'u-admin', AT(0));
    expect(saved).toMatchObject({ startDate: '2026-11-07', version: 2, updatedBy: 'u-admin' });
    expect(store.saveSettings({ startDate: '2026-11-07', endDate: '2026-11-08', rules: '本部が決める' }, 2, 'u-admin', AT(1))).toMatchObject({ version: 2 });
    expect(store.saveSettings({ startDate: null, endDate: null, rules: '' }, 1, 'u-admin', AT(2))).toBe('conflict');
    expect(store.adminHistory()).toHaveLength(1);
    expect(store.adminHistory()[0]).toMatchObject({ action: 'settings', before: { startDate: null }, after: { startDate: '2026-11-07' } });
  });

  it('keeps the settings when the file is opened again', () => {
    store.saveSettings({ startDate: '2026-11-07', endDate: '2026-11-07', rules: '' }, 1, 'u-admin', AT(0));
    store.close();
    store = new DayOfStore(dir);
    expect(store.settings()).toMatchObject({ startDate: '2026-11-07', version: 2 });
  });

  it('grants and takes away posters with a history row per change, a repeat changing nothing', () => {
    const r0 = store.revision();
    store.setPosterGrant('user', 'u-editor-a', true, 'u-admin', AT(0));
    store.setPosterGrant('user', 'u-editor-a', true, 'u-admin', AT(1));
    store.setPosterGrant('department', '企画部', true, 'u-admin', AT(2));
    expect(store.posterGrants()).toEqual({ users: ['u-editor-a'], departments: ['企画部'] });
    store.setPosterGrant('user', 'u-editor-a', false, 'u-admin', AT(3));
    expect(store.posterGrants()).toEqual({ users: [], departments: ['企画部'] });
    expect(store.adminHistory().map((h) => h.action)).toEqual(['revoke_user', 'grant_department', 'grant_user']);
    expect(store.revision()).toBe(r0 + 3);
  });
});

describe('notices', () => {
  it('answers a retried post with the first one and refuses the same token with other content', () => {
    const first = store.create(input(), 'u-editor-a', AT(0), 'tok-0123456789abcdef');
    expect(first.replayed).toBe(false);
    const again = store.create(input(), 'u-editor-a', AT(1), 'tok-0123456789abcdef');
    expect(again).toMatchObject({ replayed: true, row: { id: first.row.id } });
    expect(() => store.create(input({ body: '別の本文' }), 'u-editor-a', AT(2), 'tok-0123456789abcdef')).toThrow(DomainError);
    expect(store.count()).toBe(1);
  });

  it('corrects an open notice with a version, keeps what it was in the history, and refuses an old version', () => {
    const { row } = store.create(input(), 'u-editor-a', AT(0), null);
    const edited = store.update(row.id, 1, input({ body: '直した連絡', priority: 'urgent' }), 'u-admin', AT(1));
    expect(edited).toMatchObject({ version: 2, edited: true, input: { body: '直した連絡', priority: 'urgent' }, updatedBy: 'u-admin' });
    expect(store.update(row.id, 1, input({ body: 'もう一度' }), 'u-admin', AT(2))).toBe('conflict');
    expect(store.update(row.id, 2, input({ body: '直した連絡', priority: 'urgent' }), 'u-admin', AT(3))).toMatchObject({ version: 2 });
    expect(store.update('dp_0000000000000000', 1, input(), 'u-admin', AT(3))).toBeNull();
    const history = store.history(row.id);
    expect(history.map((h) => h.action)).toEqual(['edited', 'created']);
    expect(history[0]!.changed).toEqual(['body', 'priority']);
    const before = store.db.prepare("SELECT before_json FROM post_history WHERE post_id=? AND action='edited'").get(row.id) as { before_json: string };
    expect(JSON.parse(before.before_json)).toMatchObject({ status: 'open', input: { body: '合成の連絡' } });
  });

  it('resolves, reopens, withdraws and restores to where it was; a resolved one is not corrected', () => {
    const { row } = store.create(input(), 'u-editor-a', AT(0), null);
    const resolved = store.changeStatus(row.id, 'resolve', 1, 'u-editor-c', AT(1));
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: 'u-editor-c', resolvedAt: AT(1), version: 2 });
    expect(store.update(row.id, 2, input({ body: '直す' }), 'u-editor-a', AT(2))).toBe('not_allowed');
    expect(store.changeStatus(row.id, 'resolve', 2, 'u-editor-c', AT(2))).toBe('not_allowed');
    const withdrawn = store.changeStatus(row.id, 'withdraw', 2, 'u-editor-a', AT(3));
    expect(withdrawn).toMatchObject({ status: 'withdrawn', version: 3 });
    expect(store.changeStatus(row.id, 'restore', 3, 'u-editor-a', AT(4))).toMatchObject({ status: 'resolved', resolvedAt: AT(1) });
    expect(store.changeStatus(row.id, 'reopen', 4, 'u-editor-a', AT(5))).toMatchObject({ status: 'open', resolvedAt: null, resolvedBy: null });
    expect(store.changeStatus(row.id, 'withdraw', 5, 'u-editor-a', AT(6))).toMatchObject({ status: 'withdrawn' });
    expect(store.changeStatus(row.id, 'restore', 6, 'u-editor-a', AT(7))).toMatchObject({ status: 'open' });
    expect(store.changeStatus(row.id, 'restore', 7, 'u-editor-a', AT(8))).toBe('not_allowed');
    expect(store.history(row.id).map((h) => h.action)).toEqual(['restored', 'withdrawn', 'reopened', 'restored', 'withdrawn', 'resolved', 'created']);
    // Nothing is deleted: the notice is still in the file.
    expect(store.count()).toBe(1);
  });

  it('puts the open notices of the period on the board and today’s resolved and withdrawn ones from the start of the day', () => {
    const dayStart = '2026-11-06T15:00:00.000Z'; // 2026-11-07 00:00 JST
    const periodStart = '2026-11-05T15:00:00.000Z'; // 2026-11-06 00:00 JST, the day before
    const yesterday = '2026-11-06T10:00:00.000Z';
    const oldOpen = store.create(input({ body: '前の日からの連絡' }), 'u-admin', yesterday, null).row;
    const oldResolved = store.create(input({ body: '前の日に済んだ' }), 'u-admin', yesterday, null).row;
    store.changeStatus(oldResolved.id, 'resolve', 1, 'u-admin', yesterday);
    const todayResolved = store.create(input({ body: '今日済んだ' }), 'u-admin', AT(0), null).row;
    store.changeStatus(todayResolved.id, 'resolve', 1, 'u-admin', AT(1));
    const withdrawn = store.create(input({ body: '取り下げ' }), 'u-admin', AT(2), null).row;
    store.changeStatus(withdrawn.id, 'withdraw', 1, 'u-admin', AT(3));
    const board = store.board({ dayStart, periodStart }, 30);
    expect(board.posts.map((p) => p.id)).toEqual([oldOpen.id, todayResolved.id]);
    expect(board.withdrawn.map((p) => p.id)).toEqual([withdrawn.id]);
  });

  it('does not carry the notices of an earlier period into the next one, and keeps them in the file', () => {
    // A trial period on 2026-11-01, then the festival from 2026-11-07: what was left open in the trial stays out.
    const trial = store.create(input({ body: '試しの至急', priority: 'urgent', staffVisible: true }), 'u-admin', '2026-11-01T02:00:00.000Z', null).row;
    const trialResolvedToday = store.create(input({ body: '試しの連絡' }), 'u-admin', '2026-11-01T02:10:00.000Z', null).row;
    const trialWithdrawnToday = store.create(input({ body: '試しの連絡 2' }), 'u-admin', '2026-11-01T02:20:00.000Z', null).row;
    const festival = store.create(input({ body: '本番の連絡' }), 'u-admin', AT(0), null).row;
    // Tidied up through the API on the festival day: still not part of this period's board.
    store.changeStatus(trialResolvedToday.id, 'resolve', 1, 'u-admin', AT(1));
    store.changeStatus(trialWithdrawnToday.id, 'withdraw', 1, 'u-admin', AT(2));
    const board = store.board({ dayStart: '2026-11-06T15:00:00.000Z', periodStart: '2026-11-06T15:00:00.000Z' }, 30);
    expect(board.posts.map((p) => p.id)).toEqual([festival.id]);
    expect(board.withdrawn).toEqual([]);
    expect(store.get(trial.id)).toMatchObject({ status: 'open' });
    expect(store.count()).toBe(4);
  });

  it('counts the revision up with every write and not for a read or a refused write', () => {
    const r0 = store.revision();
    const { row } = store.create(input(), 'u-admin', AT(0), null);
    store.board({ dayStart: '2026-11-06T15:00:00.000Z', periodStart: '2026-11-06T15:00:00.000Z' }, 30);
    store.update(row.id, 9, input({ body: '古い版' }), 'u-admin', AT(1));
    expect(store.revision()).toBe(r0 + 1);
    store.changeStatus(row.id, 'resolve', 1, 'u-admin', AT(2));
    expect(store.revision()).toBe(r0 + 2);
  });
});

describe('the demo board', () => {
  it('dates the seeded notices no earlier than 00:00 JST of the first day, so an early-morning start shows them', () => {
    const decisions = new DecisionsStore(dir);
    try {
      const now = '2026-11-06T15:30:00.000Z'; // 2026-11-07 00:30 JST
      seedDayOfDemo(store, decisions, 'u-admin', now);
      const board = store.board({ dayStart: '2026-11-06T15:00:00.000Z', periodStart: '2026-11-06T15:00:00.000Z' }, 30);
      expect(board.posts).toHaveLength(store.count());
      expect(board.posts.every((p) => p.createdAt >= '2026-11-06T15:00:00.000Z')).toBe(true);
    } finally {
      decisions.close();
    }
  });

  it('fills an empty board once with a period from today, a poster, a notice of each level and one decision', () => {
    const decisions = new DecisionsStore(dir);
    try {
      const now = '2026-11-07T01:00:00.000Z';
      seedDayOfDemo(store, decisions, 'u-admin', now);
      expect(store.settings()).toMatchObject({ startDate: '2026-11-07', endDate: '2026-11-08' });
      expect(store.posterGrants().users).toEqual(['u-editor-a']);
      const firstDay = { dayStart: '2026-11-06T15:00:00.000Z', periodStart: '2026-11-06T15:00:00.000Z' };
      const board = store.board(firstDay, 30);
      expect(new Set(board.posts.map((p) => p.input.priority))).toEqual(new Set(['urgent', 'important', 'normal']));
      expect(board.posts.some((p) => p.status === 'resolved')).toBe(true);
      expect(decisions.page({ terms: [], from: '2026-11-07', to: '2026-11-07' }, 'decided', 30, 0).rows[0]!.input).toMatchObject({ venue: 'other', venueOther: '当日本部', decidedOn: '2026-11-07' });
      const count = store.count();
      seedDayOfDemo(store, decisions, 'u-admin', now);
      expect(store.count()).toBe(count);
      // Days later the demo period is moved to start on that day, with the same length, and gets the notices again
      // (the board leaves out those of the earlier period).
      seedDayOfDemo(store, decisions, 'u-admin', '2026-11-20T01:00:00.000Z');
      expect(store.settings()).toMatchObject({ startDate: '2026-11-20', endDate: '2026-11-21' });
      const moved = store.board({ dayStart: '2026-11-19T15:00:00.000Z', periodStart: '2026-11-19T15:00:00.000Z' }, 30);
      expect(new Set(moved.posts.map((p) => p.input.priority))).toEqual(new Set(['urgent', 'important', 'normal']));
      expect(store.count()).toBe(count * 2);
    } finally {
      decisions.close();
    }
  });
});
