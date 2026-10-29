import type { HandlingStatus, LabelFacet, TriageView } from '../../shared/api.js';
import type { LineAccountSummary, LineConversationDetail, LineInboxItem, LineMessageView, LineSending } from '../../shared/line.js';
import { normalizeForSearch } from '../domain/queries.js';
import type { AppState, User } from '../domain/types.js';
import { canEditLine, canReadLine, canReplyLine, canTriageLine, lineGrant, permittedConversations, readableConversation } from './access.js';
import { evaluateTarget, outboxView, targetView } from './reply.js';
import type { LineAccount, LineConversation, LineMessage, LineState } from './types.js';

export const sendingOf = (account: LineAccount): LineSending => (account.outbound === 'push' ? 'live' : account.outbound === 'push_mock' ? 'mock' : 'none');

// LINE read paths. Each starts from permittedConversations()/readableConversation(),
// so filters, snippets, counts, facets and paging only see permitted accounts.
// People are never linked across sources or accounts by name, address or ID.

export interface LineQuery {
  accountId?: string;
  q?: string;
  status?: HandlingStatus;
  label?: string;
  assignee?: string;
}

export type NameOf = (userId: string) => string;

/** The people LINE shows names of and offers as assignees (the mail state, or the committee's Discord people). */
export type LinePeople = Pick<AppState, 'users'>;

export function namesFrom(mail: LinePeople): NameOf {
  return (id) => (id === 'system' ? 'システム（取り込み）' : (mail.users.find((u) => u.id === id)?.displayName ?? '（不明な利用者）'));
}

function accountOf(state: LineState, accountId: string) {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`integrity: missing LINE account ${accountId}`);
  return account;
}

/** Stable timeline order: send time, then ID, regardless of arrival order. */
export function messagesOf(state: LineState, conv: LineConversation): LineMessage[] {
  return state.messages
    .filter((m) => m.conversationId === conv.id)
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id));
}

function searchableText(m: LineMessage): string {
  return m.content.kind === 'text' ? m.content.text : '';
}

function snippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const first = terms[0];
  if (first) {
    const idx = normalizeForSearch(flat).indexOf(first);
    if (idx > 30) return `…${flat.slice(idx - 30, idx + 90)}`;
  }
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

function triageMatches(conv: LineConversation, user: User, q: LineQuery): boolean {
  if (q.status && conv.triage.status !== q.status) return false;
  if (q.label && !conv.triage.labels.includes(q.label)) return false;
  if (q.assignee) {
    const target = q.assignee === 'me' ? user.id : q.assignee;
    if (q.assignee === 'none' ? conv.triage.assigneeId !== null : conv.triage.assigneeId !== target) return false;
  }
  return true;
}

export function collectLineItems(state: LineState, names: NameOf, user: User, q: LineQuery): LineInboxItem[] {
  const terms = q.q ? normalizeForSearch(q.q).split(/\s+/).filter(Boolean) : [];
  const items: LineInboxItem[] = [];
  for (const conv of permittedConversations(state, user, q.accountId)) {
    if (!triageMatches(conv, user, q)) continue;
    const messages = messagesOf(state, conv);
    const account = accountOf(state, conv.accountId);
    const head = normalizeForSearch(`${conv.title}\n${account.name}`);
    const matched = terms.length === 0
      ? messages
      : messages.filter((m) => {
          const hay = `${head}\n${normalizeForSearch(`${m.senderLabel}\n${searchableText(m)}`)}`;
          return terms.every((t) => hay.includes(t));
        });
    const titleMatch = terms.length > 0 && terms.every((t) => head.includes(t));
    if (terms.length > 0 && matched.length === 0 && !titleMatch) continue;
    const latest = messages[messages.length - 1];
    const latestText = [...(matched.length > 0 ? matched : messages)].reverse().find((m) => m.content.kind === 'text');
    items.push({
      source: 'line',
      conversationId: conv.id,
      account: { id: account.id, name: account.name, kind: account.kind },
      title: conv.title,
      targetType: targetView(conv).type,
      latestAt: latest?.sentAt ?? conv.eligibility.relationAt ?? '1970-01-01T00:00:00.000Z',
      messageCount: messages.length,
      matchCount: terms.length === 0 ? messages.length : matched.length,
      snippet: latestText ? snippet(searchableText(latestText), terms) : '（表示できる本文はありません）',
      senders: [...new Set(messages.filter((m) => m.direction === 'inbound').map((m) => m.senderLabel))],
      statuses: [conv.triage.status],
      labels: [...conv.triage.labels].sort(),
      assignees: conv.triage.assigneeId ? [names(conv.triage.assigneeId)] : [],
    });
  }
  return items;
}

