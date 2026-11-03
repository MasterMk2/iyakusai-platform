import { shiftYears } from './calendar.js';
import type { OrgKind } from './organizations.js';

// Year rollover (年度の切り替え, 2026-11-04): what the access administrators do once a year when the officers change.
// Five steps, each on its own: copy the organizations to the next year, copy the yearly schedule, list the open
// tasks, take stock of the grants, and write the handover draft. Every step shows a preview before it is confirmed.
//
// 年度: the festival year, as the organizations hold it (2026 is the 2026 festival). In the calendar, year N is the
// calendar year N (January to December), which is how the calendar already picks a year.

export const ROLLOVER_STEPS = ['organizations', 'calendar', 'tasks', 'grants', 'handover'] as const;
export type RolloverStep = (typeof ROLLOVER_STEPS)[number];

export const ROLLOVER_STEP_LABELS: Record<RolloverStep, string> = {
  organizations: '団体の台帳を次の年度に写す',
  calendar: '毎年の予定を次の年度に写す',
  tasks: '未完了のタスクを一覧にする',
  grants: '権限の棚卸し',
  handover: '引き継ぎの資料を書き出す',
};

/** Steps that write the next year's data: a completed run for the same target year stops a second one. */
export const ONCE_PER_YEAR_STEPS: readonly RolloverStep[] = ['organizations', 'calendar'];

export const ROLLOVER_LIMITS = {
  yearMin: 2000,
  yearMax: 2099,
  /** Organizations or events in one run (a year of the committee has far fewer). */
  itemsMax: 2000,
  /** Grants removed in one run. */
  grantsMax: 300,
} as const;

