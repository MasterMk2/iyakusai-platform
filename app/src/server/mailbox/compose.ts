import { randomBytes } from 'node:crypto';
import { isMailAddress } from '../../shared/mailbox.js';

// One outgoing message as RFC 5322 bytes (sending from the committee mailbox).
// Every part is UTF-8 in base64 and every non-ASCII header word is an RFC 2047 encoded word, so the
// message is 7-bit with short lines whatever the text is. Callers pass checked values only: addresses
// already validated, no CR/LF anywhere (this module refuses them too, so a header cannot be injected).
// Bcc is never written into the message; it is given to SMTP as recipients only.

export interface OutgoingAddress {
  name: string | null;
  address: string;
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingMail {
  from: OutgoingAddress;
  /** Where answers should go when not to From. */
  replyTo?: OutgoingAddress | null;
  to: OutgoingAddress[];
  cc: OutgoingAddress[];
  subject: string;
  text: string;
  /** Message-ID without angle brackets. */
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  date: Date;
  attachments: OutgoingAttachment[];
}

export class ComposeError extends Error {}

// eslint-disable-next-line no-control-regex
const LINE_BREAK_OR_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const MESSAGE_ID = /^[\x21-\x3b\x3d\x3f-\x7e]{1,250}$/; // printable ASCII without < > and space
const CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/;

/** A Message-ID this builder can write (stored mail may carry ones it cannot: those are left out of replies). */
export const isMessageId = (value: string): boolean => MESSAGE_ID.test(value);

/** A new Message-ID on the sending address's own domain. */
export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1);
  return `${Date.now().toString(36)}.${randomBytes(12).toString('hex')}@${domain}`;
}

function check(value: string, what: string): string {
  if (LINE_BREAK_OR_CONTROL.test(value)) throw new ComposeError(`${what}に改行や制御文字は使えません。`);
  return value;
}

/** RFC 2047 "B" encoded words of 60 characters at most, never splitting a character. */
function encodedWords(value: string): string[] {
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    // 36 bytes of UTF-8 make 48 base64 characters, +12 for "=?UTF-8?B?" and "?=": a header line stays within 78.
    if (Buffer.byteLength(chunk + ch, 'utf8') > 36) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`);
}

const printableAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

/** Unstructured header text (the subject): plain when ASCII and short, else encoded words, folded. */
function unstructured(value: string): string {
  if (printableAscii(value) && value.length <= 900 && !/=\?/.test(value)) return value;
  return encodedWords(value).join('\r\n ');
}

function mailbox(a: OutgoingAddress): string {
  if (!isMailAddress(a.address)) throw new ComposeError('メールアドレスの形式が正しくありません。');
  const name = a.name?.trim();
  if (!name) return a.address;
  check(name, '名前');
  if (printableAscii(name) && !/=\?/.test(name)) return `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}" <${a.address}>`;
  // Encoded words and the address each on a folded line.
  return `${encodedWords(name).join('\r\n ')}\r\n <${a.address}>`;
}

/** An address list folded one address per line. */
function addressList(list: OutgoingAddress[]): string {
  return list.map(mailbox).join(',\r\n ');
}

function ids(values: string[]): string {
  for (const v of values) if (!MESSAGE_ID.test(v)) throw new ComposeError('Message-ID の形式が正しくありません。');
  return values.map((v) => `<${v}>`).join('\r\n ');
}

/** Date in RFC 5322 form, in Japan time (+0900) like the committee's own mail. */
export function rfc5322Date(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3_600_000);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][jst.getUTCDay()]!;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][jst.getUTCMonth()]!;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${day}, ${jst.getUTCDate()} ${month} ${jst.getUTCFullYear()} ${two(jst.getUTCHours())}:${two(jst.getUTCMinutes())}:${two(jst.getUTCSeconds())} +0900`;
}

const base64Lines = (data: Buffer) => data.toString('base64').replace(/.{76}/g, '$&\r\n');

/** Text with CRLF line ends (what SMTP carries), whatever the browser sent. */
const crlf = (text: string) => text.replace(/\r\n|\r|\n/g, '\r\n');

function filenameParams(filename: string): { name: string; filename: string } {
  const safe = check(filename, 'ファイル名');
  if (printableAscii(safe) && !/["\\]|=\?/.test(safe)) return { name: `name="${safe}"`, filename: `filename="${safe}"` };
  // Encoded words in the parameters, as Gmail writes them (read by Japanese mail software too).
  const words = encodedWords(safe).join('\r\n ');
  return { name: `name="${words}"`, filename: `filename="${words}"` };
}

export function buildRawMail(m: OutgoingMail): Buffer {
  if (m.to.length + m.cc.length === 0) throw new ComposeError('宛先がありません。');
  const headers = [
    `Date: ${rfc5322Date(m.date)}`,
    `From: ${mailbox(m.from)}`,
    ...(m.replyTo ? [`Reply-To: ${mailbox(m.replyTo)}`] : []),
    ...(m.to.length > 0 ? [`To: ${addressList(m.to)}`] : []),
    ...(m.cc.length > 0 ? [`Cc: ${addressList(m.cc)}`] : []),
    `Subject: ${unstructured(check(m.subject, '件名'))}`,
    `Message-ID: ${ids([m.messageId])}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${ids([m.inReplyTo])}`] : []),
    ...(m.references.length > 0 ? [`References: ${ids(m.references)}`] : []),
    'MIME-Version: 1.0',
  ];
  const text = Buffer.from(crlf(m.text), 'utf8');
  const textHead = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
  if (m.attachments.length === 0) {
    return Buffer.from([...headers, ...textHead, '', base64Lines(text), ''].join('\r\n'), 'ascii');
  }
  const boundary = `----=_iyakusai_${randomBytes(12).toString('hex')}`;
  const lines = [...headers, `Content-Type: multipart/mixed;\r\n boundary="${boundary}"`, '', 'This is a multi-part message in MIME format.', '', `--${boundary}`, ...textHead, '', base64Lines(text)];
  for (const a of m.attachments) {
    if (!CONTENT_TYPE.test(a.contentType)) throw new ComposeError('添付ファイルの種類が正しくありません。');
    const p = filenameParams(a.filename);
    lines.push(`--${boundary}`, `Content-Type: ${a.contentType};\r\n ${p.name}`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment;\r\n ${p.filename}`, '', base64Lines(a.content));
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'), 'ascii');
}
