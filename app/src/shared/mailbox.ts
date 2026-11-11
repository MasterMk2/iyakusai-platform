// Committee mailbox API contract (Discord login with SMM_MAIL_DIR): the parts the synthetic test
// version does not have. Thread, message and handling views are the shared ones in api.ts.
import type { Persona } from './api.js';
import type { SignatureParts } from './signature.js';

/** GET /api/mail/status: whether the mailbox exists here and whether this device must type the password again. */
export interface MailStatusResponse {
  enabled: boolean;
  /** False while the mailbox is open only to the trial accounts and this account is not one of them. */
  canOpen: boolean;
  /** No mail use on this device for `idleHours`: the password is needed again before mail opens. */
  reauthRequired: boolean;
  idleHours: number;
  /** Unhandled messages across all mailboxes, each counted once; null while the mailbox cannot be opened. */
  unhandledTotal: number | null;
  /** Mail waiting for an approval (2026-11-11); null while the mailbox cannot be opened, absent without sending or on an older server. */
  approvals?: MailApprovalCounts | null;
}

/** Error code of a mail request that needs the password again. */
export const REAUTH_REQUIRED = 'reauth_required';

/** GET /api/mail/admin/access (access administrators). */
export interface MailAccessResponse {
  people: Persona[];
  mailboxes: { id: string; name: string; address: string }[];
  /** Edit grants: the person may change status, assignee, labels and notes of mail in that mailbox. */
  grants: { userId: string; mailboxId: string }[];
  /** Send grants: the person may send mail with that mailbox's address as From. */
  sendGrants: { userId: string; mailboxId: string }[];
  /** Mailboxes the server can send from; null when sending is not set up on this server. */
  sendable: string[] | null;
  /** Departments that can be granted (those of the listed people, temporary staff left out). */
  departments: string[];
  /** Grants to a department: everyone in it, now or later, has them (2026-10-26). */
  departmentGrants: { department: string; mailboxId: string; kind: 'edit' | 'send' | 'review' }[];
  /** Review grants (2026-11-11): the person may approve, change and return mail that waits for an approval in that mailbox. */
  reviewGrants?: { userId: string; mailboxId: string }[];
  /** People whose mail from that mailbox always waits for an approval, even with a send grant (2026-11-11). */
  approvalRequired?: { userId: string; mailboxId: string }[];
  ingest: { messages: number; latestStoredAt: string | null; sources: Record<string, number> };
}

/** The department of temporary staff accounts: never granted mail (they use the rental screen only). */
export const TEMPORARY_STAFF_DEPARTMENT = '臨時スタッフ';

/**
 * The departments of a person, from the label the Discord login gives: the department names of their roles
 * joined with "・", or "委員" when they have none.
 */
export function departmentsOfLabel(roleLabel: string): string[] {
  if (roleLabel.trim() === '委員') return [];
  return [...new Set(roleLabel.split('・').map((d) => d.trim()).filter(Boolean))];
}

// ---- sending from the app (SMTP of the committee's Gmail account, per-mailbox send grants)

/** GET /api/mail/send/options: what the signed-in person can send. */
export interface MailSendOptions {
  /** Sending is set up on this server. */
  enabled: boolean;
  /**
   * Addresses this person may write mail from, in mailbox order: those they send from at once, and those where their
   * mail waits for an approval (`approvalMailboxIds`). Empty: this person cannot write mail.
   */
  from: { mailboxId: string; name: string; address: string }[];
  /** From mailboxes where this person's mail is sent only after a reviewer approves it (2026-11-11); absent: none. */
  approvalMailboxIds?: string[];
  /** Display name of the From line. */
  fromName: string;
  /** Added to every message as BCC (the committee archive), or null. */
  bcc: string | null;
  /** From mailboxes this person may also put a reply deadline on (the edit grant too); empty when none (2026-11-03). */
  dueMailboxIds?: string[];
  maxAttachmentBytes: number;
  /** To, Cc and Bcc together, the archive BCC not counted. */
  maxRecipients: number;
  /** The signed-in person's name (for the signature). */
  senderName: string;
  /** What the committee's signature is made of (2026-11-10); absent on an older server: the old signature. */
  signature?: SignatureParts;
}

