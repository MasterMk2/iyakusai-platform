import { composeMailReviewRequest } from '../../shared/mailReview';
import { ownText } from '../../shared/mailScreen';
import { BotReview } from './BotReview';

/**
 * Proofreading and fact-checking by the Bot while writing a committee mail (2026-10-26). Shown only when the
 * Bot's documents are on. Pressing the button sends the subject, the recipients' names and the person's own
 * text (no quoted mail, no addresses) as a /doc job; the answer stays here while the mail is changed.
 */
export function MailReview({ subject, body, toNames, fromName }: { subject: string; body: string; toNames: string[]; fromName: string }) {
  return (
    <BotReview
      request={composeMailReviewRequest({ subject, toNames, body: ownText(body), fromName })}
      empty={!subject.trim() && !ownText(body).trim()}
      intro="誤字・敬語、日付・曜日・金額・名称などを委員会の資料と照らした食い違い、宛名・署名の有無を Bot（AI）が確かめます。件名・宛先の名前・本文（引用した部分を除く）が Bot に渡ります。メールアドレスは渡しません。"
      changedWhat="件名か本文"
      testId="mail-review"
    />
  );
}
