import type { Address, ReceiptView } from '../../shared/api.js';
import { MAIL_SUBJECT_MAX, type MailSendOptions } from '../../shared/mailbox.js';
import { mailSignature, replaceDraftSignature } from '../../shared/signature.js';
import { fmtDate } from '../api.js';

// The first text of the mail form (MailCompose): new mail, a reply or a reply to all, with the committee's signature.
// Kept apart from the form so the rules for whom a reply goes to can be tested without a browser.

export type ComposeMode = 'new' | 'reply' | 'replyAll';

export interface ComposeDraft {
  mailboxId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  replyToReceiptId: string | null;
  /** 返信先 (Reply-To) as typed; empty: answers go to From. */
  replyTo?: string;
  /**
   * A reply to mail a Google Group passed on ("'名前' via システム課" <system@…>): the group's own address. Mail sent
   * back to it only reaches the committee, so the form says so, and the check before sending warns when it is in To.
   */
  viaGroupAddress?: string;
  /** Said above the form: the author of the mail being answered is not known (its group rewrote From). */
  notice?: string;
}

const fmtAddress = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);

/**
 * The signature the body starts with (it can be changed like the rest of the text): the committee's shape, made from
 * what the server says (2026-11-10; each person sets their title and address in the settings). An older server sends
 * no parts: the earlier signature, which names the From mailbox.
 */
export function signature(options: MailSendOptions, mailboxId: string): string {
  if (options.signature) return mailSignature(options.signature);
  const box = options.from.find((f) => f.mailboxId === mailboxId);
  return ['--', options.fromName, box ? `${box.name}（${box.address}）` : '', options.senderName].filter(Boolean).join('\n');
}

/**
 * A Bot draft's body with the committee's signature: the Bot's own signature block is replaced by it, and a draft
 * without one gets it after the text unless the Bot already wrote the committee's name.
 */
function withSignature(options: MailSendOptions, mailboxId: string, body: string): string {
  const text = body.replace(/\r\n/g, '\n').trimEnd();
  const sig = signature(options, mailboxId);
  const replaced = options.signature ? replaceDraftSignature(text, sig, options.fromName) : null;
  if (replaced !== null) return `${replaced}\n`;
  return text.includes(options.fromName) ? `${text}\n` : `${text}\n\n${sig}\n`;
}

/** New mail; `to` is set when it is written from a contact. */
export function newDraft(options: MailSendOptions, mailboxId?: string, fromBot?: { subject: string; body: string }, to = ''): ComposeDraft {
  const from = options.from.find((f) => f.mailboxId === mailboxId)?.mailboxId ?? options.from[0]?.mailboxId ?? '';
  return {
    mailboxId: from,
    to,
    cc: '',
    bcc: '',
    subject: fromBot?.subject.slice(0, MAIL_SUBJECT_MAX) ?? '',
    body: fromBot ? withSignature(options, from, fromBot.body) : `\n\n${signature(options, from)}\n`,
    replyToReceiptId: null,
  };
}

/**
 * A reply to one message, quoting it: for the committee's own mail, to whom it was sent; otherwise to where the mail
 * asked answers to go (Reply-To), else to its author when a Google Group passed it on (X-Original-From), else to From.
 * A group's own address in From is never where an answer goes (2026-11-27: a reply to "'名前' via システム課"
 * <system@…> went back to the committee's own group and never reached the sender outside). When the author is not
 * known, To is left empty with a notice. With a Bot draft, its subject and body replace the empty start.
 */
export function replyDraft(options: MailSendOptions, receipt: ReceiptView, mode: 'reply' | 'replyAll', fromBot?: { subject: string; body: string }): ComposeDraft {
  const lower = (a: Address) => a.address.toLowerCase();
  // From: among the mailboxes the message is in, the one whose address wrote it (the committee's own mail, or the group
  // that passed it on), else the one it was written to, else the first. Mail to a group that forwards into another
  // mailbox is in both; mailbox order alone once picked the other one (2026-11-27).
  const inMailbox = new Set((receipt.mailboxes ?? [receipt.mailbox]).map((m) => m.id));
  const boxes = options.from.filter((f) => inMailbox.has(f.mailboxId));
  const named = (list: Address[]) => boxes.find((f) => list.some((a) => lower(a) === f.address.toLowerCase()));
  const from = named([receipt.from]) ?? named([...receipt.to, ...receipt.cc]) ?? boxes[0] ?? options.from[0];
  const sender = from?.address.toLowerCase() ?? '';
  // Never written back: the addresses this person sends from (one account's aliases) and the archive BCC.
  const skip = new Set([sender, ...options.from.map((f) => f.address.toLowerCase()), ...(options.bcc ? [options.bcc.toLowerCase()] : [])]);
  // A reply to the committee's own message from the same address goes to whom it was sent; any other, to its sender.
  // Mail a group passed on carries the group's address in From but was written by someone else: never "own" mail.
  const back = !receipt.viaGroup && receipt.from.address.toLowerCase() === sender ? receipt.to.filter((a) => !skip.has(lower(a))) : [];
  const group = receipt.viaGroup ? lower(receipt.from) : null;
  const answerable = (a: Address) => !skip.has(lower(a)) && lower(a) !== group;
  const asked = (receipt.replyTo ?? []).filter(answerable);
  const author = receipt.originalFrom && answerable(receipt.originalFrom) ? [receipt.originalFrom] : [];
  const to = back.length > 0 ? back : asked.length > 0 ? asked : author.length > 0 ? author : group ? [] : [receipt.from];
  const toKeys = new Set(to.map(lower));
  const cc =
    mode === 'replyAll'
      ? [...receipt.to, ...receipt.cc].filter((a, i, all) => {
          const k = lower(a);
          return !skip.has(k) && !toKeys.has(k) && all.findIndex((b) => lower(b) === k) === i;
        })
      : [];
  const subject = /^\s*re\s*[:：]/i.test(receipt.subject) ? receipt.subject : `Re: ${receipt.subject}`;
  const quoted = receipt.text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(0, 300)
    .map((l) => `> ${l}`)
    .join('\n');
  const mailboxId = from?.mailboxId ?? '';
  const quote = `${fmtDate(receipt.receivedAt)} ${fmtAddress(receipt.from)}:\n${quoted}\n`;
  return {
    mailboxId,
    to: to.map(fmtAddress).join(', '),
    cc: cc.map(fmtAddress).join(', '),
    bcc: '',
    subject: (fromBot?.subject.trim() || subject).slice(0, MAIL_SUBJECT_MAX),
    body: fromBot ? `${withSignature(options, mailboxId, fromBot.body)}\n${quote}` : `\n\n${signature(options, mailboxId)}\n\n${quote}`,
    replyToReceiptId: receipt.receiptId,
    ...(group ? { viaGroupAddress: group } : {}),
    ...(group && to.length === 0
      ? {
          notice: `元のメールはグループ（${receipt.from.address}）を通って届いたため、差出人のアドレスが分かりません。宛先に相手のアドレスを入れてください（グループのアドレスに返すと委員会に戻るだけで、相手には届きません）。`,
        }
      : {}),
  };
}
