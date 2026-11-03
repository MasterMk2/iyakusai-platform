import { describe, expect, it } from 'vitest';
import { staffRouteAllowed } from '../../src/server/discord-auth/temporary-staff.js';
import {
  DAYOF_IDLE_POLL_MS,
  DAYOF_POLL_MS,
  dayOfPeriodDay,
  dayofEditDrift,
  dayofPollDelay,
  diffDayOfPosts,
  findDayOfPost,
  isDayOfActive,
  jstDayStartIso,
  periodProblem,
  sortDayOfPosts,
  type DayOfPostView,
} from '../../src/shared/dayof.js';

// Pure rules of the festival-day board: the period in Japan time, the order of the notices and what changed between
// two refreshes. Synthetic values only.

const period = { startDate: '2026-11-07', endDate: '2026-11-08' };

describe('the period (Japan time, both ends included)', () => {
  it('starts at 00:00 JST, which is 15:00 UTC of the day before', () => {
    expect(isDayOfActive(new Date('2026-11-06T14:59:59.999Z'), period)).toBe(false);
    expect(isDayOfActive(new Date('2026-11-06T15:00:00.000Z'), period)).toBe(true);
    expect(jstDayStartIso('2026-11-07')).toBe('2026-11-06T15:00:00.000Z');
  });

  it('ends after 23:59 JST of the last day', () => {
    expect(isDayOfActive(new Date('2026-11-08T14:59:59.999Z'), period)).toBe(true);
    expect(isDayOfActive(new Date('2026-11-08T15:00:00.000Z'), period)).toBe(false);
  });

  it('counts the days of a period of several days', () => {
    expect(dayOfPeriodDay('2026-11-07', period)).toEqual({ index: 1, total: 2 });
    expect(dayOfPeriodDay('2026-11-08', period)).toEqual({ index: 2, total: 2 });
    expect(dayOfPeriodDay('2026-11-09', period)).toBeNull();
    expect(dayOfPeriodDay('2026-11-06', period)).toBeNull();
    const across = { startDate: '2026-12-30', endDate: '2027-01-02' };
    expect(dayOfPeriodDay('2027-01-01', across)).toEqual({ index: 3, total: 4 });
    expect(dayOfPeriodDay('2026-11-07', { startDate: '2026-11-07', endDate: '2026-11-07' })).toEqual({ index: 1, total: 1 });
  });

  it('is off without a period or for a date that is not a day', () => {
    expect(dayOfPeriodDay('2026-11-07', null)).toBeNull();
    expect(isDayOfActive(new Date('2026-11-07T03:00:00Z'), null)).toBe(false);
    expect(dayOfPeriodDay('2026-11-7', period)).toBeNull();
  });

  it('accepts both ends or neither, a real day, in order, at most 14 days', () => {
    expect(periodProblem(null, null)).toBeNull();
    expect(periodProblem('2026-11-07', '2026-11-07')).toBeNull();
    expect(periodProblem('2026-11-01', '2026-11-14')).toBeNull();
    expect(periodProblem('2026-11-07', null)).toMatch(/両方/);
    expect(periodProblem(null, '2026-11-07')).toMatch(/両方/);
    expect(periodProblem('2026-02-30', '2026-03-01')).toMatch(/実在/);
    expect(periodProblem('2026-11-08', '2026-11-07')).toMatch(/後/);
    expect(periodProblem('2026-11-01', '2026-11-15')).toMatch(/14 日/);
  });
});

type P = Pick<DayOfPostView, 'id' | 'status' | 'priority' | 'createdAt' | 'resolvedAt' | 'version'>;
const post = (id: string, over: Partial<P> = {}): P => ({ id, status: 'open', priority: 'normal', createdAt: '2026-11-07T01:00:00.000Z', resolvedAt: null, version: 1, ...over });

