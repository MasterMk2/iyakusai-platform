import { describe, expect, it } from 'vitest';
import { handoverMarkdown, scrubContacts } from '../../src/server/rollover/handover.js';
import { markedMemo } from '../../src/server/rollover/calendar.js';
import { DATE_CHECK_MARK, defaultSourceYear, needsDateCheck, sameWeekdayInYear, shiftByRule, weekdayOfMonthLabel } from '../../src/shared/rollover.js';

// The year rollover's rules that need no store: the year to start from, where a date goes, the date-check mark,
// and the removal of contact details from the handover draft. Synthetic values only.

describe('the year a rollover starts from', () => {
  it('is this year from April on, else last year', () => {
    expect(defaultSourceYear('2026-11-04')).toBe(2026);
    expect(defaultSourceYear('2026-04-01')).toBe(2026);
    expect(defaultSourceYear('2027-03-31')).toBe(2026);
    expect(defaultSourceYear('2027-01-01')).toBe(2026);
  });
});

describe('where a date goes in the next year', () => {
  it('keeps the month and day, and 2/29 becomes 2/28', () => {
    expect(shiftByRule('2026-04-10', 2027, 'same-date')).toBe('2027-04-10');
    expect(shiftByRule('2028-02-29', 2029, 'same-date')).toBe('2029-02-28');
  });

  it('keeps the week and weekday of the month when chosen', () => {
    expect(weekdayOfMonthLabel('2026-11-14')).toBe('第2土曜日');
    expect(sameWeekdayInYear('2026-11-14', 2027)).toBe('2027-11-13');
    expect(shiftByRule('2026-11-14', 2027, 'same-weekday')).toBe('2027-11-13');
    // 2028-02-29 is the 5th Tuesday; February 2029 has four, so the last one.
    expect(sameWeekdayInYear('2028-02-29', 2029)).toBe('2029-02-27');
    // 2026-08-31 is the 5th Monday; August 2027 has five Mondays.
    expect(sameWeekdayInYear('2026-08-31', 2027)).toBe('2027-08-30');
    // 2026-01-01 is the 1st Thursday; the 1st Thursday of 2027 is January 7.
    expect(sameWeekdayInYear('2026-01-01', 2027)).toBe('2027-01-07');
  });
});

describe('the date-check mark of a copied event', () => {
  it('is on while the first memo line is there, and only on a copy', () => {
    const memo = markedMemo('元のメモ', '2026-04-10');
    expect(memo.startsWith(DATE_CHECK_MARK)).toBe(true);
    expect(memo.endsWith('\n元のメモ')).toBe(true);
    expect(needsDateCheck({ copiedFrom: 'ev_0123456789abcdef', memo })).toBe(true);
    expect(needsDateCheck({ copiedFrom: 'ev_0123456789abcdef', memo: '元のメモ' })).toBe(false);
    expect(needsDateCheck({ copiedFrom: null, memo })).toBe(false);
  });

  it('keeps the memo within the calendar’s limit', () => {
    expect([...markedMemo('あ'.repeat(2000), '2026-04-10')]).toHaveLength(2000);
  });
});

describe('contact details in the handover draft', () => {
  it('replaces mail addresses and phone numbers, and leaves other numbers', () => {
    expect(scrubContacts('連絡は x@example.invalid まで')).toBe('連絡は （連絡先を省略） まで');
    expect(scrubContacts('電話 090-0000-0000、事務所 076-000-0000')).toBe('電話 （連絡先を省略）、事務所 （連絡先を省略）');
    expect(scrubContacts('携帯０９０００００００００')).toBe('携帯（連絡先を省略）');
    expect(scrubContacts('+81 90-0000-0000')).toBe('（連絡先を省略）');
    expect(scrubContacts('2026-11-14 に 2,000 部、予算 300000 円')).toBe('2026-11-14 に 2,000 部、予算 300000 円');
  });

  it('escapes a table cell and says what is missing', () => {
    const md = handoverMarkdown({
      format: 'iyakusai-handover',
      version: 1,
      fiscalYear: 2026,
      generatedAt: '2026-11-04T03:00:00.000Z',
      missing: ['決定事項の台帳がこのサーバーにないため、決定事項は入っていません。'],
      decisions: [],
      organizations: [{ kind: '協賛', name: '合成|薬局', status: '入金済み', amountYen: 30000, content: '', department: '渉外部', hasContact: false }],
      events: [],
      tasks: { state: 'off', total: null, byDepartment: [] },
      rollover: [],
    });
    expect(md).toContain('| 合成\\|薬局 | 入金済み | 30,000 円 | — | 渉外部 | — |');
    expect(md).toContain('- 決定事項の台帳がこのサーバーにないため、決定事項は入っていません。');
  });
});
