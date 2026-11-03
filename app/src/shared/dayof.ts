import { addDays, daysBetween, isDateOnly, jstDate } from './calendar.js';
import type { DecisionStatus } from './decisions.js';

// Festival-day board (当日の連絡板, 2026-11-03): the headquarters' notices, the decisions made on the spot (kept in
// the decision register), how decisions are made, today's events and the counts of lent items. Shown at the top of
// the home screen only on the days an access administrator chose (Japan time). Shared by the server (validation,
// the period) and the screens (the order of the notices, what changed since the last refresh).

export const DAYOF_PRIORITIES = ['urgent', 'important', 'normal'] as const;
export type DayOfPriority = (typeof DAYOF_PRIORITIES)[number];
export const DAYOF_PRIORITY_LABELS: Record<DayOfPriority, string> = { urgent: '至急', important: '重要', normal: '通常' };

export const DAYOF_POST_STATUSES = ['open', 'resolved', 'withdrawn'] as const;
export type DayOfPostStatus = (typeof DAYOF_POST_STATUSES)[number];

/** The place a decision recorded from the board is filed under in the register (its venue `other`). */
export const DAYOF_VENUE_NAME = '当日本部';

/** Shown to temporary staff instead of the poster's name (their screen does not need a member's real name). */
export const DAYOF_STAFF_AUTHOR = '本部';

export const DAYOF_LIMITS = {
  body: 300,
  bodyLines: 8,
  place: 40,
  departments: 5,
  department: 40,
  rules: 800,
  /** The longest festival period an administrator may set (days, both ends included). */
  periodDays: 14,
  /** Resolved and withdrawn notices of today shown on the board. */
  closedShown: 30,
  decisionsShown: 30,
  decisionPlace: 60,
} as const;

/** The home panel reads the board again this often while it is on screen and the period is on. */
export const DAYOF_POLL_MS = 30_000;

/**
 * Outside the period the panel still asks this often while it is on screen (the rental screen's IDLE_MS), so a home
 * screen left open from the day before shows 当日 soon after 00:00 JST or after an administrator saves the period.
 */
export const DAYOF_IDLE_POLL_MS = 300_000;

/** How long until the home panel reads the board again, or null to stop (a hidden page, or a board refused to this person). */
export function dayofPollDelay(state: { visible: boolean; refused: boolean; active: boolean }): number | null {
  if (!state.visible || state.refused) return null;
  return state.active ? DAYOF_POLL_MS : DAYOF_IDLE_POLL_MS;
}

export const DAYOF_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export interface DayOfPeriod {
  /** YYYY-MM-DD (Japan time), both ends included. */
  startDate: string;
  endDate: string;
}

/** The day of the period `today` is (1-based) and the number of days, or null outside the period. */
export function dayOfPeriodDay(today: string, period: DayOfPeriod | null): { index: number; total: number } | null {
  if (!period || !isDateOnly(today) || today < period.startDate || today > period.endDate) return null;
  return { index: daysBetween(period.startDate, today) + 1, total: daysBetween(period.startDate, period.endDate) + 1 };
}

/** The period is on at this moment: the Japan date of `now` is between its first and last day. */
export function isDayOfActive(now: Date, period: DayOfPeriod | null): boolean {
  return dayOfPeriodDay(jstDate(now), period) !== null;
}

