import { describe, expect, it } from 'vitest';
import { compareDepartments, DEPARTMENT_ORDER } from '../../src/shared/departments.js';

describe('department order (2026-11-05)', () => {
  it('puts each 部 before its 課, in the organisation order', () => {
    const shuffled = ['システム課', '会場課', '内務部', '総務部', '役員会', '渉外課', '外務部', '会計課', '広報課', '企画課'];
    expect([...shuffled].sort(compareDepartments)).toEqual([...DEPARTMENT_ORDER]);
  });

  it('puts names outside the list after it, in Japanese order', () => {
    expect(['臨時スタッフ', '外務部', 'あ班', '役員会'].sort(compareDepartments)).toEqual(['役員会', '外務部', 'あ班', '臨時スタッフ']);
  });
});
