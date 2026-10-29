import { describe, expect, it } from 'vitest';
import { ASSISTANT_LIMITS } from '../../src/shared/assistant.js';
import { composeMailRequest, MAIL_LIMITS, parseMailRequest, splitMailDraft } from '../../src/shared/mailDraft.js';

describe('composeMailRequest', () => {
  it('uses the labels and order of the Bot (mail_draft.compose_request)', () => {
    // The same case and the same expected text as the Bot's tests/test_mail_draft.py.
    const text = composeMailRequest({ to: ' 学務課 ご担当者様 ', purpose: '会計書類を提出します\n提出先は?', sender: '総務部 山田', relation: 'ongoing', received: '学務課の担当です。\n書類をお願いします。' });
    expect(text).toBe(
      '【相手】学務課 ご担当者様\n【差出人】総務部 山田\n【これまでのやりとり】以前からやりとりがある\n【要件】\n会計書類を提出します\n提出先は?\n【届いたメール(これへの返信を書く)】\n学務課の担当です。\n書類をお願いします。',
    );
  });

  it('leaves out empty optional parts', () => {
    expect(composeMailRequest({ to: '先方', purpose: 'お礼', sender: '  ', relation: null, received: '' })).toBe('【相手】先方\n【要件】\nお礼');
  });

  it('fits the /doc content limit with every field at its limit', () => {
    const text = composeMailRequest({ to: '相'.repeat(MAIL_LIMITS.toMax), purpose: '要'.repeat(MAIL_LIMITS.purposeMax), sender: '差'.repeat(MAIL_LIMITS.senderMax), relation: 'ongoing', received: '届'.repeat(MAIL_LIMITS.receivedMax) });
    expect(text.length).toBeLessThanOrEqual(ASSISTANT_LIMITS.docContentMax);
  });
});

describe('parseMailRequest', () => {
  it('reads the recipient and the purpose back, without the received mail', () => {
    const text = composeMailRequest({ to: 'サンプルレンタル', purpose: '発電機の見積依頼', sender: '渉外課 山田', received: '先方の本文' });
    expect(parseMailRequest(text)).toEqual({ to: 'サンプルレンタル', purpose: '発電機の見積依頼' });
  });

  it('is null for a document that is not a labelled mail request', () => {
    expect(parseMailRequest('発電機の見積依頼のメール')).toBeNull();
  });
});

describe('splitMailDraft', () => {
  const note = '✉️ **お見積りのお願い**(メールの草案)\n-# 要記入: 【担当者名】\n-# model: opus / 100+50 tokens';

  it('splits the Bot notes, the subject and the body', () => {
    const draft = splitMailDraft(`${note}\n\n件名：お見積りのお願い\n\n株式会社◯◯\n【担当者名】様\n\n  よろしくお願いいたします。\n\n`);
    expect(draft).toEqual({ notes: '-# 要記入: 【担当者名】\n-# model: opus / 100+50 tokens', subject: 'お見積りのお願い', body: '株式会社◯◯\n【担当者名】様\n\n  よろしくお願いいたします。' });
  });

  it('accepts a half-width colon and CRLF', () => {
    expect(splitMailDraft('件名: Re: 打合せ\r\n\r\n本文')).toEqual({ notes: '', subject: 'Re: 打合せ', body: '本文' });
  });

  it('is null without a 件名 line (an older Bot or another document)', () => {
    expect(splitMailDraft('📄 **見積依頼**(たたき台・メール文面)\n\n見積依頼\n\n本文')).toBeNull();
  });
});
