import type {
  ChangeSource,
  HistoryEntry,
  Membership,
  MembershipAuditEntry,
  MockBotAccount,
  MockBotChannel,
  Task,
  User,
  Workspace,
} from '../../shared/types.js';

export const STATE_SCHEMA_VERSION = 1;
/** 冪等性のために保持する操作記録の上限。古いものから削除する。 */
export const MAX_OPERATION_RECORDS = 2000;

export type ResultRef =
  | { type: 'task'; taskId: string }
  | { type: 'member'; workspaceId: string; userId: string };

export interface OperationRecord {
  key: string;
  source: ChangeSource;
  actorId: string;
  operationId: string;
  fingerprint: string;
  result: ResultRef;
  at: string;
}

/** 保存単位。タスク・履歴・操作記録を 1 つの文書としてまとめて書き込む。 */
export interface AppState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  workspaces: Workspace[];
  users: User[];
  memberships: Membership[];
  tasks: Task[];
  history: HistoryEntry[];
  membershipAudit: MembershipAuditEntry[];
  operations: OperationRecord[];
  mockBot: { channels: MockBotChannel[]; accounts: MockBotAccount[] };
  counters: { task: number; history: number; audit: number };
}

export function isAppState(value: unknown): value is AppState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<AppState>;
  return (
    state.schemaVersion === STATE_SCHEMA_VERSION &&
    Array.isArray(state.workspaces) &&
    Array.isArray(state.users) &&
    Array.isArray(state.memberships) &&
    Array.isArray(state.tasks) &&
    Array.isArray(state.history) &&
    Array.isArray(state.membershipAudit) &&
    Array.isArray(state.operations) &&
    typeof state.mockBot === 'object' &&
    state.mockBot !== null &&
    Array.isArray(state.mockBot.channels) &&
    Array.isArray(state.mockBot.accounts) &&
    typeof state.counters === 'object' &&
    state.counters !== null
  );
}