/** The first and last day of year N in the calendar (年度 N = calendar year N). */
export function yearWindow(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/**
 * The year a rollover most likely starts from on `today` (YYYY-MM-DD): the festival of this calendar year from April
 * on, else last year's (the officers change between the festival in autumn and the new year's work in spring).
 * Only the starting choice of the screen; the administrator can pick another year.
 */
export function defaultSourceYear(today: string): number {
  const year = Number(today.slice(0, 4));
  return Number(today.slice(5, 7)) >= 4 ? year : year - 1;
}

export type DateRule = 'same-date' | 'same-weekday';

export const DATE_RULE_LABELS: Record<DateRule, string> = {
  'same-date': '同じ月日',
  'same-weekday': '同じ週・同じ曜日',
};

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** Which weekday of its month a date is: 2026-11-14 is the 2nd Saturday (n 2, weekday 6). */
export function weekdayOfMonth(date: string): { n: number; weekday: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { n: Math.ceil(d / 7), weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** "第2土曜日" for a date. */
export function weekdayOfMonthLabel(date: string): string {
  const { n, weekday } = weekdayOfMonth(date);
  return `第${n}${WEEKDAYS[weekday]}曜日`;
}

/**
 * The same weekday of the same week of the month in `year`: the 2nd Saturday of November stays the 2nd Saturday of
 * November. A 5th weekday that the target month does not have becomes the last one (the 4th).
 */
export function sameWeekdayInYear(date: string, year: number): string {
  const month = Number(date.slice(5, 7));
  const { n, weekday } = weekdayOfMonth(date);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let day = 1 + ((weekday - firstWeekday + 7) % 7) + 7 * (n - 1);
  if (day > lastDay) day -= 7;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Where a yearly event of year `from` goes in year `to` by the chosen rule (2/29 becomes 2/28 by the same date rule). */
export function shiftByRule(date: string, to: number, rule: DateRule): string {
  return rule === 'same-weekday' ? sameWeekdayInYear(date, to) : shiftYears(date, to - Number(date.slice(0, 4)));
}

/**
 * The first line of the memo of a copied event. It stays until someone who checked the date deletes it; the calendar
 * shows 「日付を確かめる」 while it is there (a version number could not tell a checked date from an unchecked one).
 */
export const DATE_CHECK_MARK = '【前年から写した・日付を確かめる】';

/** The copied event still waits for its date to be checked. */
export function needsDateCheck(event: { copiedFrom: string | null; memo: string }): boolean {
  return event.copiedFrom !== null && event.memo.startsWith(DATE_CHECK_MARK);
}

// ---- what the API answers

export interface RolloverRunView {
  id: string;
  step: RolloverStep;
  sourceYear: number;
  targetYear: number;
  status: 'running' | 'done' | 'undone';
  actorName: string;
  startedAt: string;
  finishedAt: string | null;
  /** What was done, in words for the screen (e.g. 「団体 12 件を写した」). */
  summary: string;
  counts: Record<string, number>;
  undoneAt: string | null;
  undoneByName: string | null;
  /** A copy still "running" ten minutes after it started: it was cut off. The next confirm takes it over. */
  stale: boolean;
  /** The run can be taken back (copies only: completed, or cut off half way). */
  canUndo: boolean;
}

export interface RolloverStepState {
  step: RolloverStep;
  label: string;
  /** False when this server has no data for the step (no organizations file, no tasks, ...). */
  available: boolean;
  /** Why the step cannot be used here, for the screen. */
  reason: string | null;
  /** The last run of this step for the chosen year, or null. */
  last: RolloverRunView | null;
}

export interface RolloverMetaResponse {
  sourceYear: number;
  targetYear: number;
  /** Years the screen offers as the source (those with organizations or events, and the default one). */
  years: number[];
  steps: RolloverStepState[];
  runs: RolloverRunView[];
}

// Step 1: organizations

export interface OrgSelection {
  kind: OrgKind;
  /** The statuses to copy; empty selects none of this kind. */
  statuses: string[];
}

export interface OrgPreviewRequest {
  sourceYear: number;
  selection: OrgSelection[];
  /** Organizations left out by hand after the first preview. */
  excludeIds: string[];
}

export interface OrgPlanItem {
  sourceId: string;
  name: string;
  kind: OrgKind;
  kindLabel: string;
  fromStatus: string;
  toStatus: string;
  amountYen: number | null;
  content: string;
  department: string;
  hasContact: boolean;
  action: 'copy' | 'skip' | 'excluded';
  reason: string | null;
}

export interface OrgChoiceKind {
  kind: OrgKind;
  label: string;
  /** Count of each status in the source year (the stages first, in order, for sponsors and exhibitors). */
  statuses: { status: string; count: number }[];
}

export interface OrgPreviewResponse {
  sourceYear: number;
  targetYear: number;
  choices: OrgChoiceKind[];
  items: OrgPlanItem[];
  counts: { copy: number; skip: number; excluded: number };
  planToken: string;
  /** A completed run for the same year: confirming is refused while it stands. */
  done: RolloverRunView | null;
}

export interface OrgApplyRequest extends OrgPreviewRequest {
  planToken: string;
}

// Step 2: yearly schedule

export interface CalendarPreviewRequest {
  sourceYear: number;
  /** Events copied by 同じ週・同じ曜日 (the others keep the month and day). */
  weekdayIds: string[];
  /** Events not to copy. */
  skipIds: string[];
}

export interface CalendarPlanItem {
  eventId: string;
  title: string;
  kindLabel: string;
  departments: string[];
  fromDate: string;
  toDate: string;
  rule: DateRule;
  /** The same weekday rule, as words for the choice (第2土曜日). */
  weekdayLabel: string;
  action: 'copy' | 'skip' | 'excluded';
  reason: string | null;
  notes: string[];
}

export interface CalendarPreviewResponse {
  sourceYear: number;
  targetYear: number;
  items: CalendarPlanItem[];
  counts: { copy: number; skip: number; excluded: number };
  planToken: string;
  done: RolloverRunView | null;
}

export interface CalendarApplyRequest extends CalendarPreviewRequest {
  planToken: string;
}

// Step 1 and 2: the answer of a confirm and of an undo

export interface RolloverApplyResponse {
  run: RolloverRunView;
  /** Names of what was made (organizations or events). */
  made: string[];
  skipped: { name: string; reason: string }[];
}

export interface RolloverUndoResponse {
  run: RolloverRunView;
  /** What was taken back. */
  removed: string[];
  /** What was kept, and why (changed since the copy). */
  kept: { name: string; reason: string }[];
}

// Step 3: open tasks

export type RolloverTasksState = 'ok' | 'off' | 'unbound' | 'unavailable';

export interface RolloverTaskRow {
  id: string;
  number: string;
  title: string;
  status: string;
  assignee: string;
  deadline: string | null;
  overdue: boolean;
}

export interface RolloverTaskGroup {
  key: string;
  label: string;
  tasks: RolloverTaskRow[];
}

export interface RolloverTasksResponse {
  state: RolloverTasksState;
  message: string | null;
  /** Open tasks, each counted once (a task with two departments is in both groups). */
  total: number;
  groups: RolloverTaskGroup[];
}

// Step 4: grants

/**
 * How a holder stands by the stored accounts and the roster (nothing asks Discord here). Under the Discord login,
 * membership is confirmed by the Bot host whenever the person signs in or uses the app, so an account left alone
 * since someone left the server is still active: it shows as "stale" once that confirmation is old.
 */
export type HolderStatus = 'active' | 'stale' | 'pending' | 'left' | 'inactive' | 'unknown' | 'no_account';

export const HOLDER_STATUS_LABELS: Record<HolderStatus, string> = {
  active: '在籍',
  stale: 'しばらく在籍を確かめていない（保存されたアカウントは有効のまま。抜けた人かもしれません）',
  pending: '登録・パスワードの再設定の途中（まだログインできません）',
  left: 'Discord のサーバーを抜けた（保存されたアカウントは無効）',
  inactive: 'アカウントが無効（ログインできません）',
  unknown: '委員の名簿に名前がない',
  no_account: 'このアプリのアカウントが見つからない',
};

/** Statuses worth a look before the grants stay another year. Someone registering now (pending) is not one. */
export const HOLDER_ATTENTION: Record<HolderStatus, boolean> = { active: false, stale: true, pending: false, left: true, inactive: true, unknown: true, no_account: true };

/** Days since membership was last confirmed after which an active account shows as "stale" (longer than a session). */
export const MEMBER_STALE_DAYS = 30;

export interface GrantItemView {
  key: string;
  sourceLabel: string;
  target: string;
  permission: string;
  removable: boolean;
  /** Why it cannot be removed here (e.g. 権限の管理者 comes from the Discord roles). */
  reason: string | null;
}

export interface GrantHolderView {
  kind: 'person' | 'department';
  /** The person's ID, or the department name. */
  id: string;
  name: string;
  roleLabel: string;
  status: HolderStatus;
  /** A clue for the screen: when membership was last confirmed, or the student ID of someone with no roster name. */
  detail: string | null;
  /** For a department: how many members it has now (0 is worth a look). */
  members: number | null;
  /** True when the holder should be looked at (left, stale, unknown, an empty department). */
  attention: boolean;
  grants: GrantItemView[];
}

export interface GrantsResponse {
  holders: GrantHolderView[];
  /** The permission stores read here (メールの受信箱, 公式LINE, 物品貸出, 権限の管理者). */
  sources: string[];
  /** Permissions this app does not hold, said once on the screen. */
  notes: string[];
  counts: { holders: number; attention: number; grants: number };
}

export interface GrantPreviewRequest {
  sourceYear: number;
  keys: string[];
}

export interface GrantPlanItem {
  key: string;
  holderName: string;
  sourceLabel: string;
  target: string;
  permission: string;
  action: 'remove' | 'gone' | 'kept';
  reason: string | null;
}

export interface GrantPreviewResponse {
  items: GrantPlanItem[];
  counts: { remove: number; gone: number; kept: number };
  planToken: string;
}

export interface GrantApplyRequest extends GrantPreviewRequest {
  planToken: string;
  /** The screen's ID for this confirm: the same ID sent twice is refused, showing the first run. */
  requestId: string;
}

export interface GrantApplyResponse {
  run: RolloverRunView;
  removed: GrantPlanItem[];
  failed: { item: GrantPlanItem; message: string }[];
}

// Step 5: handover

export interface HandoverSummary {
  sourceYear: number;
  counts: { decisions: number; organizations: number; events: number; openTasks: number | null };
  /** The Markdown as it will be downloaded (the preview). */
  markdown: string;
  /** Parts that could not be read, said in the document too. */
  missing: string[];
}
