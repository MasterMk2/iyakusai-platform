import { addDays, isDateOnly } from './calendar.js';

// Notice board (掲示板, 2026-11-11): notices of the committee for its members. A notice has the people it is shown
// to (everyone, or the members of chosen departments) and the days it is on the board (Japan time). What a person
// has not opened yet is "new" and shows on the home screen. Nothing is deleted: a notice is withdrawn (and can be
// put back), and an ended one stays readable under 終了. Shared by the server (validation, who sees what) and the
// screens.

export const BULLETIN_STATUSES = ['open', 'withdrawn'] as const;
export type BulletinStatus = (typeof BULLETIN_STATUSES)[number];

/** Where a notice stands on a given day: not yet shown, on the board, past its last day, or taken back. */
export const BULLETIN_PHASES = ['scheduled', 'current', 'ended', 'withdrawn'] as const;
export type BulletinPhase = (typeof BULLETIN_PHASES)[number];
export const BULLETIN_PHASE_LABELS: Record<BulletinPhase, string> = { scheduled: '掲載前', current: '掲載中', ended: '掲載終了', withdrawn: '取り下げ' };

/** The three lists of the board. `ended` carries the withdrawn notices too (for the people who may put them back). */
export const BULLETIN_LISTS = ['current', 'scheduled', 'ended'] as const;
export type BulletinList = (typeof BULLETIN_LISTS)[number];
export const BULLETIN_LIST_LABELS: Record<BulletinList, string> = { current: '掲載中', scheduled: 'これから', ended: '終了' };

export const BULLETIN_LIMITS = {
  title: 80,
  body: 4000,
  departments: 12,
  department: 40,
  pageSizeMax: 50,
  /** New notices listed on the home screen. */
  homeItems: 5,
  /** Letters of the body shown in a list row. */
  excerpt: 90,
} as const;

/** The last day a new notice is offered with: two weeks from today. */
export const BULLETIN_DEFAULT_DAYS = 14;

export const BULLETIN_ID = /^bb_[0-9a-f]{16}$/;
/** Token from the form: a retried save returns the notice the first one made (no duplicates). */
export const BULLETIN_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

// The board's addresses inside the app: the list, one notice (`p=`), the form (`new=1`).
export const BOARD_HREF = '#/board';
export const BOARD_NEW_HREF = '#/board?new=1';
export const boardPostHref = (id: string) => `#/board?p=${encodeURIComponent(id)}`;

/** What the query of `#/board` names. Anything that is not a notice's ID is dropped (never sent to the server). */
export function parseBoardQuery(params: URLSearchParams): { postId: string | null; creating: boolean } {
  const p = params.get('p');
  const postId = p !== null && BULLETIN_ID.test(p) ? p : null;
  return { postId, creating: postId === null && params.get('new') === '1' };
}

export function boardHash(route: { postId: string | null; creating: boolean }): string {
  return route.postId ? boardPostHref(route.postId) : route.creating ? BOARD_NEW_HREF : BOARD_HREF;
}

/** What the form sends for a new notice or a correction. */
export interface BulletinInput {
  title: string;
  /** Plain text; line breaks are kept. May be empty (a notice that is all in its title). */
  body: string;
  /** Shown first on the board and marked on the home screen. */
  important: boolean;
  /** Department names (from the members' roles) the notice is for. Empty: every committee member. */
  departments: string[];
  /** The first day on the board, YYYY-MM-DD (Japan time), or null: from the moment it is saved. */
  startsOn: string | null;
  /** The last day on the board (included), or null: no end. */
  endsOn: string | null;
}

export const BULLETIN_FIELD_KEYS = ['title', 'body', 'important', 'departments', 'startsOn', 'endsOn'] as const;

export function bulletinPhase(post: { status: BulletinStatus; startsOn: string | null; endsOn: string | null }, today: string): BulletinPhase {
  if (post.status === 'withdrawn') return 'withdrawn';
  if (post.startsOn !== null && today < post.startsOn) return 'scheduled';
  if (post.endsOn !== null && today > post.endsOn) return 'ended';
  return 'current';
}

/** The notice is for this person: for everyone, or for one of the person's departments. */
export function bulletinTargets(departments: readonly string[], mine: readonly string[]): boolean {
  return departments.length === 0 || departments.some((d) => mine.includes(d));
}

