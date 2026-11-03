import { describe, expect, it } from 'vitest';
import {
  CsvError,
  decodeCsvBytes,
  defaultStatus,
  guessMapping,
  kindFromText,
  mailValues,
  OrgValidationError,
  orgNameKey,
  parseCsv,
  parseCsvRecords,
  parseYenText,
  placeholdersIn,
  renderMail,
  validateOrg,
  validateTemplate,
  validDate,
  type OrgInput,
} from '../../src/shared/organizations.js';

// Organizations (団体の台帳): the rules shared by the server and the screen. Synthetic names only.

const sponsor: OrgInput = {
  kind: 'sponsor',
  fiscalYear: 2026,
  name: '合成商事株式会社',
  department: '渉外課',
  ownerId: null,
  contactId: null,
  status: '依頼前',
  amountYen: 300_000,
  content: '広告（大）',
  nextAction: '依頼状を送る',
  nextDue: '2026-11-30',
  notes: '',
};

describe('the organization rules', () => {
  it('accepts an organization and tidies its text (spaces in one line, line breaks kept in notes)', () => {
    expect(validateOrg({ ...sponsor, name: '  合成商事　株式会社 ', notes: 'a\r\nb  ' })).toEqual({ ...sponsor, name: '合成商事 株式会社', notes: 'a\nb' });
  });

  it('checks the status against the kind: a stage of a sponsor, any short text for the other kinds', () => {
    expect(() => validateOrg({ ...sponsor, status: '申込' })).toThrow(OrgValidationError);
    expect(validateOrg({ ...sponsor, kind: 'exhibitor', status: '申込' }).status).toBe('申込');
    expect(validateOrg({ ...sponsor, kind: 'donor', status: '相談中' }).status).toBe('相談中');
    expect(() => validateOrg({ ...sponsor, kind: 'donor', status: '   ' })).toThrow(/状態/);
    expect(defaultStatus('sponsor')).toBe('依頼前');
    expect(defaultStatus('exhibitor')).toBe('申込');
    expect(defaultStatus('vendor')).toBe('未対応');
  });

  it('refuses what cannot be stored: an unknown kind, a year out of range, a bad amount, a date that is not one', () => {
    expect(() => validateOrg({ ...sponsor, kind: 'bank' })).toThrow(/種別/);
    expect(() => validateOrg({ ...sponsor, fiscalYear: 1999 })).toThrow(/年度/);
    expect(() => validateOrg({ ...sponsor, amountYen: -1 })).toThrow(/金額/);
    expect(() => validateOrg({ ...sponsor, amountYen: 1.5 })).toThrow(/金額/);
    expect(() => validateOrg({ ...sponsor, nextDue: '2026-02-30' })).toThrow(/期限/);
    expect(() => validateOrg({ ...sponsor, name: '' })).toThrow(/団体名/);
    expect(() => validateOrg({ ...sponsor, name: '合成​商事' })).toThrow(/使えない文字/);
    expect(() => validateOrg({ ...sponsor, ownerId: 'Not Valid' })).toThrow(/担当/);
    expect(() => validateOrg({ ...sponsor, contactId: 'ct_12' })).toThrow(/相手の担当者/);
  });

  it('reads dates strictly and makes the group key ignore spaces and width', () => {
    expect(validDate('2028-02-29')).toBe(true);
    expect(validDate('2026-02-29')).toBe(false);
    expect(validDate('2026/11/30')).toBe(false);
    expect(orgNameKey('合成商事　株式会社')).toBe(orgNameKey('合成商事 株式会社'));
    expect(orgNameKey('ＡＢＣ商事')).toBe(orgNameKey('abc商事'));
  });
});

