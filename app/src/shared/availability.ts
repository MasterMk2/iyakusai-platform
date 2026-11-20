import { addDays, isDateOnly } from './calendar.js';

// Free/busy from members' own Google calendars (2026-11-20), to see who is busy when a task is assigned. A member
// shares a calendar with the committee's service account as "予定の表示（時間枠のみ、詳細は非表示）", so Google
// answers only the busy periods: no title, place or note ever reaches the app. The member chooses who may see them
// (everyone, chosen departments, chosen people) and how coarse they are (time ranges, or morning / afternoon / evening).
// Times are Japan time (UTC+9, no daylight saving).

export type AvailabilityDetail = 'blocks' | 'parts';
export const AVAILABILITY_DETAIL_LABELS: Record<AvailabilityDetail, string> = {
  parts: '午前・午後・夜のどこに予定があるかだけ',
  blocks: '予定のある時間帯（14:00–16:00 のように）',
};

/** Who may see a member's busy periods besides the member: everyone, members of these departments, these people. */
export interface AvailabilityAudience {
  everyone: boolean;
  departments: string[];
  people: string[];
}

export const AVAILABILITY_LIMITS = {
  calendarIdMax: 254,
  departmentsMax: 20,
  departmentMax: 40,
  peopleMax: 80,
  /** The most days one list may ask for (a month view is six weeks at most). */
  rangeDaysMax: 62,
} as const;

export type DayPart = 'am' | 'pm' | 'night';
/** The parts of a day in minutes from midnight (Japan time). The early hours count as the morning. */
export const DAY_PARTS: readonly { key: DayPart; label: string; from: number; to: number }[] = [
  { key: 'am', label: '午前', from: 0, to: 12 * 60 },
  { key: 'pm', label: '午後', from: 12 * 60, to: 18 * 60 },
  { key: 'night', label: '夜', from: 18 * 60, to: 24 * 60 },
];

/** A busy time range within one day: HH:MM to HH:MM (24:00 is the end of the day). */
export interface BusyBlock {
  start: string;
  end: string;
}

/** One day with something on it. Days without an entry are free, when the person's state is 'ok' or 'stale'. */
export interface AvailabilityDay {
  date: string;
  parts: DayPart[];
  /** Only when the owner shares time ranges. */
  blocks?: BusyBlock[];
}

/**
 * ok: read recently. stale: the last read is older than it should be (shown with its time). pending: not read yet.
 * not_shared: Google says the calendar is not shared with the committee's account (nothing is shown). error: Google
 * could not be read (nothing is shown). Only ok and stale say anything about free time.
 */
export type AvailabilityState = 'ok' | 'stale' | 'pending' | 'not_shared' | 'error';
export const AVAILABILITY_STATE_LABELS: Record<AvailabilityState, string> = {
  ok: '',
  stale: '少し前の情報です',
  pending: 'まだ読み込んでいません',
  not_shared: 'Google カレンダーの共有が外れています',
  error: 'Google から読み込めませんでした',
};

/** Whether the state carries busy periods (free days may be read as free). */
export const showsBusy = (state: AvailabilityState) => state === 'ok' || state === 'stale';

export interface AvailabilityPerson {
  userId: string;
  /** The person's ID in the Task service (what a task's assignee holds), or null without one. */
  taskUserId: string | null;
  displayName: string;
  self: boolean;
  detail: AvailabilityDetail;
  state: AvailabilityState;
  fetchedAt: string | null;
  days: AvailabilityDay[];
}

/** GET /api/availability?from&to: the people whose busy periods the signed-in member may see. */
export interface AvailabilityListResponse {
  enabled: boolean;
  from: string;
  to: string;
  /** The last day read from Google: later days are not known (not free). */
  coveredTo: string;
  people: AvailabilityPerson[];
}

export interface AvailabilityConnectionView {
  calendarId: string;
  audience: AvailabilityAudience;
  detail: AvailabilityDetail;
  connectedAt: string;
  updatedAt: string;
  state: AvailabilityState;
  fetchedAt: string | null;
}

/** The check that the calendar is the member's own: put an event at this time, then press 確かめる. */
export interface AvailabilityChallengeView {
  calendarId: string;
  date: string;
  start: string;
  end: string;
  createdAt: string;
}

/** GET /api/availability/me */
export interface AvailabilityMeResponse {
  enabled: boolean;
  /** The service account's address to share the calendar with. */
  serviceAccount: string | null;
  connection: AvailabilityConnectionView | null;
  challenge: AvailabilityChallengeView | null;
  choices: { departments: string[]; people: { id: string; displayName: string }[] };
  horizonDays: number;
  refreshMinutes: number;
}

export class AvailabilityValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A calendar's ID: the Gmail / Workspace address, or the ID of another calendar (…@group.calendar.google.com). */
const CALENDAR_ID = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const PERSON_ID = /^[A-Za-z0-9_:.-]{1,80}$/;

/** The calendar's ID as typed: trimmed and in lower case. */
export function normalizeCalendarId(value: unknown): string {
  if (typeof value !== 'string') throw new AvailabilityValidationError('calendarId', 'Google カレンダーの ID（Gmail のアドレスなど）を入れてください。');
  const id = value.normalize('NFKC').trim().toLowerCase();
  if (!id || id.length > AVAILABILITY_LIMITS.calendarIdMax || !CALENDAR_ID.test(id)) {
    throw new AvailabilityValidationError('calendarId', 'Google カレンダーの ID は、Gmail のアドレス（○○@gmail.com）か、カレンダーの設定の「カレンダー ID」を入れてください。');
  }
  return id;
}

