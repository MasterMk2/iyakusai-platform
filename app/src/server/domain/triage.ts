import { LIMITS, STATUS_LABELS, type AssigneeCandidate, type HandlingStatus, type NoteView, type TriageView } from '../../shared/api.js';
import { canRead, displayName, editableReceipt, findUser } from './access.js';
import { receiptView } from './queries.js';
import { DomainError, nextId, type AppState, type User } from './types.js';

// Receipt-scoped handling data. Mutations re-check the current edit grant,
// validate everything before touching state, and use optimistic versions so a
// stale write is rejected instead of overwriting a newer successful change.

export interface TriageChange {
  expectedVersion: number;
  status?: HandlingStatus;
  assigneeId?: string | null;
  labels?: string[];
}

// Control characters are rejected in labels.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function normalizeLabels(labels: string[]): string[] {
  const out: string[] = [];
  for (const raw of labels) {
    const label = raw.normalize('NFKC').trim();
    if (label.length === 0) throw new DomainError('validation', 'ラベルを空にすることはできません。', { field: 'labels' });
    if (label.length > LIMITS.labelMaxLength) {
      throw new DomainError('validation', `ラベルは ${LIMITS.labelMaxLength} 文字以内で入力してください。`, { field: 'labels' });
    }
    if (CONTROL.test(label)) throw new DomainError('validation', 'ラベルに制御文字は使えません。', { field: 'labels' });
    if (!out.includes(label)) out.push(label);
  }
  if (out.length > LIMITS.labelsPerReceipt) {
    throw new DomainError('validation', `ラベルは 1 件のメールにつき ${LIMITS.labelsPerReceipt} 個までです。`, { field: 'labels' });
  }
  return out;
}

export function updateTriage(state: AppState, user: User, receiptId: string, change: TriageChange, now: string): TriageView {
  const receipt = editableReceipt(state, user, receiptId);
  if (change.expectedVersion !== receipt.triage.version) {
    throw new DomainError('conflict', '他の利用者が先に更新しました。最新の内容を確認してから、もう一度保存してください。', {
      current: receiptView(state, user, receipt).triage,
    });
  }

  const next = { ...receipt.triage, labels: [...receipt.triage.labels] };
  if (change.assigneeId !== undefined) {
    if (change.assigneeId !== null) {
      const assignee = findUser(state, change.assigneeId);
      // Assignment never grants access: the assignee must already be able to read this mailbox.
      if (!assignee || !canRead(state, assignee.id, receipt.mailboxId)) {
        throw new DomainError('validation', '担当者には、この受信箱の閲覧権限を持つ利用者だけを指定できます。', { field: 'assigneeId' });
      }
    }
    next.assigneeId = change.assigneeId;
  }
  if (change.status !== undefined) next.status = change.status;
  if (change.labels !== undefined) next.labels = normalizeLabels(change.labels);

  const history: { action: 'assignee' | 'status' | 'labels'; from: string | null; to: string | null }[] = [];
  if (next.assigneeId !== receipt.triage.assigneeId) {
    const name = (id: string | null) => (id ? displayName(state, id) : null);
    history.push({ action: 'assignee', from: name(receipt.triage.assigneeId), to: name(next.assigneeId) });
  }
  if (next.status !== receipt.triage.status) {
    history.push({ action: 'status', from: STATUS_LABELS[receipt.triage.status], to: STATUS_LABELS[next.status] });
  }
  if (next.labels.join('\u0000') !== receipt.triage.labels.join('\u0000')) {
    history.push({ action: 'labels', from: receipt.triage.labels.join(', ') || null, to: next.labels.join(', ') || null });
  }
  if (history.length === 0) return receiptView(state, user, receipt).triage;

  receipt.triage = { ...next, version: receipt.triage.version + 1 };
  for (const h of history) receipt.history.push({ id: nextId(state, 'hist'), at: now, actorId: user.id, ...h });
  return receiptView(state, user, receipt).triage;
}

export function addNote(state: AppState, user: User, receiptId: string, body: string, now: string): NoteView {
  const receipt = editableReceipt(state, user, receiptId);
  const text = body.replace(/\r\n/g, '\n').trim();
  if (text.length === 0) throw new DomainError('validation', 'メモを入力してください。', { field: 'body' });
  if (text.length > LIMITS.noteMaxLength) {
    throw new DomainError('validation', `メモは ${LIMITS.noteMaxLength} 文字以内で入力してください。`, { field: 'body' });
  }
  const note = { id: nextId(state, 'note'), authorId: user.id, createdAt: now, body: text };
  receipt.notes.push(note);
  // History records that a note was added, not its content.
  receipt.history.push({ id: nextId(state, 'hist'), at: now, actorId: user.id, action: 'note_added', from: null, to: null });
  return { id: note.id, authorName: user.displayName, createdAt: now, body: text };
}

/** People who may be assigned: current readers of the receipt's mailbox. Requires edit access. */
export function assigneeCandidates(state: AppState, user: User, receiptId: string): AssigneeCandidate[] {
  const receipt = editableReceipt(state, user, receiptId);
  return state.users
    .filter((u) => canRead(state, u.id, receipt.mailboxId))
    .map((u) => ({ id: u.id, displayName: u.displayName }));
}