describe('mail templates and placeholders', () => {
  it('names the placeholders in a text and refuses unknown ones when the template is saved', () => {
    expect(placeholdersIn('{団体名} 様 {金額} {団体名}')).toEqual(['団体名', '金額']);
    expect(() => validateTemplate({ name: '請求', subject: '{団体名}', body: '{住所}' })).toThrow(/住所/);
    expect(validateTemplate({ name: ' 請求 ', subject: '件名 {団体名}', body: '{団体名} 様\n{金額}' })).toEqual({ name: '請求', subject: '件名 {団体名}', body: '{団体名} 様\n{金額}' });
    expect(() => validateTemplate({ name: '請求', subject: '', body: '本文' })).toThrow(/件名/);
  });

  it('fills the values and reports the empty ones, and a subject stays on one line', () => {
    const values = mailValues({ name: '合成商事', fiscalYear: 2026, kind: 'sponsor', status: '依頼前', amountYen: 1_234_567, content: '', nextAction: '', nextDue: null, department: '渉外課', ownerName: '合成 太郎', contactName: '' });
    expect(values['金額']).toBe('1,234,567円');
    expect(values['委員会の担当']).toBe('渉外課 合成 太郎');
    const body = renderMail('{団体名} 様\n協賛内容: {協賛内容}\n{担当者名}', values);
    expect(body.text).toBe('合成商事 様\n協賛内容: \n');
    expect(body.empty).toEqual(['協賛内容', '担当者名']);
    expect(renderMail('{団体名}\n{年度}', { 団体名: '甲\n乙', 年度: '2026年度' }, true)).toEqual({ text: '甲 乙 2026年度', empty: [] });
    // A placeholder with no value at all is left as written (the template check keeps those out).
    expect(renderMail('{住所}', {}).text).toBe('{住所}');
  });
});

describe('CSV from a sheet', () => {
  it('reads quoted cells, doubled quotes, CRLF and LF, and drops empty lines', () => {
    expect(parseCsv('団体名,金額\r\n"合成, 商事","1,000"\r\n\r\n"言う ""合成""",5\n')).toEqual([
      ['団体名', '金額'],
      ['合成, 商事', '1,000'],
      ['言う "合成"', '5'],
    ]);
  });

  it('refuses a quote that is never closed', () => {
    expect(() => parseCsv('"合成,金額')).toThrow(CsvError);
  });

  it('reads UTF-8 with a BOM, and Shift_JIS when the bytes are not UTF-8 (what a Japanese spreadsheet writes)', () => {
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('団体名\n', 'utf8')]);
    expect(decodeCsvBytes(utf8)).toEqual({ text: '団体名\n', encoding: 'utf-8' });
    // あいう in Shift_JIS, then a line break.
    const sjis = new Uint8Array([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4, 0x0a]);
    expect(decodeCsvBytes(sjis)).toEqual({ text: 'あいう\n', encoding: 'shift_jis' });
  });

  it('reads amounts as a sheet writes them, and says when one is not a number', () => {
    expect(parseYenText('￥1,000,000')).toBe(1_000_000);
    expect(parseYenText('1000円')).toBe(1000);
    expect(parseYenText('１２３')).toBe(123);
    expect(parseYenText('  ')).toBeNull();
    expect(parseYenText('約10万')).toBe('invalid');
    expect(parseYenText('1000000000000')).toBe('invalid');
  });

  it('knows the kinds by name or label, and guesses the columns from the header names', () => {
    expect(kindFromText('出展団体')).toBe('exhibitor');
    expect(kindFromText('exhibitor')).toBe('exhibitor');
    expect(kindFromText('不明')).toBeNull();
    expect(guessMapping(['団体名', '種別', '協賛額', '相手のメール', '次の対応', '期限'])).toEqual({ name: 0, kind: 1, amountYen: 2, contactEmail: 3, nextAction: 4, nextDue: 5 });
  });
});

describe('organizations: the CSV line numbers match the sheet', () => {
  it('gives each record the physical line it starts on, after a blank line and a line break inside a quoted cell', () => {
    const text = 'a,b\n\n"x\ny",z\r\n c,d\n';
    expect(parseCsvRecords(text)).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 3, cells: ['x\ny', 'z'] },
      { line: 5, cells: [' c', 'd'] },
    ]);
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['x\ny', 'z'],
      [' c', 'd'],
    ]);
  });
});
