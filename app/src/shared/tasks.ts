// Task contract as seen by the common Web entry. The Task service owns the data;
// these types mirror its integration API (discord-task-manager, /api/integration/v1)
// plus the gateway's own provenance and case-link views.

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '未着手',
  in_progress: '進行中',
  blocked: '保留',
  done: '完了',
};

export type TaskRole = 'viewer' | 'editor' | 'admin';
export const TASK_ROLE_LABELS: Record<TaskRole, string> = { viewer: '閲覧者', editor: '編集者', admin: '管理者' };

export const REQUIREMENT_FIELDS = ['purpose', 'deliverable', 'completionCriteria', 'openQuestions'] as const;
export type RequirementField = (typeof REQUIREMENT_FIELDS)[number];
export type Requirements = Record<RequirementField, string>;

export const REQUIREMENT_LABELS: Record<RequirementField, string> = {
  purpose: '目的',
  deliverable: '成果物',
  completionCriteria: '完了条件',
  openQuestions: '不明点',
};

export const TASK_FIELD_LABELS: Record<string, string> = {
  title: 'タイトル',
  description: '説明',
  assigneeId: '担当者',
  helperIds: '副担当',
  deadline: '期限',
  status: '状態',
  tags: '部局',
  parentId: '親タスク',
  ...REQUIREMENT_LABELS,
};

/**
 * Department tags (2026-10-14). The Bot-host Task API files tasks under departments instead of
 * channels: its workspaces are the departments (`dept-<key>`) and a task carries one or more
 * department keys in `tags`. Other Task services (the in-process one) have no tags.
 */
export const DEPARTMENT_WORKSPACE_PREFIX = 'dept-';
export const departmentKey = (workspaceId: string): string | null =>
  workspaceId.startsWith(DEPARTMENT_WORKSPACE_PREFIX) ? workspaceId.slice(DEPARTMENT_WORKSPACE_PREFIX.length) : null;
export interface Department {
  key: string;
  label: string;
  /** The department a section (課) belongs to; null for a top-level one. Absent from an older Task API. */
  parent?: string | null;
}

export const TASK_SOURCE_LABELS: Record<string, string> = {
  web: 'Web',
  'mock-bot': '模擬Bot',
  discord: 'Discord',
  system: 'サンプル初期化',
};

export const TASK_LIMITS = { titleMax: 120, textMax: 2000, tagsMax: 5, helpersMax: 10 } as const;

export interface TaskWorkspace {
  id: string;
  name: string;
  description: string;
  /** Department tags (2026-10-25): the department workspace a section belongs to, null for a department. */
  parentId?: string | null;
}

export interface TaskView {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  assigneeId: string | null;
  deadline: string | null;
  status: TaskStatus;
  requirements: Requirements;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  assignee: { id: string; displayName: string; active: boolean } | null;
  overdue: boolean;
  missingRequirements: RequirementField[];
  /** Department keys (only from a Task service with department tags). */
  tags?: string[];
  tagLabels?: string[];
  /**
   * The parent task (2026-10-25; one level: a child has no children). Null for a task without one;
   * absent from a Task service that has no parent tasks.
   */
  parentId?: string | null;
  /**
   * Helpers (副担当, 2026-10-28): members who help the assignee (the main one), in the order they were
   * added. Only on a task with an assignee, and never the assignee. Absent from a Task service without them.
   */
  helperIds?: string[];
  helpers?: { id: string; displayName: string; active: boolean }[];
}

/** The assignee or one of the helpers (what "自分の担当" and the assignee filter match). */
export const isAssignedTo = (task: Pick<TaskView, 'assigneeId' | 'helperIds'>, userId: string): boolean =>
  task.assigneeId === userId || (task.helperIds ?? []).includes(userId);

/** "#12" for the Task API's "task-12" (what Discord's /todo shows); other IDs as they are. */
export const taskNumber = (taskId: string): string => {
  const m = /^task-(\d+)$/.exec(taskId);
  return m ? `#${m[1]}` : taskId;
};

export interface TaskHistoryEntry {
  id: string;
  version: number;
  action: 'created' | 'updated' | 'reopened';
  actorName: string;
  at: string;
  source: string;
  displayChanges: { field: string; before: string | null; after: string | null }[];
}

export interface TaskMember {
  userId: string;
  displayName: string;
  role: TaskRole;
  active: boolean;
}

export interface TaskContextResponse {
  /** A Task service is configured for this server. */
  enabled: boolean;
  /** The signed-in user has a task identity binding. */
  bound: boolean;
  memberships: { workspace: TaskWorkspace; role: TaskRole }[];
  /** The workspaces are departments and tasks can carry several of them (department tags). */
  tagging?: boolean;
  /**
   * The signed-in user's own ID in the Task service (2026-10-25), which is what a task's assigneeId holds:
   * with the Discord login it is discord-<Discord user ID>, not the app's login ID. Absent from an older server.
   */
  self?: string;
}

/** Shown only to a viewer who may currently read the source case. */
export interface TaskProvenance {
  kind: 'mail' | 'line';
  label: string;
  href: string;
}

export interface TaskDetailResponse {
  task: TaskView;
  provenance: TaskProvenance[];
}

export interface TaskMutationResponse {
  task: TaskView;
  replayed: boolean;
}

export interface CaseTaskFields {
  workspaceId: string;
  title: string;
  assigneeId: string | null;
  deadline: string | null;
  requirements: Requirements;
}

export interface CaseTaskInput extends CaseTaskFields {
  /** Generated once per form submission and reused for retries of the same submission. */
  clientOperationId: string;
}

export interface CaseTasksResponse {
  canCreate: boolean;
  tasks: { id: string; title: string; status: TaskStatus; workspaceId: string }[];
  /** Linked tasks could not be confirmed because the Task service did not answer. */
  unavailable: boolean;
  /** This user's own unconfirmed submissions for this case (retry resolves them without duplicates). */
  pending: { clientOperationId: string; requestedAt: string; input: CaseTaskFields }[];
}

export interface CaseTaskResponse extends TaskMutationResponse {
  linked: true;
}

export type CaseKind = 'mail' | 'line';