export function validateAudience(value: unknown): AvailabilityAudience {
  const o = value as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some((k) => !['everyone', 'departments', 'people'].includes(k))) {
    throw new AvailabilityValidationError('audience', '見せる相手の形が正しくありません。');
  }
  if (typeof o.everyone !== 'boolean' || !Array.isArray(o.departments) || !Array.isArray(o.people)) throw new AvailabilityValidationError('audience', '見せる相手の形が正しくありません。');
  if (o.departments.length > AVAILABILITY_LIMITS.departmentsMax) throw new AvailabilityValidationError('audience', `部局は ${AVAILABILITY_LIMITS.departmentsMax} までにしてください。`);
  if (o.people.length > AVAILABILITY_LIMITS.peopleMax) throw new AvailabilityValidationError('audience', `人は ${AVAILABILITY_LIMITS.peopleMax} 人までにしてください。`);
  const departments = o.departments.map((d) => {
    if (typeof d !== 'string' || !d.trim() || d.length > AVAILABILITY_LIMITS.departmentMax || CONTROL.test(d)) throw new AvailabilityValidationError('audience', '部局の名前が正しくありません。');
    return d.trim();
  });
  const people = o.people.map((p) => {
    if (typeof p !== 'string' || !PERSON_ID.test(p)) throw new AvailabilityValidationError('audience', '人の指定が正しくありません。');
    return p;
  });
  return { everyone: o.everyone, departments: [...new Set(departments)], people: [...new Set(people)] };
}

export function validateDetail(value: unknown): AvailabilityDetail {
  if (value === 'blocks' || value === 'parts') return value;
  throw new AvailabilityValidationError('detail', '見せ方は「午前・午後・夜」か「時間帯」から選んでください。');
}

/** Whether a viewer may see an owner's busy periods (the owner always sees their own). */
export function audienceIncludes(audience: AvailabilityAudience, ownerId: string, viewer: { id: string; departments: string[] }): boolean {
  if (viewer.id === ownerId) return true;
  return audience.everyone || audience.people.includes(viewer.id) || audience.departments.some((d) => viewer.departments.includes(d));
}

const JST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

/** Midnight of a Japan date, as an instant (UTC ISO). */
export const jstMidnight = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - JST_OFFSET_MS).toISOString();

/**
 * Busy instants cut into Japan days within [from, to] (both dates included): per day, the merged ranges in minutes from
 * midnight. A range over midnight is split; one ending at midnight ends at 24:00 of the day before.
 */
export function busyMinutesByDay(intervals: readonly { start: number; end: number }[], from: string, to: string): Map<string, [number, number][]> {
  const lo = Date.parse(jstMidnight(from));
  const hi = Date.parse(jstMidnight(addDays(to, 1)));
  const out = new Map<string, [number, number][]>();
  for (const iv of intervals) {
    let s = Math.max(iv.start, lo);
    const e = Math.min(iv.end, hi);
    while (s < e) {
      const local = s + JST_OFFSET_MS;
      const dayStart = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
      const date = new Date(dayStart).toISOString().slice(0, 10);
      const dayEnd = dayStart - JST_OFFSET_MS + DAY_MS;
      const segEnd = Math.min(e, dayEnd);
      const a = Math.floor((local - dayStart) / 60_000);
      const b = Math.ceil((segEnd + JST_OFFSET_MS - dayStart) / 60_000);
      if (b > a) {
        const list = out.get(date) ?? [];
        list.push([a, Math.min(b, 1440)]);
        out.set(date, list);
      }
      s = segEnd;
    }
  }
  for (const [date, list] of out) {
    list.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const r of list) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    out.set(date, merged);
  }
  return out;
}

export const partsOf = (ranges: readonly [number, number][]): DayPart[] => DAY_PARTS.filter((p) => ranges.some(([a, b]) => a < p.to && b > p.from)).map((p) => p.key);

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The days of one person as the viewer may see them: parts only, or parts and time ranges. */
export function availabilityDays(byDay: Map<string, [number, number][]>, detail: AvailabilityDetail): AvailabilityDay[] {
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, ranges]) => ({ date, parts: partsOf(ranges), ...(detail === 'blocks' ? { blocks: ranges.map(([a, b]) => ({ start: hhmm(a), end: hhmm(b) })) } : {}) }));
}

/** One day in words: 終日, 14:00–16:00、19:00–21:00, or 午後・夜. */
export function describeDay(day: AvailabilityDay): string {
  if (day.blocks?.length === 1 && day.blocks[0]!.start === '00:00' && day.blocks[0]!.end === '24:00') return '終日';
  if (day.blocks && day.blocks.length > 0) return day.blocks.map((b) => `${b.start}–${b.end}`).join('、');
  if (day.parts.length === DAY_PARTS.length && !day.blocks) return '午前・午後・夜';
  return DAY_PARTS.filter((p) => day.parts.includes(p.key)).map((p) => p.label).join('・');
}

/** The dates from `from` to `to`, both included. */
export function datesBetween(from: string, to: string): string[] {
  if (!isDateOnly(from) || !isDateOnly(to) || from > to) return [];
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