/** The "message" part of POST /api/mail/send (multipart/form-data; files are the "attachments" parts). */
export interface MailSendRequest {
  /** Made by the screen once per message: sending again with it never sends the message twice. */
  clientToken: string;
  mailboxId: string;
  /** "名前 <address>" or "address", as typed. */
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** Reply: the message answered; the reply continues its thread. */
  replyToReceiptId: string | null;
  /** Reply: set the whole thread to 完了 once it is sent. */
  markThreadDone: boolean;
  /** Reply-To: one "名前 <address>" or "address" that answers should go to instead of From; null or empty for none. */
  replyTo?: string | null;
  /** Reply deadline (YYYY-MM-DD): the message then waits for the partner's reply (2026-11-03). Null or absent: none. */
  replyDue?: string | null;
}

export interface MailSendResponse {
  status: 'sent';
  /** The sent message in the mailbox; null when only the account's own copy (collected within minutes) will show it. */
  receiptId: string | null;
  threadId: string | null;
  threadDone: boolean;
  /** The reply deadline as kept: 'set', 'failed' (the mail is sent; set it again on the screen), or 'none' (none asked). */
  replyWait?: 'none' | 'set' | 'failed';
}

/** Error code: the connection ended after the message was handed over; it may have been sent. Do not send it again. */
export const SEND_UNKNOWN = 'send_unknown';
/** Error code: this message (its clientToken) is being sent right now, or was sent. */
export const SEND_DUPLICATE = 'send_duplicate';

/** Error code of POST /api/mail/send: this person's mail from that mailbox needs an approval (POST /api/mail/approvals). */
export const APPROVAL_NEEDED = 'approval_needed';

// ---- approval before sending (2026-11-11): a member's mail waits until a reviewer of the From mailbox approves it

/**
 * pending: waits for a reviewer. returned: sent back with a comment; the author changes it and asks again, or
 * withdraws it. sending: approved, being handed to the mail server. sent. unknown: approved, but the connection
 * ended while it was handed over (it may have been sent; never sent again). withdrawn: taken back by the author.
 */
export const MAIL_APPROVAL_STATES = ['pending', 'returned', 'sending', 'sent', 'unknown', 'withdrawn'] as const;
export type MailApprovalState = (typeof MAIL_APPROVAL_STATES)[number];

export const MAIL_APPROVAL_STATE_LABELS: Record<MailApprovalState, string> = {
  pending: '承認待ち',
  returned: '差し戻し',
  sending: '送信中',
  sent: '送信済み',
  unknown: '送信できたか不明',
  withdrawn: '取り下げ',
};

export const MAIL_APPROVAL_NOTE_MAX = 500;
export const MAIL_APPROVAL_COMMENT_MAX = 1000;
/** Requests of one author that may wait (pending or returned) at the same time. */
export const MAIL_APPROVAL_OPEN_MAX = 10;

/** GET /api/mail/status: what waits for this person. */
export interface MailApprovalCounts {
  /** Requests this person may approve (others' mail in the mailboxes they review). */
  toReview: number;
  /** This person's own requests that were sent back. */
  returned: number;
}

/** What a request would send; the same fields as MailSendRequest without the token. */
export interface MailApprovalMessage {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  replyTo: string | null;
  replyDue: string | null;
  replyToReceiptId: string | null;
  markThreadDone: boolean;
}

/** The fields a reviewer may change before approving (attachments stay the author's). */
export const MAIL_APPROVAL_EDIT_FIELDS = ['to', 'cc', 'bcc', 'subject', 'body', 'replyTo', 'replyDue'] as const;
export type MailApprovalEditField = (typeof MAIL_APPROVAL_EDIT_FIELDS)[number];

export const MAIL_APPROVAL_FIELD_LABELS: Record<MailApprovalEditField, string> = {
  to: '宛先',
  cc: 'CC',
  bcc: 'BCC',
  subject: '件名',
  body: '本文',
  replyTo: '返信先',
  replyDue: '回答期限',
};