export function lineLabelFacets(state: LineState, user: User, accountId?: string): LabelFacet[] {
  const counts = new Map<string, number>();
  for (const c of permittedConversations(state, user, accountId)) for (const l of c.triage.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

export function lineAccountSummaries(state: LineState, user: User): LineAccountSummary[] {
  return state.accounts
    .filter((a) => canReadLine(state, user, a.id))
    .map((a) => {
      const convs = permittedConversations(state, user, a.id);
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        access: lineGrant(state, user, a.id).level as 'read' | 'edit',
        canReply: canReplyLine(state, user, a.id),
        sending: sendingOf(a),
        conversationCount: convs.length,
        unhandledCount: convs.filter((c) => c.triage.status === 'unhandled').length,
      };
    });
}

export function lineTriageView(state: LineState, mail: LinePeople, user: User, conv: LineConversation): TriageView {
  const id = conv.triage.assigneeId;
  const assignee = id ? mail.users.find((u) => u.id === id) : undefined;
  return {
    version: conv.triage.version,
    status: conv.triage.status,
    labels: [...conv.triage.labels],
    assignee: id
      ? {
          id,
          displayName: assignee?.displayName ?? '（不明な利用者）',
          ...(canEditLine(state, user, conv.accountId) ? { hasMailboxAccess: assignee ? canReadLine(state, assignee, conv.accountId) : false } : {}),
        }
      : null,
  };
}

function messageView(m: LineMessage): LineMessageView {
  return { id: m.id, direction: m.direction, senderLabel: m.senderLabel, sentAt: m.sentAt, content: m.content, provenance: m.provenance.source };
}

export function lineConversationDetail(state: LineState, mail: LinePeople, user: User, conversationId: string, now: string, inFlight: ReadonlySet<string>): LineConversationDetail {
  const conv = readableConversation(state, user, conversationId);
  const account = accountOf(state, conv.accountId);
  const names = namesFrom(mail);
  const nowMs = Date.parse(now);
  const canReply = canReplyLine(state, user, conv.accountId);
  const check = evaluateTarget(state, conv, nowMs);
  const draft = state.drafts.find((d) => d.conversationId === conv.id && d.authorId === user.id);
  return {
    conversationId: conv.id,
    account: { id: account.id, name: account.name, kind: account.kind },
    access: lineGrant(state, user, conv.accountId).level as 'read' | 'edit',
    sending: sendingOf(account),
    canTriage: canTriageLine(state, user, conv.accountId),
    title: conv.title,
    origin: conv.origin,
    target: targetView(conv),
    messages: messagesOf(state, conv).map(messageView),
    triage: lineTriageView(state, mail, user, conv),
    notes: conv.notes.map((n) => ({ id: n.id, authorName: names(n.authorId), createdAt: n.createdAt, body: n.body })),
    history: conv.history.map((h) => ({ id: h.id, at: h.at, actorName: names(h.actorId), action: h.action, from: h.from, to: h.to })),
    reply: {
      // A group whose member count is still unknown: the preview reads it from LINE.
      available: canReply && (check.ok || check.countPending === true),
      canReply,
      reason: !check.ok && !check.countPending ? check.reason : canReply ? null : 'この LINE アカウントで返信する権限がありません（閲覧・対応情報の権限とは別です）。',
      draft: canReply && draft ? { id: draft.id, version: draft.version, body: draft.body, updatedAt: draft.updatedAt } : null,
    },
    outbox: state.outbox
      .filter((o) => o.conversationId === conv.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map((o) => outboxView(o, names, nowMs, inFlight.has(o.id))),
  };
}
