import { z } from 'zod';

// Committee calendar (2026-11-03): deadlines, meetings, school procedures and events, plus the yearly schedule
// that the next year's owner copies. Dates are calendar dates in Japan time (Asia/Tokyo, no daylight saving),
// stored as "YYYY-MM-DD" and "HH:MM" text, so the same value means the same day on the server and on the screen.

export const CALENDAR_KINDS = ['deadline', 'meeting', 'procedure', 'event', 'other'] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];
export const CALENDAR_KIND_LABELS: Record<CalendarKind, string> = {
  deadline: '締切',
  meeting: '会議',
  procedure: '学務の手続き',
  event: '行事',
  other: 'その他',
};

export const CALENDAR_LIMITS = {
  titleMax: 120,
  memoMax: 2000,
  departmentMax: 40,
  departmentsMax: 10,
  remindMax: 5,
  remindDayMax: 60,
  rangeDaysMax: 400,
} as const;

/** The reminder choices offered in the form: days before the date (0 = the day itself). */
export const REMIND_CHOICES = [14, 7, 3, 1, 0] as const;

/** Tasks reach the home screen this many days before their deadline. Tasks have no setting of their own. */
export const TASK_REMIND_DAYS = 7;

/** The data of one event as the screen sends it and the store keeps it. `time` null means all day. */
export interface CalendarEventInput {
  title: string;
  kind: CalendarKind;
  date: string;
  time: string | null;
  departments: string[];
  memo: string;
  /** 毎年: the event is part of the yearly schedule and is copied to the next year. */
  yearly: boolean;
  /** Days before the date to show it on the home screen, in ascending order (e.g. [3, 14]). */
  remindDays: number[];
}

export class CalendarValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarValidationError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;

/** A real calendar date in "YYYY-MM-DD" (2026-02-30 is refused). */
export function isDateOnly(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Today's date in Japan time for a moment. */
export function jstDate(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The date `days` days after `date` (negative goes back). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * The same month and day `years` years later (or earlier). 2028-02-29 moves to 2029-02-28, and the next leap
 * year does not bring it back: the yearly copy always starts from the day the owner typed.
 */
export function shiftYears(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = y + years;
  const lastDay = new Date(Date.UTC(target, m, 0)).getUTCDate();
  return `${String(target).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** Where a yearly event falls in `year`, keeping its month and day (see shiftYears). */
export function occurrenceInYear(date: string, year: number): string {
  return shiftYears(date, year - Number(date.slice(0, 4)));
}

/** The day a link asks the calendar to open on (`cal=`): a real date, or null for anything else. */
export function calendarDateParam(value: string | null): string | null {
  return value !== null && isDateOnly(value) ? value : null;
}

/** The Sunday on or before `date` (weeks start on Sunday, as the calendar grid does). */
export function weekStart(date: string): string {
  return addDays(date, -new Date(`${date}T00:00:00Z`).getUTCDay());
}

/** The calendar text for a day: 2026年4月1日（水）. */
export function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const w = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}年${m}月${d}日（${w}）`;
}

// A title and a department name are one line: every control character (LF, CR and tab included) is refused.
// eslint-disable-next-line no-control-regex
const CONTROL_SINGLE_LINE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const eventSchema = z.strictObject({
  title: z.string().max(CALENDAR_LIMITS.titleMax * 4),
  kind: z.enum(CALENDAR_KINDS),
  date: z.string().max(10),
  time: z.string().max(5).nullable(),
  departments: z.array(z.string().max(CALENDAR_LIMITS.departmentMax * 4)).max(CALENDAR_LIMITS.departmentsMax),
  memo: z.string().max(CALENDAR_LIMITS.memoMax * 4),
  yearly: z.boolean(),
  remindDays: z.array(z.number().int().min(0).max(CALENDAR_LIMITS.remindDayMax)).max(CALENDAR_LIMITS.remindMax),
});

/**
 * Checks and normalizes an event from the screen or a copy. Throws CalendarValidationError with the field and a
 * message for the screen. Nothing else in the record is trusted: unknown keys are refused.
 */
export function validateCalendarEvent(input: unknown): CalendarEventInput {
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? '');
    const message = field === 'kind' ? '種類を選んでください。' : field === 'departments' ? '部局は 10 件までです。' : field === 'remindDays' ? '知らせる日は 5 件までです。' : '入力内容を確かめてください。';
    throw new CalendarValidationError(field || 'event', message);
  }
  const e = parsed.data;
  const title = e.title.trim();
  if (!title) throw new CalendarValidationError('title', '題名を入れてください。');
  if ([...title].length > CALENDAR_LIMITS.titleMax || CONTROL_SINGLE_LINE.test(title)) throw new CalendarValidationError('title', `題名は ${CALENDAR_LIMITS.titleMax} 文字までで、改行は使えません。`);
  if (!isDateOnly(e.date)) throw new CalendarValidationError('date', '日付は 2026-04-01 のように、実在する日付で入れてください。');
  if (e.time !== null && !TIME_RE.test(e.time)) throw new CalendarValidationError('time', '時刻は 09:30 のように入れてください。');
  const departments: string[] = [];
  for (const raw of e.departments) {
    const name = raw.trim();
    if (!name) continue;
    if ([...name].length > CALENDAR_LIMITS.departmentMax || CONTROL_SINGLE_LINE.test(name)) throw new CalendarValidationError('departments', `部局名は ${CALENDAR_LIMITS.departmentMax} 文字までで、改行は使えません。`);
    if (!departments.includes(name)) departments.push(name);
  }
  if (departments.length > CALENDAR_LIMITS.departmentsMax) throw new CalendarValidationError('departments', '部局は 10 件までです。');
  const memo = e.memo.replace(/\r\n?/g, '\n').trim();
  if ([...memo].length > CALENDAR_LIMITS.memoMax) throw new CalendarValidationError('memo', `メモは ${CALENDAR_LIMITS.memoMax} 文字までです。`);
  if (CONTROL.test(memo)) throw new CalendarValidationError('memo', 'メモに使えない文字が含まれています。');
  const remindDays = [...new Set(e.remindDays)].sort((a, b) => a - b);
  return { title, kind: e.kind, date: e.date, time: e.time, departments, memo, yearly: e.yearly, remindDays };
}

