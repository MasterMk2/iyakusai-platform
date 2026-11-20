import { describe, expect, it } from 'vitest';
import {
  audienceIncludes,
  AvailabilityValidationError,
  availabilityDays,
  busyMinutesByDay,
  describeDay,
  jstMidnight,
  normalizeCalendarId,
  partsOf,
  validateAudience,
} from '../../src/shared/availability.js';

// Free/busy (2026-11-20): cutting Google's busy instants into Japan days, the parts of a day, the owner's audience
// and the input checks. Synthetic times only.

const at = (iso: string) => Date.parse(iso);

describe('busyMinutesByDay', () => {
  it('turns UTC instants into Japan minutes of the right day', () => {
    // 05:00–07:00 UTC is 14:00–16:00 in Japan.
    const days = busyMinutesByDay([{ start: at('2026-11-21T05:00:00Z'), end: at('2026-11-21T07:00:00Z') }], '2026-11-20', '2026-11-30');
    expect([...days.entries()]).toEqual([['2026-11-21', [[840, 960]]]]);
  });

  it('splits a period over midnight (Japan time) into the two days', () => {
    // 2026-11-21 22:00 to 2026-11-22 02:00 Japan time.
    const days = busyMinutesByDay([{ start: at('2026-11-21T13:00:00Z'), end: at('2026-11-21T17:00:00Z') }], '2026-11-20', '2026-11-30');
    expect(days.get('2026-11-21')).toEqual([[1320, 1440]]);
    expect(days.get('2026-11-22')).toEqual([[0, 120]]);
  });

  it('keeps a whole Japan day as 0–1440 and nothing on the next day', () => {
    const days = busyMinutesByDay([{ start: at(jstMidnight('2026-11-23')), end: at(jstMidnight('2026-11-24')) }], '2026-11-20', '2026-11-30');
    expect(days.get('2026-11-23')).toEqual([[0, 1440]]);
    expect(days.has('2026-11-24')).toBe(false);
  });

  it('merges overlapping and touching periods and drops what is outside the days asked', () => {
    const days = busyMinutesByDay(
      [
        { start: at('2026-11-21T00:00:00Z'), end: at('2026-11-21T01:00:00Z') }, // 09:00–10:00
        { start: at('2026-11-21T00:30:00Z'), end: at('2026-11-21T02:00:00Z') }, // 09:30–11:00
        { start: at('2026-11-21T02:00:00Z'), end: at('2026-11-21T03:00:00Z') }, // 11:00–12:00 (touching)
        { start: at('2026-11-10T00:00:00Z'), end: at('2026-11-10T01:00:00Z') }, // before the days asked
      ],
      '2026-11-20',
      '2026-11-30',
    );
    expect([...days.entries()]).toEqual([['2026-11-21', [[540, 720]]]]);
  });

  it('rounds partial minutes outward (a busy second is a busy minute)', () => {
    const days = busyMinutesByDay([{ start: at('2026-11-21T05:00:30Z'), end: at('2026-11-21T05:10:10Z') }], '2026-11-21', '2026-11-21');
    expect(days.get('2026-11-21')).toEqual([[840, 851]]);
  });
});

describe('parts and words', () => {
  it('marks the parts a range touches', () => {
    expect(partsOf([[600, 780]])).toEqual(['am', 'pm']);
    expect(partsOf([[1080, 1200]])).toEqual(['night']);
    expect(partsOf([[0, 1440]])).toEqual(['am', 'pm', 'night']);
  });

  it('sends no times when the owner shares parts only', () => {
    const byDay = new Map<string, [number, number][]>([['2026-11-21', [[840, 960]]]]);
    expect(availabilityDays(byDay, 'parts')).toEqual([{ date: '2026-11-21', parts: ['pm'] }]);
    expect(availabilityDays(byDay, 'blocks')).toEqual([{ date: '2026-11-21', parts: ['pm'], blocks: [{ start: '14:00', end: '16:00' }] }]);
  });

  it('describes a day in words', () => {
    expect(describeDay({ date: '2026-11-21', parts: ['pm', 'night'] })).toBe('午後・夜');
    expect(describeDay({ date: '2026-11-21', parts: ['pm'], blocks: [{ start: '14:00', end: '16:00' }, { start: '19:00', end: '21:30' }] })).toBe('14:00–16:00、19:00–21:30');
    expect(describeDay({ date: '2026-11-21', parts: ['am', 'pm', 'night'], blocks: [{ start: '00:00', end: '24:00' }] })).toBe('終日');
    expect(describeDay({ date: '2026-11-21', parts: ['am', 'pm', 'night'] })).toBe('午前・午後・夜');
  });
});

describe('audience', () => {
  const audience = { everyone: false, departments: ['役員会'], people: ['u-b'] };
  it('lets the owner, the chosen departments and the chosen people see; nobody else', () => {
    expect(audienceIncludes(audience, 'u-owner', { id: 'u-owner', departments: [] })).toBe(true);
    expect(audienceIncludes(audience, 'u-owner', { id: 'u-a', departments: ['総務部', '役員会'] })).toBe(true);
    expect(audienceIncludes(audience, 'u-owner', { id: 'u-b', departments: [] })).toBe(true);
    expect(audienceIncludes(audience, 'u-owner', { id: 'u-c', departments: ['内務部'] })).toBe(false);
    expect(audienceIncludes({ ...audience, everyone: true }, 'u-owner', { id: 'u-c', departments: [] })).toBe(true);
  });

  it('checks the shape and removes duplicates', () => {
    expect(validateAudience({ everyone: false, departments: ['役員会', '役員会 '], people: ['u-b', 'u-b'] })).toEqual({ everyone: false, departments: ['役員会'], people: ['u-b'] });
    expect(() => validateAudience({ everyone: 'yes', departments: [], people: [] })).toThrow(AvailabilityValidationError);
    expect(() => validateAudience({ everyone: false, departments: [], people: [], extra: 1 })).toThrow(AvailabilityValidationError);
    expect(() => validateAudience({ everyone: false, departments: ['a\nb'], people: [] })).toThrow(AvailabilityValidationError);
    expect(() => validateAudience({ everyone: false, departments: [], people: ['<script>'] })).toThrow(AvailabilityValidationError);
  });
});

describe('calendar ID', () => {
  it('takes an address or another calendar ID, trimmed and in lower case', () => {
    expect(normalizeCalendarId('  Someone@Example.INVALID ')).toBe('someone@example.invalid');
    expect(normalizeCalendarId('abc123def@group.calendar.google.com')).toBe('abc123def@group.calendar.google.com');
    expect(normalizeCalendarId('ｓｏｍｅｏｎｅ＠ｅｘａｍｐｌｅ．ｉｎｖａｌｉｄ')).toBe('someone@example.invalid');
  });
  it('refuses what is not one', () => {
    for (const bad of ['', 'someone', 'someone@', '@example.invalid', 'a b@example.invalid', 'someone@localhost', 42]) {
      expect(() => normalizeCalendarId(bad)).toThrow(AvailabilityValidationError);
    }
  });
});
