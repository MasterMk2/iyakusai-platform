import type { AccessLevel } from '../../shared/api.js';
import { DomainError, notFound, type AppState, type Mailbox, type Receipt, type User } from './types.js';
import { approvedSharedMailTarget, isApprovedSharedReceipt, isVerifiedCommitteeReader, requireVerifiedCommitteeReader } from './shared-mail-policy.js';

// Existing grants govern handling edits only. A verified current committee
// member reads every explicitly approved shared mailbox, regardless of department.

export function accessLevel(state: AppState, userId: string, mailboxId: string): AccessLevel {
  const grant = state.grants.find((g) => g.userId === userId && g.mailboxId === mailboxId);
  return grant?.level ?? 'none';
}

export function canRead(state: AppState, userId: string, mailboxId: string): boolean {
  return accessLevel(state, userId, mailboxId) !== 'none';
}

export function canEdit(state: AppState, userId: string, mailboxId: string): boolean {
  return accessLevel(state, userId, mailboxId) === 'edit';
}

export function readAccessLevel(state: AppState, user: User, mailboxId: string): AccessLevel {
  const mailbox = state.mailboxes.find((m) => m.id === mailboxId);
  if (!isVerifiedCommitteeReader(state, user) || !mailbox || !approvedSharedMailTarget(state, mailbox)) return 'none';
  return canEdit(state, user.id, mailboxId) ? 'edit' : 'read';
}

export function permittedMailboxes(state: AppState, user: User): Mailbox[] {
  requireVerifiedCommitteeReader(state, user);
  return state.mailboxes.filter((m) => readAccessLevel(state, user, m.id) !== 'none');
}

/**
 * The single starting point for every read path: receipts the user may read,
 * optionally narrowed to one mailbox. An unknown or unpermitted mailbox scope
 * yields the same not_found error.
 */
export function permittedReceipts(state: AppState, user: User, mailboxId?: string): Receipt[] {
  requireVerifiedCommitteeReader(state, user);
  if (mailboxId !== undefined && readAccessLevel(state, user, mailboxId) === 'none') throw notFound();
  const allowed = new Set(permittedMailboxes(state, user).map((m) => m.id));
  return state.receipts.filter((r) => allowed.has(r.mailboxId) && isApprovedSharedReceipt(state, r) && (mailboxId === undefined || r.mailboxId === mailboxId));
}

export function readableReceipt(state: AppState, user: User, receiptId: string): Receipt {
  const receipt = state.receipts.find((r) => r.id === receiptId);
  if (!receipt || readAccessLevel(state, user, receipt.mailboxId) === 'none' || !isApprovedSharedReceipt(state, receipt)) throw notFound();
  return receipt;
}

export function editableReceipt(state: AppState, user: User, receiptId: string): Receipt {
  const receipt = readableReceipt(state, user, receiptId);
  if (!canEdit(state, user.id, receipt.mailboxId)) {
    throw new DomainError('forbidden', 'この受信箱は閲覧のみ許可されています。編集権限がありません。');
  }
  return receipt;
}

export function findUser(state: AppState, userId: string): User | undefined {
  return state.users.find((u) => u.id === userId);
}

export function displayName(state: AppState, userId: string): string {
  if (userId === 'system') return 'システム（モック同期）';
  return findUser(state, userId)?.displayName ?? '（不明な利用者）';
}
