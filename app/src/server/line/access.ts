import type { LineLevel } from '../../shared/line.js';
import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT } from '../../shared/mailbox.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import type { LineConversation, LineState } from './types.js';

// Per-account LINE ACL, independent of mailbox grants. Evaluated against the
// current state on every request. There is no global shortcut: the access
// administrator manages grants but holds none, and assignment never grants.
// A disabled user has no LINE access at all.
//
// The committee's state (state.committee, 2026-10-28) follows its mailbox instead: every committee member reads,
// an edit grant (notes) and a send grant (replies) go to the person or to one of their departments, and the
// access administrator is a committee member like the others. Temporary staff never see LINE.

function committeeGrant(state: LineState, user: User, accountId: string): { level: LineLevel; reply: boolean } {
  const departments = departmentsOfLabel(user.roleLabel);
  if (departments.includes(TEMPORARY_STAFF_DEPARTMENT)) return { level: 'none', reply: false };
  const own = state.grants.find((x) => x.userId === user.id && x.accountId === accountId);
  const team = (state.departmentGrants ?? []).filter((g) => g.accountId === accountId && departments.includes(g.department));
  const edit = own?.level === 'edit' || team.some((g) => g.kind === 'edit');
  const reply = own?.reply === true || team.some((g) => g.kind === 'send');
  return { level: edit ? 'edit' : 'read', reply };
}

export function lineGrant(state: LineState, user: User, accountId: string): { level: LineLevel; reply: boolean } {
  if (user.disabled) return { level: 'none', reply: false };
  if (state.committee) return committeeGrant(state, user, accountId);
  const g = state.grants.find((x) => x.userId === user.id && x.accountId === accountId);
  return g ? { level: g.level, reply: g.reply } : { level: 'none', reply: false };
}

export const canReadLine = (state: LineState, user: User, accountId: string) => lineGrant(state, user, accountId).level !== 'none';
export const canEditLine = (state: LineState, user: User, accountId: string) => lineGrant(state, user, accountId).level === 'edit';
/** Reply requires the separate capability and read access. */
export const canReplyLine = (state: LineState, user: User, accountId: string) => {
  const g = lineGrant(state, user, accountId);
  return g.level !== 'none' && g.reply;
};
/** Status, assignee and labels: an edit grant, or (committee) any reader, as in the committee mailbox. */
export const canTriageLine = (state: LineState, user: User, accountId: string) =>
  state.committee ? canReadLine(state, user, accountId) : canEditLine(state, user, accountId);

/** Read paths start here. An unknown or unpermitted account scope yields not_found. */
export function permittedConversations(state: LineState, user: User, accountId?: string): LineConversation[] {
  if (accountId !== undefined && !canReadLine(state, user, accountId)) throw notFound();
  return state.conversations.filter((c) => (accountId === undefined || c.accountId === accountId) && canReadLine(state, user, c.accountId));
}

export function readableConversation(state: LineState, user: User, conversationId: string): LineConversation {
  const conv = state.conversations.find((c) => c.id === conversationId);
  if (!conv || !canReadLine(state, user, conv.accountId)) throw notFound();
  return conv;
}

export function editableConversation(state: LineState, user: User, conversationId: string): LineConversation {
  const conv = readableConversation(state, user, conversationId);
  if (!canEditLine(state, user, conv.accountId)) {
    throw new DomainError(
      'forbidden',
      state.committee
        ? 'メモを書くには、この LINE アカウントの編集権限が要ります。権限管理者に依頼してください。'
        : 'この LINE アカウントは閲覧のみ許可されています。編集権限がありません。',
    );
  }
  return conv;
}

/** Status, assignee and labels (see canTriageLine). */
export function triageableConversation(state: LineState, user: User, conversationId: string): LineConversation {
  return state.committee ? readableConversation(state, user, conversationId) : editableConversation(state, user, conversationId);
}

export function replyableConversation(state: LineState, user: User, conversationId: string): LineConversation {
  const conv = readableConversation(state, user, conversationId);
  if (!canReplyLine(state, user, conv.accountId)) {
    throw new DomainError('forbidden', state.committee ? 'この LINE アカウントで送る権限がありません。権限管理者に、LINE の送信権限を依頼してください。' : 'この LINE アカウントで返信する権限がありません。');
  }
  return conv;
}