/** The first moment of a Japan date, as a UTC ISO string (00:00 JST is 15:00 UTC of the day before). */
export function jstDayStartIso(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00+09:00`)).toISOString();
}

/** Why a period is not acceptable, or null. Both empty clears the period. */
export function periodProblem(startDate: string | null, endDate: string | null): string | null {
  if (startDate === null && endDate === null) return null;
  if (startDate === null || endDate === null) return '開始日と終了日の両方を入れてください（期間をやめるときは両方を空にします）。';
  if (!isDateOnly(startDate) || !isDateOnly(endDate)) return '日付は 2026-11-07 のように、実在する日で入れてください。';
  if (startDate > endDate) return '終了日は開始日と同じか、それより後にしてください。';
  if (addDays(startDate, DAYOF_LIMITS.periodDays - 1) < endDate) return `期間は ${DAYOF_LIMITS.periodDays} 日までです。`;
  return null;
}

export interface DayOfPostView {
  id: string;
  status: DayOfPostStatus;
  priority: DayOfPriority;
  body: string;
  /** Where it concerns (free text, one line), or ''. */
  place: string;
  /** Departments it concerns (names from the members' roles), possibly none. */
  departments: string[];
  /** Temporary staff see this notice too. */
  staffVisible: boolean;
  createdAt: string;
  /** The poster's name; DAYOF_STAFF_AUTHOR for temporary staff. */
  authorName: string;
  updatedAt: string;
  /** The text was corrected after it was posted. */
  edited: boolean;
  resolvedAt: string | null;
  resolvedByName: string | null;
  version: number;
  /** This person may correct and withdraw it (its poster or an access administrator, while a poster). */
  canEdit: boolean;
}

/** What a poster sends for a new notice or a correction. */
export interface DayOfPostInput {
  body: string;
  priority: DayOfPriority;
  place: string;
  departments: string[];
  staffVisible: boolean;
}

export interface DayOfDecisionItem {
  id: string;
  title: string;
  status: DecisionStatus;
  /** 決めた場: 当日本部 for the board's decisions, the register's label otherwise. */
  venueLabel: string;
  /** Department keys (the Task service's keys). */
  departments: string[];
  /** What changed, for a change of an earlier decision. */
  changeNote: string;
  supersedes: string | null;
  body: string;
  createdAt: string;
}

export interface DayOfEventItem {
  id: string;
  title: string;
  /** HH:MM, or null for all day. */
  time: string | null;
  kindLabel: string;
  departments: string[];
}

export interface DayOfSupplies {
  /** Cards (individual items) lent and not back. */
  cardsOut: number;
  /** Counted supplies lent and not back (units). */
  unitsOut: number;
  /** Groups with something still out. */
  groupsOpen: number;
}

export interface DayOfBoardResponse {
  active: boolean;
  /** Today in Japan time (YYYY-MM-DD). */
  today: string;
  period: DayOfPeriod | null;
  day: { index: number; total: number } | null;
  /** Counts up with every write to the board (notices, settings, posters). */
  revision: number;
  /** How decisions are made on the day (plain text, line breaks only), or ''. */
  rules: string;
  canPost: boolean;
  /** May record a decision on the spot (a committee member, the register on). */
  canDecide: boolean;
  /**
   * Open notices written since the period began (至急 first; an open one of an earlier period is not carried into
   * this one) and today's resolved ones, in the order shown (sortDayOfPosts).
   */
  posts: DayOfPostView[];
  /** Today's withdrawn notices, for the posters (they can put one back). */
  withdrawn: DayOfPostView[];
  /** Today's decisions (newest first), or null when the register is off. */
  decisions: DayOfDecisionItem[] | null;
  /** Today's events, or null when the calendar cannot be read. */
  events: DayOfEventItem[] | null;
  /** Null when this person has no rental permission or rental is off. */
  supplies: DayOfSupplies | null;
  /** Department names offered in the notice form (from the members' roles). */
  departmentChoices: string[];
  /** Department keys the register already uses (offered next to the Task service's departments). */
  decisionDepartments: string[];
  generatedAt: string;
}

/** GET /api/dayof/notices: the notices alone, for the rental screen (temporary staff see those marked for them). */
export interface DayOfNoticesResponse {
  active: boolean;
  today: string;
  day: { index: number; total: number } | null;
  revision: number;
  staff: boolean;
  posts: DayOfPostView[];
}

export interface DayOfAdminResponse {
  settings: { startDate: string | null; endDate: string | null; rules: string; version: number; updatedAt: string | null; updatedByName: string | null };
  /** Who may post besides the access administrators. */
  posters: { users: string[]; departments: string[] };
  people: { id: string; displayName: string; roleLabel: string; canManageAccess: boolean }[];
  /** Departments that can be chosen (those of the listed people, temporary staff left out). */
  departments: string[];
  history: { at: string; actorName: string; action: string; detail: string }[];
  today: string;
}

const RANK: Record<DayOfPriority, number> = { urgent: 0, important: 1, normal: 2 };

/**
 * The order on the board: open 至急 notices pinned first, then the other open ones, newest first (重要 and 通常 are
 * not reordered: the time matters more than the level), then the resolved ones, latest resolved first. Withdrawn
 * notices are left out.
 */
export function sortDayOfPosts<T extends Pick<DayOfPostView, 'status' | 'priority' | 'createdAt' | 'resolvedAt' | 'id'>>(posts: T[]): T[] {
  const group = (p: T) => (p.status === 'open' ? (p.priority === 'urgent' ? 0 : 1) : 2);
  return posts
    .filter((p) => p.status !== 'withdrawn')
    .sort((a, b) => {
      const g = group(a) - group(b);
      if (g !== 0) return g;
      if (a.status === 'resolved') return (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '') || b.id.localeCompare(a.id);
      return b.createdAt.localeCompare(a.createdAt) || RANK[a.priority] - RANK[b.priority] || b.id.localeCompare(a.id);
    });
}

/**
 * What became of a notice while someone was correcting it, against the version they began from. `changed`: someone
 * else corrected it (or resolved and reopened it) and it is still open, so saving would overwrite that. `closed`: it was
 * resolved or withdrawn meanwhile, or is no longer on the board, so it cannot be corrected now.
 */
export type DayOfEditDrift =
  | { kind: 'none' }
  | { kind: 'changed'; latest: DayOfPostView }
  | { kind: 'closed'; status: 'resolved' | 'withdrawn' | 'gone' };

export function dayofEditDrift(baseVersion: number, latest: DayOfPostView | null): DayOfEditDrift {
  if (!latest) return { kind: 'closed', status: 'gone' };
  if (latest.status !== 'open') return { kind: 'closed', status: latest.status };
  if (latest.version !== baseVersion) return { kind: 'changed', latest };
  return { kind: 'none' };
}

/** A notice as the board now has it (open, resolved or, for the posters, withdrawn), or null. */
export function findDayOfPost(board: Pick<DayOfBoardResponse, 'posts' | 'withdrawn'>, id: string): DayOfPostView | null {
  return board.posts.find((p) => p.id === id) ?? board.withdrawn.find((p) => p.id === id) ?? null;
}

export interface DayOfDiff {
  /** Open 至急 notices that are new since the last refresh, or became 至急 since then. */
  newUrgent: string[];
  /** Notices that were not on the board before. */
  added: string[];
  /** Notices on both whose version moved (corrected, resolved, reopened). */
  changed: string[];
  /** Notices that left the board (withdrawn, or resolved on an earlier day). */
  removed: string[];
}

/**
 * What changed between two refreshes of the board. The first load (no previous list) reports nothing: everything on
 * screen then is what the person sees for the first time anyway, and flagging all of it would mean nothing.
 */
export function diffDayOfPosts(prev: Pick<DayOfPostView, 'id' | 'version' | 'priority' | 'status'>[] | null, next: Pick<DayOfPostView, 'id' | 'version' | 'priority' | 'status'>[]): DayOfDiff {
  const out: DayOfDiff = { newUrgent: [], added: [], changed: [], removed: [] };
  if (prev === null) return out;
  const before = new Map(prev.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const p of next) {
    seen.add(p.id);
    const old = before.get(p.id);
    const urgentNow = p.status === 'open' && p.priority === 'urgent';
    if (!old) {
      out.added.push(p.id);
      if (urgentNow) out.newUrgent.push(p.id);
      continue;
    }
    if (old.version !== p.version) {
      out.changed.push(p.id);
      if (urgentNow && !(old.status === 'open' && old.priority === 'urgent')) out.newUrgent.push(p.id);
    }
  }
  for (const p of prev) if (!seen.has(p.id)) out.removed.push(p.id);
  return out;
}