/** Dates in order; on one day the timed items come by time, then by title. */
export function sortByDateTime<T extends { date: string; time: string | null; title: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title, 'ja'));
}

/** Days shown on the home screen for an event: the reminder days that are in the future (or today). */
export function reminderLeft(event: Pick<CalendarEventInput, 'remindDays'>, date: string, today: string): number | null {
  const left = daysBetween(today, date);
  if (left < 0 || event.remindDays.length === 0) return null;
  return left <= Math.max(...event.remindDays) ? left : null;
}

// ---- what the API answers (the server and the screen share these)

export interface CalendarEventView extends CalendarEventInput {
  id: string;
  version: number;
  /** The event this one was copied from (the yearly copy), or null. */
  copiedFrom: string | null;
  /**
   * True when a yearly event is listed on another year's date: `date` is then that occurrence's date, and `baseDate`
   * is the date the record holds (the one the owner typed). Changing an event always starts from `baseDate`.
   */
  occurrence: boolean;
  /** The date the record holds (the same as `date` unless `occurrence` is true). */
  baseDate: string;
  createdByName: string;
  updatedAt: string;
  updatedByName: string;
  /** The signed-in person may delete it: the one who made it, or an access administrator. */
  canDelete: boolean;
}

export interface CalendarListResponse {
  events: CalendarEventView[];
  /** Every department name in use (the people's roles and the events): the choices of the filter and the form. */
  departments: string[];
  /** The signed-in person's own departments (from their role labels). */
  myDepartments: string[];
  canAdminister: boolean;
}

export interface CalendarHistoryView {
  at: string;
  actorName: string;
  action: 'created' | 'updated' | 'deleted';
  changed: string[];
}

export interface CalendarDetailResponse {
  event: CalendarEventView;
  history: CalendarHistoryView[];
}

export interface CalendarYearlyResponse {
  year: number;
  items: { event: CalendarEventView; occurrence: string }[];
}

/** The error code of every calendar screen route when this server could not open the calendar file (503). */
export const CALENDAR_UNAVAILABLE = 'calendar_unavailable';

/** 'unbound': the person has no task identity; 'off': no Task service; 'unavailable': the Task service did not answer. */
export type UpcomingTasksState = 'ok' | 'unbound' | 'off' | 'unavailable';

export interface UpcomingItem {
  kind: 'event' | 'task';
  id: string;
  title: string;
  date: string;
  daysLeft: number;
  /** The kind of event, or "タスク" with the task's status. */
  label: string;
}

export interface UpcomingResponse {
  items: UpcomingItem[];
  tasks: UpcomingTasksState;
}

export interface SubscriptionResponse {
  /** The subscription is on in this server (SMM_CALENDAR_ICAL). When off, the screen hides the panel. */
  available: boolean;
  subscribed: boolean;
  createdAt: string | null;
  rotatedAt: string | null;
}

/** The address of a new secret subscription URL: a path to join to the address the screen was opened at. */
export interface SubscriptionIssued {
  path: string;
  createdAt: string;
  rotatedAt: string;
}

/** The reminder days a new event of a kind starts with (the form lets the person change them). */
export function defaultRemindDays(kind: CalendarKind): number[] {
  return kind === 'deadline' || kind === 'procedure' ? [14, 3] : [];
}

/** The reminder choices as the form shows them. */
export const REMIND_LABELS: Record<number, string> = { 14: '14日前', 7: '7日前', 3: '3日前', 1: '1日前', 0: '当日' };
