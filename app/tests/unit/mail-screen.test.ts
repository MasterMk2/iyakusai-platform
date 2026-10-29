import { describe, expect, it } from 'vitest';
import { botReplyRequest } from '../../src/shared/mailHandoff.js';
import type { ReceiptView } from '../../src/shared/api.js';
import { ASSISTANT_LIMITS } from '../../src/shared/assistant.js';
import { departmentsOfLabel } from '../../src/shared/mailbox.js';
import { MAIL_LIMITS } from '../../src/shared/mailDraft.js';
import { composeMailReviewRequest } from '../../src/shared/mailReview.js';
import { screenMail, type ScreenInput } from '../../src/shared/mailScreen.js';

// Checks before sending, the Bot's proofreading request and the mailbox → Bot handoff (2026-10-26). Synthetic text only.

const NOW = new Date('2026-10-26T03:00:00Z');
const SIGNATURE = '--\n合成 医学薬学祭実行委員会\n協賛（sponsorship@committee.example）\n合成 太郎';
const base: ScreenInput = {
  subject: '協賛のお願い',
  body: `株式会社サンプル 御中\n\nいつもお世話になっております。協賛のお願いでご連絡いたしました。\n\n${SIGNATURE}`,
  to: [{ name: '株式会社サンプル', address: 'contact@partner.example' }],
  cc: [],
  fromAddress: 'sponsorship@committee.example',
  fromName: '合成 医学薬学祭実行委員会',
  attachments: 0,
  now: NOW,
};
const texts = (i: Partial<ScreenInput>) => screenMail({ ...base, ...i }).map((f) => `${f.level}:${f.text}`);

describe('checks before sending', () => {
  it('finds nothing in a complete mail', () => {
    expect(texts({})).toEqual([]);
  });

  it('says when the signature or the addressee line is missing, or the body is empty', () => {
    expect(texts({ body: '株式会社サンプル 御中\n\nいつもお世話になっております。協賛のお願いです。' })).toEqual(['warning:署名が見当たりません（「合成 医学薬学祭実行委員会」の名前が本文にありません）。']);
    expect(texts({ body: `いつもお世話になっております。協賛のお願いです。\n\n${SIGNATURE}` })).toEqual(['warning:本文の冒頭に宛名（「〇〇様」「〇〇御中」など）が見当たりません。']);
    expect(texts({ body: `\n\n${SIGNATURE}` })).toEqual(['warning:本文の冒頭に宛名（「〇〇様」「〇〇御中」など）が見当たりません。', 'warning:本文がほとんど書かれていません。']);
  });

  it('tells half-written 【 】 from labels with a value, and finds ○○', () => {
    const body = `株式会社サンプル【担当者名】様\n\n【日時】10月30日 13時から\n【場所】○○会議室\n【 】までにご返信ください。\n\n${SIGNATURE}\n【氏名】`;
    expect(texts({ body })).toEqual(['warning:書きかけの箇所が残っているようです：【担当者名】、○○、【 】、【氏名】']);
  });

  it('says when 添付 is written without a file, and when a file is not mentioned', () => {
    expect(texts({ body: base.body.replace('ご連絡いたしました。', '資料を添付いたします。') })).toEqual(['warning:本文に「添付」とありますが、ファイルが付いていません。']);
    expect(texts({ attachments: 1 })).toEqual(['info:添付ファイルがありますが、本文では触れていません。']);
  });

  it('checks the weekday of written dates in the nearest year, and impossible days', () => {
    const body = (s: string) => base.body.replace('ご連絡いたしました。', s);
    // 2026-10-27 is a Tuesday. Without a year, 1/5 and 2/30 written in late October 2026 mean 2027 (the nearer).
    expect(texts({ body: body('10月27日（火）にお伺いします。') })).toEqual([]);
    expect(texts({ body: body('10月27日（月）にお伺いします。') })).toEqual(['warning:「10月27日(月)」の曜日が違います（2026年10月27日は火曜日）。']);
    expect(texts({ body: body('1/5（月）までに。') })).toEqual(['warning:「1/5(月)」の曜日が違います（2027年1月5日は火曜日）。']);
    expect(texts({ body: body('2025年10月27日（月曜日）の件') })).toEqual([]);
    expect(texts({ body: body('２月３０日（月）に') })).toEqual(['warning:「2月30日(月)」の日はありません（2027年2月は28日まで）。']);
    expect(texts({ subject: '11月3日(水)の打合せ' })).toEqual(['warning:「11月3日(水)」の曜日が違います（2026年11月3日は火曜日）。']);
  });

  it('ignores the quoted mail and says when the From address is a recipient', () => {
    expect(texts({ body: `${base.body}\n\n> 10月27日（月）に伺います【氏名】` })).toEqual([]);
    expect(texts({ cc: [{ name: null, address: 'SPONSORSHIP@committee.example' }] })).toEqual(['warning:宛先か CC に、差出人と同じアドレスがあります。']);
  });
});

