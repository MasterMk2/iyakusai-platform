import type {
  AttachmentView,
  HandlingStatus,
  LabelFacet,
  MailboxSummary,
  ReceiptView,
  ThreadDetailResponse,
  ThreadListItem,
  ThreadListResponse,
  TriageView,
} from '../../shared/api.js';
import { canEdit, canRead, displayName, findUser, permittedMailboxes, permittedReceipts, readableReceipt, readAccessLevel } from './access.js';
import { displayRecipients } from './recipients.js';
import { htmlToText, sanitizeMailHtml } from './sanitize.js';
import { notFound, type AppState, type Message, type Receipt, type User } from './types.js';

// Read paths. Each one starts from permittedReceipts()/readableReceipt(), so
// filtering, grouping, snippets, counts and paging only ever see receipts the
// current user may read. Nothing about other mailboxes is consulted.

export interface ThreadQuery {
  mailboxId?: string;
  q?: string;
  status?: HandlingStatus;
  label?: string;
  assignee?: string;
  page: number;
  pageSize: number;
}

function messageOf(state: AppState, receipt: Receipt): Message {
  const message = state.messages.find((m) => m.id === receipt.messageId);
  if (!message) throw new Error(`integrity: missing message for receipt ${receipt.id}`);
  return message;
}

function mailboxOf(state: AppState, receipt: Receipt) {
  const mailbox = state.mailboxes.find((m) => m.id === receipt.mailboxId);
  if (!mailbox) throw new Error(`integrity: missing mailbox for receipt ${receipt.id}`);
  return mailbox;
}

export function plainText(message: Message): string {
  if (message.text !== null) return message.text;
  if (message.html !== null) return htmlToText(message.html);
  return '';
}

