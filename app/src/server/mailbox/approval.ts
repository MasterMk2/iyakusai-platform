import { randomBytes } from 'node:crypto';
import {
  MAIL_APPROVAL_COMMENT_MAX,
  MAIL_APPROVAL_EDIT_FIELDS,
  MAIL_APPROVAL_FIELD_LABELS,
  MAIL_APPROVAL_NOTE_MAX,
  MAIL_APPROVAL_OPEN_MAX,
  SEND_UNKNOWN,
  type MailApprovalCounts,
  type MailApprovalDetail,
  type MailApprovalEditField,
  type MailApprovalEditRequest,
  type MailApprovalMessage,
  type MailApprovalsResponse,
  type MailApprovalSubmitRequest,
  type MailApprovalSummary,
  type MailSendRequest,
} from '../../shared/mailbox.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';
import type { CommitteeAddresses } from './addresses.js';
import { APPROVAL_NOTICE_MAX_TARGETS, type ApprovalNoticeKind, type ApprovalNotifier } from './approval-notice.js';
import {
  changeRequest,
  finishedRequestsOf,
  insertRequest,
  openRequestsOf,
  pendingForReview,
  requestAttachmentFiles,
  requestAttachments,
  requestById,
  requestBySubmitToken,
  requestHistory,
  returnedCountOf,
  waitingCountOf,
  type RequestAttachment,
  type SendRequestRow,
} from './approval-store.js';
import type { OutgoingAttachment } from './compose.js';
import type { MailboxDefinition } from './config.js';
import type { MailSender } from './send.js';
import type { MailboxService, People } from './service.js';
import type { MailboxStore } from './store.js';

// Approval before sending (2026-11-11). A member whose mail from a mailbox needs an approval (no send grant
// there, or marked 承認必須) asks for it instead of sending: the mail and its files are kept here. A reviewer of
// that mailbox (the review grant) approves it — it is then sent at once, with the author as the sender of
// record and the reviewer in the request's history — or changes it first, or returns it with a comment. The
// author changes a returned mail and asks again, or withdraws it. Nobody approves their own mail.
// Who reads a request: its author and the reviewers of its mailbox. Anyone else gets "not found".

const FINISHED_LIST = 30;
/** A request still "sending" after this long was cut off (the app stopped): it may have gone out. */
const SENDING_STALE_MS = 10 * 60_000;

const validation = (message: string, field: string) => new DomainError('validation', message, { field });
const conflict = () => new DomainError('conflict', '他の人が先にこの依頼を更新しました。最新の内容を確かめてから、もう一度操作してください。');

function messageOf(request: Omit<MailSendRequest, 'clientToken' | 'mailboxId'>): MailApprovalMessage {
  return {
    to: request.to,
    cc: request.cc,
    bcc: request.bcc,
    subject: request.subject.trim(),
    body: request.body,
    replyTo: request.replyTo?.trim() || null,
    replyDue: request.replyDue ?? null,
    replyToReceiptId: request.replyToReceiptId,
    markThreadDone: request.markThreadDone,
  };
}

const sameField = (a: MailApprovalMessage, b: MailApprovalMessage, field: MailApprovalEditField) => JSON.stringify(a[field]) === JSON.stringify(b[field]);

function stored(files: OutgoingAttachment[]): Omit<RequestAttachment, 'idx'>[] {
  return files.map((f) => ({ filename: f.filename, content_type: f.contentType, size: f.content.length, content: f.content }));
}

export class MailApprovals {
  constructor(
    private readonly store: MailboxStore,
    private readonly addresses: CommitteeAddresses,
    private readonly people: People,
    private readonly service: MailboxService,
    private readonly sender: MailSender,
    /** Tells people on Discord (approval-notice.ts); absent: only the counts on the screens tell. */
    private readonly notifier: ApprovalNotifier | null = null,
  ) {}

