import type { LineAccountKind, OutboxStatus } from '../../shared/line.js';
import type { Note, Triage } from '../domain/types.js';

// LINE state lives in its own file with its own kind and version, separate from
// the mail AppState, so enabling LINE never rewrites or mixes into existing mail data.

export const LINE_STATE_KIND = 'smm-line-state';
export const LINE_SCHEMA_VERSION = 1;

export interface LineAccount {
  id: string;
  name: string;
  kind: LineAccountKind;
  /**
   * Bot user ID that the existing, signature-verifying receiver reports as the
   * webhook `destination`. Binds normalized events to this account. Hidden from the API.
   * Null for legacy history, which has no verified official-account association.
   */
  destination: string | null;
  /** Outbound path: the mock connector, the Messaging API (2026-10-28), or none. */
  outbound: 'push_mock' | 'push' | 'disabled';
  /** Push messages this app may send in a calendar month (JST), counting a group once per member. */
  monthlyLimit?: number;
  /** Groups and rooms may be sent to (else read-only). Absent: allowed, as in the synthetic version. */
  allowGroups?: boolean;
}

/** A verified Messaging API recipient, taken only from validated events. */
export interface MessagingTarget {
  kind: 'messaging_api';
  type: 'user' | 'group' | 'room';
  id: string;
}

/** A chat from an old history export. Never a Messaging API recipient. */
export interface LegacyTarget {
  kind: 'legacy_chat';
  legacyKind: 'user' | 'group' | 'unknown';
  ref: string;
}

export type LineTarget = MessagingTarget | LegacyTarget;

/** Observed facts used for push eligibility. Older events never override newer ones. */
export interface Eligibility {
  relation: 'friend' | 'unfollowed' | 'joined' | 'left' | 'unknown';
  relationAt: string | null;
  /** Latest inbound 1:1 message from the user (7-day push window). */
  lastUserMessageAt: string | null;
  memberCount: number | null;
  memberCountAt: string | null;
}

export interface LineHistoryRecord {
  id: string;
  at: string;
  actorId: string;
  action: 'assignee' | 'status' | 'labels' | 'note_added' | 'message_unsent' | 'reply_started' | 'reply_retry' | 'reply_result';
  from: string | null;
  to: string | null;
}

export interface LineConversation {
  id: string;
  accountId: string;
  target: LineTarget;
  title: string;
  origin: 'legacy_export' | 'event_feed';
  eligibility: Eligibility;
  triage: Triage;
  notes: Note[];
  history: LineHistoryRecord[];
}

export type StoredLineContent =
  | { kind: 'text'; text: string }
  | { kind: 'unsupported'; mediaType: string }
  | { kind: 'unavailable'; reason: 'e2ee' | 'missing' }
  | { kind: 'unsent' };

export interface LineMessage {
  id: string;
  accountId: string;
  conversationId: string;
  /** Provider (or legacy export) message ID. Hidden from the API. */
  externalMessageId: string;
  direction: 'inbound' | 'outbound_legacy';
  /** Display label from the source. Never an identity and never linked across sources. */
  senderLabel: string;
  sentAt: string;
  importedAt: string;
  content: StoredLineContent;
  /** Hash of the normalized content for conflict detection; null once unsent. */
  fingerprint: string | null;
  provenance: { source: 'legacy_export' | 'event_feed'; batchId: string; cursor: string };
}

export interface ProcessedEvent {
  accountId: string;
  webhookEventId: string;
  /** Null once the referenced message was unsent (no body-derived value is kept). */
  fingerprint: string | null;
  messageId: string | null;
}

export interface Tombstone {
  accountId: string;
  externalMessageId: string;
  at: string;
}

export interface LineGrant {
  userId: string;
  accountId: string;
  level: 'read' | 'edit';
  /** Separate capability: may prepare and confirm manual replies. Requires read. */
  reply: boolean;
}

export interface ReplyDraft {
  id: string;
  conversationId: string;
  accountId: string;
  authorId: string;
  body: string;
  version: number;
  updatedAt: string;
}

export interface ReplyConsent {
  /** SHA-256 of the opaque consent token; the token itself is never stored. */
  tokenHash: string;
  actorId: string;
  draftId: string;
  draftVersion: number;
  accountId: string;
  conversationId: string;
  targetFingerprint: string;
  bodyHash: string;
  createdAt: string;
  expiresAt: string;
  consumedByIntentId: string | null;
}

export type AttemptOutcome =
  | 'accepted'
  | 'accepted_duplicate'
  | 'not_sent'
  | 'rate_limited'
  | 'permission_denied'
  | 'not_configured'
  | 'ineligible'
  | 'invalid'
  | 'unknown';

export interface OutboxAttempt {
  n: number;
  actorId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: AttemptOutcome | null;
  /** Provider request ID reference (mock). Never a token or header dump. */
  requestId: string | null;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
}

/** Immutable send intent. Recipient, account, body and retry key never change after creation. */
export interface OutboxIntent {
  id: string;
  operationId: string;
  actorId: string;
  accountId: string;
  conversationId: string;
  target: MessagingTarget;
  targetFingerprint: string;
  body: string;
  bodyHash: string;
  method: 'push';
  connector: 'mock' | 'messaging_api';
  /** Generated once per intent; reused for every explicit retry (X-Line-Retry-Key semantics). */
  retryKey: string;
  createdAt: string;
  billableRecipients: number;
  status: OutboxStatus;
  statusReason: string | null;
  retryNotBefore: string | null;
  attempts: OutboxAttempt[];
}

export interface LineAuditRecord {
  id: string;
  at: string;
  actorId: string;
  action: 'line_grant_changed' | 'line_import' | 'line_unsend' | 'line_reset';
  detail: string;
}

/** A grant to a department of the committee (everyone whose Discord roles put them in it, now and later). */
export interface LineDepartmentGrant {
  department: string;
  accountId: string;
  /** edit: notes. send: replies. */
  kind: 'edit' | 'send';
}

export interface LineState {
  kind: typeof LINE_STATE_KIND;
  schemaVersion: typeof LINE_SCHEMA_VERSION;
  /**
   * The committee's rules (2026-10-28, the same as its mailbox): every committee member reads and changes status,
   * assignee and labels; notes need an edit grant and replies a send grant, to the person or their department.
   * Absent: the per-account grants of the synthetic version.
   */
  committee?: true;
  departmentGrants?: LineDepartmentGrant[];
  accounts: LineAccount[];
  grants: LineGrant[];
  accessVersion: number;
  conversations: LineConversation[];
  messages: LineMessage[];
  processedEvents: ProcessedEvent[];
  tombstones: Tombstone[];
  feed: { releasedBatch: number; cursors: Record<string, string> };
  drafts: ReplyDraft[];
  consents: ReplyConsent[];
  outbox: OutboxIntent[];
  audit: LineAuditRecord[];
  seq: number;
}

export function nextLineId(state: LineState, prefix: string): string {
  state.seq += 1;
  return `${prefix}_${state.seq.toString(36).padStart(4, '0')}`;
}
