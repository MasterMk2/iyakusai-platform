// サーバーとブラウザで共有する型。保存形式と API 応答の両方の基準になる。

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ROLES = ['viewer', 'editor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const REQUIREMENT_FIELDS = ['purpose', 'deliverable', 'completionCriteria', 'openQuestions'] as const;
export type RequirementField = (typeof REQUIREMENT_FIELDS)[number];
export type Requirements = Record<RequirementField, string>;

export const TASK_FIELDS = ['title', 'description', 'assigneeId', 'deadline', 'status', ...REQUIREMENT_FIELDS] as const;
export type TaskField = (typeof TASK_FIELDS)[number];

export const DEADLINE_FILTERS = ['overdue', 'set', 'none'] as const;
export type DeadlineFilter = (typeof DEADLINE_FILTERS)[number];

export type ChangeSource = 'web' | 'mock-bot' | 'discord' | 'system';

export interface Workspace {
  id: string;
  name: string;
  description: string;
}

export interface User {
  id: string;
  displayName: string;
  email: string;
  /** 模擬ログイン画面に出す説明。実在の人物ではない。 */
  personaNote: string;
}

export interface Membership {
  workspaceId: string;
  userId: string;
  role: Role;
  active: boolean;
}

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  assigneeId: string | null;
  /** 日付のみ（YYYY-MM-DD）。未設定は null。 */
  deadline: string | null;
  status: TaskStatus;
  requirements: Requirements;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface FieldChange {
  field: TaskField;
  before: string | null;
  after: string | null;
}

export type HistoryAction = 'created' | 'updated' | 'reopened';

export interface HistoryEntry {
  id: string;
  taskId: string;
  workspaceId: string;
  version: number;
  action: HistoryAction;
  actorId: string;
  at: string;
  source: ChangeSource;
  operationId: string | null;
  changes: FieldChange[];
}

export interface MembershipChange {
  field: 'role' | 'active';
  before: string;
  after: string;
}

export interface MembershipAuditEntry {
  id: string;
  workspaceId: string;
  targetUserId: string;
  actorId: string;
  at: string;
  changes: MembershipChange[];
}

/** 模擬 Bot のチャンネルと委員会の対応。実在の Discord 識別子ではない。 */
export interface MockBotChannel {
  channelId: string;
  workspaceId: string;
  name: string;
}

/** 模擬 Bot の外部アカウントと内部利用者の対応。 */
export interface MockBotAccount {
  externalUserId: string;
  userId: string;
}

// ---- API 応答 ----

export interface UserSummary {
  id: string;
  displayName: string;
  active: boolean;
}

export interface TaskView extends Task {
  assignee: UserSummary | null;
  overdue: boolean;
  missingRequirements: RequirementField[];
}

export interface HistoryView extends HistoryEntry {
  actorName: string;
  /** 担当者 ID の変更を表示名に置き換えたもの。 */
  displayChanges: FieldChange[];
}

export interface MemberView {
  userId: string;
  displayName: string;
  email: string;
  role: Role;
  active: boolean;
}

export interface MembershipAuditView extends MembershipAuditEntry {
  actorName: string;
  targetName: string;
}

export interface PersonaView {
  id: string;
  displayName: string;
  email: string;
  personaNote: string;
}

export interface MeResponse {
  user: PersonaView;
  memberships: Array<{ workspace: Workspace; role: Role }>;
}

export interface TaskMutationResponse {
  task: TaskView;
  replayed: boolean;
}

export interface MemberMutationResponse {
  member: MemberView;
  replayed: boolean;
}

export interface FaultSettings {
  failNextLoads: number;
  failNextSaves: number;
  delayMs: number;
}

export interface MockBotDirectory {
  channels: Array<MockBotChannel & { workspaceName: string }>;
  accounts: Array<MockBotAccount & { displayName: string }>;
}

export interface MockBotReply {
  ok: boolean;
  replayed: boolean;
  reply: string;
}

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'NO_CHANGE',
  'INVALID_TRANSITION',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'LOAD_FAILED',
  'SAVE_FAILED',
  'BAD_HOST',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Array<{ path: string; message: string }>;
    current?: TaskView;
  };
}
