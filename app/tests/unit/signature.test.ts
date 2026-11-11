import { describe, expect, it } from 'vitest';
import { screenMail } from '../../src/shared/mailScreen.js';
import { composeMailReviewRequest } from '../../src/shared/mailReview.js';
import {
  committeeSignatureBody,
  defaultTitle,
  isSignatureRule,
  lineOwnText,
  lineSignature,
  lineStart,
  mailSignature,
  MAIL_SIGNATURE_RULE,
  ownSignatureBody,
  replaceDraftSignature,
  type SignatureParts,
} from '../../src/shared/signature.js';

// The committee's signature (2026-11-10). Synthetic names and addresses only.

const FULL: SignatureParts = {
  organization: '合成 医学薬学祭実行委員会',
  name: '合成 太郎',
  title: '副委員長',
  address: '〒000-0000 合成市 合成キャンパス',
  contactEmail: 'contact@committee.example',
  personalEmail: 'taro@committee.example',
};

describe('the mail signature', () => {
  it('is the committee\'s shape: rule, 送信者, the committee, title and name, the address lines, rule', () => {
    expect(mailSignature(FULL)).toBe(
      [
        MAIL_SIGNATURE_RULE,
        '送信者',
        '',
        '合成 医学薬学祭実行委員会',
        '副委員長 合成 太郎',
        '',
        '〒000-0000 合成市 合成キャンパス',
        '団体代表email : contact@committee.example',
        '委員個人email : taro@committee.example',
        MAIL_SIGNATURE_RULE,
      ].join('\n'),
    );
    expect(MAIL_SIGNATURE_RULE).toBe('ーーー ーーー ーーー ーーー ーーー ーーー ーーー ーーー');
  });

  it('leaves out what is not set: no title, no address lines', () => {
    expect(mailSignature({ ...FULL, title: '', address: '', contactEmail: '', personalEmail: '' })).toBe([MAIL_SIGNATURE_RULE, '送信者', '', '合成 医学薬学祭実行委員会', '合成 太郎', MAIL_SIGNATURE_RULE].join('\n'));
    expect(mailSignature({ ...FULL, address: '', contactEmail: '' }).split('\n').slice(5)).toEqual(['', '委員個人email : taro@committee.example', MAIL_SIGNATURE_RULE]);
  });

  it('starts at a rule the mail checks see as a signature, and the checks find the committee name in it', () => {
    expect(isSignatureRule(MAIL_SIGNATURE_RULE)).toBe(true);
    expect(isSignatureRule('--')).toBe(true);
    expect(isSignatureRule('ーーーーーーーーーーーーーーーーーーーー')).toBe(true);
    // A row of hyphens is used in bodies too: not a signature.
    expect(isSignatureRule('------------')).toBe(false);
    const body = `株式会社サンプル 御中\n\nいつもお世話になっております。協賛のお願いでご連絡いたしました。\n\n${mailSignature(FULL)}\n`;
    const findings = screenMail({ subject: '協賛のお願い', body, to: [{ name: null, address: 'a@partner.example' }], cc: [], fromAddress: 'sponsorship@committee.example', fromName: FULL.organization, attachments: 0, now: new Date('2026-11-10T00:00:00+09:00') });
    expect(findings).toEqual([]);
    // Only the signature: the text above it is empty.
    const empty = screenMail({ subject: '件名', body: `株式会社サンプル 御中\n\n${mailSignature(FULL)}`, to: [{ name: null, address: 'a@partner.example' }], cc: [], fromAddress: 'sponsorship@committee.example', fromName: FULL.organization, attachments: 0 });
    expect(empty.map((f) => f.text)).toContain('本文がほとんど書かれていません。');
  });

  it('does not send the addresses in the text to the Bot', () => {
    const { content } = composeMailReviewRequest({ subject: '件名', toNames: ['相手'], body: `本文です。\n\n${mailSignature(FULL)}`, fromName: FULL.organization });
    expect(content).not.toContain('@');
    expect(content).toContain('団体代表email : （メールアドレス）');
  });
});

