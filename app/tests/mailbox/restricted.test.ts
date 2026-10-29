import { describe, expect, it } from 'vitest';
import { isSignInMail } from '../../src/server/mailbox/restricted.js';

// Subjects of the kinds the committee mailbox has received (services and codes made up).
const signIn = (subject: string, text = '', from = 'no-reply@service.example') => isSignInMail(subject, from, text, ['bank.example']);

describe('sign-in mail', () => {
  it('is told by the subject', () => {
    for (const subject of [
      '[adm] ログインコードは123456です',
      '[adm] 123456：[合成ID] ログインコード',
      '[adm] [IT] 【合成ドメイン】新しくコントロールパネルにログインがありました',
      '[adm] [acct] 合成 ID 新しい環境からログインがありました',
      '[adm] [pr] New login to Photo App from Photo App on Phone',
      '[adm] [pr] We can help you get straight back into your account.',
      '[adm] 個人用 合成 アカウントのセキュリティ コード',
      '合成サービスのパスワード再設定手続きのご案内',
      '「ご本人確認」ワンタイムパスワードのお知らせ',
      '2 段階認証プロセスが有効になりました',
      'Security alert: new passkey added to your account',
      'Verify email for your account',
    ]) {
      expect(signIn(subject), subject).toBe(true);
    }
  });

  it('is told by a code in the text, or by a listed sender and its subdomains', () => {
    expect(signIn('ご登録ありがとうございます', '確認コード: 482913')).toBe(true);
    expect(signIn('お知らせ', '', 'notice@mail.bank.example')).toBe(true);
    expect(signIn('お知らせ', '', 'notice@notbank.example')).toBe(false);
  });

  it('leaves ordinary business mail alone, including passwords of attached files', () => {
    for (const [subject, text] of [
      ['見積書の送付', '資料のパスワードは別のメールでお送りします。'],
      ['協賛のお問い合わせ', '電話番号 0761234567 までご連絡ください。'],
      ['会場使用のご相談', 'コードネーム「企画A」で進めています。'],
    ]) {
      expect(signIn(subject!, text), subject).toBe(false);
    }
  });
});
