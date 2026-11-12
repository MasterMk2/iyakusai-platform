import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLater, LAST_READ_LIMIT, laterOf, newestAt, readPlace, rememberedRead, rememberRead } from '../../src/client/components/lineLastRead.js';

// Where an official LINE conversation opens (2026-11-13): just below the last row this person read on this browser.

const at = (minute: number) => `2026-11-13T00:${String(minute).padStart(2, '0')}:00.000Z`;
const rows = [at(1), at(2), at(3), at(4)];

describe('readPlace', () => {
  it('opens at the latest when nothing was remembered (first open on this browser)', () => {
    expect(readPlace(rows, null)).toEqual({ lastRead: 3, unread: 0 });
  });

  it('opens at the latest when nothing came since', () => {
    expect(readPlace(rows, at(4))).toEqual({ lastRead: 3, unread: 0 });
    expect(readPlace(rows, at(9))).toEqual({ lastRead: 3, unread: 0 });
  });

  it('puts the place after the last row read when rows came since', () => {
    expect(readPlace(rows, at(2))).toEqual({ lastRead: 1, unread: 2 });
    // A time between rows: the rows up to it were read.
    expect(readPlace(rows, '2026-11-13T00:02:30.000Z')).toEqual({ lastRead: 1, unread: 2 });
  });

  it('puts the place before the first row when every row is newer', () => {
    expect(readPlace(rows, at(0))).toEqual({ lastRead: -1, unread: 4 });
  });

  it('counts a late row with an older time as read (rows are in time order, so it sits before the place)', () => {
    // at(3) came in after the place was kept at at(4), but is older: read. Only at(5) is new.
    expect(readPlace([at(1), at(3), at(5)], at(4))).toEqual({ lastRead: 1, unread: 1 });
  });

  it('has no place in an empty conversation', () => {
    expect(readPlace([], at(1))).toEqual({ lastRead: -1, unread: 0 });
    expect(readPlace([], null)).toEqual({ lastRead: -1, unread: 0 });
  });

  it('puts the line before the first new row that counts (the committee’s own sends never do)', () => {
    // Rows 3 (own send) and 4 (the other side) are new; the line goes before row 4.
    expect(readPlace(rows, at(2), [true, true, false, true])).toEqual({ lastRead: 2, unread: 1 });
    // Only own sends are new: nothing unread, open at the latest.
    expect(readPlace(rows, at(2), [true, true, false, false])).toEqual({ lastRead: 3, unread: 0 });
  });

  it('compares times, not strings (an offset or a missing fraction)', () => {
    expect(readPlace(['2026-11-13T09:01:00+09:00', '2026-11-13T00:03:00Z'], '2026-11-13T00:02:00.000Z')).toEqual({ lastRead: 0, unread: 1 });
  });
});

describe('newestAt', () => {
  it('is the latest time, wherever it is', () => {
    expect(newestAt([at(1), at(5), at(3)])).toBe(at(5));
    expect(newestAt([])).toBeNull();
  });
});

describe('the later of this device’s and the server’s place', () => {
  it('takes whichever is later, or the one there is', () => {
    expect(laterOf(at(2), at(5))).toBe(at(5));
    expect(laterOf(at(5), at(2))).toBe(at(5));
    expect(laterOf(null, at(2))).toBe(at(2));
    expect(laterOf(at(2), null)).toBe(at(2));
    expect(laterOf(null, null)).toBeNull();
    expect(isLater('2026-11-13T09:05:00+09:00', at(4))).toBe(true);
    expect(isLater(at(4), at(4))).toBe(false);
  });
});

describe('remembered place (per person, on this browser)', () => {
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps each person apart', () => {
    rememberRead('u-a', 'c1', at(3));
    expect(rememberedRead('u-a', 'c1')).toBe(at(3));
    expect(rememberedRead('u-b', 'c1')).toBeNull();
    expect(rememberedRead('u-a', 'c2')).toBeNull();
  });

  it('never goes back to an older time', () => {
    rememberRead('u-a', 'c1', at(5));
    rememberRead('u-a', 'c1', at(2));
    expect(rememberedRead('u-a', 'c1')).toBe(at(5));
    rememberRead('u-a', 'c1', at(7));
    expect(rememberedRead('u-a', 'c1')).toBe(at(7));
  });

  it('forgets the least recently opened beyond the limit', () => {
    for (let i = 0; i <= LAST_READ_LIMIT; i += 1) rememberRead('u-a', `c${i}`, at(1));
    rememberRead('u-a', 'c1', at(2)); // opened again: kept
    rememberRead('u-a', 'extra', at(1));
    expect(rememberedRead('u-a', 'c0')).toBeNull();
    expect(rememberedRead('u-a', 'c2')).toBeNull();
    expect(rememberedRead('u-a', 'c1')).toBe(at(2));
    expect(rememberedRead('u-a', 'extra')).toBe(at(1));
  });

  it('reads a broken or foreign value as nothing remembered', () => {
    data.set('iyakusai.line.lastRead.u-a', '{oops');
    expect(rememberedRead('u-a', 'c1')).toBeNull();
    data.set('iyakusai.line.lastRead.u-a', JSON.stringify({ c1: 5, c2: at(1) }));
    expect(rememberedRead('u-a', 'c1')).toBeNull();
    expect(rememberedRead('u-a', 'c2')).toBe(at(1));
  });

  it('opens at the latest when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => rememberRead('u-a', 'c1', at(1))).not.toThrow();
    expect(rememberedRead('u-a', 'c1')).toBeNull();
  });
});
