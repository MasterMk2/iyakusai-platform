import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarDateParam,
  CalendarValidationError,
  daysBetween,
  isDateOnly,
  jstDate,
  occurrenceInYear,
  reminderLeft,
  shiftYears,
  validateCalendarEvent,
  weekStart,
} from '../../src/shared/calendar.js';
import { buildIcs, escapeText, FailureCounter, foldLine, newIcalToken, tokenFromFile, tokenHash } from '../../src/server/calendar/ical.js';

// Pure rules of the committee calendar: validation, Japan-time dates, the yearly shift and the iCalendar text.
// Synthetic values only.

const sample = {
  title: '（例）企画書の提出締切',
  kind: 'deadline',
  date: '2026-11-20',
  time: null,
  departments: ['企画部'],
  memo: '合成データ',
  yearly: false,
  remindDays: [3, 14],
};

describe('validateCalendarEvent', () => {
  it('accepts a complete event and keeps the values as typed', () => {
    expect(validateCalendarEvent(sample)).toEqual(sample);
  });

  it('trims the title, drops empty and repeated departments, and sorts the reminder days', () => {
    const out = validateCalendarEvent({ ...sample, title: '  会議  ', departments: [' 総務部 ', '', '総務部', '企画部'], remindDays: [1, 14, 1] });
    expect(out.title).toBe('会議');
    expect(out.departments).toEqual(['総務部', '企画部']);
    expect(out.remindDays).toEqual([1, 14]);
  });

  it('normalizes line breaks in the memo', () => {
    expect(validateCalendarEvent({ ...sample, memo: 'a\r\nb\rc' }).memo).toBe('a\nb\nc');
  });

  it.each([
    ['empty title', { title: '   ' }, 'title'],
    ['control character in title', { title: 'a\u0007b' }, 'title'],
    ['line break in title', { title: '会議\n第2回' }, 'title'],
    ['carriage return in title', { title: '会議\r第2回' }, 'title'],
    ['line break in a department name', { departments: ['企画部\n総務部'] }, 'departments'],
    ['tab in a department name', { departments: ['企画部\t総務部'] }, 'departments'],
    ['a date that does not exist', { date: '2026-02-30' }, 'date'],
    ['a date in another shape', { date: '2026/11/20' }, 'date'],
    ['a time out of range', { time: '25:00' }, 'time'],
    ['an unknown kind', { kind: 'party' }, 'kind'],
    ['too many reminder days', { remindDays: [1, 2, 3, 4, 5, 6] }, 'remindDays'],
    ['a reminder day out of range', { remindDays: [61] }, 'remindDays'],
  ])('refuses %s', (_label, change, field) => {
    let caught: unknown = null;
    try {
      validateCalendarEvent({ ...sample, ...change });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CalendarValidationError);
    expect((caught as CalendarValidationError).field).toBe(field);
  });

  it('refuses keys it does not know (a record may not carry more than the form)', () => {
    expect(() => validateCalendarEvent({ ...sample, assignee: 'someone' })).toThrow(CalendarValidationError);
  });
});

