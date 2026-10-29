// Sign-in mail (2026-10-30, security review H-4): password resets, one-time codes, sign-in and security
// notices. Whoever reads one can take over the account it is for, and every committee member reads the
// mailbox, so only access administrators see these messages; others see that one arrived and from whom.
// The test looks at the subject, a code next to its name in the text, and the sender's domain
// (restrictedSenderDomains in the mailbox configuration, e.g. the committee's banks).

const SUBJECT = new RegExp(
  [
    'パスワード.{0,8}(再設定|リセット|設定|変更|発行|お知らせ|ご案内|ご連絡)',
    '(確認|認証|ログイン) ?コード',
    'ワンタイム',
    '認証トークン|トークン.{0,4}(発行|通知)',
    '段階認証',
    'ログイン.{0,6}(通知|アラート|試行|リンク)|ログインが(行われ|あり)',
    'セキュリティ ?(コード|情報|通知|アラート)',
    'アカウント.{0,6}(復元|回復)',
    'メールアドレス.{0,4}(確認|認証)',
    'password.{0,12}(reset|change)|reset.{0,12}password',
    'verification|verify',
    'one[- ]?time',
    'security (code|alert|info)',
    'sign[- ]?in (attempt|link|code)|new (sign[- ]?in|log ?in)|log ?in (link|code)',
    'back into your account|account recovery|recover your account',
    '(two|2)[- ]?step',
    'confirm your email',
  ].join('|'),
  'i',
);

/** A code word and, close after it, four to eight digits. */
const CODE = /((確認|認証|ログイン|セキュリティ) ?コード|ワンタイム|verification code|security code|log ?in code|one[- ]?time (code|password)|passcode)\D{0,20}\d{4,8}(?!\d)/i;

export function isSignInMail(subject: string, fromAddress: string, text: string, senderDomains: readonly string[]): boolean {
  const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1).toLowerCase();
  if (senderDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  return SUBJECT.test(subject) || CODE.test(subject) || CODE.test(text);
}

/** What other members see instead of the subject and the text. */
export const SIGN_IN_MAIL_SUBJECT = '（認証メールのため非表示）';
export const SIGN_IN_MAIL_TEXT =
  'パスワードの再設定・確認コード・ログイン通知などの認証メールとみなしたため、件名・本文・添付は権限管理者にだけ表示しています。対応が必要なときは権限管理者に伝えてください。';
