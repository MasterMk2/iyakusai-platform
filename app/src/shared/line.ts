// LINE and integrated-inbox API contract shared by the server and the browser client.
// Only authorized, display-ready data appears here. External LINE IDs, retry keys,
// consent secrets and provenance cursors are deliberately absent (targets are masked).
import type { HandlingStatus, NoteView, ThreadListItem, TriageView } from './api.js';

export const LINE_LIMITS = {
  /** Text message limit of the Messaging API. */
  replyMaxLength: 5000,
} as const;

export type InboxSource = 'email' | 'line';
export type LineAccountKind = 'official_account' | 'legacy_archive';
export type LineTargetType = 'user' | 'group' | 'room' | 'legacy_chat';
export type LineLevel = 'none' | 'read' | 'edit';
export type LineSending = 'mock' | 'live' | 'none';

export interface LineAccountSummary {
  id: string;
  name: string;
  kind: LineAccountKind;
  access: Exclude<LineLevel, 'none'>;
  /** The viewer holds the separate reply capability for this account. */
  canReply: boolean;
  /** How replies go: the mock connector, LINE itself (2026-10-28), or not at all (read-only). */
  sending: LineSending;
  conversationCount: number;
  unhandledCount: number;
}

export interface LineInboxItem {
  source: 'line';
  conversationId: string;
  account: { id: string; name: string; kind: LineAccountKind };
  title: string;
  targetType: LineTargetType;
  latestAt: string;
  messageCount: number;
  matchCount: number;
  snippet: string;
  senders: string[];
  statuses: HandlingStatus[];
  labels: string[];
  assignees: string[];
}

export type InboxItem = ({ source: 'email' } & ThreadListItem) | LineInboxItem;

export interface InboxResponse {
  items: InboxItem[];
  total: number;
  page: number;
  pageSize: number;
  /** Matching items per source, after access control and filters. */
  counts: { email: number; line: number };
  /** LINE is configured for this server (not a statement about the viewer's access). */
  lineEnabled: boolean;
}

export type LineMessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'unsupported'; mediaType: string }
  | { kind: 'unavailable'; reason: 'e2ee' | 'missing' }
  | { kind: 'unsent' };

export interface LineMessageView {
  id: string;
  direction: 'inbound' | 'outbound_legacy';
  senderLabel: string;
  sentAt: string;
  content: LineMessageContent;
  provenance: 'legacy_export' | 'event_feed';
}

export type LineHistoryAction =
  | 'assignee'
  | 'status'
  | 'labels'
  | 'note_added'
  | 'message_unsent'
  | 'reply_started'
  | 'reply_retry'
  | 'reply_result';

export interface LineHistoryView {
  id: string;
  at: string;
  actorName: string;
  action: LineHistoryAction;
  from: string | null;
  to: string | null;
}

export interface LineTargetView {
  type: LineTargetType;
  /** Japanese description of the target kind, e.g. "1:1 トーク". */
  typeLabel: string;
  /** Last characters of the stored target ID only; null for legacy history. */
  maskedId: string | null;
  /** Known member count of a group/room (billable fan-out), when observed. */
  memberCount: number | null;
}

export type OutboxStatus = 'pending' | 'accepted' | 'failed' | 'unknown' | 'manual_review';

export interface OutboxAttemptView {
  n: number;
  startedAt: string;
  actorName: string;
  outcome: string | null;
  outcomeLabel: string;
}

export interface OutboxView {
  id: string;
  conversationId: string;
  createdAt: string;
  actorName: string;
  method: 'push';
  /** Sent through the mock connector (synthetic version), not to LINE. */
  mock: boolean;
  body: string;
  status: OutboxStatus;
  statusLabel: string;
  statusNote: string;
  retryable: boolean;
  retryNotBefore: string | null;
  attempts: OutboxAttemptView[];
  billableRecipients: number | null;
}

export interface LineDraftView {
  id: string;
  version: number;
  body: string;
  updatedAt: string;
}

export interface LineReplyState {
  /** Sending is possible for this viewer and target right now. */
  available: boolean;
  /** Viewer holds the reply capability for the account. */
  canReply: boolean;
  /** Why sending is not available (ordinary language), or null. */
  reason: string | null;
  /** The viewer's own saved draft only. */
  draft: LineDraftView | null;
}

export interface LineConversationDetail {
  conversationId: string;
  account: { id: string; name: string; kind: LineAccountKind };
  access: Exclude<LineLevel, 'none'>;
  sending: LineSending;
  /** Status, assignee and labels can be changed (committee: every reader; notes still need `access: 'edit'`). */
  canTriage: boolean;
  title: string;
  origin: 'legacy_export' | 'event_feed';
  target: LineTargetView;
  messages: LineMessageView[];
  triage: TriageView;
  notes: NoteView[];
  history: LineHistoryView[];
  reply: LineReplyState;
  outbox: OutboxView[];
}

export interface LinePreviewResponse {
  /** Opaque, single-use, short-lived confirmation reference. */
  consentId: string;
  expiresAt: string;
  draftId: string;
  draftVersion: number;
  account: { id: string; name: string };
  target: LineTargetView & { title: string };
  /** Exact normalized text that will be sent. */
  body: string;
  method: 'push';
  /** The mock connector (synthetic version); false: this goes to LINE. */
  mock: boolean;
  billableRecipients: number;
  notices: string[];
}

export interface LineSendResponse {
  replayed: boolean;
  outbox: OutboxView;
}

export interface LineAccessMatrixResponse {
  users: { id: string; displayName: string; roleLabel: string }[];
  accounts: { id: string; name: string; kind: LineAccountKind }[];
  grants: { userId: string; accountId: string; level: LineLevel; reply: boolean }[];
  version: number;
}

export interface LineIngestReport {
  imported: number;
  duplicates: number;
  conflicts: number;
  suppressed: number;
  rejected: number;
  unsent: number;
  stateEvents: number;
}

export const MOCK_PUSH_OUTCOMES = [
  'accept',
  'fail_before_accept',
  'accept_response_lost',
  'server_error',
  'rate_limited',
  'permission_denied',
  'not_configured',
  'ineligible',
] as const;
export type MockPushOutcome = (typeof MOCK_PUSH_OUTCOMES)[number];

export interface MockLineConnectorState {
  queued: MockPushOutcome[];
  acceptedCount: number;
}
