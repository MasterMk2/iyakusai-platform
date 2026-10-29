import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { validateMailboxConfig, type MailboxConfig } from '../../src/server/mailbox/config.js';
import { INGEST_PATH } from '../../src/server/mailbox/ingest.js';
import { canonicalStringForBodyHash } from '../../src/server/tasks/signing.js';

// Synthetic committee domain and addresses only (reserved .example names; no real address or person).
export const DOMAIN = 'committee.example';
export const ALIAS_DOMAIN = 'committee-alias.example';
export const CONTACT = `contact@${DOMAIN}`;
export const SPONSOR = `sponsorship@${DOMAIN}`;
export const ADM = `adm@${DOMAIN}`;
export const COLLECTOR = `taro@${DOMAIN}`;
export const PERSONAL = `chair-person@${DOMAIN}`;
export const OUTSIDE = 'company@partner.example';

export function testMailboxConfig(dataDir: string, changes: Record<string, unknown> = {}, key: Buffer = randomBytes(32), smtpPassword: string | null = null): MailboxConfig {
  return validateMailboxConfig(
    {
      version: 1,
      mailboxes: [
        { id: 'contact', name: '問い合わせ', address: CONTACT, subjectTag: 'cnt' },
        // sponsorship@ forwards to adm@ (a group inside a group), as in the committee's own setup.
        { id: 'sponsorship', name: '協賛', address: SPONSOR, subjectTag: 'sps', forwardsTo: ['adm'] },
        { id: 'adm', name: '大学窓口', address: ADM, subjectTag: 'adm' },
        { id: 'taro', name: '委員会共用', address: COLLECTOR, catchAll: true },
      ],
      domainAliases: { [ALIAS_DOMAIN]: DOMAIN },
      ...changes,
    },
    dataDir,
    key,
    smtpPassword,
  );
}

export interface RawMailOptions {
  messageId?: string | null;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  /** Subject as an ISO-2022-JP encoded word (the bytes are given as a JIS escape sequence). */
  subjectJis?: string;
  text?: string;
  /** Body in ISO-2022-JP (7bit JIS bytes). */
  textJis?: string;
  html?: string;
  date?: string;
  inReplyTo?: string;
  references?: string[];
  listId?: string;
  deliveredTo?: string;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}

/** Builds an RFC 5322 message like Gmail's raw content. */
export function rawMail(o: RawMailOptions = {}): Buffer {
  const headers: string[] = [];
  if (o.deliveredTo) headers.push(`Delivered-To: ${o.deliveredTo}`);
  headers.push(`From: ${o.from ?? `"取引先 担当" <${OUTSIDE}>`}`);
  if (o.to !== undefined) headers.push(`To: ${o.to}`);
  if (o.cc) headers.push(`Cc: ${o.cc}`);
  if (o.subjectJis) headers.push(`Subject: =?ISO-2022-JP?B?${Buffer.from(o.subjectJis, 'latin1').toString('base64')}?=`);
  else headers.push(`Subject: =?UTF-8?B?${Buffer.from(o.subject ?? '合成テストの件名', 'utf8').toString('base64')}?=`);
  headers.push(`Date: ${o.date ?? 'Tue, 13 Oct 2026 10:00:00 +0900'}`);
  if (o.messageId !== null) headers.push(`Message-ID: <${o.messageId ?? `${randomBytes(6).toString('hex')}@partner.example`}>`);
  if (o.inReplyTo) headers.push(`In-Reply-To: <${o.inReplyTo}>`);
  if (o.references) headers.push(`References: ${o.references.map((r) => `<${r}>`).join(' ')}`);
  if (o.listId) headers.push(`List-Id: ${o.listId}`);
  headers.push('MIME-Version: 1.0');

  const textPart = o.textJis
    ? { type: 'text/plain; charset=ISO-2022-JP', encoding: '7bit', body: Buffer.from(o.textJis, 'latin1') }
    : { type: 'text/plain; charset=UTF-8', encoding: 'base64', body: Buffer.from(Buffer.from(o.text ?? '合成テストの本文です。', 'utf8').toString('base64'), 'latin1') };
  const parts: { type: string; encoding: string; body: Buffer; disposition?: string }[] = [textPart];
  if (o.html) parts.push({ type: 'text/html; charset=UTF-8', encoding: 'base64', body: Buffer.from(Buffer.from(o.html, 'utf8').toString('base64'), 'latin1') });
  for (const a of o.attachments ?? []) {
    parts.push({
      type: `${a.contentType}; name="=?UTF-8?B?${Buffer.from(a.filename).toString('base64')}?="`,
      encoding: 'base64',
      body: Buffer.from(a.content.toString('base64').replace(/.{76}/g, '$&\r\n'), 'latin1'),
      disposition: `attachment; filename="=?UTF-8?B?${Buffer.from(a.filename).toString('base64')}?="`,
    });
  }
  const crlf = Buffer.from('\r\n');
  if (parts.length === 1) {
    headers.push(`Content-Type: ${textPart.type}`, `Content-Transfer-Encoding: ${textPart.encoding}`);
    return Buffer.concat([Buffer.from(headers.join('\r\n')), crlf, crlf, textPart.body, crlf]);
  }
  const boundary = `b-${randomBytes(6).toString('hex')}`;
  const alternative = parts.length === 2 && !!o.html && !o.attachments?.length;
  headers.push(`Content-Type: multipart/${alternative ? 'alternative' : 'mixed'}; boundary="${boundary}"`);
  const chunks: Buffer[] = [Buffer.from(headers.join('\r\n')), crlf, crlf];
  for (const part of parts) {
    const head = [`--${boundary}`, `Content-Type: ${part.type}`, `Content-Transfer-Encoding: ${part.encoding}`];
    if (part.disposition) head.push(`Content-Disposition: ${part.disposition}`);
    chunks.push(Buffer.from(head.join('\r\n')), crlf, crlf, part.body, crlf);
  }
  chunks.push(Buffer.from(`--${boundary}--`), crlf);
  return Buffer.concat(chunks);
}

/** Signed headers for one ingest request, as the collector (GAS) builds them. */
export function ingestHeaders(key: Buffer, path: string, body: Buffer, at = Date.now(), nonce = randomBytes(18).toString('base64url')): Record<string, string> {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const timestamp = String(at);
  const signature = createHmac('sha256', key).update(canonicalStringForBodyHash({ client: 'mail-collector', method: 'POST', path, timestamp, nonce, actor: '' }, bodyHash), 'utf8').digest('hex');
  return { 'x-svc-client': 'mail-collector', 'x-svc-timestamp': timestamp, 'x-svc-nonce': nonce, 'x-svc-signature': signature, 'content-type': 'message/rfc822' };
}

export function ingestPath(source: 'collector' | 'backfill', id: string, at: number): string {
  return `${INGEST_PATH}?source=${source}&id=${id}&at=${at}`;
}

/** Posts one raw message the way the collector does. */
export async function ingest(app: FastifyInstance, key: Buffer, host: string, raw: Buffer, o: { source?: 'collector' | 'backfill'; id?: string; at?: number; now?: number; headers?: Record<string, string> } = {}) {
  const at = o.at ?? Date.parse('2026-10-13T01:00:00.000Z');
  const path = ingestPath(o.source ?? 'collector', o.id ?? randomBytes(8).toString('hex'), at);
  const res = await app.inject({ method: 'POST', url: path, headers: { host, ...ingestHeaders(key, path, raw, o.now), ...o.headers }, payload: raw });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, json: json as any, path };
}
