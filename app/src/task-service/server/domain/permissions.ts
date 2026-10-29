import type { Membership, Role, Task, User } from '../../shared/types.js';
import { AppError, notFoundTask } from './errors.js';
import type { AppState } from './state.js';

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

export function hasRole(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function requireUser(state: AppState, actorId: string): User {
  const user = state.users.find((candidate) => candidate.id === actorId);
  if (!user) throw new AppError('UNAUTHENTICATED', '模擬ログインの人物を選んでください。');
  return user;
}

export function activeMembership(state: AppState, userId: string, workspaceId: string): Membership | undefined {
  return state.memberships.find(
    (membership) => membership.userId === userId && membership.workspaceId === workspaceId && membership.active,
  );
}

/**
 * 委員会単位の操作を許可するか判定する。所属がない委員会は存在の有無も区別しない。
 */
export function requireWorkspaceRole(state: AppState, actorId: string, workspaceId: string, minimum: Role): Membership {
  requireUser(state, actorId);
  const membership = activeMembership(state, actorId, workspaceId);
  if (!membership) throw new AppError('FORBIDDEN', 'この委員会を利用する権限がありません。');
  if (!hasRole(membership.role, minimum)) {
    const message =
      minimum === 'admin' ? 'この操作は委員会の管理者だけが行えます。' : '閲覧者は変更できません。編集者以上の役割が必要です。';
    throw new AppError('FORBIDDEN', message);
  }
  return membership;
}

/**
 * タスク単位の操作を許可するか判定する。直接 ID を指定しても、所属外のタスクは「見つからない」として扱う。
 * scopeWorkspaceId を指定した場合は、その委員会のタスクに限定する（模擬 Bot のチャンネル単位の制限）。
 */
export function requireTaskAccess(
  state: AppState,
  actorId: string,
  taskId: string,
  minimum: Role,
  scopeWorkspaceId?: string,
): Task {
  requireUser(state, actorId);
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw notFoundTask();
  if (scopeWorkspaceId !== undefined && task.workspaceId !== scopeWorkspaceId) throw notFoundTask();
  const membership = activeMembership(state, actorId, task.workspaceId);
  if (!membership) throw notFoundTask();
  if (!hasRole(membership.role, minimum)) {
    throw new AppError('FORBIDDEN', '閲覧者は変更できません。編集者以上の役割が必要です。');
  }
  return task;
}