describe('Japan-time dates', () => {
  it('reads the date in Japan time, not UTC', () => {
    expect(jstDate(new Date('2026-11-02T14:59:00Z'))).toBe('2026-11-02');
    expect(jstDate(new Date('2026-11-02T15:00:00Z'))).toBe('2026-11-03');
  });

  it('counts days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(daysBetween('2026-11-03', '2026-11-10')).toBe(7);
    expect(daysBetween('2026-11-10', '2026-11-03')).toBe(-7);
  });

  it('starts a week on Sunday', () => {
    const start = weekStart('2026-11-03');
    expect(new Date(`${start}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(daysBetween(start, '2026-11-03')).toBeGreaterThanOrEqual(0);
    expect(daysBetween(start, '2026-11-03')).toBeLessThan(7);
  });

  it('rejects impossible calendar dates', () => {
    expect(isDateOnly('2028-02-29')).toBe(true);
    expect(isDateOnly('2027-02-29')).toBe(false);
  });

  it('takes only a real date from the day a home link asks the calendar to open on', () => {
    expect(calendarDateParam('2026-12-25')).toBe('2026-12-25');
    expect(calendarDateParam('2026-02-30')).toBeNull();
    expect(calendarDateParam('2026/12/25')).toBeNull();
    expect(calendarDateParam('../x')).toBeNull();
    expect(calendarDateParam(null)).toBeNull();
  });

});

describe('yearly shift', () => {
  it('keeps the month and day for the same date in another year', () => {
    expect(shiftYears('2026-04-01', 1)).toBe('2027-04-01');
    expect(occurrenceInYear('2026-04-01', 2030)).toBe('2030-04-01');
  });

  it('moves 29 February to 28 February in a year without it', () => {
    expect(shiftYears('2028-02-29', 1)).toBe('2029-02-28');
    expect(occurrenceInYear('2028-02-29', 2032)).toBe('2032-02-29');
  });
});

describe('reminder window', () => {
  const today = '2026-11-03';
  it('shows an event once its reminder days have begun, with the days left', () => {
    expect(reminderLeft({ remindDays: [14, 3] }, '2026-11-10', today)).toBe(7);
    expect(reminderLeft({ remindDays: [14, 3] }, '2026-11-03', today)).toBe(0);
  });

  it('does not show an event before its window, after its date, or with no reminder', () => {
    expect(reminderLeft({ remindDays: [3] }, '2026-11-20', today)).toBeNull();
    expect(reminderLeft({ remindDays: [14] }, '2026-11-02', today)).toBeNull();
    expect(reminderLeft({ remindDays: [] }, '2026-11-05', today)).toBeNull();
  });
});

describe('iCalendar text', () => {
  it('escapes the characters the format reserves', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('folds long lines at 75 octets without cutting a character, and unfolds to the original', () => {
    const japanese = '委員会の予定と締切を一緒に見られるように'.repeat(4);
    for (const line of [japanese, 'x'.repeat(200)]) {
      const folded = foldLine(line);
      for (const physical of folded.split('\r\n')) expect(Buffer.byteLength(physical, 'utf8')).toBeLessThanOrEqual(75);
      expect(folded.replace(/\r\n /g, '')).toBe(line);
    }
  });

  it('writes a valid calendar with CRLF line ends and all-day items only, and no memo or time', () => {
    const ics = buildIcs(
      [
        { key: 'ev_1', title: '締切, 大事', date: '2026-11-20' },
        { key: 'ev_2', title: '会議', date: '2026-11-21' },
      ],
      '2026-11-03T01:02:03.000Z',
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261121');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261121\r\nDTEND;VALUE=DATE:20261122');
    expect(ics).not.toMatch(/DTSTART:\d{8}T/);
    expect(ics).toContain('SUMMARY:締切\\, 大事');
    expect(ics).toMatch(/UID:ev_1@[a-z.]+\.invalid/);
    expect(ics).toContain('DTSTAMP:20261103T010203Z');
    expect(ics).not.toMatch(/DESCRIPTION/);
    expect(ics.split('\r\n').every((l) => l.length === 0 || Buffer.byteLength(l, 'utf8') <= 75)).toBe(true);
  });
});

describe('subscription tokens', () => {
  it('makes 43-character tokens from 32 random bytes, and reads them back from the file part only', () => {
    const token = newIcalToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newIcalToken()).not.toBe(token);
    expect(tokenFromFile(`${token}.ics`)).toBe(token);
    expect(tokenFromFile(`${token}.txt`)).toBeNull();
    expect(tokenFromFile('abc.ics')).toBeNull();
  });

  it('keeps a hash, not the token, and the hash is stable', () => {
    const token = newIcalToken();
    expect(tokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(token)).toBe(tokenHash(token));
    expect(tokenHash(token)).not.toContain(token);
  });
});

describe('failure counter', () => {
  it('refuses after the limit inside the window and allows again after it', () => {
    const counter = new FailureCounter(2, 1000);
    expect(counter.allow('a', 0)).toBe(true);
    expect(counter.allow('a', 1)).toBe(true);
    expect(counter.allow('a', 2)).toBe(false);
    expect(counter.allow('b', 2)).toBe(true);
    expect(counter.allow('a', 1001)).toBe(true);
  });
});
