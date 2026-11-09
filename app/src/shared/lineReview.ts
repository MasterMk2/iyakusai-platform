import { ASSISTANT_LIMITS, cleanText } from './assistant.js';

// Asking the Bot to proofread and fact-check an official LINE message before it is sent (2026-11-09), like the mail
// one (mailReview.ts): a /doc job (docType free, txt, with the committee's materials). The Bot gets the account's
// name, how many people it goes to and the text; never the people's names or LINE IDs. A long text is cut and says so.

export interface LineReviewInput {
  /** The official account it is sent from. */
  accountName: string;
  /** Whom it goes to, without names, e.g. "1:1 の相手 3 人（同じ文を 1 人ずつ）". */
  audience: string;
  body: string;
}

const HEAD = [
  '【依頼】委員会の公式LINEから送る前のメッセージの校閲とファクトチェック',
  '下のメッセージを、送る前に確かめてください。直した方がよい点だけを、項目ごとに箇条書きで挙げてください。直す点が無い項目は「なし」と書いてください。書き直した全文は要りません。',
  '1. 誤字・脱字・敬語・言い回し（「元の表現 → 直す案」の形で）',
  '2. 事実の確認：日付・曜日・時刻・金額・数量・名称（団体・人・場所）・締切・連絡先を、委員会の資料と照らして、食い違う点と資料で確かめられない点（確かめた資料の名前を添える）',
  '3. LINE での読みやすさ：通知と一覧には冒頭しか出ないので、最初の 2 行で用件が分かるか。長すぎる段落、改行の位置',
  '4. 【 】などの書きかけ、相手に失礼になりうる点、誤解されうる点',
].join('\n');

/** The doc job's content and whether the text had to be cut. */
export function composeLineReviewRequest(input: LineReviewInput): { content: string; cut: boolean } {
  const top = `${HEAD}\n\n【送信元】${cleanText(input.accountName)}（公式LINE）\n【相手】${cleanText(input.audience)}\n【本文】\n`;
  const body = cleanText(input.body);
  const room = ASSISTANT_LIMITS.docContentMax - top.length - 40;
  if (body.length <= room) return { content: `${top}${body}`, cut: false };
  return { content: `${top}${body.slice(0, Math.max(0, room))}\n（長いので、ここから後は省きました）`, cut: true };
}
