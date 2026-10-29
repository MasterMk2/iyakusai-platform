import { describe, expect, it } from 'vitest';
import { ContactValidationError, normalizeContactSearch, normalizePhone, normalizePostalCode, recipientText, splitTags, validateContact } from '../../src/shared/contacts.js';
import { parseRecipient, splitRecipients } from '../../src/shared/mailbox.js';

// The contact rule shared by the server and the screen (synthetic values only).

const base = { category: 'external', organization: '合成商事株式会社', name: '' };

describe('validateContact', () => {
  it('tidies a contact: spaces, empty rows, repeated addresses and numbers, full-width forms', () => {
    const c = validateContact({
      ...base,
      section: '  営業部　 部長 ',
      name: ' 合成  太郎 ',
      emails: [{ label: '', address: 'Taro@Partner.example' }, { label: '', address: '' }, { label: '控え', address: 'taro@partner.example' }],
      phones: [{ label: '代表', number: '０７６－０００－００００' }, { label: '', number: '076-000-0000' }, { label: '携帯', number: '090ー0000ー0000' }],
      postalCode: '〒１２３４５６７',
      tags: ['協賛', '協賛', ' 2026 '],
      notes: '一行目\r\n二行目',
    });
    expect(c.section).toBe('営業部 部長');
    expect(c.name).toBe('合成 太郎');
    expect(c.emails).toEqual([{ label: '', address: 'Taro@Partner.example' }]);
    expect(c.phones).toEqual([
      { label: '代表', number: '076-000-0000' },
      { label: '携帯', number: '090-0000-0000' },
    ]);
    expect(c.postalCode).toBe('123-4567');
    expect(c.tags).toEqual(['協賛', '2026']);
    expect(c.notes).toBe('一行目\n二行目');
  });

  it('needs a name or an organization and a known category', () => {
    expect(() => validateContact({ category: 'external', organization: ' ', name: '' })).toThrow(ContactValidationError);
    expect(() => validateContact({ ...base, category: 'friend' })).toThrow('種類');
  });

  it('names the field of a wrong address, number or postal code', () => {
    const field = (input: object) => {
      try {
        validateContact({ ...base, ...input });
      } catch (err) {
        return (err as ContactValidationError).field;
      }
      return null;
    };
    expect(field({ emails: [{ label: '', address: 'ok@partner.example' }, { label: '', address: 'no-at-mark' }] })).toBe('emails.1');
    expect(field({ phones: [{ label: '', number: '電話してね' }] })).toBe('phones.0');
    expect(field({ postalCode: '930-01' })).toBe('postalCode');
    expect(field({ notes: 'x'.repeat(2001) })).toBe('notes');
    expect(field({ organization: 'a\u0007b' })).toBe('organization');
    expect(field({ emails: Array.from({ length: 6 }, (_, i) => ({ label: '', address: `p${i}@partner.example` })) })).toBe('emails');
  });

  it('keeps extensions and international numbers', () => {
    expect(normalizePhone('076-000-1234 内線 1234')).toBe('076-000-1234 内線 1234');
    expect(normalizePhone('+81 76 000 1234')).toBe('+81 76 000 1234');
    expect(normalizePhone('(076) 000-1234')).toBe('(076) 000-1234');
    expect(normalizePhone('1')).toBeNull();
    expect(normalizePostalCode('')).toBe('');
  });
});

describe('search and recipients', () => {
  it('finds katakana with hiragana and full-width with half-width', () => {
    expect(normalizeContactSearch('ヤマダ　ＴＡＲＯ')).toBe('やまだ taro');
  });

  it('writes a recipient the mail form reads back, quoting a name with a separator', () => {
    for (const [name, address] of [
      ['合成 太郎', 'taro@partner.example'],
      ['合成商事、営業部', 'sales@partner.example'],
      ['"引用" <名前>', 'x@partner.example'],
      ['', 'only@partner.example'],
    ] as const) {
      const text = recipientText(name, address);
      const split = splitRecipients(`${text}, other@partner.example`);
      expect(split).toHaveLength(2);
      expect(parseRecipient(split[0]!)?.address).toBe(address);
    }
    expect(recipientText('合成商事、営業部', 'sales@partner.example')).toBe('"合成商事、営業部" <sales@partner.example>');
  });

  it('splits typed tags', () => {
    expect(splitTags('協賛、業者 協賛,2026')).toEqual(['協賛', '業者', '2026']);
  });
});