  /** The reviewers of a request's mailbox, its author left out. */
  private reviewersOf(row: SendRequestRow): User[] {
    return this.people
      .list()
      .filter((u) => !u.disabled && u.id !== row.author_id && this.service.grantedMailboxes(u, 'review').has(row.mailbox_id))
      .slice(0, APPROVAL_NOTICE_MAX_TARGETS);
  }

  /** Tells the reviewers (a request arrived) or the author (approved, returned). Never fails the step it follows. */
  private notify(kind: ApprovalNoticeKind, actor: User, id: string): void {
    if (!this.notifier) return;
    try {
      const row = requestById(this.store, id);
      const author = row ? this.people.lookup(row.author_id) : undefined;
      if (!row) return;
      const targets = kind === 'requested' ? this.reviewersOf(row) : author && !author.disabled ? [author] : [];
      if (targets.length === 0) return;
      this.notifier({ kind, requestId: row.id, version: row.version, actor, targets, mailboxName: this.mailboxOf(row).name, authorName: this.name(row.author_id) });
    } catch {
      // The step is done; the screens show it.
    }
  }

  private name(userId: string): string {
    return this.people.lookup(userId)?.displayName ?? '（不明な利用者）';
  }

  private mailboxOf(row: SendRequestRow): MailboxDefinition {
    const box = this.addresses.mailboxes.find((m) => m.id === row.mailbox_id);
    if (!box) throw notFound();
    return box;
  }

  private canReview(user: User, row: SendRequestRow): boolean {
    return row.author_id !== user.id && this.service.grantedMailboxes(user, 'review').has(row.mailbox_id);
  }

  /** The request, when this person may read it. */
  private readable(user: User, id: string): SendRequestRow {
    const row = requestById(this.store, id);
    if (!row || user.disabled || (row.author_id !== user.id && !this.canReview(user, row))) throw notFound();
    return row;
  }

  private state(row: SendRequestRow, now: Date): SendRequestRow['state'] {
    return row.state === 'sending' && now.getTime() - Date.parse(row.updated_at) > SENDING_STALE_MS ? 'unknown' : row.state;
  }

