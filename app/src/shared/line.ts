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
  /** The viewer may change the status here (list rows' buttons, 2026-11-04), and the version to change it from. */
  canSetStatus?: boolean;
  triageVersion?: number;
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
  /** oa_history: a row of the official account's own history file (2026-11-02), never a reply target. */
  provenance: 'legacy_export' | 'event_feed' | 'oa_history';
  /** oa_history only: the committee member who sent it (outgoing rows) and whether it was an automatic answer. */
  history?: { staff: string | null; autoReply: boolean };
  /** A received image the app can show (2026-11-04): signed-in route, read access checked. */
  imageUrl?: string;
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
  /** Where it was confirmed: the app's screen or a Discord thread (2026-11-02). */
  via?: 'app' | 'discord';
  /** One recipient of a broadcast (the broadcast's ID), or null. */
  broadcastId?: string | null;
  /** The image sent after the text (the preview, from this server), or null. */
  image?: { previewUrl: string } | null;
  /** All images sent after the text (2026-11-10; `image` is the first), and the files linked in the text. */
  images?: { previewUrl: string }[];
  files?: LineSentFileView[];
  /** Until when the images and file links were made public by this send, or null. */
  publicUntil?: string | null;
}

export interface LineDraftView {
  id: string;
  version: number;
  body: string;
  updatedAt: string;
  /** An uploaded image to send after the text (2026-11-02), and its preview on this server. */
  imageId?: string | null;
  imagePreviewUrl?: string | null;
  /** Up to four images and three files (2026-11-10). */
  images?: { id: string; previewUrl: string }[];
  files?: LineFileView[];
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
  /** An image can be attached (the server has a public URL for it), 2026-11-02. */
  imagesEnabled?: boolean;
  /** A file can be linked (2026-11-10). */
  filesEnabled?: boolean;
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
  /**
   * Where the signed-in person last read this conversation, on any device (2026-11-13): the time of the newest row
   * they had on the screen; null when they have not opened it yet. Absent: this server does not keep it (the screen
   * keeps it per device). Opening the conversation does not change it; the screen moves it with PUT …/read.
   */
  lastReadAt?: string | null;
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
  /** The image sent after the text, or null (2026-11-02). */
  image?: { previewUrl: string } | null;
  /** All images and the linked files (2026-11-10), and until when they are public (null: none attached). */
  images?: { previewUrl: string }[];
  files?: LineSentFileView[];
  publicUntil?: string | null;
  publicDays?: number | null;
  /** This month's messages from this app and its limit, and LINE's own count (null: not read). */
  monthUsed?: number;
  monthlyLimit?: number | null;
  lineUsage?: number | null;
  lineLimit?: number | null;
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

// ---- images and broadcasts (2026-11-02)

export const LINE_IMAGE_LIMITS = {
  originalMaxSide: 2048,
  originalMaxBytes: 10 * 1024 * 1024,
  previewMaxSide: 1024,
  previewMaxBytes: 1024 * 1024,
} as const;

export interface LineMediaResponse {
  id: string;
  previewUrl: string;
  expiresAt: string;
}

/**
 * Images and files with a message (2026-11-10). LINE has no file message, so a file goes as a link in the text:
 * the app publishes it under a name nobody can guess until the date the sender chose (1, 7 or 30 days). A message
 * is the text and up to four images (LINE takes five messages per request).
 */
export const LINE_ATTACH_LIMITS = {
  imagesMax: 4,
  filesMax: 3,
  fileMaxBytes: 15 * 1024 * 1024,
  publicDays: [1, 7, 30],
  defaultPublicDays: 7,
} as const;

export type LinePublicDays = (typeof LINE_ATTACH_LIMITS.publicDays)[number];

/** A file kept for sending: its display name, size and kind ("PDF", "Word" …). */
export interface LineFileView {
  id: string;
  name: string;
  bytes: number;
  kindLabel: string;
}

export interface LineFileResponse extends LineFileView {
  expiresAt: string;
}

/** A file as sent: the link in the text. */
export interface LineSentFileView {
  name: string;
  bytes: number;
  kindLabel: string;
  url: string;
}

export interface BroadcastRecipientView {
  conversationId: string;
  title: string;
  maskedId: string;
  /** The person is a known friend (else: not known; LINE delivers only to friends). */
  friend: boolean;
  latestAt: string | null;
}

export interface BroadcastOptionsResponse {
  account: { id: string; name: string };
  /** 1:1 conversations with a user ID that have not unfollowed or blocked. */
  recipients: BroadcastRecipientView[];
  monthUsed: number;
  monthlyLimit: number | null;
  imagesEnabled: boolean;
  /** Files can be linked (2026-11-10). */
  filesEnabled?: boolean;
  /** Mock connector (synthetic version). */
  mock: boolean;
}

export interface BroadcastPreviewResponse {
  consentId: string;
  expiresAt: string;
  account: { id: string; name: string };
  recipients: { conversationId: string; title: string; maskedId: string }[];
  count: number;
  body: string;
  image: { previewUrl: string } | null;
  images?: { previewUrl: string }[];
  files?: LineSentFileView[];
  publicUntil?: string | null;
  publicDays?: number | null;
  monthUsed: number;
  monthlyLimit: number | null;
  lineUsage: number | null;
  lineLimit: number | null;
  mock: boolean;
  notices: string[];
}

export interface BroadcastSendResponse {
  broadcastId: string;
  replayed: boolean;
  count: number;
  /** Per status: how many recipients. */
  statuses: Record<OutboxStatus, number>;
  message: string;
}