export interface MailApprovalSummary {
  id: string;
  state: MailApprovalState;
  version: number;
  mailbox: { id: string; name: string; address: string };
  subject: string;
  /** The To recipients as written. */
  to: string[];
  authorName: string;
  /** The signed-in person wrote it. */
  mine: boolean;
  /** The signed-in person may approve, change or return it now. */
  canReview: boolean;
  createdAt: string;
  updatedAt: string;
  /** Who approved or returned it, and when; null while nobody has. */
  decidedByName: string | null;
  decidedAt: string | null;
}

export type MailApprovalAction = 'submitted' | 'resubmitted' | 'edited' | 'returned' | 'approved' | 'sent' | 'send_failed' | 'send_unknown' | 'withdrawn';

export interface MailApprovalDetail extends MailApprovalSummary {
  message: MailApprovalMessage;
  /** What the author asked for, when a reviewer changed it since; null when nothing was changed. */
  submitted: MailApprovalMessage | null;
  /** The fields a reviewer changed since the author asked. */
  changedFields: MailApprovalEditField[];
  /** The author's words to the reviewer. */
  note: string;
  /** The reviewer's words with the return; null unless it was returned. */
  returnComment: string | null;
  attachments: { idx: number; filename: string; contentType: string; size: number }[];
  /** The thread a reply continues, when it can still be read. */
  replyThread: { threadId: string; subject: string } | null;
  /** The sent message's thread, once sent and stored. */
  sentThreadId: string | null;
  /** The author may put a reply deadline on mail from this mailbox, or the signed-in reviewer may. */
  canSetDue: boolean;
  history: { at: string; actorName: string; action: MailApprovalAction; detail: string | null }[];
}

/** GET /api/mail/approvals. */
export interface MailApprovalsResponse {
  /** The signed-in person reviews at least one mailbox. */
  reviewer: boolean;
  /** Waiting for the signed-in person's approval, oldest first. */
  review: MailApprovalSummary[];
  /** The signed-in person's own requests that are not finished, newest first. */
  mine: MailApprovalSummary[];
  /** Finished ones (sent, withdrawn, unknown) the person wrote or decided, newest first, the latest only. */
  done: MailApprovalSummary[];
}

/** The "message" part of POST /api/mail/approvals and PUT /api/mail/approvals/:id (multipart; files are "attachments"). */
export interface MailApprovalSubmitRequest extends MailSendRequest {
  /** Words to the reviewer; may be empty. */
  note: string;
  /** PUT only: the request's version as read, and the attachments kept from it (by idx). */
  expectedVersion?: number;
  keepAttachments?: number[];
}

/** PATCH /api/mail/approvals/:id (a reviewer changes the mail before approving). */
export interface MailApprovalEditRequest {
  expectedVersion: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  replyTo: string | null;
  replyDue: string | null;
}

export const MAIL_SUBJECT_MAX = 300;
export const MAIL_BODY_MAX = 100_000;
export const MAIL_ATTACHMENTS_MAX = 10;

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const isMailAddress = (value: string): boolean => value.length <= 254 && ADDRESS.test(value);

/** One recipient as typed: "address", "<address>" or "名前 <address>" (the name may be quoted). Null when it is not one. */
export function parseRecipient(value: string): { name: string | null; address: string } | null {
  const v = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!v || v.length > 400 || /[\u0000-\u001f\u007f]/.test(v)) return null;
  const angle = /^(.*?)\s*<([^<>\s]+)>$/.exec(v);
  const address = (angle ? angle[2]! : v).trim();
  if (!isMailAddress(address)) return null;
  const name = angle ? angle[1]!.trim().replace(/^"(.*)"$/, '$1').trim() : '';
  if (/[<>"]/.test(name) || name.length > 100) return null;
  return { name: name || null, address };
}

/** Recipients typed in one field, separated by commas, semicolons, full-width commas or new lines. */
export function splitRecipients(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && /[,;、，；\n\r]/.test(ch)) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