/** Why the days are not acceptable, or null. `today` is given for a new notice (its last day cannot be in the past). */
export function bulletinPeriodProblem(startsOn: string | null, endsOn: string | null, today: string | null): string | null {
  if (startsOn !== null && !isDateOnly(startsOn)) return '掲載開始日は 2026-11-20 のように、実在する日で入れてください。';
  if (endsOn !== null && !isDateOnly(endsOn)) return '掲載期限は 2026-11-20 のように、実在する日で入れてください。';
  if (startsOn !== null && endsOn !== null && endsOn < startsOn) return '掲載期限は、掲載開始日と同じか、それより後にしてください。';
  if (today !== null && endsOn !== null && endsOn < today) return '掲載期限が今日より前です。今日か、それより後の日にしてください。';
  return null;
}

export function defaultBulletinEndsOn(today: string): string {
  return addDays(today, BULLETIN_DEFAULT_DAYS);
}

/** 対象 in words: 全員, or the departments joined. */
export function bulletinAudienceLabel(departments: readonly string[]): string {
  return departments.length === 0 ? '全員' : departments.join('・');
}

/** 掲載期間 in words, e.g. `11/20 まで`, `11/15 から 11/20 まで`, `期限なし`. */
export function bulletinPeriodLabel(startsOn: string | null, endsOn: string | null): string {
  const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  const from = startsOn ? `${md(startsOn)} から` : '';
  const to = endsOn ? `${md(endsOn)} まで` : '期限なし';
  return from ? `${from} ${to}` : to;
}

/** The start of the body on one line, for a list row. */
export function bulletinExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > BULLETIN_LIMITS.excerpt ? `${flat.slice(0, BULLETIN_LIMITS.excerpt)}…` : flat;
}

export interface BulletinListItem {
  id: string;
  title: string;
  excerpt: string;
  important: boolean;
  departments: string[];
  startsOn: string | null;
  endsOn: string | null;
  phase: BulletinPhase;
  /** On the board, for this person, and not opened since it was last announced. */
  unread: boolean;
  /** When it was posted, or announced again after a correction (UTC). New notices are ordered by this. */
  announcedAt: string;
  authorName: string;
}

export interface BulletinView extends BulletinInput {
  id: string;
  status: BulletinStatus;
  phase: BulletinPhase;
  unread: boolean;
  /** For this person (false: shown because they wrote it or administer access). */
  targeted: boolean;
  createdAt: string;
  authorName: string;
  updatedAt: string;
  updatedByName: string;
  /** The text or the settings were corrected after it was posted. */
  edited: boolean;
  announcedAt: string;
  version: number;
  /** This person may correct, withdraw and put back (the writer and the access administrators). */
  canEdit: boolean;
  /** For those who may edit: how many of the people it is for have opened it since it was last announced. */
  readers: { read: number; audience: number } | null;
}

export interface BulletinListResponse {
  list: BulletinList;
  items: BulletinListItem[];
  total: number;
  page: number;
  pageSize: number;
  /** New notices on the board for this person (whatever list is shown). */
  unreadTotal: number;
  /** Today in Japan time (YYYY-MM-DD). */
  today: string;
}

export interface BulletinDetailResponse {
  post: BulletinView;
  /** True when a save was answered from an earlier one with the same token (nothing new was stored). */
  replayed?: boolean;
}

/** GET /api/bulletin/summary: the home screen's part. */
export interface BulletinSummaryResponse {
  unreadTotal: number;
  /** The new notices, 重要 first, then the newest (at most BULLETIN_LIMITS.homeItems). */
  items: BulletinListItem[];
}

export interface BulletinMetaResponse {
  /** The board is on for this server and the signed-in person is a committee member. */
  enabled: boolean;
  canPost: boolean;
  /** Department names offered as 表示対象 (from the members' roles, in the organisation's order). */
  departments: string[];
  myDepartments: string[];
  today: string;
}

export interface BulletinReadResponse {
  unreadTotal: number;
}

/**
 * The order of the board's list: 重要 first, then the newest announcement. Ended and withdrawn notices are ordered
 * by the caller (by the day they left the board).
 */
export function sortBulletinCurrent<T extends Pick<BulletinListItem, 'important' | 'announcedAt' | 'id'>>(items: T[]): T[] {
  return [...items].sort((a, b) => Number(b.important) - Number(a.important) || b.announcedAt.localeCompare(a.announcedAt) || b.id.localeCompare(a.id));
}
