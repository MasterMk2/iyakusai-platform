// API contract shared by the server and the browser client.
// Only authorized, display-ready data appears here. Hidden delivery metadata
// (connector keys, provider IDs, raw headers) is deliberately absent.

export const HANDLING_STATUSES = ['unhandled', 'in_progress', 'on_hold', 'done'] as const;
export type HandlingStatus = (typeof HANDLING_STATUSES)[number];

export const STATUS_LABELS: Record<HandlingStatus, string> = {
  unhandled: '未対応',
  in_progress: '対応中',
  on_hold: '保留',
  done: '完了',
};

export type AccessLevel = 'none' | 'read' | 'edit';

export const LIMITS = {
  labelMaxLength: 20,
  labelsPerReceipt: 8,
  noteMaxLength: 2000,
  queryMaxLength: 100,
  pageSizeMax: 100,
} as const;

/** Rows per page the thread list offers; the first is the default. */
export const PAGE_SIZE_CHOICES = [5, 10, 20, 50, 100] as const;

export interface SessionUser {
  id: string;
  displayName: string;
  roleLabel: string;
  canManageAccess: boolean;
}

export interface DemoSessionResponse {
  demoAuthentication: true;
  user: SessionUser | null;
}

/** Identity verified by an allowlisted reverse proxy. Data is still synthetic mock data. */
export interface ProxySessionResponse {
  demoAuthentication: false;
  authMode: 'trusted-proxy';
  user: SessionUser;
}

/**
 * Account login (verified Discord binding + effective Group membership, own password).
 * `mock` = loopback composition with synthetic providers; `production` = operator providers.
 */
export interface AccountSessionResponse {
  demoAuthentication: false;
  authMode: 'account';
  composition: 'production' | 'mock';
  user: SessionUser | null;
  passwordPolicy: { minLength: number; maxLength: number };
}

/**
 * Discord account login of the common app: registration from Discord `/register`, sign-in with the
 * student ID (or iy- ID) and password, sessions kept on the device for `sessionDays`.
 */
export interface DiscordSessionResponse {
  demoAuthentication: false;
  authMode: 'discord';
  user: SessionUser | null;
  account: { initialLoginId: string; studentId: string | null; temporaryStaff: boolean; departments: string[]; signIn: SignInSummary } | null;
  /** The Bot host could not be reached; the last confirmed membership is being used. */
  degraded: boolean;
  passwordPolicy: { minLength: number; maxLength: number };
  sessionDays: number;
}

export type SessionResponse = DemoSessionResponse | ProxySessionResponse | AccountSessionResponse | DiscordSessionResponse;

/** Shown at sign-in: the sign-in before this one and the wrong passwords for the account since then. */
export interface SignInSummary {
  previousLoginAt: string | null;
  failedSince: number;
}

export type LoginEventKind =
  | 'login_ok'
  | 'login_failed'
  | 'login_blocked'
  | 'password_failed'
  | 'register_ok'
  | 'register_failed'
  | 'register_blocked'
  | 'code_issued'
  | 'code_bulk_issued';

/** Sign-in records for access administrators (GET /api/auth/admin/activity). No secrets. */
export interface LoginActivityResponse {
  accounts: {
    initialLoginId: string;
    name: string | null;
    studentId: string | null;
    status: 'pending' | 'active' | 'retired';
    lastLoginAt: string | null;
    failedSinceLogin: number;
    failures24h: number;
    limited: boolean;
    pendingCode: { expiresAt: string; bulk: boolean; attempts: number } | null;
    sessions: number;
  }[];
  events: {
    at: string;
    kind: LoginEventKind;
    /** The typed login ID (only when it has the shape of one). */
    loginId: string | null;
    account: string | null;
    name: string | null;
    client: string | null;
    reason: string | null;
  }[];
  days: number;
  limits: { accountTriesPer10Min: number; accountFailuresPerDay: number; clientFailures: number; clientWindowMinutes: number };
}

