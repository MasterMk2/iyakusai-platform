import { LIMITS, STATUS_LABELS, type AssigneeCandidate, type AttachmentView, type HandlingStatus, type LabelFacet, type MailboxSummary, type NoteView, type ReceiptImagesView, type ReceiptView, type ThreadDetailResponse, type ThreadListResponse, type ThreadStatusResponse, type TriageView } from '../../shared/api.js';
import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT, type MailAccessResponse } from '../../shared/mailbox.js';
import { sanitizeMailHtml } from '../domain/sanitize.js';
import { normalizeLabels } from '../domain/triage.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { isDueDate, japaneseDay, jstDay, type MailDueResponse, type MessageDueView } from '../../shared/mailDue.js';
import type { CommitteeAddresses } from './addresses.js';
import { AUTO_ACTOR, AUTO_ACTOR_NAME, dueEntries, loadDue, messageDueView, NO_DUE, openDueRows, threadDueView, writeDue, type DueHistoryInput, type DueState } from './due.js';
import type { MailboxDefinition } from './config.js';
import { contentIdOf, eachLimited, imageSources, MAIL_IMAGE_MAX_BYTES, MAIL_IMAGES_TOTAL_BYTES, MAIL_REMOTE_IMAGES_MAX, remoteImageUrl, sniffMailImage, type RemoteImageFetch } from './images.js';
import { SIGN_IN_MAIL_SUBJECT, SIGN_IN_MAIL_TEXT } from './restricted.js';
import { approvalRequired, approvalRequiredMailboxesOf, departmentReviewGrants, departmentReviewMailboxes, reviewedMailboxes, reviewGrants, reviewMailboxesOf, setApprovalRequired, setDepartmentReviewGrant, setReviewGrant } from './approval-store.js';
import { normalizeForSearch, type AttachmentRow, type ListFilter, type MailboxStore, type MessageRow } from './store.js';

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
  /** Threads awaiting a reply, or with a deadline passed (2026-11-03). */
  due?: 'awaiting' | 'overdue';
  /** The nearest deadline first, instead of the newest activity first. */
  sort?: 'latest' | 'due';
  page: number;
  pageSize: number;
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];
/** Lines per list on the home screen's deadline card (the counts are not cut). */
const HOME_DUE_LIST = 5;

export class MailboxService {
  constructor(
    private readonly store: MailboxStore,
    private readonly addresses: CommitteeAddresses,
    private readonly people: People,
    /** Mailboxes the server can send from, or null when sending is not set up. */
    private readonly sendable: readonly string[] | null = null,
    /** The current time (ISO); the deadlines are judged by the Japan calendar day of it. */
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private get mailboxes(): readonly MailboxDefinition[] {
    return this.addresses.mailboxes;
  }

  private today(): string {
    return jstDay(this.clock());
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
  private hidden(user: User, row: Pick<MessageRow, 'subject' | 'from_address' | 'text'>): boolean {
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
      ...(query.due ? { due: { kind: query.due, today: this.today() } } : {}),
      ...(query.sort === 'due' ? { sort: 'due' as const } : {}),
    };
  }

  /** Mailboxes this person may edit (or send from, or review): their own grants and their departments' (2026-10-26). */
  grantedMailboxes(user: User, kind: 'edit' | 'send' | 'review'): Set<string> {
    if (user.disabled) return new Set();
    const departments = departmentsOfLabel(user.roleLabel).filter((d) => d !== TEMPORARY_STAFF_DEPARTMENT);
    if (kind === 'review') return new Set([...reviewMailboxesOf(this.store, user.id), ...departmentReviewMailboxes(this.store, departments)]);
    const own = kind === 'edit' ? this.store.editMailboxesOf(user.id) : this.store.sendMailboxesOf(user.id);
    return new Set([...own, ...this.store.departmentMailboxes(departments, kind)]);
  }

  /**
   * The From mailboxes of this person (2026-11-11), among those the server can send from. `direct`: they send at once
   * (a send grant, and not marked 承認必須 there). `approval`: their mail waits for a reviewer, which is every other
   * mailbox that has a reviewer at all, so nothing waits where nobody could approve it. Temporary staff write no mail.
   */
  writeMailboxes(user: User): { direct: Set<string>; approval: Set<string> } {
    const direct = new Set<string>();
    const approval = new Set<string>();
    if (user.disabled || !this.sendable || departmentsOfLabel(user.roleLabel).includes(TEMPORARY_STAFF_DEPARTMENT)) return { direct, approval };
    const send = this.grantedMailboxes(user, 'send');
    const required = approvalRequiredMailboxesOf(this.store, user.id);
    const reviewed = reviewedMailboxes(this.store);
    for (const id of this.sendable) {
      if (!this.mailbox(id)) continue;
      if (send.has(id) && !required.has(id)) direct.add(id);
      else if (reviewed.has(id)) approval.add(id);
    }
    return { direct, approval };
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
    const dues = loadDue(this.store, all.map((m) => m.id));
    const today = this.today();
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
        due: threadDueView(
          messages.map((m) => ({ status: m.status, due: dues.get(m.id) ?? NO_DUE })),
          today,
        ),
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
      ...(sanitized ? this.imageCounts(row.id, row.html!) : {}),
      attachments,
      triage: this.triageView(row),
      due: messageDueView(loadDue(this.store, [row.id]).get(row.id) ?? NO_DUE, row.status, this.today(), row.version, editable, this.addresses.isCommitteeAddress(row.from_address)),
      notes,
      history: this.store.history(row.id).map((h) => ({ id: String(h.id), at: h.at, actorName: h.actor_id === AUTO_ACTOR ? AUTO_ACTOR_NAME : this.name(h.actor_id), action: h.action, from: h.from_value, to: h.to_value })),
    };
  }

