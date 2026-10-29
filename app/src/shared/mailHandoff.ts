import type { ReceiptView } from './api.js';
import { MAIL_LIMITS } from './mailDraft.js';

// Between the committee mailbox and the Bot's mail drafts,
// held by the app in memory only (never in browser storage, so no mail text stays on the device):
// - mailbox → Bot: the message to answer fills the Bot's mail form. The Bot gets it only when the person
//   presses 草案を作る there (as when the text is pasted by hand).
// - Bot → mailbox: a finished draft opens the mailbox's compose form, as a reply in that thread or as new mail.

/** Mailbox → Bot: the message to answer. */
export interface BotReplyRequest {
  receiptId: string;
  threadId: string;
  subject: string;
  /** For the Bot's 相手 field. */
  to: string;
  /** The message text without quoted lines, cut to the Bot's limit. */
  received: string;
  /** The text was longer than the Bot's limit and was cut. */
  cut: boolean;
}

/** Bot → mailbox: a draft to send. */
export interface DraftToSend {
  /** The message answered, when the draft was asked for from a thread; null for new mail. */
  reply: { receiptId: string; threadId: string } | null;
  subject: string;
  body: string;
}

/** Links the screens pass on (App holds the state). */
export interface MailBotLink {
  /** A message to answer, waiting for the Bot's mail form; null when none. */
  request: BotReplyRequest | null;
  onRequestUsed: () => void;
  /** This person can send from the mailbox (the draft gets a button that opens the compose form). */
  canSend: boolean;
  onUseDraft: (draft: DraftToSend) => void;
}

export function botReplyRequest(receipt: ReceiptView): BotReplyRequest {
  const text = receipt.text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const cut = text.length > MAIL_LIMITS.receivedMax;
  const name = receipt.from.name?.trim();
  return {
    receiptId: receipt.receiptId,
    threadId: receipt.threadId,
    subject: receipt.subject,
    to: (name ? `${name} 様` : receipt.from.address).slice(0, MAIL_LIMITS.toMax),
    received: cut ? text.slice(0, MAIL_LIMITS.receivedMax) : text,
    cut,
  };
}
