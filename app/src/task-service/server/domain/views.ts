import { isOverdue } from '../../shared/dates.js';
import {
  REQUIREMENT_FIELDS,
  type HistoryEntry,
  type HistoryView,
  type Membership,
  type MembershipAuditEntry,
  type MembershipAuditView,
  type MemberView,
  type Task,
  type TaskView,
  type UserSummary,
} from '../../shared/types.js';
import { activeMembership } from './permissions.js';
import type { AppState } from './state.js';

function userName(state: AppState, userId: string): string {
  return state.users.find((user) => user.id === userId)?.displayName ?? '（不明な利用者）';
}

function assigneeSummary(state: AppState, task: Task): UserSummary | null {
  if (task.assigneeId === null) return null;
  return {
    id: task.assigneeId,
    displayName: userName(state, task.assigneeId),
    active: activeMembership(state, task.assigneeId, task.workspaceId) !== undefined,
  };
}

export function toTaskView(state: AppState, task: Task, today: string): TaskView {
  return {
    ...structuredClone(task),
    assignee: assigneeSummary(state, task),
    overdue: isOverdue(task.deadline, task.status, today),
    missingRequirements: REQUIREMENT_FIELDS.filter((field) => task.requirements[field].trim() === ''),
  };
}

export function toHistoryView(state: AppState, entry: HistoryEntry): HistoryView {
  return {
    ...structuredClone(entry),
    actorName: userName(state, entry.actorId),
    displayChanges: entry.changes.map((change) =>
      change.field === 'assigneeId'
        ? {
            field: change.field,
            before: change.before === null ? null : userName(state, change.before),
            after: change.after === null ? null : userName(state, change.after),
          }
        : { ...change },
    ),
  };
}

export function toMemberView(state: AppState, membership: Membership): MemberView {
  const user = state.users.find((candidate) => candidate.id === membership.userId);
  return {
    userId: membership.userId,
    displayName: user?.displayName ?? '（不明な利用者）',
    email: user?.email ?? '',
    role: membership.role,
    active: membership.active,
  };
}

export function toAuditView(state: AppState, entry: MembershipAuditEntry): MembershipAuditView {
  return {
    ...structuredClone(entry),
    actorName: userName(state, entry.actorId),
    targetName: userName(state, entry.targetUserId),
  };
}