describe('the reply-to address in the checks', () => {
  it('says when answers would go outside the committee', () => {
    expect(texts({ replyTo: { name: null, address: 'contact@committee.example' } })).toEqual([]);
    expect(texts({ replyTo: { name: '個人', address: 'someone@partner.example' } })).toEqual(['warning:返信先（someone@partner.example）が委員会の外のアドレスです。相手の返信は委員会の受信箱に入りません。']);
  });
});

describe('the Bot proofreading request', () => {
  it('carries the names, subject and own text but no addresses, within the doc limit', () => {
    const { content, cut } = composeMailReviewRequest({ subject: '協賛のお願い', toNames: ['株式会社サンプル', '（名前なし）'], body: base.body, fromName: base.fromName });
    expect(cut).toBe(false);
    expect(content).toContain('【宛先】株式会社サンプル、（名前なし）');
    expect(content).toContain('【件名】協賛のお願い');
    expect(content).toContain('いつもお世話になっております。');
    expect(content).toContain('委員会の資料と照らして');
    expect(content).not.toContain('@partner.example');
    expect(content.length).toBeLessThanOrEqual(ASSISTANT_LIMITS.docContentMax);
  });

  it('cuts a long body and says so', () => {
    const { content, cut } = composeMailReviewRequest({ subject: '件名', toNames: [], body: 'あ'.repeat(5000), fromName: base.fromName });
    expect(cut).toBe(true);
    expect(content.length).toBeLessThanOrEqual(ASSISTANT_LIMITS.docContentMax);
    expect(content.endsWith('（長いので、ここから後は省きました）')).toBe(true);
  });
});

describe('departments of a person', () => {
  it('reads the department names the Discord login joins with ・, and none from 委員', () => {
    expect(departmentsOfLabel('企画部・渉外課')).toEqual(['企画部', '渉外課']);
    expect(departmentsOfLabel('総務部')).toEqual(['総務部']);
    expect(departmentsOfLabel('委員')).toEqual([]);
    expect(departmentsOfLabel(' 企画部 ・ 企画部 ')).toEqual(['企画部']);
  });
});

describe('mailbox → Bot', () => {
  const receipt = (text: string, name: string | null = '取引先 担当'): ReceiptView =>
    ({
      receiptId: 'rc_0000000000000001', threadId: 'th_0000000000000001', subject: 'お問い合わせ', from: { name, address: 'sender@partner.example' }, text,
    }) as unknown as ReceiptView;

  it('passes the sender as 相手 and the text without quoted lines, cut to the Bot limit', () => {
    expect(botReplyRequest(receipt('ご質問です。\n\n> 以前のメール\n> 引用'))).toEqual({ receiptId: 'rc_0000000000000001', threadId: 'th_0000000000000001', subject: 'お問い合わせ', to: '取引先 担当 様', received: 'ご質問です。', cut: false });
    expect(botReplyRequest(receipt('ご質問です。', null)).to).toBe('sender@partner.example');
    const long = botReplyRequest(receipt('あ'.repeat(MAIL_LIMITS.receivedMax + 10)));
    expect(long.cut).toBe(true);
    expect(long.received).toHaveLength(MAIL_LIMITS.receivedMax);
  });
});