describe('a Bot draft\'s signature', () => {
  const sig = mailSignature(FULL);
  it('is replaced by the committee\'s when the Bot wrote one between two rules', () => {
    const draft = ['合成株式会社', 'ご担当者様', '', '本文です。', '', '何卒よろしくお願い申し上げます。', '', 'ーーーーーーーーーーーーーーーーーーーー', '合成 医学薬学祭実行委員会', '【所属(部・課)】【氏名】', '【住所】', 'E-mail：【連絡先メールアドレス】', 'ーーーーーーーーーーーーーーーーーーーー'].join('\n');
    expect(replaceDraftSignature(draft, sig, FULL.organization)).toBe(['合成株式会社', 'ご担当者様', '', '本文です。', '', '何卒よろしくお願い申し上げます。', '', sig].join('\n'));
  });

  it('is replaced up to the end when the closing rule is missing, and left alone when it does not name the committee', () => {
    expect(replaceDraftSignature('本文です。\n\nーーーーーーーーーー\n合成 医学薬学祭実行委員会\n合成 太郎', sig, FULL.organization)).toBe(`本文です。\n\n${sig}`);
    expect(replaceDraftSignature('本文です。\n\nーーーーーーーーーー\n表の見出し\nーーーーーーーーーー\n続き', sig, FULL.organization)).toBeNull();
    expect(replaceDraftSignature('本文だけです。', sig, FULL.organization)).toBeNull();
  });
});

describe('the official LINE signature', () => {
  it('is a short block at the end: rule, committee, title and name', () => {
    expect(lineSignature(FULL)).toBe('ーーー\n合成 医学薬学祭実行委員会\n副委員長 合成 太郎');
    expect(lineSignature({ ...FULL, title: '' })).toBe('ーーー\n合成 医学薬学祭実行委員会\n合成 太郎');
    expect(lineStart(FULL)).toBe(`\n\n${lineSignature(FULL)}`);
  });

  it('does not count as text the person wrote', () => {
    const sig = lineSignature(FULL);
    expect(lineOwnText(lineStart(FULL), sig)).toBe('');
    expect(lineOwnText(`ご連絡です。${lineStart(FULL)}`, sig)).toBe('ご連絡です。');
    // Changed by hand: all of it is the person's.
    expect(lineOwnText('ーーー\n別の署名', sig)).toBe('ーーー\n別の署名');
    expect(lineOwnText('  本文  ', null)).toBe('本文');
  });
});

describe('the title and the settings', () => {
  it('uses the 課 when there is one, leaves out 役員会 and 委員', () => {
    expect(defaultTitle('総務部・会計課')).toBe('会計課');
    expect(defaultTitle('役員会・内務部')).toBe('内務部');
    expect(defaultTitle('総務部・システム課・内務部・企画課')).toBe('システム課・企画課');
    expect(defaultTitle('委員')).toBe('');
    expect(defaultTitle('役員会')).toBe('');
  });

  it('takes one line of up to 30 characters and an address or nothing', () => {
    expect(ownSignatureBody.parse({ title: ' 委員長 ', personalEmail: ' taro@committee.example ' })).toEqual({ title: '委員長', personalEmail: 'taro@committee.example' });
    expect(ownSignatureBody.parse({ title: '', personalEmail: '' })).toEqual({ title: '', personalEmail: '' });
    expect(ownSignatureBody.safeParse({ title: 'あ'.repeat(31), personalEmail: '' }).success).toBe(false);
    expect(ownSignatureBody.safeParse({ title: '委員長\n', personalEmail: '' }).success).toBe(true);
    expect(ownSignatureBody.safeParse({ title: '委\n員長', personalEmail: '' }).success).toBe(false);
    expect(ownSignatureBody.safeParse({ title: '', personalEmail: 'taro at example' }).success).toBe(false);
    expect(ownSignatureBody.safeParse({ title: '', personalEmail: '', extra: 1 }).success).toBe(false);
    expect(committeeSignatureBody.safeParse({ address: 'あ'.repeat(81), contactEmail: '' }).success).toBe(false);
    expect(committeeSignatureBody.parse({ address: '〒000-0000 合成市', contactEmail: 'contact@committee.example' })).toEqual({ address: '〒000-0000 合成市', contactEmail: 'contact@committee.example' });
  });
});

describe('the Bot draft in the committee shape (2026-11-10)', () => {
  it('is replaced as a whole by the person\'s signature', () => {
    const sig = mailSignature(FULL);
    const bot = ['本文です。', '', MAIL_SIGNATURE_RULE, '送信者', '', '合成 医学薬学祭実行委員会', '【所属(部・課)】 【氏名】', '', '【住所】', '団体代表email : 【委員会の窓口のメールアドレス】', '委員個人email : 【自分のメールアドレス】', MAIL_SIGNATURE_RULE].join('\n');
    expect(replaceDraftSignature(bot, sig, FULL.organization)).toBe(`本文です。\n\n${sig}`);
  });
});
