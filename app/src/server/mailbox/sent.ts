import type { Address } from '../../shared/api.js';
import type { MailSentItem, MailSentResponse, MailSentState } from '../../shared/mailbox.js';
import { notFound, type User } from '../domain/types.js';
import type { CommitteeAddresses } from './addresses.js';
import type { MailboxDefinition } from './config.js';
import { SIGN_IN_MAIL_SUBJECT } from './restricted.js';
import { normalizeForSearch, type MailboxStore, type MessageRow, type OutgoingRow } from './store.js';

// 送信箱 (2026-11-23): mail the committee sent, one row per message, newest first. Two records make it:
// - Stored messages from an address on a committee domain: sent from this app (a send row, so the member who wrote it
//   is known), from the account's Gmail directly with a mailbox's address (who wrote it is not known), or from a
//   member's own address (the member whose signature names the address, else the name in the mail). A member's own
//   mail to a committee group counts too (decided 2026-11-23). Google Groups deliver mail posted to a group with the
//   group's address as From and "<name> via <group>" as the name: someone else wrote such mail (often outside the
//   committee), so it is not counted.
// - Sends from this app whose message is not kept here: refused by the mail server, cut off half way, or sent but
//   their copy not stored yet. Their subject and text are never stored: the row has the time, the mailbox, the
//   number of recipients and the member.
// Everyone who reads the committee mail sees every row, the ones that did not go out too (decided 2026-11-23).
// Addresses of BCC recipients are never shown (only the number, in the count of recipients).

/** The name Google Groups give mail they deliver for someone else: "'Name' via Group". */
const GROUP_REWRITE = /\svia\s/i;
/** A send still "sending" after this long was cut off (the app stopped) and may have gone out, as send.ts answers. */
const CUT_OFF_MS = 10 * 60_000;

export interface SentQuery {
  mailboxId?: string;
  /** Only mail from members' own addresses. */
  personal?: '1';
  q?: string;
  /** Only the signed-in person's sends. */
  mine?: '1';
  /** Only the ones that may not have gone out (unknown, failed). */
  state?: 'problem';
  page: number;
  pageSize: number;
}

export interface SentDeps {
  store: MailboxStore;
  addresses: CommitteeAddresses;
  nameOf(userId: string): string;
  /** The member whose own address this is (設定 › 署名), or null. */
  ownerOf(address: string): string | null;
  /** Sign-in mail this person may not read. */
  hidden(user: User, row: MessageRow): boolean;
  now: Date;
}

/** The step of the SMTP conversation that refused a send (smtp.ts), in words. */
const REFUSED_AT: Record<string, string> = {
  connect: 'メールサーバーにつながりませんでした',
  greeting: 'メールサーバーにつながりませんでした',
  starttls: 'メールサーバーにつながりませんでした',
  auth: 'メールサーバーへのログインが通りませんでした',
  sender: '差出人のアドレスが受け付けられませんでした',
  recipient: '宛先が受け付けられませんでした',
  data: 'メールの内容が受け付けられませんでした',
};

/** The send's error as recorded ("step:code", send.ts) in words. */
function reasonOf(error: string | null): string {
  const [step = '', code = '-'] = (error ?? '').split(':');
  const words = REFUSED_AT[step] ?? 'メールサーバーが受け付けませんでした';
  return /^\d{3}$/.test(code) ? `${words}（${code}）` : words;
}

function stateOf(send: OutgoingRow, now: Date): MailSentState {
  if (send.status !== 'sending') return send.status;
  return now.getTime() - Date.parse(send.created_at) > CUT_OFF_MS ? 'unknown' : 'sending';
}

const shown = (a: Address) => a.name?.trim() || a.address;

/** A stored message: `mailbox` null when a member sent it from their own address; `fromApp` when it is a send from this app. */
type Entry = { kind: 'message'; id: string; at: string; mailbox: MailboxDefinition | null; senderId: string | null; fromApp: boolean } | { kind: 'send'; send: OutgoingRow; at: string; mailbox: MailboxDefinition; state: MailSentState };

const keyOf = (e: Entry) => (e.kind === 'message' ? e.id : e.send.id);

