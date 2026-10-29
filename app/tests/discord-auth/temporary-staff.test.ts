import { afterEach, describe, expect, it } from 'vitest';
import { isStaffStudentId, isTemporaryStaffId, isTemporaryStaffLoginId } from '../../src/server/discord-auth/temporary-staff.js';

const saved = process.env.SMM_TEMPORARY_STAFF_RANGE;
afterEach(() => {
  if (saved === undefined) delete process.env.SMM_TEMPORARY_STAFF_RANGE;
  else process.env.SMM_TEMPORARY_STAFF_RANGE = saved;
});

describe('the temporary staff number range', () => {
  it('is the operator range, both ends included, and nothing else', () => {
    process.env.SMM_TEMPORARY_STAFF_RANGE = '00000100-00000199';
    expect(['00000100', '00000150', '00000199'].every(isStaffStudentId)).toBe(true);
    expect(['00000099', '00000200', '0000015', '000001500', 'abcdefgh'].some(isStaffStudentId)).toBe(false);
    expect(isTemporaryStaffId('staff:00000150')).toBe(true);
    expect(isTemporaryStaffLoginId('iy-00000150')).toBe(true);
    expect(isTemporaryStaffId('staff:00000200')).toBe(false);
  });

  it('has no numbers when it is unset or not two eight-digit ends in order', () => {
    for (const value of [undefined, '', '00000100', '00000199-00000100', '100-199', '00000100 - 00000199']) {
      if (value === undefined) delete process.env.SMM_TEMPORARY_STAFF_RANGE;
      else process.env.SMM_TEMPORARY_STAFF_RANGE = value;
      expect(isStaffStudentId('00000150')).toBe(false);
      expect(isTemporaryStaffId('staff:00000150')).toBe(false);
    }
  });
});
