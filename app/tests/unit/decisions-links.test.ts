import { describe, expect, it } from 'vitest';
import {
  decisionHref,
  decisionNewHref,
  departmentLabel,
  japanDay,
  oneLine,
  parseDecisionPrefill,
  parseWords,
  returnHref,
} from '../../src/client/components/decisions/decisionLinks.js';
import { DECISION_TASK_ID } from '../../src/shared/decisions.js';

// The hand-over addresses of the decision register (mail, LINE and minutes screens) and the small helpers of its
// screens. Synthetic text only.

describe('decision addresses', () => {
  it('builds the detail address of a decision', () => {
    expect(decisionHref('dc_0123456789abcdef')).toBe('#/decisions?d=dc_0123456789abcdef');
  });

  it('carries the prefill of a mail into the form and reads it back', () => {
    const href = decisionNewHref({
      title: '出展団体への案内は 10 月 31 日まで',
      decidedOn: '2026-10-10',
      source: { kind: 'mail', refId: 'th_0123456789abcdef', label: '合成の案内メール', link: '#/all?thread=th_0123456789abcdef' },
    });
    expect(href.startsWith('#/decisions?new=1')).toBe(true);
    const params = new URLSearchParams(href.split('?')[1]);
    expect(parseDecisionPrefill(params)).toEqual({
      title: '出展団体への案内は 10 月 31 日まで',
      decidedOn: '2026-10-10',
      source: { kind: 'mail', refId: 'th_0123456789abcdef', label: '合成の案内メール', link: '#/all?thread=th_0123456789abcdef' },
    });
  });

  it('drops a link that is not an address of this app, and a day that is not a day', () => {
    const params = new URLSearchParams({ new: '1', src: 'manual', label: '合成', link: 'https://example.invalid/x', date: '2026-13-40' });
    expect(parseDecisionPrefill(params)).toEqual({ title: '', decidedOn: '', source: { kind: 'manual', refId: null, label: '合成', link: null } });
  });

  it('ignores a source kind it does not know', () => {
    const params = new URLSearchParams({ new: '1', title: '合成の決定', src: 'fax', label: '合成' });
    expect(parseDecisionPrefill(params)).toEqual({ title: '合成の決定', decidedOn: '', source: null });
  });

  it('gives no prefill for a bare form', () => {
    expect(parseDecisionPrefill(new URLSearchParams({ new: '1' }))).toBeNull();
    expect(decisionNewHref(null)).toBe('#/decisions?new=1');
  });

  it('keeps a subject to one line, without control characters, within the limit', () => {
    expect(oneLine('件名\n二行目\u0001の続き', 100)).toBe('件名 二行目 の続き');
    expect(oneLine('あ'.repeat(150), 100)).toHaveLength(100);
  });
});

describe('the screen a form returns to', () => {
  it('carries the screen the form was opened from, and returns there', () => {
    const href = decisionNewHref({ title: '', decidedOn: '2026-10-10', source: null }, '#/line/acc_1?conv=conv_1');
    expect(returnHref(href)).toBe('#/line/acc_1?conv=conv_1');
  });

  it('goes to the list when there is no such screen, or it is not an address of this app', () => {
    expect(returnHref('#/decisions?new=1')).toBe('#/decisions');
    expect(returnHref(decisionNewHref(null, 'https://example.invalid/x'))).toBe('#/decisions');
    expect(decisionNewHref(null, '#/mail?thread=th_0123456789abcdef')).toContain('back=');
  });
});

describe('small helpers', () => {
  it('reads the day in Japan from an instant', () => {
    expect(japanDay('2026-10-17T15:30:00.000Z')).toBe('2026-10-18');
    expect(japanDay('not a date')).toBe('');
  });

  it('splits words typed by hand (department keys, task IDs)', () => {
    expect(parseWords(' planning, naimu、gaimu  ')).toEqual(['planning', 'naimu', 'gaimu']);
    expect(parseWords('')).toEqual([]);
    expect(DECISION_TASK_ID.test('task-12')).toBe(true);
  });

  it('shows the key itself when the Task service has no name for it', () => {
    expect(departmentLabel('somu', [{ key: 'somu', label: '総務部' }])).toBe('総務部');
    expect(departmentLabel('planning', [])).toBe('planning');
  });
});