export function normalizeForSearch(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function searchHaystack(message: Message): string {
  return normalizeForSearch(
    [message.subject, message.from.name ?? '', message.from.address, plainText(message), ...message.attachments.map((a) => a.filename)].join('\n'),
  );
}

function tokens(q: string | undefined): string[] {
  return q ? normalizeForSearch(q).split(/\s+/).filter(Boolean) : [];
}

function snippetOf(message: Message, terms: string[]): string {
  const text = plainText(message).replace(/\s+/g, ' ').trim();
  const first = terms[0];
  if (first) {
    const idx = normalizeForSearch(text).indexOf(first);
    if (idx > 30) return `…${text.slice(idx - 30, idx + 90)}`;
  }
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function matches(state: AppState, user: User, receipt: Receipt, query: Omit<ThreadQuery, 'page' | 'pageSize'>, terms: string[]): boolean {
  if (query.status && receipt.triage.status !== query.status) return false;
  if (query.label && !receipt.triage.labels.includes(query.label)) return false;
  if (query.assignee) {
    const target = query.assignee === 'me' ? user.id : query.assignee;
    if (query.assignee === 'none' ? receipt.triage.assigneeId !== null : receipt.triage.assigneeId !== target) return false;
  }
  if (terms.length > 0) {
    const hay = searchHaystack(messageOf(state, receipt));
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  return true;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function listThreads(state: AppState, user: User, query: ThreadQuery): ThreadListResponse {
  const items = collectThreadItems(state, user, query);
  const total = items.length;
  const start = (query.page - 1) * query.pageSize;
  return { items: items.slice(start, start + query.pageSize), total, page: query.page, pageSize: query.pageSize };
}

/** All matching, permitted thread items in list order (no paging). */
export function collectThreadItems(state: AppState, user: User, query: Omit<ThreadQuery, 'page' | 'pageSize'>): ThreadListItem[] {
  const permitted = permittedReceipts(state, user, query.mailboxId);
  const terms = tokens(query.q);

  const byThread = new Map<string, Receipt[]>();
  for (const r of permitted) byThread.set(r.threadId, [...(byThread.get(r.threadId) ?? []), r]);

  const matchedByThread = new Map<string, Receipt[]>();
  for (const r of permitted) {
    if (matches(state, user, r, query, terms)) matchedByThread.set(r.threadId, [...(matchedByThread.get(r.threadId) ?? []), r]);
  }

  const items: ThreadListItem[] = [...matchedByThread.entries()].map(([threadId, matched]) => {
    const all = [...(byThread.get(threadId) ?? [])].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const first = all[0]!;
    const latest = all[all.length - 1]!;
    const latestMatch = [...matched].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0]!;
    const mailbox = mailboxOf(state, first);
    return {
      threadId,
      mailbox: { id: mailbox.id, name: mailbox.name },
      subject: messageOf(state, first).subject,
      latestReceivedAt: latest.receivedAt,
      receiptCount: all.length,
      matchCount: matched.length,
      snippet: snippetOf(messageOf(state, latestMatch), terms),
      senders: unique(all.map((r) => {
        const from = messageOf(state, r).from;
        return from.name ?? from.address;
      })),
      statuses: unique(all.map((r) => r.triage.status)),
      labels: unique(all.flatMap((r) => r.triage.labels)).sort(),
      assignees: unique(all.flatMap((r) => (r.triage.assigneeId ? [displayName(state, r.triage.assigneeId)] : []))),
    };
  });

  items.sort((a, b) => b.latestReceivedAt.localeCompare(a.latestReceivedAt) || a.threadId.localeCompare(b.threadId));
  return items;
}

function triageView(state: AppState, user: User, receipt: Receipt): TriageView {
  const assigneeId = receipt.triage.assigneeId;
  const assigneeUser = assigneeId ? findUser(state, assigneeId) : undefined;
  return {
    version: receipt.triage.version,
    status: receipt.triage.status,
    labels: [...receipt.triage.labels],
    assignee: assigneeId
      ? {
          id: assigneeId,
          displayName: assigneeUser?.displayName ?? '（不明な利用者）',
          // Only editors of this mailbox learn whether the assignee still has access.
          ...(canEdit(state, user.id, receipt.mailboxId) ? { hasMailboxAccess: canRead(state, assigneeId, receipt.mailboxId) } : {}),
        }
      : null,
  };
}

export function receiptView(state: AppState, user: User, receipt: Receipt): ReceiptView {
  receipt = readableReceipt(state, user, receipt.id);
  const message = messageOf(state, receipt);
  const mailbox = mailboxOf(state, receipt);
  const level = readAccessLevel(state, user, mailbox.id);
  if (level === 'none') throw notFound();
  const sanitized = message.html !== null ? sanitizeMailHtml(message.html) : null;
  const attachments: AttachmentView[] = message.attachments.map((a) => ({
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    size: Buffer.byteLength(a.content, 'utf8'),
  }));
  return {
    receiptId: receipt.id,
    threadId: receipt.threadId,
    mailbox: { id: mailbox.id, name: mailbox.name, address: mailbox.address },
    access: level,
    receivedAt: receipt.receivedAt,
    subject: message.subject,
    from: message.from,
    to: displayRecipients(message.to, mailbox, state.mailboxes),
    cc: displayRecipients(message.cc, mailbox, state.mailboxes),
    text: plainText(message),
    hasHtml: message.html !== null,
    sanitizedHtml: sanitized?.html ?? null,
    blockedRemoteResources: sanitized?.blockedRemoteResources ?? 0,
    attachments,
    triage: triageView(state, user, receipt),
    notes: receipt.notes.map((n) => ({ id: n.id, authorName: displayName(state, n.authorId), createdAt: n.createdAt, body: n.body })),
    history: receipt.history.map((h) => ({ id: h.id, at: h.at, actorName: displayName(state, h.actorId), action: h.action, from: h.from, to: h.to })),
  };
}

export function getReceipt(state: AppState, user: User, receiptId: string): ReceiptView {
  return receiptView(state, user, readableReceipt(state, user, receiptId));
}

export function getThread(state: AppState, user: User, threadId: string): ThreadDetailResponse {
  const receipts = permittedReceipts(state, user)
    .filter((r) => r.threadId === threadId)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const first = receipts[0];
  if (!first) throw notFound();
  const mailbox = mailboxOf(state, first);
  return {
    threadId,
    mailbox: { id: mailbox.id, name: mailbox.name, address: mailbox.address },
    subject: messageOf(state, first).subject,
    receipts: receipts.map((r) => receiptView(state, user, r)),
  };
}

export function getAttachment(state: AppState, user: User, receiptId: string, attachmentId: string) {
  const receipt = readableReceipt(state, user, receiptId);
  const attachment = messageOf(state, receipt).attachments.find((a) => a.id === attachmentId);
  if (!attachment) throw notFound();
  return attachment;
}

export function labelFacets(state: AppState, user: User, mailboxId?: string): LabelFacet[] {
  const counts = new Map<string, number>();
  for (const r of permittedReceipts(state, user, mailboxId)) {
    for (const label of r.triage.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label, 'ja'));
}

export function mailboxSummaries(state: AppState, user: User): MailboxSummary[] {
  return permittedMailboxes(state, user).map((m) => {
    const receipts = permittedReceipts(state, user, m.id);
    return {
      id: m.id,
      name: m.name,
      address: m.address,
      access: readAccessLevel(state, user, m.id) as 'read' | 'edit',
      threadCount: new Set(receipts.map((r) => r.threadId)).size,
      unhandledCount: receipts.filter((r) => r.triage.status === 'unhandled').length,
    };
  });
}