export function listSentMail(deps: SentDeps, user: User, query: SentQuery): MailSentResponse {
  const { store, addresses } = deps;
  if (query.mailboxId !== undefined && !addresses.mailboxes.some((m) => m.id === query.mailboxId)) throw notFound();
  const terms = query.q ? normalizeForSearch(query.q).split(/\s+/).filter(Boolean) : [];
  const wanted = (mailbox: MailboxDefinition | null, senderId: string | null) =>
    (!query.mailboxId || mailbox?.id === query.mailboxId) && (!query.personal || mailbox === null) && (!query.mine || senderId === user.id);
  const entries: Entry[] = [];
  if (query.state !== 'problem') {
    for (const c of store.sentCandidates(addresses.domainsWithAliases(), terms, !user.canManageAccess)) {
      const mailbox = addresses.ofAddress(c.from_address) ?? null;
      const fromApp = c.sender_id !== null;
      // A send from this app always has a mailbox's address; without one, the configuration has changed since.
      if (fromApp && !mailbox) continue;
      if (!fromApp && (GROUP_REWRITE.test(c.from_name ?? '') || !addresses.isCommitteeAddress(c.from_address))) continue;
      const senderId = fromApp ? c.sender_id : mailbox ? null : deps.ownerOf(c.from_address);
      if (wanted(mailbox, senderId)) entries.push({ kind: 'message', id: c.id, at: c.received_at, mailbox, senderId, fromApp });
    }
  }
  // A search looks in subjects and text, which a send not kept here does not have; such a send has a mailbox.
  if (terms.length === 0 && !query.personal) {
    for (const send of store.unkeptOutgoing()) {
      const mailbox = addresses.mailboxes.find((m) => m.id === send.mailbox_id);
      if (!mailbox || !wanted(mailbox, send.user_id)) continue;
      const state = stateOf(send, deps.now);
      if (query.state === 'problem' && state !== 'unknown' && state !== 'failed') continue;
      entries.push({ kind: 'send', send, at: send.created_at, mailbox, state });
    }
  }
  entries.sort((a, b) => b.at.localeCompare(a.at) || keyOf(a).localeCompare(keyOf(b)));
  const start = (query.page - 1) * query.pageSize;
  const items = entries.slice(start, start + query.pageSize).map((e) => (e.kind === 'message' ? messageItem(deps, user, e) : sendItem(deps, user, e)));
  return { items, total: entries.length, page: query.page, pageSize: query.pageSize };
}

function messageItem(deps: SentDeps, user: User, e: Extract<Entry, { kind: 'message' }>): MailSentItem {
  const row = deps.store.message(e.id)!;
  const hidden = deps.hidden(user, row);
  const to = JSON.parse(row.to_json) as Address[];
  const cc = JSON.parse(row.cc_json) as Address[];
  const send = e.fromApp ? deps.store.outgoingOfMessage(row.internet_message_id) : null;
  const personal = !send && e.mailbox === null;
  return {
    id: row.id,
    state: 'sent',
    at: e.at,
    mailbox: e.mailbox ? { id: e.mailbox.id, name: e.mailbox.name } : null,
    via: send ? 'app' : personal ? 'personal' : 'gmail',
    senderName: send ? deps.nameOf(send.user_id) : personal ? (e.senderId ? deps.nameOf(e.senderId) : row.from_name?.trim() || row.from_address) : null,
    threadId: row.thread_id,
    subject: hidden ? SIGN_IN_MAIL_SUBJECT : row.subject,
    to: hidden ? [] : to.map(shown),
    // A send from this app knows its BCC too (the archive copy is not counted).
    recipients: send ? send.recipients : to.length + cc.length,
    attachments: deps.store.attachments(row.id).length,
    replyTo: null,
    reason: null,
  };
}

function sendItem(deps: SentDeps, user: User, e: Extract<Entry, { kind: 'send' }>): MailSentItem {
  const { send } = e;
  const answered = send.reply_to_id ? deps.store.message(send.reply_to_id) : null;
  const readable = answered && (deps.store.links([answered.id]).get(answered.id) ?? []).some((id) => deps.addresses.mailboxes.some((m) => m.id === id));
  return {
    id: send.id,
    state: e.state,
    at: e.at,
    mailbox: { id: e.mailbox.id, name: e.mailbox.name },
    via: 'app',
    senderName: deps.nameOf(send.user_id),
    threadId: null,
    subject: null,
    to: [],
    recipients: send.recipients,
    attachments: null,
    replyTo: answered && readable ? { threadId: answered.thread_id, subject: deps.hidden(user, answered) ? SIGN_IN_MAIL_SUBJECT : answered.subject } : null,
    reason: e.state === 'failed' ? reasonOf(send.error) : null,
  };
}
