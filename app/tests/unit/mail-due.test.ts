import { describe, expect, it } from 'vitest';
import { addDays, isDueDate, japaneseDay, jstDay, replyDueMin, replyDueSentence } from '../../src/shared/mailDue.js';

// Deadlines of committee mail (2026-11-03): the calendar rules the server and the screens share. Synthetic dates only.

describe('deadline dates', () => {
  it('accepts a real calendar day in the YYYY-MM-DD form and nothing else', () => {
    expect(isDueDate('2026-11-10')).toBe(true);
    expect(isDueDate('2028-02-29')).toBe(true);
    expect(isDueDate('2026-02-29')).toBe(false);
    expect(isDueDate('2026-13-01')).toBe(false);
    expect(isDueDate('2026-1-5')).toBe(false);
    expect(isDueDate('2026-11-10T00:00:00Z')).toBe(false);
    expect(isDueDate('1999-12-31')).toBe(false);
    expect(isDueDate(20261110)).toBe(false);
    expect(isDueDate(null)).toBe(false);
  });

  it('takes the calendar day in Japan time, so 01:00 JST is already the next day', () => {
    // 2026-11-10T16:00Z is 2026-11-11 01:00 in Japan.
    expect(jstDay('2026-11-10T16:00:00.000Z')).toBe('2026-11-11');
    expect(jstDay('2026-11-10T14:59:59.999Z')).toBe('2026-11-10');
    expect(jstDay(Date.parse('2026-11-10T16:00:00.000Z'))).toBe('2026-11-11');
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-03', 3)).toBe('2026-11-06');
    expect(addDays('2026-11-03', -1)).toBe('2026-11-02');
  });

  it('writes a Japanese day with its weekday, and the year only when it is not this year', () => {
    expect(japaneseDay('2026-11-10', '2026-11-03')).toBe('11月10日（火）');
    expect(japaneseDay('2027-01-10', '2026-11-03')).toBe('2027年1月10日（日）');
  });

  it('builds the reply sentence that the compose screen adds to the end of the body', () => {
    expect(replyDueSentence('2026-11-10', '2026-11-03')).toBe('ご回答は11月10日（火）までにお願いいたします。');
  });

  it('keeps a saved reply deadline that has passed, but not a day typed in now', () => {
    // A new day must be today or later.
    expect(replyDueMin('2026-11-03', null, '2026-11-10')).toBe('2026-11-03');
    expect(replyDueMin('2026-11-03', '2026-11-01', '2026-11-05')).toBe('2026-11-03');
    // The saved (already passed) day may stay while other fields change.
    expect(replyDueMin('2026-11-03', '2026-11-01', '2026-11-01')).toBeUndefined();
    expect(replyDueMin('2026-11-03', null, '')).toBeUndefined();
  });
});