  private attachmentsByContentId(id: string): Map<string, AttachmentRow> {
    const out = new Map<string, AttachmentRow>();
    for (const a of this.store.attachments(id)) {
      const cid = a.content_id ? contentIdOf(`cid:${a.content_id}`) : null;
      if (cid && !out.has(cid)) out.set(cid, a);
    }
    return out;
  }

  private imageCounts(id: string, html: string): { inlineImages: number; remoteImages: number } {
    const sources = [...new Set(imageSources(html))];
    const byCid = this.attachmentsByContentId(id);
    return {
      inlineImages: sources.filter((src) => byCid.has(contentIdOf(src) ?? '')).length,
      remoteImages: sources.filter((src) => remoteImageUrl(src) !== null).length,
    };
  }

  /**
   * The HTML with its images as data: URIs: those the mail carries (cid:) always, those on other servers only with
   * `remote` (fetched by `fetchRemote`, public addresses only). Types are read from the bytes; too large, unreadable
   * or anything else stays blocked and is counted as failed.
   */
  async receiptImages(user: User, id: string, remote: boolean, fetchRemote: RemoteImageFetch): Promise<ReceiptImagesView> {
    const { row } = this.visible(id);
    if (row.html === null || this.hidden(user, row)) throw notFound();
    const sources = [...new Set(imageSources(row.html))];
    const byCid = this.attachmentsByContentId(row.id);
    const images = new Map<string, string>();
    let total = 0;
    let failed = 0;
    const keep = (src: string, data: Buffer | null) => {
      const type = data && data.length <= MAIL_IMAGE_MAX_BYTES ? sniffMailImage(data) : null;
      if (!data || !type || total + data.length > MAIL_IMAGES_TOTAL_BYTES) {
        failed += 1;
        return;
      }
      total += data.length;
      images.set(src, `data:${type};base64,${data.toString('base64')}`);
    };
    for (const src of sources) {
      const cid = contentIdOf(src);
      if (cid === null) continue;
      const attachment = byCid.get(cid);
      let data: Buffer | null;
      try {
        data = attachment && attachment.size <= MAIL_IMAGE_MAX_BYTES ? this.store.readAttachment(attachment) : null;
      } catch {
        data = null;
      }
      keep(src, data);
    }
    if (remote) {
      const remotes = sources.flatMap((src) => {
        const url = remoteImageUrl(src);
        return url ? [{ src, url }] : [];
      });
      failed += Math.max(0, remotes.length - MAIL_REMOTE_IMAGES_MAX);
      await eachLimited(remotes.slice(0, MAIL_REMOTE_IMAGES_MAX), 6, async ({ src, url }) => keep(src, await fetchRemote(url)));
    }
    return { sanitizedHtml: sanitizeMailHtml(row.html, images).html, shown: images.size, failed, remote };
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

  private dueViewOf(id: string, today: string, canEdit: boolean): MessageDueView {
    const row = this.store.message(id)!;
    return messageDueView(loadDue(this.store, [id]).get(id) ?? NO_DUE, row.status, today, row.version, canEdit, this.addresses.isCommitteeAddress(row.from_address));
  }

  /**
   * Sets, changes or removes a message's deadlines (2026-11-03): 対応期限 (responseDue) and 回答期限 (replyDue, which
   * makes the thread wait for a reply). Needs the mailbox edit grant, as notes do. `undefined` keeps a deadline,
   * `null` removes it. A 回答期限 can only be set on a mail the committee sent. The version must be the message's
   * current one, or the answer is a conflict with the newer state. Every change is in the history.
   */
  updateDue(user: User, id: string, change: { expectedVersion: number; responseDue?: string | null; replyDue?: string | null }, now: string): MessageDueView {
    const { row, linked } = this.visible(id);
    if (!this.canEdit(user, linked)) throw new DomainError('forbidden', '期限を付ける・変えるには、このメールの受信箱の編集権限が要ります。権限管理者に依頼してください。');
    const today = jstDay(now);
    const conflict = () => new DomainError('conflict', '他の利用者が先に更新しました。最新の内容を確認してから、もう一度保存してください。', { current: this.dueViewOf(id, today, true) });
    if (change.expectedVersion !== row.version) throw conflict();
    for (const [field, value] of [
      ['responseDue', change.responseDue],
      ['replyDue', change.replyDue],
    ] as const) {
      if (value !== undefined && value !== null && !isDueDate(value)) throw new DomainError('validation', '期限は、実在する日付（例：2026-11-10）で指定してください。', { field });
    }
    // Only a mail the committee sent can wait for a reply. Removing a wait (null) is allowed on any mail.
    if (typeof change.replyDue === 'string' && !this.addresses.isCommitteeAddress(row.from_address)) {
      throw new DomainError('validation', '回答期限は、委員会が送ったメールに付けます。受信したメールには付けられません。', { field: 'replyDue' });
    }
    const current = loadDue(this.store, [id]).get(id) ?? NO_DUE;
    const next: DueState = { responseDue: change.responseDue === undefined ? current.responseDue : change.responseDue, replyDue: current.replyDue, replySince: current.replySince };
    if (change.replyDue === null) {
      next.replyDue = null;
      next.replySince = null;
    } else if (change.replyDue !== undefined) {
      if (change.replyDue !== current.replyDue && change.replyDue < today) throw new DomainError('validation', '回答期限は今日以降の日付にしてください。', { field: 'replyDue' });
      next.replyDue = change.replyDue;
      next.replySince = current.replySince ?? now;
    }
    const day = (value: string | null) => (value === null ? null : japaneseDay(value, today));
    const history: DueHistoryInput[] = [];
    if (next.responseDue !== current.responseDue) history.push({ action: 'due', from: day(current.responseDue), to: day(next.responseDue) });
    if (next.replyDue !== current.replyDue) history.push({ action: 'reply_wait', from: current.replyDue === null ? null : `${day(current.replyDue)}まで`, to: next.replyDue === null ? null : `${day(next.replyDue)}まで` });
    if (history.length === 0) return this.dueViewOf(id, today, true);
    if (!writeDue(this.store, id, change.expectedVersion, next, history, user.id, now)) throw conflict();
    return this.dueViewOf(id, today, true);
  }

  /** The home screen's deadline lists (mail only): the reply waits passed and the response dues near or passed. */
  dueSummary(user: User): MailDueResponse {
    const today = this.today();
    const rows = openDueRows(this.store, this.mailboxes.map((m) => m.id));
    const links = this.store.links(rows.map((r) => r.message_id));
    const items = rows.map((row) => {
      const box = this.mailboxesOf(links.get(row.message_id));
      return { row, mailboxName: box[0]?.name ?? '', subject: this.hidden(user, row) ? SIGN_IN_MAIL_SUBJECT : row.subject || '（件名なし）' };
    });
    return { today, ...dueEntries(items, today, HOME_DUE_LIST) };
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
      departmentGrants: [
        ...this.store.departmentGrants().map((g) => ({ department: g.department, mailboxId: g.mailbox_id, kind: g.kind })),
        ...departmentReviewGrants(this.store).map((g) => ({ department: g.department, mailboxId: g.mailbox_id, kind: 'review' as const })),
      ],
      reviewGrants: reviewGrants(this.store).filter((g) => known.has(g.user_id)).map((g) => ({ userId: g.user_id, mailboxId: g.mailbox_id })),
      approvalRequired: approvalRequired(this.store).filter((g) => known.has(g.user_id)).map((g) => ({ userId: g.user_id, mailboxId: g.mailbox_id })),
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
  setDepartmentGrant(actor: User, department: string, mailboxId: string, kind: 'edit' | 'send' | 'review', on: boolean, now: string): MailAccessResponse {
    if (!this.mailbox(mailboxId)) throw new DomainError('validation', '存在しない受信箱です。');
    if (on) {
      if (!this.departments(this.people.list()).includes(department)) throw new DomainError('validation', 'この部局には今、委員がいません（Discord のロールで部局が決まります）。');
      if (kind !== 'edit' && !this.sendable?.includes(mailboxId)) throw new DomainError('validation', 'この受信箱のアドレスからは送信できない設定です（サーバーの send.mailboxes にありません）。');
    }
    if (kind === 'review') setDepartmentReviewGrant(this.store, department, mailboxId, on, actor.id, now);
    else this.store.setDepartmentGrant(department, mailboxId, kind, on, actor.id, now);
    return this.accessMatrix();
  }

  /**
   * A person's review grant (`review`) or their 承認必須 mark (`approval`), for a mailbox the server can send from
   * (2026-11-11). Taking one away needs no current account, as for a send grant.
   */
  setApprovalGrant(actor: User, userId: string, mailboxId: string, kind: 'review' | 'approval', on: boolean, now: string): MailAccessResponse {
    if (!this.mailbox(mailboxId)) throw new DomainError('validation', '存在しない受信箱です。');
    if (on && !this.sendable?.includes(mailboxId)) throw new DomainError('validation', 'この受信箱のアドレスからは送信できない設定です（サーバーの send.mailboxes にありません）。');
    if (on && !this.people.lookup(userId)) throw new DomainError('validation', 'このアカウントは見つからないか、利用できない状態です。');
    if (kind === 'review') setReviewGrant(this.store, userId, mailboxId, on, actor.id, now);
    else setApprovalRequired(this.store, userId, mailboxId, on, actor.id, now);
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
