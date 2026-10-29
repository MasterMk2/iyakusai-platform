import type { AccessLevel, AccessMatrixResponse, AuditEntry } from '../../shared/api.js';
import { displayName, findUser } from './access.js';
import { DomainError, nextId, type AppState, type User } from './types.js';

// Demo access administration. Managing grants is separate from reading mail:
// the demo administrator holds no mailbox grant and cannot grant one to itself.

export const MAX_MOCK_BATCH = 2;

function requireManager(user: User): void {
  if (!user.canManageAccess) throw new DomainError('forbidden', '権限管理はデモ管理者だけが行えます。');
}

export function accessMatrix(state: AppState, user: User): AccessMatrixResponse {
  requireManager(user);
  return {
    users: state.users.filter((u) => !u.canManageAccess).map((u) => ({ id: u.id, displayName: u.displayName, roleLabel: u.roleLabel })),
    mailboxes: state.mailboxes.map((m) => ({ id: m.id, name: m.name, address: m.address })),
    grants: state.grants.map((g) => ({ ...g })),
    version: state.accessVersion,
  };
}

export function setGrant(
  state: AppState,
  user: User,
  input: { userId: string; mailboxId: string; level: AccessLevel; expectedVersion: number },
  now: string,
): AccessMatrixResponse {
  requireManager(user);
  const target = findUser(state, input.userId);
  const mailbox = state.mailboxes.find((m) => m.id === input.mailboxId);
  if (!target || !mailbox) throw new DomainError('validation', '利用者または受信箱が存在しません。');
  if (target.canManageAccess) throw new DomainError('validation', '権限管理者にはメール閲覧権限を付与できません。');
  if (input.expectedVersion !== state.accessVersion) {
    throw new DomainError('conflict', '権限表が別の操作で更新されています。再読み込みしてからやり直してください。');
  }
  const before = state.grants.find((g) => g.userId === target.id && g.mailboxId === mailbox.id)?.level ?? 'none';
  if (before === input.level) return accessMatrix(state, user);
  state.grants = state.grants.filter((g) => !(g.userId === target.id && g.mailboxId === mailbox.id));
  if (input.level !== 'none') state.grants.push({ userId: target.id, mailboxId: mailbox.id, level: input.level });
  state.accessVersion += 1;
  state.audit.push({
    id: nextId(state, 'audit'),
    at: now,
    actorId: user.id,
    action: 'grant_changed',
    detail: `${target.displayName} の「${mailbox.name}」権限: ${before} → ${input.level}`,
  });
  return accessMatrix(state, user);
}

export function releaseMockBatch(state: AppState, user: User, now: string): number {
  requireManager(user);
  if (state.mockConnector.releasedBatch >= MAX_MOCK_BATCH) {
    throw new DomainError('conflict', 'モックの新着バッチはすべて配信済みです。サンプルをリセットすると最初からやり直せます。');
  }
  state.mockConnector.releasedBatch += 1;
  state.audit.push({ id: nextId(state, 'audit'), at: now, actorId: user.id, action: 'mock_batch_released', detail: `モック新着バッチ ${state.mockConnector.releasedBatch} を配信` });
  return state.mockConnector.releasedBatch;
}

export function auditLog(state: AppState, user: User): AuditEntry[] {
  requireManager(user);
  return [...state.audit].reverse().map((a) => ({ id: a.id, at: a.at, actorName: displayName(state, a.actorId), action: a.action, detail: a.detail }));
}
