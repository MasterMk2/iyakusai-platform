// Committee mailbox API contract (Discord login with SMM_MAIL_DIR): the parts the synthetic test
// version does not have. Thread, message and handling views are the shared ones in api.ts.
import type { Persona } from './api.js';

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
  departmentGrants: { department: string; mailboxId: string; kind: 'edit' | 'send' }[];
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
  /** Addresses this person may send from, in mailbox order. Empty: this person cannot send. */
  from: { mailboxId: string; name: string; address: string }[];
  /** Display name of the From line. */
  fromName: string;
  /** Added to every message as BCC (the committee archive), or null. */
  bcc: string | null;
  maxAttachmentBytes: number;
  /** To, Cc and Bcc together, the archive BCC not counted. */
  maxRecipients: number;
  /** The signed-in person's name (for the signature). */
  senderName: string;
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
}

export interface MailSendResponse {
  status: 'sent';
  /** The sent message in the mailbox; null when only the account's own copy (collected within minutes) will show it. */
  receiptId: string | null;
  threadId: string | null;
  threadDone: boolean;
}

/** Error code: the connection ended after the message was handed over; it may have been sent. Do not send it again. */
export const SEND_UNKNOWN = 'send_unknown';
/** Error code: this message (its clientToken) is being sent right now, or was sent. */
export const SEND_DUPLICATE = 'send_duplicate';

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
