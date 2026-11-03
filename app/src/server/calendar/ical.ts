import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { addDays } from '../../shared/calendar.js';

// iCalendar (RFC 5545) for a personal calendar subscription. The URL carries a random token (32 bytes, base64url),
// and the server keeps only its SHA-256 hash. The feed holds the title and the date of the items that concern the
// owner (their tasks' deadlines, the events of their departments and the committee-wide events): never a time, a
// memo, an assignee or another person. Every item is all day, so a time never leaves the server.

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const UID_HOST = 'calendar.iyakusai.invalid';

/** A new secret for a subscription URL (43 characters, 256 bits). */
export function newIcalToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The token of a request's file part ("<token>.ics"), or null when the shape is wrong. */
export function tokenFromFile(file: string): string | null {
  const m = /^(.+)\.ics$/.exec(file);
  if (!m || !TOKEN_RE.test(m[1]!)) return null;
  return m[1]!;
}

/** The path a subscription URL is made of (the screen joins it to the address it was opened at). */
export function icalPath(token: string): string {
  return `/api/calendar/ical/${token}.ics`;
}

/** iCalendar TEXT: backslash, semicolon, comma and line breaks escaped; control characters dropped. */
export function escapeText(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** One content line, folded at 75 octets (never inside a character); continuation lines start with a space. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > limit) {
      parts.push(current);
      current = ch;
      bytes = size;
      limit = 74;
    } else {
      current += ch;
      bytes += size;
    }
  }
  parts.push(current);
  return parts.map((p, i) => (i === 0 ? p : ` ${p}`)).join('\r\n');
}

export interface IcsItem {
  /** Stable per item (the event's or the task's ID). */
  key: string;
  title: string;
  /** The day, "YYYY-MM-DD" in Japan time. Every item is all day. */
  date: string;
}

/** The calendar text: CRLF line ends, every line folded. Items carry the title and the date only. */
export function buildIcs(items: IcsItem[], nowIso: string, calendarName = '医薬祭 委員会の予定'): string {
  const stamp = new Date(nowIso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//iyakusai//committee calendar//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(calendarName)}`];
  for (const item of items) {
    lines.push('BEGIN:VEVENT', `UID:${item.key}@${UID_HOST}`, `DTSTAMP:${stamp}`);
    // All day: the end is the next day (exclusive), as RFC 5545 writes it.
    lines.push(`DTSTART;VALUE=DATE:${item.date.replaceAll('-', '')}`, `DTEND;VALUE=DATE:${addDays(item.date, 1).replaceAll('-', '')}`);
    lines.push(`SUMMARY:${escapeText(item.title)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/**
 * Counts unknown-token requests per key in a sliding window. A valid token never reaches this, so the limit can
 * never lock out a feed that is in use.
 */
export class FailureCounter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records one failure for the key and says whether it is still within the limit. */
  allow(key: string, nowMs: number): boolean {
    if (this.hits.size > 10_000) this.hits.clear();
    const recent = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    const ok = recent.length < this.limit;
    if (ok) recent.push(nowMs);
    this.hits.set(key, recent);
    return ok;
  }
}

/** The feed text of each owner for a short time, so a poll or a leaked URL does not ask the Task API every time. */
export class FeedCache {
  private readonly entries = new Map<string, { until: number; body: string }>();

  constructor(private readonly ttlMs: number) {}

  get(userId: string, nowMs: number): string | null {
    const hit = this.entries.get(userId);
    if (!hit || hit.until <= nowMs) return null;
    return hit.body;
  }

  set(userId: string, body: string, nowMs: number): void {
    if (this.entries.size > 1_000) this.entries.clear();
    this.entries.set(userId, { until: nowMs + this.ttlMs, body });
  }
}

/**
 * The address a request came from. Behind the committee's proxy the address is the last entry of its single
 * X-Forwarded-For header (the same rule as the login's). Only the proxy's own address is trusted to say so.
 */
export function clientAddress(request: FastifyRequest, fromTrustedProxy: boolean): string {
  if (fromTrustedProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',').at(-1)!.trim();
  }
  return request.raw.socket.remoteAddress ?? 'unknown';
}
