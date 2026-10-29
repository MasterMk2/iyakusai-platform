import { LIMITS, STATUS_LABELS, type AssigneeCandidate, type AttachmentView, type HandlingStatus, type LabelFacet, type MailboxSummary, type NoteView, type ReceiptView, type ThreadDetailResponse, type ThreadListResponse, type ThreadStatusResponse, type TriageView } from '../../shared/api.js';
import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT, type MailAccessResponse } from '../../shared/mailbox.js';
import { sanitizeMailHtml } from '../domain/sanitize.js';
import { normalizeLabels } from '../domain/triage.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import type { CommitteeAddresses } from './addresses.js';
import type { MailboxDefinition } from './config.js';
import { SIGN_IN_MAIL_SUBJECT, SIGN_IN_MAIL_TEXT } from './restricted.js';
import { normalizeForSearch, type ListFilter, type MailboxStore, type MessageRow } from './store.js';

// What the committee mailbox shows. Every signed-in committee member reads every configured mailbox
// (requirement 3-3). Members change status, assignees and labels; notes need a mailbox edit grant, given to
// the person or to one of their departments.
// Addresses are shown as they are written in the mail (no hiding, requirement 3-5). The exception is sign-in
// mail (restricted.ts, 2026-10-30): only access administrators see its subject, text and attachments.

/** Names of people for display and the accounts that can be granted (never used to authorize). */
export interface People {
  lookup(userId: string): User | undefined;
  list(): User[];
}

export interface ThreadQuery {
  mailboxId?: string;
  q?: string;
  status?: HandlingStatus;
  label?: string;
  assignee?: string;
  page: number;
  pageSize: number;
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];

export class MailboxService {
  constructor(
    private readonly store: MailboxStore,
    private readonly addresses: CommitteeAddresses,
    private readonly people: People,
    /** Mailboxes the server can send from, or null when sending is not set up. */
    private readonly sendable: readonly string[] | null = null,
  ) {}

  private get mailboxes(): readonly MailboxDefinition[] {
    return this.addresses.mailboxes;
  }

  private mailbox(id: string): MailboxDefinition | undefined {
    return this.mailboxes.find((m) => m.id === id);
  }

  private name(userId: string): string {
    return this.people.lookup(userId)?.displayName ?? '（不明な利用者）';
  }

  /** Configured mailboxes this message is in, in configuration order. */
  private mailboxesOf(linked: string[] | undefined): MailboxDefinition[] {
    const set = new Set(linked ?? []);
    return this.mailboxes.filter((m) => set.has(m.id));
  }

  /** Sign-in mail this person may not read. */
  private hidden(user: User, row: MessageRow): boolean {
    return !user.canManageAccess && this.store.isSignInMail(row);
  }

  private filter(user: User, query: Omit<ThreadQuery, 'page' | 'pageSize'>): ListFilter {
    if (query.mailboxId !== undefined && !this.mailbox(query.mailboxId)) throw notFound();
    const terms = query.q ? normalizeForSearch(query.q).split(/\s+/).filter(Boolean) : [];
    return {
      mailboxIds: query.mailboxId ? [query.mailboxId] : this.mailboxes.map((m) => m.id),
      terms,
      termsSkipSignIn: !user.canManageAccess,
      ...(query.status ? { status: query.status } : {}),
      ...(query.label ? { label: query.label } : {}),
      ...(query.assignee ? { assignee: query.assignee === 'me' ? user.id : query.assignee } : {}),
    };
  }

  /** Mailboxes this person may edit (or send from): their own grants and their departments' (2026-10-26). */
  grantedMailboxes(user: User, kind: 'edit' | 'send'): Set<string> {
    if (user.disabled) return new Set();
    const own = kind === 'edit' ? this.store.editMailboxesOf(user.id) : this.store.sendMailboxesOf(user.id);
    const departments = departmentsOfLabel(user.roleLabel).filter((d) => d !== TEMPORARY_STAFF_DEPARTMENT);
    return new Set([...own, ...this.store.departmentMailboxes(departments, kind)]);
  }

