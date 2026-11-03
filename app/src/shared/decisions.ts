// Decision register (2026-11-03): what the committee decided, when and where, from which source, and how a later
// decision replaced it. Shared by the server (validation, the Bot's view) and the screens. The labels are the words
// the screens show; the department keys are the Task service's keys (the same shape as a task's department tags).

export const DECISION_STATUSES = ['active', 'changed', 'revoked'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];
export const DECISION_STATUS_LABELS: Record<DecisionStatus, string> = { active: '有効', changed: '変更された', revoked: '取り消し' };

export const DECISION_VENUES = ['board', 'regular', 'subcommittee', 'mail', 'other'] as const;
export type DecisionVenue = (typeof DECISION_VENUES)[number];
export const DECISION_VENUE_LABELS: Record<DecisionVenue, string> = { board: '役員会', regular: '定例ミーティング', subcommittee: '部会', mail: 'メール', other: 'その他' };

export const DECISION_SOURCE_KINDS = ['minutes', 'mail', 'line', 'discord', 'manual'] as const;
export type DecisionSourceKind = (typeof DECISION_SOURCE_KINDS)[number];
export const DECISION_SOURCE_LABELS: Record<DecisionSourceKind, string> = { minutes: '議事録', mail: 'メール', line: '公式LINE', discord: 'Discord', manual: '手入力' };

export const DECISION_ACTIONS = ['created', 'updated', 'replaced', 'revoked', 'restored', 'reactivated'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];
export const DECISION_ACTION_LABELS: Record<DecisionAction, string> = {
  created: '登録',
  updated: '内容を直した',
  replaced: '新しい決定に置き換えられた',
  revoked: '取り消した',
  restored: '取り消しを戻した',
  reactivated: '有効に戻した（後の決定の取り消しに伴う）',
};

/** Upper limits. Bodies are short on purpose: the Bot's answer carries every body (the view's `body`). */
export const DECISION_LIMITS = {
  title: 100,
  body: 2000,
  departments: 10,
  sources: 5,
  sourceRef: 80,
  sourceLabel: 120,
  sourceLink: 300,
  venueOther: 40,
  taskIds: 20,
  taskId: 40,
  note: 200,
  pageSizeMax: 100,
  /** Items in the Bot's answer (newest changes first). */
  botItems: 100,
} as const;

export const DECISION_DEPARTMENT_KEY = /^[a-z]{2,16}$/;
export const DECISION_TASK_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** An in-app link only: a hash path of this app (e.g. `#/all?thread=th_…`). Never an outside address. */
export const DECISION_APP_LINK = /^#\/[A-Za-z0-9_\-/%.=&?]{1,299}$/;
export const DECISION_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Token from the client: makes a retried registration return the first one (no duplicates). */
export const DECISION_CLIENT_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export interface DecisionSource {
  kind: DecisionSourceKind;
  refId: string | null;
  label: string;
  /** An in-app hash link (DECISION_APP_LINK), or null. */
  link: string | null;
}

/** What the form sends (and what a change or an edit replaces the fields with). */
export interface DecisionInput {
  title: string;
  body: string;
  /** Department keys (the Task service's keys), at least one. */
  departments: string[];
  /** The day it was decided, YYYY-MM-DD (Japan time). */
  decidedOn: string;
  venue: DecisionVenue;
  /** Filled only when the venue is `other`. */
  venueOther: string;
  sources: DecisionSource[];
  /** Task IDs this decision bears on (the Task service's IDs). */
  taskIds: string[];
}

export interface DecisionView extends DecisionInput {
  id: string;
  status: DecisionStatus;
  /** The decision this one replaces (it is a change of that one), or null. */
  supersedes: string | null;
  /** The decision that replaced this one, or null. */
  supersededBy: string | null;
  /** What changed, in one line (on the decision that replaced another). */
  changeNote: string;
  /** Why it was revoked (filled while revoked). */
  revokeNote: string;
  version: number;
  createdAt: string;
  createdByName: string;
  updatedAt: string;
  updatedByName: string;
  /** Only an active decision can be edited or changed. */
  editable: boolean;
  /** The registrant and the access administrators may revoke, and restore a revoked decision. */
  canRevoke: boolean;
}

export interface DecisionListItem {
  id: string;
  title: string;
  departments: string[];
  decidedOn: string;
  venue: DecisionVenue;
  status: DecisionStatus;
  supersedes: string | null;
  supersededBy: string | null;
  /** The last change of the record (registration, edit, replacement, revoke or restore), UTC. */
  changedAt: string;
}

export interface DecisionListResponse {
  items: DecisionListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** One step of the chain a decision belongs to (oldest first). */
export interface DecisionRef {
  id: string;
  title: string;
  status: DecisionStatus;
  decidedOn: string;
  changeNote: string;
}

export interface DecisionHistoryEntry {
  at: string;
  actorName: string;
  action: DecisionAction;
  /** The fields that changed (keys of the input), for an update. */
  changed: string[];
}

export interface DecisionDetailResponse {
  decision: DecisionView;
  chain: DecisionRef[];
  history: DecisionHistoryEntry[];
  /** True when a registration was answered from an earlier one with the same token (nothing new was stored). */
  replayed?: boolean;
}

export interface DecisionMetaResponse {
  /** The ledger is on for this server and the signed-in person is a committee member. */
  enabled: boolean;
  canRegister: boolean;
  canAdminister: boolean;
  /** Department keys already used by the decisions (offered next to the Task service's departments). */
  departments: string[];
}

/** The answer of registering decision items of a confirmed meeting: per item, the decision it is (made now or before). */
export interface MinutesRegisterResponse {
  results: { index: number; decisionId: string; replayed: boolean }[];
}

/** The field names that a history entry may list as changed. */
export const DECISION_FIELD_KEYS = ['title', 'body', 'departments', 'decidedOn', 'venue', 'venueOther', 'sources', 'taskIds'] as const;

/** True for a real calendar day written as YYYY-MM-DD (no rollover such as 2026-02-30). */
export function isDecisionDate(text: string): boolean {
  if (!DECISION_DATE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
