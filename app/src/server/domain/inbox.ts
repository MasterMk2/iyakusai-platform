import type { HandlingStatus, LabelFacet } from '../../shared/api.js';
import type { InboxItem, InboxResponse } from '../../shared/line.js';
import { collectLineItems, lineLabelFacets, namesFrom } from '../line/queries.js';
import type { LineState } from '../line/types.js';
import { collectThreadItems, labelFacets } from './queries.js';
import { notFound, type AppState, type User } from './types.js';

// Integrated inbox: email threads and LINE conversations side by side. Each source
// applies its own ACL first (mailbox grants / LINE account grants), then filters;
// counting, merging and paging only ever see the permitted, matching items.
// Nothing is merged across sources: the same name or address stays two items.

export interface InboxQuery {
  source: 'all' | 'email' | 'line';
  mailboxId?: string;
  lineAccountId?: string;
  q?: string;
  status?: HandlingStatus;
  label?: string;
  assignee?: string;
  page: number;
  pageSize: number;
}

const latestOf = (item: InboxItem) => (item.source === 'email' ? item.latestReceivedAt : item.latestAt);
const idOf = (item: InboxItem) => (item.source === 'email' ? item.threadId : item.conversationId);

export function listInbox(mail: AppState, line: LineState | null, user: User, query: InboxQuery): InboxResponse {
  if (query.lineAccountId !== undefined && !line) throw notFound();
  const filters = { q: query.q, status: query.status, label: query.label, assignee: query.assignee };
  const email: InboxItem[] =
    query.source !== 'line' && query.lineAccountId === undefined
      ? collectThreadItems(mail, user, { ...filters, mailboxId: query.mailboxId }).map((t) => ({ source: 'email' as const, ...t }))
      : [];
  const lineItems: InboxItem[] =
    line && query.source !== 'email' && query.mailboxId === undefined
      ? collectLineItems(line, namesFrom(mail), user, { ...filters, accountId: query.lineAccountId })
      : [];
  const items = [...email, ...lineItems].sort((a, b) => latestOf(b).localeCompare(latestOf(a)) || idOf(a).localeCompare(idOf(b)));
  const start = (query.page - 1) * query.pageSize;
  return {
    items: items.slice(start, start + query.pageSize),
    total: items.length,
    page: query.page,
    pageSize: query.pageSize,
    counts: { email: email.length, line: lineItems.length },
    lineEnabled: line !== null,
  };
}

export function inboxLabels(mail: AppState, line: LineState | null, user: User, scope: { mailboxId?: string; lineAccountId?: string }): LabelFacet[] {
  if (scope.lineAccountId !== undefined && !line) throw notFound();
  const counts = new Map<string, number>();
  const add = (facets: LabelFacet[]) => facets.forEach((f) => counts.set(f.label, (counts.get(f.label) ?? 0) + f.count));
  if (scope.lineAccountId === undefined) add(labelFacets(mail, user, scope.mailboxId));
  if (line && scope.mailboxId === undefined) add(lineLabelFacets(line, user, scope.lineAccountId));
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label, 'ja'));
}