  private summary(user: User, row: SendRequestRow, now: Date): MailApprovalSummary {
    const box = this.mailboxOf(row);
    const message = JSON.parse(row.message_json) as MailApprovalMessage;
    const state = this.state(row, now);
    return {
      id: row.id,
      state,
      version: row.version,
      mailbox: { id: box.id, name: box.name, address: box.address },
      subject: message.subject,
      to: message.to,
      authorName: this.name(row.author_id),
      mine: row.author_id === user.id,
      canReview: state === 'pending' && this.canReview(user, row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decidedByName: row.decided_by ? this.name(row.decided_by) : null,
      decidedAt: row.decided_at,
    };
  }

  private detail(user: User, row: SendRequestRow, now: Date): MailApprovalDetail {
    const message = JSON.parse(row.message_json) as MailApprovalMessage;
    const submitted = JSON.parse(row.submitted_json) as MailApprovalMessage;
    const changedFields = MAIL_APPROVAL_EDIT_FIELDS.filter((f) => !sameField(message, submitted, f));
    const author = this.people.lookup(row.author_id);
    const holders = [user, ...(author ? [author] : [])];
    return {
      ...this.summary(user, row, now),
      message,
      submitted: changedFields.length > 0 ? submitted : null,
      changedFields,
      note: row.note,
      returnComment: row.state === 'returned' ? row.return_comment : null,
      attachments: requestAttachments(this.store, row.id).map((a) => ({ idx: a.idx, filename: a.filename, contentType: a.content_type, size: a.size })),
      replyThread: message.replyToReceiptId ? this.replyThread(user, message.replyToReceiptId) : null,
      sentThreadId: row.sent_thread_id,
      canSetDue: holders.some((u) => this.service.grantedMailboxes(u, 'edit').has(row.mailbox_id)),
      history: requestHistory(this.store, row.id).map((h) => ({ at: h.at, actorName: this.name(h.actor_id), action: h.action, detail: h.detail })),
    };
  }

  private replyThread(user: User, receiptId: string): { threadId: string; subject: string } | null {
    try {
      const receipt = this.service.getReceipt(user, receiptId);
      return { threadId: receipt.threadId, subject: receipt.subject };
    } catch {
      return null;
    }
  }

  counts(user: User): MailApprovalCounts {
    if (user.disabled) return { toReview: 0, returned: 0 };
    const reviewed = [...this.service.grantedMailboxes(user, 'review')];
    return { toReview: pendingForReview(this.store, reviewed, user.id).length, returned: returnedCountOf(this.store, user.id) };
  }

  list(user: User, now: Date): MailApprovalsResponse {
    const reviewed = [...this.service.grantedMailboxes(user, 'review')];
    const known = (row: SendRequestRow) => this.addresses.mailboxes.some((m) => m.id === row.mailbox_id);
    const view = (rows: SendRequestRow[]) => rows.filter(known).map((r) => this.summary(user, r, now));
    return {
      reviewer: reviewed.length > 0,
      review: view(pendingForReview(this.store, reviewed, user.id)),
      mine: view(openRequestsOf(this.store, user.id)),
      done: view(finishedRequestsOf(this.store, user.id, FINISHED_LIST)),
    };
  }

  get(user: User, id: string, now: Date): MailApprovalDetail {
    return this.detail(user, this.readable(user, id), now);
  }

  attachment(user: User, id: string, idx: number): { filename: string; content: Buffer } {
    const row = this.readable(user, id);
    const file = requestAttachmentFiles(this.store, row.id).find((a) => a.idx === idx);
    if (!file) throw notFound();
    return { filename: file.filename, content: file.content };
  }

  private note(value: string): string {
    const note = value.replace(/\r\n/g, '\n').trim();
    if (note.length > MAIL_APPROVAL_NOTE_MAX) throw validation(`校閲者へのひとことは ${MAIL_APPROVAL_NOTE_MAX} 文字以内にしてください。`, 'note');
    return note;
  }

  /** The From mailbox, when this person's mail from it goes through an approval. */
  private approvalMailbox(user: User, mailboxId: string): MailboxDefinition {
    const from = this.service.writeMailboxes(user).approval.has(mailboxId) ? this.sender.sendableMailbox(mailboxId) : null;
    if (!from) throw new DomainError('forbidden', 'この受信箱では承認の依頼ができません（校閲者がいないか、送信できない受信箱です）。権限管理者に確かめてください。');
    return from;
  }

  /** Asks for an approval. The same clientToken again (an answer lost on the way) answers with the first request. */
  submit(user: User, request: MailApprovalSubmitRequest, attachments: OutgoingAttachment[], now: Date): MailApprovalDetail {
    if (user.disabled) throw new DomainError('forbidden', 'このアカウントは利用できません。');
    const known = requestBySubmitToken(this.store, request.clientToken);
    if (known) {
      if (known.author_id !== user.id) throw conflict();
      return this.detail(user, known, now);
    }
    const from = this.approvalMailbox(user, request.mailboxId);
    const note = this.note(request.note);
    this.sender.check([user], from, request, attachments, now);
    if (waitingCountOf(this.store, user.id) >= MAIL_APPROVAL_OPEN_MAX) {
      throw new HttpError(429, { error: 'too_many_requests', message: `承認待ち・差し戻しのメールは ${MAIL_APPROVAL_OPEN_MAX} 通までです。送られるのを待つか、取り下げてから出してください。` });
    }
    const id = `ar_${randomBytes(8).toString('hex')}`;
    insertRequest(
      this.store,
      { id, author_id: user.id, mailbox_id: from.id, message_json: JSON.stringify(messageOf(request)), note, submit_token: request.clientToken, send_token: randomBytes(24).toString('hex') },
      stored(attachments),
      now.toISOString(),
    );
    this.notify('requested', user, id);
    return this.detail(user, requestById(this.store, id)!, now);
  }

  /**
   * The author's new version of a returned mail, asked again. `keepAttachments` are the files kept from the earlier
   * version; the new files follow them.
   */
  resubmit(user: User, id: string, request: MailApprovalSubmitRequest, attachments: OutgoingAttachment[], now: Date): MailApprovalDetail {
    const row = this.readable(user, id);
    if (row.author_id !== user.id) throw new DomainError('forbidden', '出し直せるのは、書いた本人だけです。');
    // The same form sent again after its answer was lost.
    if (row.submit_token === request.clientToken) return this.detail(user, row, now);
    if (row.state !== 'returned' || request.expectedVersion !== row.version) throw conflict();
    if (request.mailboxId !== row.mailbox_id) throw validation('出し直すときは、差出人の受信箱を変えられません。変えるときは取り下げて、新しく書いてください。', 'mailboxId');
    const from = this.approvalMailbox(user, row.mailbox_id);
    const note = this.note(request.note);
    const keep = new Set(request.keepAttachments ?? []);
    const kept = requestAttachmentFiles(this.store, row.id).filter((a) => keep.has(a.idx));
    const files = [...kept.map(({ filename, content_type, size, content }) => ({ filename, content_type, size, content })), ...stored(attachments)];
    this.sender.check([user], from, request, files, now);
    const message = JSON.stringify(messageOf(request));
    const done = changeRequest(
      this.store,
      row.id,
      row.version,
      ['returned'],
      { state: 'pending', message_json: message, submitted_json: message, note, submit_token: request.clientToken, attachments: files },
      { actorId: user.id, action: 'resubmitted' },
      now.toISOString(),
    );
    if (!done) throw conflict();
    this.notify('requested', user, row.id);
    return this.detail(user, requestById(this.store, row.id)!, now);
  }

  /** The request as a reviewer may act on it now: waiting, in a mailbox they review, at the version they read. */
  private reviewable(user: User, id: string, expectedVersion: number): SendRequestRow {
    const row = this.readable(user, id);
    if (!this.canReview(user, row)) throw new DomainError('forbidden', row.author_id === user.id ? '自分が書いたメールは、自分では承認・差し戻しできません。ほかの校閲者に頼んでください。' : 'この受信箱の校閲権限がありません。');
    if (row.state !== 'pending' || row.version !== expectedVersion) throw conflict();
    return row;
  }

  /** A reviewer changes the mail before approving; what the author asked for stays in submitted_json. */
  edit(user: User, id: string, change: MailApprovalEditRequest, now: Date): MailApprovalDetail {
    const row = this.reviewable(user, id, change.expectedVersion);
    const current = JSON.parse(row.message_json) as MailApprovalMessage;
    const next: MailApprovalMessage = { ...current, to: change.to, cc: change.cc, bcc: change.bcc, subject: change.subject.trim(), body: change.body, replyTo: change.replyTo?.trim() || null, replyDue: change.replyDue };
    const changed = MAIL_APPROVAL_EDIT_FIELDS.filter((f) => !sameField(current, next, f));
    if (changed.length === 0) return this.detail(user, row, now);
    const author = this.people.lookup(row.author_id);
    const files = requestAttachmentFiles(this.store, row.id);
    this.sender.check([user, ...(author ? [author] : [])], this.mailboxOf(row), { ...next, mailboxId: row.mailbox_id }, files, now);
    const done = changeRequest(
      this.store,
      row.id,
      row.version,
      ['pending'],
      { message_json: JSON.stringify(next) },
      { actorId: user.id, action: 'edited', detail: changed.map((f) => MAIL_APPROVAL_FIELD_LABELS[f]).join('・') },
      now.toISOString(),
    );
    if (!done) throw conflict();
    return this.detail(user, requestById(this.store, row.id)!, now);
  }

  returnToAuthor(user: User, id: string, expectedVersion: number, comment: string, now: Date): MailApprovalDetail {
    const row = this.reviewable(user, id, expectedVersion);
    const text = comment.replace(/\r\n/g, '\n').trim();
    if (!text) throw validation('差し戻す理由（直してほしい所）を書いてください。', 'comment');
    if (text.length > MAIL_APPROVAL_COMMENT_MAX) throw validation(`差し戻しの理由は ${MAIL_APPROVAL_COMMENT_MAX} 文字以内にしてください。`, 'comment');
    const at = now.toISOString();
    if (!changeRequest(this.store, row.id, row.version, ['pending'], { state: 'returned', return_comment: text, decided_by: user.id, decided_at: at }, { actorId: user.id, action: 'returned', detail: text }, at)) throw conflict();
    this.notify('returned', user, row.id);
    return this.detail(user, requestById(this.store, row.id)!, now);
  }

  /** The author takes the request back (while it waits or after it was returned); its files are deleted. */
  withdraw(user: User, id: string, expectedVersion: number, now: Date): MailApprovalDetail {
    const row = this.readable(user, id);
    if (row.author_id !== user.id) throw new DomainError('forbidden', '取り下げられるのは、書いた本人だけです。');
    if (!changeRequest(this.store, row.id, expectedVersion, ['pending', 'returned'], { state: 'withdrawn', dropAttachments: true }, { actorId: user.id, action: 'withdrawn' }, now.toISOString())) throw conflict();
    return this.detail(user, requestById(this.store, row.id)!, now);
  }

  /**
   * Approves and sends. The request is first marked "sending" at the version the reviewer read, so a second
   * approval (or a change meanwhile) is a conflict; the send itself uses the request's own token, so it can never
   * go out twice. A send the mail server refused leaves the request waiting; one cut off on the way is "unknown".
   */
  async approve(user: User, id: string, expectedVersion: number, now: Date): Promise<MailApprovalDetail> {
    const row = this.reviewable(user, id, expectedVersion);
    const author = this.people.lookup(row.author_id);
    if (!author || author.disabled) throw new DomainError('forbidden', '書いた人のアカウントが利用できないため、送れません。差し戻すか、書いた人に確かめてください。');
    const at = now.toISOString();
    if (!changeRequest(this.store, row.id, row.version, ['pending'], { state: 'sending', decided_by: user.id, decided_at: at }, { actorId: user.id, action: 'approved' }, at)) throw conflict();
    const message = JSON.parse(row.message_json) as MailApprovalMessage;
    const files = requestAttachmentFiles(this.store, row.id).map((a) => ({ filename: a.filename, contentType: a.content_type, content: a.content }));
    const back = (action: 'send_failed' | 'send_unknown', detail: string | null) =>
      changeRequest(this.store, row.id, null, ['sending'], action === 'send_failed' ? { state: 'pending', decided_by: null, decided_at: null } : { state: 'unknown' }, { actorId: user.id, action, detail }, new Date().toISOString());
    try {
      const result = await this.sender.sendApproved(author, user, { ...message, clientToken: row.send_token, mailboxId: row.mailbox_id }, files, now);
      changeRequest(this.store, row.id, null, ['sending'], { state: 'sent', sent_thread_id: result.threadId, dropAttachments: true }, { actorId: user.id, action: 'sent' }, new Date().toISOString());
      this.notify('approved', user, row.id);
    } catch (err) {
      const code = err instanceof HttpError ? err.body.error : null;
      if (code === SEND_UNKNOWN) {
        back('send_unknown', null);
        throw err;
      }
      // Refused before anything went out (a rule of the mail, the hourly limit, the mail server): it waits again.
      back('send_failed', err instanceof Error ? err.message.slice(0, 300) : null);
      if (code === 'send_failed') {
        throw new HttpError(502, { error: 'send_failed', message: 'メールを送れませんでした。メールは送られていません。承認待ちのまま残っているので、少し待ってからもう一度「承認して送信」を押してください。' });
      }
      throw err;
    }
    return this.detail(user, requestById(this.store, row.id)!, now);
  }
}