export interface Persona {
  id: string;
  displayName: string;
  roleLabel: string;
}

export interface MailboxSummary {
  id: string;
  name: string;
  address: string;
  access: Exclude<AccessLevel, 'none'>;
  threadCount: number;
  unhandledCount: number;
}

export interface Address {
  name: string | null;
  address: string;
}

export interface ThreadListItem {
  threadId: string;
  mailbox: { id: string; name: string };
  /** Committee mailbox: every mailbox the thread's messages are in (the message is stored once). */
  mailboxes?: { id: string; name: string }[];
  subject: string;
  latestReceivedAt: string;
  receiptCount: number;
  matchCount: number;
  snippet: string;
  senders: string[];
  statuses: HandlingStatus[];
  labels: string[];
  assignees: string[];
  /** Committee mail: the viewer may set the status of the whole thread (PATCH /api/threads/:threadId/status). */
  canSetStatus?: boolean;
}

export interface ThreadListResponse {
  items: ThreadListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AttachmentView {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface NoteView {
  id: string;
  authorName: string;
  createdAt: string;
  body: string;
}

export interface HistoryView {
  id: string;
  at: string;
  actorName: string;
  action: 'assignee' | 'status' | 'labels' | 'note_added';
  from: string | null;
  to: string | null;
}

export interface TriageView {
  version: number;
  status: HandlingStatus;
  assignee: { id: string; displayName: string; hasMailboxAccess?: boolean } | null;
  labels: string[];
}

export interface ReceiptView {
  receiptId: string;
  threadId: string;
  mailbox: { id: string; name: string; address: string };
  /**
   * Committee mailbox: every mailbox this message is in. Handling is per message, and To/Cc are shown
   * as written in the mail. Absent in the synthetic test version (per-mailbox receipts, hidden addresses).
   */
  mailboxes?: { id: string; name: string; address: string }[];
  access: Exclude<AccessLevel, 'none'>;
  /** Committee mail: signed-in members may change assignees and labels without a mailbox edit grant. */
  canEditAssignmentAndLabels?: boolean;
  /** Committee mail: signed-in members may also change the status without a grant (notes still need one). */
  canEditStatus?: boolean;
  receivedAt: string;
  subject: string;
  from: Address;
  /** Recipient display policy: only this receipt's mailbox address and non-app addresses. */
  to: Address[];
  cc: Address[];
  text: string;
  hasHtml: boolean;
  /** Sanitized HTML; render only inside a sandboxed iframe. */
  sanitizedHtml: string | null;
  blockedRemoteResources: number;
  attachments: AttachmentView[];
  triage: TriageView;
  notes: NoteView[];
  history: HistoryView[];
}

export interface ThreadStatusResponse {
  threadId: string;
  /** Statuses of the thread's messages after the change. */
  statuses: HandlingStatus[];
  /** Messages whose status changed (0 when all already had it). */
  changed: number;
}

export interface ThreadDetailResponse {
  threadId: string;
  mailbox: { id: string; name: string; address: string };
  mailboxes?: { id: string; name: string; address: string }[];
  subject: string;
  receipts: ReceiptView[];
}

export interface AssigneeCandidate {
  id: string;
  displayName: string;
}

export interface LabelFacet {
  label: string;
  count: number;
}

export interface AccessMatrixResponse {
  users: Persona[];
  mailboxes: { id: string; name: string; address: string }[];
  grants: { userId: string; mailboxId: string; level: AccessLevel }[];
  version: number;
}

export interface AuditEntry {
  id: string;
  at: string;
  actorName: string;
  action: string;
  detail: string;
}

export interface SyncReport {
  mailboxes: { mailboxId: string; imported: number; duplicates: number; rejected: number; failed: boolean; error?: string }[];
  imported: number;
  duplicates: number;
  rejected: number;
  failed: number;
}

export interface FaultState {
  failNextRequests: number;
  delayNextRequests: number;
  delayMs: number;
  connectorFailMailboxId: string | null;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
  current?: TriageView;
}
