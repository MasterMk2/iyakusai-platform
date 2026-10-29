import { ASSISTANT_LIMITS, cleanText } from './assistant.js';

// Asking the Bot to proofread and fact-check a mail before it is sent, from the compose screen.
// It goes as a /doc job (docType free, txt, with the committee's materials), like the
// mail drafts go as docType mail. The Bot gets the subject, the recipients' names (no addresses) and the person's
// own text (no quoted lines); the whole request fits the doc limit, so a long body is cut and says so.

export interface MailReviewInput {
  subject: string;
  /** Display names of the recipients (or "（名前なし）"); addresses are not sent. */
  toNames: string[];
  /** The person's own text, without the quoted mail. */
  body: string;
  /** The committee's name (who sends it). */
  fromName: string;
}

const HEAD = [
  '【依頼】委員会から送る前のメールの校閲とファクトチェック',
  '下のメール（件名と本文）を、送る前に確かめてください。直した方がよい点だけを、項目ごとに箇条書きで挙げてください。直す点が無い項目は「なし」と書いてください。本文を書き直した全文は要りません。',
  '1. 誤字・脱字・敬語・言い回し（「元の表現 → 直す案」の形で）',
  '2. 事実の確認：日付・曜日・時刻・金額・数量・名称（団体・人・場所）・締切・連絡先を、委員会の資料と照らして、食い違う点と資料で確かめられない点（確かめた資料の名前を添える）',
  '3. 宛名・名乗り・結び・署名の有無と、【 】などの書きかけ',
  '4. 相手に失礼になりうる点、誤解されうる点',
].join('\n');

/** The doc job's content and whether the body had to be cut. */
export function composeMailReviewRequest(input: MailReviewInput): { content: string; cut: boolean } {
  const names = input.toNames.map((n) => cleanText(n)).filter(Boolean).join('、') || '（名前なし）';
  const top = `${HEAD}\n\n【差出人】${cleanText(input.fromName)}\n【宛先】${names}\n【件名】${cleanText(input.subject)}\n【本文】\n`;
  const body = cleanText(input.body);
  const room = ASSISTANT_LIMITS.docContentMax - top.length - 40;
  if (body.length <= room) return { content: `${top}${body}`, cut: false };
  return { content: `${top}${body.slice(0, Math.max(0, room))}\n（長いので、ここから後は省きました）`, cut: true };
}
