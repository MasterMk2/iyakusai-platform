import PostalMime, { type Address as MimeAddress } from 'postal-mime';
import type { Address } from '../../shared/api.js';
import { htmlToText } from '../domain/sanitize.js';

// Raw mail (RFC 5322, as Gmail stores it) to the fields the mailbox keeps. Charsets (ISO-2022-JP,
// Shift_JIS, ...), encoded words and attachments are decoded by postal-mime. Bcc is never kept.
// Limits keep a hostile message from exhausting the server; a message beyond them is refused whole.

export const MAX_RAW_BYTES = 40 * 1024 * 1024;
const MAX_TEXT = 1_000_000;
const MAX_HTML = 3_000_000;
const MAX_ATTACHMENTS = 200;
const MAX_ADDRESSES = 500;

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  disposition: string | null;
  contentId: string | null;
  content: Buffer;
}

export interface ParsedMail {
  /** Message-ID without angle brackets, or null. */
  messageId: string | null;
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  /** Date header as ISO 8601, or null when missing or unreadable. */
  date: string | null;
  text: string;
  html: string | null;
  inReplyTo: string | null;
  references: string[];
  /** List-Id headers (mail delivered through a Google Group). */
  listIds: string[];
  /** Delivered-To and X-Original-To headers. */
  deliveredTo: string[];
  attachments: ParsedAttachment[];
}

export class MailParseError extends Error {}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function flatten(list: MimeAddress[] | MimeAddress | undefined): Address[] {
  const out: Address[] = [];
  for (const a of Array.isArray(list) ? list : list ? [list] : []) {
    const members = a.group ? a.group : [a];
    for (const m of members) {
      const address = (m.address ?? '').trim().toLowerCase();
      if (!address) continue;
      out.push({ name: m.name?.replace(CONTROL, ' ').trim() || null, address });
    }
  }
  return out.slice(0, MAX_ADDRESSES);
}

const ids = (value: string | undefined): string[] => {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!);
  return (bracketed.length > 0 ? bracketed : value.split(/\s+/).filter(Boolean)).map((v) => v.slice(0, 500)).slice(0, 200);
};

function safeFilename(name: string | null, index: number, mimeType: string): string {
  const cleaned = (name ?? '').replace(CONTROL, '').replace(/[\\/]/g, '_').trim().slice(0, 200);
  if (cleaned) return cleaned;
  const ext = mimeType === 'message/rfc822' ? '.eml' : mimeType === 'text/calendar' ? '.ics' : '';
  return `attachment-${index + 1}${ext}`;
}

export async function parseRawMail(raw: Buffer): Promise<ParsedMail> {
  if (raw.length === 0 || raw.length > MAX_RAW_BYTES) throw new MailParseError('size');
  let email;
  try {
    email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer', maxPartCount: 2000, maxNestingDepth: 50, maxRfc822NestingDepth: 3, rfc822Attachments: true });
  } catch {
    throw new MailParseError('parse');
  }
  const header = (key: string) => email.headers.filter((h) => h.key === key).map((h) => h.value.trim()).filter(Boolean);
  const from = flatten(email.from)[0] ?? flatten(email.sender)[0] ?? { name: '（差出人の記載なし）', address: '' };
  let html = email.html ?? null;
  if (html !== null && html.length > MAX_HTML) html = null;
  let text = email.text ?? (email.html ? htmlToText(email.html) : '');
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n…（長すぎるため以降を省略）`;
  const date = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : null;
  if (email.attachments.length > MAX_ATTACHMENTS) throw new MailParseError('attachments');
  return {
    messageId: ids(email.messageId)[0] ?? null,
    subject: (email.subject ?? '').replace(CONTROL, ' ').trim().slice(0, 1000) || '（件名なし）',
    from,
    to: flatten(email.to),
    cc: flatten(email.cc),
    date,
    text,
    html,
    inReplyTo: ids(email.inReplyTo)[0] ?? null,
    references: ids(email.references),
    listIds: header('list-id').slice(0, 10),
    deliveredTo: [...header('delivered-to'), ...header('x-original-to')].map((v) => v.replace(/^<|>$/g, '').toLowerCase()).slice(0, 20),
    attachments: email.attachments.map((a, i) => ({
      filename: safeFilename(a.filename, i, a.mimeType),
      contentType: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(a.mimeType) ? a.mimeType : 'application/octet-stream',
      disposition: a.disposition ?? null,
      contentId: a.contentId?.slice(0, 500) ?? null,
      content: Buffer.from(a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : a.content),
    })),
  };
}