  canEdit(user: User, linked: string[]): boolean {
    if (user.disabled) return false;
    const mine = this.grantedMailboxes(user, 'edit');
    return this.mailboxesOf(linked).some((m) => mine.has(m.id));
  }

  /** A stored message that is in at least one configured mailbox, with its mailboxes. */
  private visible(id: string): { row: MessageRow; mailboxes: MailboxDefinition[]; linked: string[] } {
    const row = this.store.message(id);
    const linked = row ? (this.store.links([row.id]).get(row.id) ?? []) : [];
    const mailboxes = this.mailboxesOf(linked);
    if (!row || mailboxes.length === 0) throw notFound();
    return { row, mailboxes, linked };
  }

  unhandledTotal(): number {
    return this.store.unhandledMessages(this.mailboxes.map((m) => m.id));
  }

  mailboxSummaries(user: User): MailboxSummary[] {
    const counts = this.store.mailboxCounts();
    const mine = this.grantedMailboxes(user, 'edit');
    return this.mailboxes.map((m) => ({
      id: m.id,
      name: m.name,
      address: m.address,
      access: mine.has(m.id) && !user.disabled ? 'edit' : 'read',
      threadCount: counts.get(m.id)?.threads ?? 0,
      unhandledCount: counts.get(m.id)?.unhandled ?? 0,
    }));
  }

