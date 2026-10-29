import { LIMITS, STATUS_LABELS, type AssigneeCandidate, type NoteView, type TriageView } from '../../shared/api.js';
import type { LineAccessMatrixResponse, LineLevel, OutboxView } from '../../shared/line.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { normalizeLabels, type TriageChange } from '../domain/triage.js';
import { canReadLine, editableConversation, readableConversation, triageableConversation } from './access.js';
import { lineTriageView, namesFrom, type LinePeople } from './queries.js';
import { outboxView } from './reply.js';
import { nextLineId, type LineState } from './types.js';

// Conversation-scoped handling data, mirroring the mail receipt rules: current
// edit grant re-checked, validation before mutation, optimistic versions,
// assignment never grants access, history without note content.

export function updateLineTriage(state: LineState, mail: LinePeople, user: User, conversationId: string, change: TriageChange, now: string): TriageView {
  const conv = triageableConversation(state, user, conversationId);
  if (change.expectedVersion !== conv.triage.version) {
    throw new DomainError('conflict', '他の利用者が先に更新しました。最新の内容を確認してから、もう一度保存してください。', {
      current: lineTriageView(state, mail, user, conv),
    });
  }
  const names = namesFrom(mail);
  const next = { ...conv.triage, labels: [...conv.triage.labels] };
  if (change.assigneeId !== undefined) {
    if (change.assigneeId !== null) {
      const assignee = mail.users.find((u) => u.id === change.assigneeId);
      if (!assignee || !canReadLine(state, assignee, conv.accountId)) {
        throw new DomainError('validation', '担当者には、この LINE アカウントの閲覧権限を持つ利用者だけを指定できます。', { field: 'assigneeId' });
      }
    }
    next.assigneeId = change.assigneeId;
  }
  if (change.status !== undefined) next.status = change.status;
  if (change.labels !== undefined) next.labels = normalizeLabels(change.labels);

  const history: { action: 'assignee' | 'status' | 'labels'; from: string | null; to: string | null }[] = [];
  if (next.assigneeId !== conv.triage.assigneeId) {
    history.push({ action: 'assignee', from: conv.triage.assigneeId ? names(conv.triage.assigneeId) : null, to: next.assigneeId ? names(next.assigneeId) : null });
  }
  if (next.status !== conv.triage.status) history.push({ action: 'status', from: STATUS_LABELS[conv.triage.status], to: STATUS_LABELS[next.status] });
  if (next.labels.join('\u0000') !== conv.triage.labels.join('\u0000')) {
    history.push({ action: 'labels', from: conv.triage.labels.join(', ') || null, to: next.labels.join(', ') || null });
  }
  if (history.length === 0) return lineTriageView(state, mail, user, conv);
  conv.triage = { ...next, version: conv.triage.version + 1 };
  for (const h of history) conv.history.push({ id: nextLineId(state, 'lhist'), at: now, actorId: user.id, ...h });
  return lineTriageView(state, mail, user, conv);
}

export function addLineNote(state: LineState, user: User, conversationId: string, body: string, now: string): NoteView {
  const conv = editableConversation(state, user, conversationId);
  const text = body.replace(/\r\n/g, '\n').trim();
  if (text.length === 0) throw new DomainError('validation', 'メモを入力してください。', { field: 'body' });
  if (text.length > LIMITS.noteMaxLength) throw new DomainError('validation', `メモは ${LIMITS.noteMaxLength} 文字以内で入力してください。`, { field: 'body' });
  const note = { id: nextLineId(state, 'lnote'), authorId: user.id, createdAt: now, body: text };
  conv.notes.push(note);
  conv.history.push({ id: nextLineId(state, 'lhist'), at: now, actorId: user.id, action: 'note_added', from: null, to: null });
  return { id: note.id, authorName: user.displayName, createdAt: now, body: text };
}

export function lineAssigneeCandidates(state: LineState, mail: LinePeople, user: User, conversationId: string): AssigneeCandidate[] {
  const conv = triageableConversation(state, user, conversationId);
  return mail.users.filter((u) => canReadLine(state, u, conv.accountId)).map((u) => ({ id: u.id, displayName: u.displayName }));
}

export function getOutbox(state: LineState, mail: LinePeople, user: User, intentId: string, now: string, inFlight: boolean): OutboxView {
  const intent = state.outbox.find((o) => o.id === intentId);
  if (!intent) throw notFound();
  readableConversation(state, user, intent.conversationId);
  return outboxView(intent, namesFrom(mail), Date.parse(now), inFlight);
}

// ---- administration: per-account grants. Managing never implies reading.

function requireManager(user: User): void {
  if (!user.canManageAccess) throw new DomainError('forbidden', '権限管理は権限管理者だけが行えます。');
}

export function lineAccessMatrix(state: LineState, mail: LinePeople, user: User): LineAccessMatrixResponse {
  requireManager(user);
  return {
    users: mail.users.filter((u) => !u.canManageAccess).map((u) => ({ id: u.id, displayName: u.displayName, roleLabel: u.roleLabel })),
    accounts: state.accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
    grants: state.grants.map((g) => ({ ...g })),
    version: state.accessVersion,
  };
}

export function setLineGrant(
  state: LineState,
  mail: LinePeople,
  user: User,
  input: { userId: string; accountId: string; level: LineLevel; reply: boolean; expectedVersion: number },
  now: string,
): LineAccessMatrixResponse {
  requireManager(user);
  const target = mail.users.find((u) => u.id === input.userId);
  const account = state.accounts.find((a) => a.id === input.accountId);
  if (!target || !account) throw new DomainError('validation', '利用者または LINE アカウントが存在しません。');
  if (target.canManageAccess) throw new DomainError('validation', '権限管理者には LINE の閲覧・返信権限を付与できません。');
  if (input.reply && input.level === 'none') throw new DomainError('validation', '返信権限には閲覧権限が必要です。');
  if (input.expectedVersion !== state.accessVersion) {
    throw new DomainError('conflict', '権限表が別の操作で更新されています。再読み込みしてからやり直してください。');
  }
  const before = state.grants.find((g) => g.userId === target.id && g.accountId === account.id);
  const describe = (level: LineLevel, reply: boolean) => `${level}${reply ? '+reply' : ''}`;
  const from = describe(before?.level ?? 'none', before?.reply ?? false);
  const to = describe(input.level, input.reply);
  if (from === to) return lineAccessMatrix(state, mail, user);
  state.grants = state.grants.filter((g) => !(g.userId === target.id && g.accountId === account.id));
  if (input.level !== 'none') state.grants.push({ userId: target.id, accountId: account.id, level: input.level, reply: input.reply });
  state.accessVersion += 1;
  state.audit.push({ id: nextLineId(state, 'laudit'), at: now, actorId: user.id, action: 'line_grant_changed', detail: `${target.displayName} の「${account.name}」権限: ${from} → ${to}` });
  return lineAccessMatrix(state, mail, user);
}

export function lineAuditLog(state: LineState, mail: LinePeople, user: User) {
  requireManager(user);
  const names = namesFrom(mail);
  return [...state.audit].reverse().map((a) => ({ id: a.id, at: a.at, actorName: names(a.actorId), action: a.action, detail: a.detail }));
}
