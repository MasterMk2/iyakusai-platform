import type { AccessLevel, Address, HandlingStatus } from '../../shared/api.js';

export interface User {
  id: string;
  displayName: string;
  roleLabel: string;
  email: string;
  /** Demo administrator: may change grants, but this never implies reading mail. */
  canManageAccess: boolean;
  /** Inactive account: a trusted-proxy identity may not map to it. */
  disabled?: boolean;
}

export interface Mailbox {
  id: string;
  name: string;
  address: string;
  /** Connector-side identifier. Hidden delivery metadata: never returned by the API. */
  sourceKey: string;
  /** Explicit operator classification. Missing/unknown/personal never permits shared mail. */
  scope?: 'committee-shared' | 'personal' | 'unknown';
}

/** Exact approved acquisition binding; aliases are separate entries, never inferred. */
export interface CommitteeSharedMailTarget {
  mailboxId: string;
  address: string;
  sourceKey: string;
  connectorId: string;
}

export interface CommitteeSharedMailReadPolicy {
  version: 1;
  mode: 'operator-approved' | 'synthetic-fixture';
  targets: CommitteeSharedMailTarget[];
  /** Only used by the loopback demo with reserved-domain mock targets. */
  syntheticCurrentMemberIds?: string[];
}

export interface Grant {
  userId: string;
  mailboxId: string;
  level: Exclude<AccessLevel, 'none'>;
}

export interface StoredAttachment {
  id: string;
  filename: string;
  contentType: string;
  /** UTF-8 text content of the synthetic attachment. */
  content: string;
}

/** Normalized message content, shared by every receipt of the same message. */
export interface Message {
  id: string;
  internetMessageId: string | null;
  contentHash: string;
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  sentAt: string;
  text: string | null;
  html: string | null;
  inReplyTo: string | null;
  references: string[];
  threadKey: string;
  attachments: StoredAttachment[];
}

/** Hidden delivery metadata. Kept for idempotency and diagnosis; never serialized to clients. */
export interface DeliveryMetadata {
  connectorId: string;
  sourceMailboxKey: string;
  providerMessageId: string;
  deliveredTo: string;
  rawHeaders: Record<string, string>;
}

export interface Note {
  id: string;
  authorId: string;
  createdAt: string;
  body: string;
}

export interface HistoryRecord {
  id: string;
  at: string;
  actorId: string;
  action: 'assignee' | 'status' | 'labels' | 'note_added';
  from: string | null;
  to: string | null;
}

export interface Triage {
  version: number;
  status: HandlingStatus;
  assigneeId: string | null;
  labels: string[];
}

/** One delivery of a message into one mailbox. Handling data is scoped here. */
export interface Receipt {
  id: string;
  mailboxId: string;
  messageId: string;
  threadId: string;
  receivedAt: string;
  delivery: DeliveryMetadata;
  triage: Triage;
  notes: Note[];
  history: HistoryRecord[];
}

export interface AuditRecord {
  id: string;
  at: string;
  actorId: string;
  action: 'grant_changed' | 'sync' | 'mock_batch_released' | 'reset';
  detail: string;
}

export interface MockConnectorState {
  releasedBatch: number;
  cursors: Record<string, number>;
}

export interface AppState {
  schemaVersion: 1;
  users: User[];
  mailboxes: Mailbox[];
  /** An absent policy denies mail reads and acquisition; saved legacy states are not upgraded silently. */
  committeeSharedMailReadPolicy?: CommitteeSharedMailReadPolicy;
  grants: Grant[];
  accessVersion: number;
  messages: Message[];
  receipts: Receipt[];
  audit: AuditRecord[];
  mockConnector: MockConnectorState;
  seq: number;
}

export type DomainErrorCode = 'not_found' | 'forbidden' | 'validation' | 'conflict' | 'unauthenticated';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: unknown;
  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Uniform response for unknown and unauthorized resources, so existence is not revealed. */
export function notFound(): DomainError {
  return new DomainError('not_found', '対象が見つからないか、閲覧権限がありません。');
}

export function nextId(state: AppState, prefix: string): string {
  state.seq += 1;
  return `${prefix}_${state.seq.toString(36).padStart(4, '0')}`;
}