  listThreads(user: User, query: ThreadQuery): ThreadListResponse {
    const f = this.filter(user, query);
    const { total, threads } = this.store.threadPage(f, query.pageSize, (query.page - 1) * query.pageSize);
    const ids = threads.map((t) => t.thread_id);
    const all = this.store.threadMessages(f, ids, false);
    const matched = new Set(this.store.threadMessages(f, ids, true).map((m) => m.id));
    const links = this.store.links(all.map((m) => m.id));
    const items = threads.map((t) => {
      const messages = all.filter((m) => m.thread_id === t.thread_id);
      const first = messages[0]!;
      const latest = messages[messages.length - 1]!;
      const hits = messages.filter((m) => matched.has(m.id));
      const latestMatch = hits[hits.length - 1] ?? latest;
      const boxes = this.mailboxesOf(unique(messages.flatMap((m) => links.get(m.id) ?? [])));
      const primary = (query.mailboxId ? this.mailbox(query.mailboxId) : undefined) ?? boxes[0]!;
      return {
        threadId: t.thread_id,
        mailbox: { id: primary.id, name: primary.name },
        mailboxes: boxes.map((b) => ({ id: b.id, name: b.name })),
        subject: this.hidden(user, first) ? SIGN_IN_MAIL_SUBJECT : first.subject,
        latestReceivedAt: latest.received_at,
        receiptCount: messages.length,
        matchCount: hits.length,
        snippet: this.hidden(user, latestMatch) ? '' : snippetOf(latestMatch.text, f.terms),
        senders: unique(messages.map((m) => m.from_name ?? m.from_address)),
        statuses: unique(messages.map((m) => m.status)),
        labels: unique(messages.flatMap((m) => JSON.parse(m.labels_json) as string[])).sort(),
        assignees: unique(messages.flatMap((m) => (m.assignee_id ? [this.name(m.assignee_id)] : []))),
        canSetStatus: !user.disabled,
      };
    });
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  private triageView(row: MessageRow): TriageView {
    const assigneeId = row.assignee_id;
    const assignee = assigneeId ? this.people.lookup(assigneeId) : undefined;
    return {
      version: row.version,
      status: row.status,
      labels: JSON.parse(row.labels_json) as string[],
      assignee: assigneeId
        ? {
            id: assigneeId,
            displayName: this.name(assigneeId),
            hasMailboxAccess: !!assignee && !assignee.disabled,
          }
        : null,
    };
  }

  private receiptView(user: User, row: MessageRow, linked: string[]): ReceiptView {
    const boxes = this.mailboxesOf(linked);
    const editable = this.canEdit(user, linked);
    const hidden = this.hidden(user, row);
    const sanitized = row.html !== null && !hidden ? sanitizeMailHtml(row.html) : null;
    const attachments: AttachmentView[] = hidden ? [] : this.store.attachments(row.id).map((a) => ({ id: `att${a.idx}`, filename: a.filename, contentType: a.content_type, size: a.size }));
    const notes: NoteView[] = this.store.notes(row.id).map((n) => ({ id: n.id, authorName: this.name(n.author_id), createdAt: n.created_at, body: n.body }));
    return {
      receiptId: row.id,
      threadId: row.thread_id,
      mailbox: { id: boxes[0]!.id, name: boxes[0]!.name, address: boxes[0]!.address },
      mailboxes: boxes.map((b) => ({ id: b.id, name: b.name, address: b.address })),
      access: editable ? 'edit' : 'read',
      canEditAssignmentAndLabels: !user.disabled,
      canEditStatus: !user.disabled,
      receivedAt: row.received_at,
      subject: hidden ? SIGN_IN_MAIL_SUBJECT : row.subject,
      from: { name: row.from_name, address: row.from_address },
      to: JSON.parse(row.to_json) as ReceiptView['to'],
      cc: JSON.parse(row.cc_json) as ReceiptView['cc'],
      text: hidden ? SIGN_IN_MAIL_TEXT : row.text,
      hasHtml: row.html !== null && !hidden,
      sanitizedHtml: sanitized?.html ?? null,
      blockedRemoteResources: sanitized?.blockedRemoteResources ?? 0,
      attachments,
      triage: this.triageView(row),
      notes,
      history: this.store.history(row.id).map((h) => ({ id: String(h.id), at: h.at, actorName: this.name(h.actor_id), action: h.action, from: h.from_value, to: h.to_value })),
    };
  }

  getReceipt(user: User, id: string): ReceiptView {
    const { row, linked } = this.visible(id);
    return this.receiptView(user, row, linked);
  }

  getThread(user: User, threadId: string): ThreadDetailResponse {
    const f = this.filter(user, {});
    const messages = this.store.threadMessages(f, [threadId], false);
    if (messages.length === 0) throw notFound();
    const links = this.store.links(messages.map((m) => m.id));
    const receipts = messages.map((m) => this.receiptView(user, m, links.get(m.id) ?? []));
    const boxes = this.mailboxesOf(unique(messages.flatMap((m) => links.get(m.id) ?? [])));
    return {
      threadId,
      mailbox: { id: boxes[0]!.id, name: boxes[0]!.name, address: boxes[0]!.address },
      mailboxes: boxes.map((b) => ({ id: b.id, name: b.name, address: b.address })),
      subject: this.hidden(user, messages[0]!) ? SIGN_IN_MAIL_SUBJECT : messages[0]!.subject,
      receipts,
    };
  }

  attachment(user: User, id: string, attachmentId: string): { filename: string; content: Buffer } {
    if (this.hidden(user, this.visible(id).row)) throw notFound();
    const idx = Number(attachmentId.slice(3));
    const row = this.store.attachments(id).find((a) => a.idx === idx);
    if (!row) throw notFound();
    return { filename: row.filename, content: this.store.readAttachment(row) };
  }

  labelFacets(user: User, mailboxId?: string): LabelFacet[] {
    const f = this.filter(user, mailboxId ? { mailboxId } : {});
    return this.store.labelCounts(f.mailboxIds).sort((a, b) => a.label.localeCompare(b.label, 'ja'));
  }

  private editable(user: User, id: string): { row: MessageRow; linked: string[] } {
    const { row, linked } = this.visible(id);
    if (!this.canEdit(user, linked)) throw new DomainError('forbidden', 'このメールの対応情報を編集する権限がありません。権限管理者に、受信箱の編集権限を依頼してください。');
    return { row, linked };
  }

  /** Any active committee account may be assigned, regardless of mailbox edit grants. */
  assigneeCandidates(user: User, id: string): AssigneeCandidate[] {
    this.visible(id);
    if (user.disabled) throw new DomainError('forbidden', 'このアカウントは利用できません。');
    return this.people.list()
      .filter((u) => !u.disabled)
      .map((u) => ({ id: u.id, displayName: u.displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
  }

  updateTriage(user: User, id: string, change: { expectedVersion: number; status?: HandlingStatus; assigneeId?: string | null; labels?: string[] }, now: string): TriageView {
    const { row } = this.visible(id);
    if (user.disabled) throw new DomainError('forbidden', 'このアカウントは利用できません。');
    const conflict = () =>
      new DomainError('conflict', '他の利用者が先に更新しました。最新の内容を確認してから、もう一度保存してください。', { current: this.triageView(this.store.message(id)!) });
    if (change.expectedVersion !== row.version) throw conflict();
    const current = { status: row.status, assigneeId: row.assignee_id, labels: JSON.parse(row.labels_json) as string[] };
    const next = { ...current, labels: [...current.labels] };
    if (change.assigneeId !== undefined && change.assigneeId !== current.assigneeId) {
      if (change.assigneeId !== null && !this.assigneeCandidates(user, id).some((c) => c.id === change.assigneeId)) {
        throw new DomainError('validation', '担当者には、利用できる委員アカウントを指定してください。', { field: 'assigneeId' });
      }
      next.assigneeId = change.assigneeId;
    }
    if (change.status !== undefined) next.status = change.status;
    if (change.labels !== undefined) next.labels = normalizeLabels(change.labels);
    const history: { action: 'assignee' | 'status' | 'labels'; from: string | null; to: string | null }[] = [];
    if (next.assigneeId !== current.assigneeId) {
      const name = (uid: string | null) => (uid ? this.name(uid) : null);
      history.push({ action: 'assignee', from: name(current.assigneeId), to: name(next.assigneeId) });
    }
    if (next.status !== current.status) history.push({ action: 'status', from: STATUS_LABELS[current.status], to: STATUS_LABELS[next.status] });
    if (next.labels.join('\u0000') !== current.labels.join('\u0000')) history.push({ action: 'labels', from: current.labels.join(', ') || null, to: next.labels.join(', ') || null });
    if (history.length === 0) return this.triageView(row);
    if (!this.store.updateTriage(id, change.expectedVersion, next, history, user.id, now)) throw conflict();
    return this.triageView(this.store.message(id)!);
  }

  /** The list and the top of a thread: one status for every message of the thread. */
  setThreadStatus(user: User, threadId: string, status: HandlingStatus, now: string): ThreadStatusResponse {
    if (user.disabled) throw new DomainError('forbidden', 'このアカウントは利用できません。');
    const f = this.filter(user, {});
    const changed = this.store.setThreadStatus(f, threadId, status, (s) => STATUS_LABELS[s], user.id, now);
    if (changed === null) throw notFound();
    return { threadId, statuses: unique(this.store.threadMessages(f, [threadId], false).map((m) => m.status)), changed };
  }

  addNote(user: User, id: string, body: string, now: string): NoteView {
    this.editable(user, id);
    const text = body.replace(/\r\n/g, '\n').trim();
    if (text.length === 0) throw new DomainError('validation', 'メモを入力してください。', { field: 'body' });
    if (text.length > LIMITS.noteMaxLength) throw new DomainError('validation', `メモは ${LIMITS.noteMaxLength} 文字以内で入力してください。`, { field: 'body' });
    const note = this.store.addNote(id, user.id, text, now);
    return { id: note.id, authorName: user.displayName, createdAt: now, body: text };
  }

  /** For task links: the message title and where it opens, or null when it cannot be read. */
  provenance(user: User, id: string): { label: string; href: string } | null {
    try {
      const { row } = this.visible(id);
      return { label: (this.hidden(user, row) ? SIGN_IN_MAIL_SUBJECT : row.subject) || '（件名なし）', href: `#/all?thread=${encodeURIComponent(row.thread_id)}` };
    } catch {
      return null;
    }
  }

  // ---- access administration (権限管理者)

  accessMatrix(): MailAccessResponse {
    const people = this.people.list().sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
    const known = new Set(people.map((p) => p.id));
    const summary = this.store.ingestSummary();
    return {
      people: people.map((p) => ({ id: p.id, displayName: p.displayName, roleLabel: p.roleLabel })),
      mailboxes: this.mailboxes.map((m) => ({ id: m.id, name: m.name, address: m.address })),
      grants: this.store.grants().filter((g) => known.has(g.user_id)).map((g) => ({ userId: g.user_id, mailboxId: g.mailbox_id })),
      sendGrants: this.store.sendGrants().filter((g) => known.has(g.user_id)).map((g) => ({ userId: g.user_id, mailboxId: g.mailbox_id })),
      sendable: this.sendable ? [...this.sendable] : null,
      departments: this.departments(people),
      departmentGrants: this.store.departmentGrants().map((g) => ({ department: g.department, mailboxId: g.mailbox_id, kind: g.kind })),
      ingest: { messages: summary.messages, latestStoredAt: summary.latestStoredAt, sources: summary.sources },
    };
  }

  /** The departments of the listed people, temporary staff left out, in Japanese order. */
  private departments(people: User[]): string[] {
    const all = new Set(people.filter((p) => !p.disabled).flatMap((p) => departmentsOfLabel(p.roleLabel)));
    all.delete(TEMPORARY_STAFF_DEPARTMENT);
    return [...all].sort((a, b) => a.localeCompare(b, 'ja'));
  }

  /**
   * A grant to a department: everyone whose Discord roles put them in it has it, now and later. Granting needs a
   * department someone is in (not temporary staff), and sending a mailbox the server can send from; removing is
   * always allowed.
   */
  setDepartmentGrant(actor: User, department: string, mailboxId: string, kind: 'edit' | 'send', on: boolean, now: string): MailAccessResponse {
    if (!this.mailbox(mailboxId)) throw new DomainError('validation', '存在しない受信箱です。');
    if (on) {
      if (!this.departments(this.people.list()).includes(department)) throw new DomainError('validation', 'この部局には今、委員がいません（Discord のロールで部局が決まります）。');
      if (kind === 'send' && !this.sendable?.includes(mailboxId)) throw new DomainError('validation', 'この受信箱のアドレスからは送信できない設定です（サーバーの send.mailboxes にありません）。');
    }
    this.store.setDepartmentGrant(department, mailboxId, kind, on, actor.id, now);
    return this.accessMatrix();
  }

  setGrant(actor: User, userId: string, mailboxId: string, edit: boolean, now: string): MailAccessResponse {
    if (!this.mailbox(mailboxId)) throw new DomainError('validation', '存在しない受信箱です。');
    if (!this.people.lookup(userId)) throw new DomainError('validation', 'このアカウントは見つからないか、利用できない状態です。');
    this.store.setGrant(userId, mailboxId, edit, actor.id, now);
    return this.accessMatrix();
  }

  /** Send grants exist only for the mailboxes the server can send from. Removing one is always allowed. */
  setSendGrant(actor: User, userId: string, mailboxId: string, send: boolean, now: string): MailAccessResponse {
    if (!this.mailbox(mailboxId)) throw new DomainError('validation', '存在しない受信箱です。');
    if (send && !this.sendable?.includes(mailboxId)) throw new DomainError('validation', 'この受信箱のアドレスからは送信できない設定です（サーバーの send.mailboxes にありません）。');
    // Taking a grant away needs no current account (someone who left the roster can still lose it).
    if (send && !this.people.lookup(userId)) throw new DomainError('validation', 'このアカウントは見つからないか、利用できない状態です。');
    this.store.setSendGrant(userId, mailboxId, send, actor.id, now);
    return this.accessMatrix();
  }
}

function snippetOf(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const first = terms[0];
  if (first) {
    const idx = normalizeForSearch(flat).indexOf(first);
    if (idx > 30) return `…${flat.slice(idx - 30, idx + 90)}`;
  }
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}
