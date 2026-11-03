// Deadlines of committee mail (2026-11-03). Two kinds, both calendar days in Japan time (JST), written as
// YYYY-MM-DD and shared by the server and the screens:
//   - response due (対応期限): a due date on a received message, while its status is not 完了;
//   - reply deadline (返事待ち): set when a message is sent with a reply deadline. The message waits for the
//     partner's reply until a reply from outside the committee arrives in its thread (see due.ts).

export const DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A response due date within this many days (or overdue) is listed on the home screen as near. */
export const DUE_SOON_DAYS = 3;
const JST_OFFSET_MS = 9 * 3_600_000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** A calendar day that exists (2026-02-30 does not), between 2000 and 2100. */
export function isDueDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DUE_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (y < 2000 || y > 2100) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The Japan calendar day (YYYY-MM-DD) of an instant given as an ISO string, epoch milliseconds or a Date. */
export function jstDay(at: string | number | Date): string {
  const ms = (typeof at === 'string' ? Date.parse(at) : typeof at === 'number' ? at : at.getTime()) + JST_OFFSET_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The calendar day `days` after `day` (negative for before). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 11月10日（火）. The year is written only when it is not the year of `today`. */
export function japaneseDay(day: string, today: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const year = y === Number(today.slice(0, 4)) ? '' : `${y}年`;
  return `${year}${m}月${d}日（${weekday}）`;
}

/** The sentence added to the end of a message that asks for a reply by `day` (the screen adds it; the server does not rewrite text). */
export function replyDueSentence(day: string, today: string): string {
  return `ご回答は${japaneseDay(day, today)}までにお願いいたします。`;
}

/**
 * The earliest day the 回答期限 input accepts. A day already saved may pass (the wait is kept as it is while
 * other fields change), so the minimum applies only to a day that was typed in now. The server checks the same
 * rule (updateDue: a changed reply deadline must be today or later).
 */
export function replyDueMin(today: string, saved: string | null, typed: string): string | undefined {
  return typed === (saved ?? '') ? undefined : today;
}

export interface ReplyWaitView {
  /** The reply deadline (YYYY-MM-DD). */
  dueOn: string;
  /** When the wait started (ISO time, the send). */
  since: string;
  /** The deadline has passed (before today, in Japan time). */
  overdue: boolean;
}

/** The deadlines of one received or sent message, as its screen shows them. */
export interface MessageDueView {
  /** The message's handling version (the same counter as the triage): a change must name it. */
  version: number;
  responseDue: string | null;
  responseOverdue: boolean;
  replyWait: ReplyWaitView | null;
  /** The signed-in person may set, change or remove the deadlines (a mailbox edit grant). */
  canEdit: boolean;
  /** A reply wait (回答期限) can be set on this message: it was sent from a committee address, not received. */
  replyWaitAllowed: boolean;
}

/** The deadlines of a thread, from its messages (the list and the top of a thread). */
export interface ThreadDueView {
  /** The nearest response due date of the messages that are not 完了. */
  responseDue: string | null;
  responseOverdue: boolean;
  /** The earliest reply wait of the thread. */
  replyWait: ReplyWaitView | null;
}

/** One line of the home screen's lists. */
export interface MailDueEntry {
  threadId: string;
  subject: string;
  mailboxName: string;
  kind: 'reply' | 'response';
  dueOn: string;
  overdue: boolean;
}

/** GET /api/mail/due: what the home screen shows (the counts are all of them, the lists the first few). */
export interface MailDueResponse {
  today: string;
  counts: { replyOverdue: number; responseDue: number };
  replyOverdue: MailDueEntry[];
  responseDue: MailDueEntry[];
}