describe('the order of the notices', () => {
  it('pins open 至急 first, newest first, then the other open ones by time, then the resolved, withdrawn left out', () => {
    const sorted = sortDayOfPosts([
      post('n-old', { createdAt: '2026-11-07T00:10:00.000Z' }),
      post('u-old', { priority: 'urgent', createdAt: '2026-11-07T00:00:00.000Z' }),
      post('i-new', { priority: 'important', createdAt: '2026-11-07T02:00:00.000Z' }),
      post('n-new', { createdAt: '2026-11-07T03:00:00.000Z' }),
      post('u-new', { priority: 'urgent', createdAt: '2026-11-07T01:00:00.000Z' }),
      post('r-early', { status: 'resolved', priority: 'urgent', createdAt: '2026-11-07T04:00:00.000Z', resolvedAt: '2026-11-07T04:10:00.000Z' }),
      post('r-late', { status: 'resolved', createdAt: '2026-11-06T23:00:00.000Z', resolvedAt: '2026-11-07T05:00:00.000Z' }),
      post('w', { status: 'withdrawn', priority: 'urgent', createdAt: '2026-11-07T06:00:00.000Z' }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(['u-new', 'u-old', 'n-new', 'i-new', 'n-old', 'r-late', 'r-early']);
  });

  it('does not move a resolved 至急 above an open 通常', () => {
    const sorted = sortDayOfPosts([post('r', { status: 'resolved', priority: 'urgent', resolvedAt: '2026-11-07T05:00:00.000Z' }), post('n')]);
    expect(sorted.map((p) => p.id)).toEqual(['n', 'r']);
  });
});

describe('what changed between two refreshes', () => {
  it('reports nothing on the first load', () => {
    expect(diffDayOfPosts(null, [post('a', { priority: 'urgent' })])).toEqual({ newUrgent: [], added: [], changed: [], removed: [] });
  });

  it('flags a new 至急, a notice that became 至急, and leaves a known one alone', () => {
    const before = [post('known', { priority: 'urgent' }), post('raised'), post('gone'), post('fixed')];
    const after = [
      post('known', { priority: 'urgent' }),
      post('raised', { priority: 'urgent', version: 2 }),
      post('fixed', { version: 2 }),
      post('fresh', { priority: 'urgent' }),
      post('plain'),
    ];
    const diff = diffDayOfPosts(before, after);
    expect(diff.newUrgent).toEqual(['raised', 'fresh']);
    expect(diff.added).toEqual(['fresh', 'plain']);
    expect(diff.changed).toEqual(['raised', 'fixed']);
    expect(diff.removed).toEqual(['gone']);
  });

  it('does not flag a 至急 that was resolved, and flags it again when it is reopened', () => {
    const resolved = diffDayOfPosts([post('a', { priority: 'urgent' })], [post('a', { priority: 'urgent', status: 'resolved', version: 2 })]);
    expect(resolved.newUrgent).toEqual([]);
    expect(resolved.changed).toEqual(['a']);
    const reopened = diffDayOfPosts([post('a', { priority: 'urgent', status: 'resolved', version: 2 })], [post('a', { priority: 'urgent', version: 3 })]);
    expect(reopened.newUrgent).toEqual(['a']);
  });
});

describe('how often the home panel reads the board', () => {
  it('reads every 30 seconds in the period and every 5 minutes outside it, so a screen left open turns on at 00:00 JST', () => {
    expect(dayofPollDelay({ visible: true, refused: false, active: true })).toBe(DAYOF_POLL_MS);
    expect(dayofPollDelay({ visible: true, refused: false, active: false })).toBe(DAYOF_IDLE_POLL_MS);
    expect(DAYOF_IDLE_POLL_MS).toBe(5 * 60_000);
  });

  it('stops while the page is hidden and for a board refused to this person', () => {
    expect(dayofPollDelay({ visible: false, refused: false, active: true })).toBeNull();
    expect(dayofPollDelay({ visible: true, refused: true, active: false })).toBeNull();
  });
});

describe('a notice that moves on while it is being corrected', () => {
  const view = (over: Partial<DayOfPostView> = {}): DayOfPostView => ({
    id: 'dp_0000000000000001',
    status: 'open',
    priority: 'normal',
    body: '合成の連絡',
    place: '',
    departments: [],
    staffVisible: false,
    createdAt: '2026-11-07T01:00:00.000Z',
    authorName: '合成 本部',
    updatedAt: '2026-11-07T01:00:00.000Z',
    edited: false,
    resolvedAt: null,
    resolvedByName: null,
    version: 1,
    canEdit: true,
    ...over,
  });

  it('is unchanged while the board still has the version the correction began from', () => {
    expect(dayofEditDrift(1, view())).toEqual({ kind: 'none' });
  });

  it('is changed when someone else corrected it meanwhile, however many refreshes later', () => {
    const latest = view({ body: '別の人が直した連絡', version: 2, edited: true });
    // Judged against the version the correction began from (PostForm keeps it), not the one a refresh brings.
    expect(dayofEditDrift(1, latest)).toEqual({ kind: 'changed', latest });
    // Taking the current text (or choosing to overwrite it) moves the base on, and the drift goes.
    expect(dayofEditDrift(2, latest)).toEqual({ kind: 'none' });
  });

  it('is closed when it was resolved or withdrawn meanwhile, or left the board', () => {
    expect(dayofEditDrift(1, view({ status: 'resolved', version: 2 }))).toEqual({ kind: 'closed', status: 'resolved' });
    expect(dayofEditDrift(1, view({ status: 'withdrawn', version: 2 }))).toEqual({ kind: 'closed', status: 'withdrawn' });
    expect(dayofEditDrift(1, null)).toEqual({ kind: 'closed', status: 'gone' });
  });

  it('finds the notice among the open, resolved and withdrawn ones of the board', () => {
    const open = view();
    const withdrawn = view({ id: 'dp_0000000000000002', status: 'withdrawn' });
    expect(findDayOfPost({ posts: [open], withdrawn: [withdrawn] }, open.id)).toBe(open);
    expect(findDayOfPost({ posts: [open], withdrawn: [withdrawn] }, withdrawn.id)).toBe(withdrawn);
    expect(findDayOfPost({ posts: [open], withdrawn: [] }, 'dp_0000000000000003')).toBeNull();
  });
});

describe('temporary staff under the Discord login', () => {
  it('may read the notices and nothing else of the board', () => {
    expect(staffRouteAllowed('GET', '/api/dayof/notices')).toBe(true);
    expect(staffRouteAllowed('GET', '/api/dayof/board')).toBe(false);
    expect(staffRouteAllowed('POST', '/api/dayof/posts')).toBe(false);
    expect(staffRouteAllowed('POST', '/api/dayof/decisions')).toBe(false);
    expect(staffRouteAllowed('GET', '/api/dayof/admin')).toBe(false);
  });
});
