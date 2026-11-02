import { readFileSync, statSync } from 'node:fs';
import type { LineIngestReport } from '../../shared/line.js';
import { emptyReport, ensureConversation, messageIdFor, recordImport } from './ingest.js';
import { messageFingerprint } from './normalize.js';
import type { LineStore } from './store.js';
import type { LineConversation, LineMessage, LineState, OutboxIntent, StoredLineContent } from './types.js';

// The official account's own chat history (2026-11-02, contract A): the admin screen's export turned into one
// JSON line per message. A row with the person's Messaging API user ID joins that person's conversation (made
// when there is none, as the receiver would make it); a row without one goes to a read-only archive conversation
// of its chat name. `_key` keeps a row from being imported twice. Nothing here changes whether a person can be
// sent to (only verified webhook events do), and a history row is never a reply target.
//
// The file is read at start and again whenever its modification time or size changes, about as often as the
// receiver is polled.

const KEY = /^chatpro:[0-9a-f]{24}$/;
const USER = /^U[0-9a-f]{32}$/;
const KINDS = new Set(['text', 'image', 'file', 'video', 'audio', 'sticker', 'location', 'unsend']);
/** A webhook message and a history row with the same text this close in time are the same message. */
export const SAME_MESSAGE_WINDOW_MS = 2 * 60 * 1000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export interface HistoryRow {
  key: string;
  sentAt: string;
  direction: 'in' | 'out';
  kind: string;
  content: string;
  chat: string;
  userId: string | null;
  staff: string | null;
  autoReply: boolean;
}

const text = (value: unknown, max: number): string | null => (typeof value === 'string' ? value.replace(CONTROL, '').trim().slice(0, max) : null);

/** One line of the file, or null when it is not of the contract's form. */
export function parseHistoryRow(raw: unknown): HistoryRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r._key !== 'string' || !KEY.test(r._key)) return null;
  // ISO 8601 with an offset (+09:00): a time without one would be read as the server's local time.
  if (typeof r.ts_sec !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(r.ts_sec)) return null;
  const ms = Date.parse(r.ts_sec);
  if (!Number.isFinite(ms)) return null;
  if (r.direction !== 'in' && r.direction !== 'out') return null;
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) return null;
  const chat = text(r.chat, 200);
  if (!chat) return null;
  if (r.user_id !== null && r.user_id !== undefined && (typeof r.user_id !== 'string' || !USER.test(r.user_id))) return null;
  const content = typeof r.content === 'string' ? r.content.replace(/\r\n?/g, '\n').slice(0, 20_000) : '';
  if (r.kind === 'text' && !content.trim()) return null;
  return {
    key: r._key,
    sentAt: new Date(ms).toISOString(),
    direction: r.direction,
    kind: r.kind,
    content,
    chat,
    userId: typeof r.user_id === 'string' ? r.user_id : null,
    staff: r.direction === 'out' ? text(r.staff, 100) || null : null,
    autoReply: r.auto_reply === true,
  };
}

function contentOf(row: HistoryRow): StoredLineContent {
  if (row.kind === 'text') return { kind: 'text', text: row.content };
  if (row.kind === 'unsend') return { kind: 'unsent' };
  return { kind: 'unsupported', mediaType: row.kind };
}

/** The archive account that holds rows without a user ID (read-only, never a send target). */
export const historyArchiveId = (accountId: string) => `${accountId.slice(0, 32)}-history`;

/**
 * Applies rows of the history file. `accountId` is the official account; rows without a user ID go to the
 * archive account. A row already imported is a duplicate (the same key with other contents: a conflict, kept as it was).
 */
export function applyHistoryRows(state: LineState, accountId: string, items: unknown[], now: string, batchId = `history-${now.slice(0, 19)}`): LineIngestReport {
  const report = emptyReport();
  const archive = state.accounts.find((a) => a.id === historyArchiveId(accountId) && a.kind === 'legacy_archive');
  const official = state.accounts.find((a) => a.id === accountId && a.kind === 'official_account');
  if (!official) {
    report.rejected = items.length;
    return report;
  }
  // By key across both accounts: a row imported once stays where it was put, even if a later export links it.
  const byKey = new Map(state.messages.filter((m) => m.provenance.source === 'oa_history').map((m) => [m.externalMessageId, m]));
  for (const item of items) {
    const row = parseHistoryRow(item);
    if (!row || (!row.userId && !archive)) {
      report.rejected += 1;
      continue;
    }
    const owner = row.userId ? official.id : archive!.id;
    const id = messageIdFor(owner, 'history', row.key);
    const content = contentOf(row);
    const fp = messageFingerprint(`history|${row.userId ?? row.chat}|${row.direction}|${row.staff ?? ''}|${row.autoReply}`, row.sentAt, content);
    const existing = byKey.get(row.key);
    if (existing) {
      if (existing.fingerprint === fp) report.duplicates += 1;
      else report.conflicts += 1;
      continue;
    }
    const conv = row.userId
      ? ensureConversation(state, official.id, { kind: 'messaging_api', type: 'user', id: row.userId }, row.chat)
      : ensureConversation(state, archive!.id, { kind: 'legacy_chat', legacyKind: 'user', ref: `chat:${row.chat}` }, row.chat);
    const message: LineMessage = {
      id,
      accountId: owner,
      conversationId: conv.id,
      externalMessageId: row.key,
      direction: row.direction === 'in' ? 'inbound' : 'outbound_legacy',
      senderLabel: row.direction === 'in' ? row.chat : (row.staff ?? (row.autoReply ? '自動応答' : '委員会')),
      sentAt: row.sentAt,
      importedAt: now,
      content,
      fingerprint: fp,
      provenance: { source: 'oa_history', batchId, cursor: row.key },
      history: { staff: row.staff, autoReply: row.autoReply },
    };
    state.messages.push(message);
    byKey.set(row.key, message);
    report.imported += 1;
  }
  if (report.imported + report.conflicts + report.rejected > 0) recordImport(state, batchId, report, now, []);
  return report;
}

const within = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_MESSAGE_WINDOW_MS;

/**
 * History rows that the app already shows from elsewhere: a received message that came through the webhook
 * (same text, at most 2 minutes apart), or a message this app sent (same text). Whichever arrived first.
 */
export function shadowedHistory(messages: LineMessage[], outbox: OutboxIntent[], conv: LineConversation): Set<string> {
  const hidden = new Set<string>();
  const rows = messages.filter((m) => m.provenance.source === 'oa_history' && m.content.kind === 'text');
  if (rows.length === 0) return hidden;
  const received = messages.filter((m) => m.provenance.source === 'event_feed' && m.direction === 'inbound' && m.content.kind === 'text');
  const sent = outbox.filter((o) => o.conversationId === conv.id && o.status !== 'failed');
  for (const row of rows) {
    const body = (row.content as { text: string }).text.trim();
    const twin =
      row.direction === 'inbound'
        ? received.some((m) => (m.content as { text: string }).text.trim() === body && within(m.sentAt, row.sentAt))
        : sent.some((o) => o.body.trim() === body && within(o.createdAt, row.sentAt));
    if (twin) hidden.add(row.id);
  }
  return hidden;
}

export interface HistoryStatus {
  lastCheckAt: string | null;
  lastImportAt: string | null;
  lastError: string | null;
  lastReport: LineIngestReport | null;
}

/** Reads the history file at start and whenever it changed (modification time or size). */
export class LineHistoryImporter {
  readonly status: HistoryStatus = { lastCheckAt: null, lastImportAt: null, lastError: null, lastReport: null };
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly opts: { store: LineStore; accountId: string; file: string; pollSeconds: number; now?: () => number },
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  start(): void {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.poll();
      this.timer = setTimeout(tick, this.opts.pollSeconds * 1000);
    };
    this.timer = setTimeout(tick, 500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One check. Synchronous: the file is local and read in one go. */
  poll(): void {
    const at = new Date(this.now()).toISOString();
    this.status.lastCheckAt = at;
    let stat: { mtimeMs: number; size: number };
    try {
      const s = statSync(this.opts.file);
      stat = { mtimeMs: Math.floor(s.mtimeMs), size: s.size };
    } catch {
      this.status.lastError = '旧履歴のファイルが見つかりません';
      return;
    }
    const seen = this.opts.store.current.historyImport;
    if (seen && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) {
      this.status.lastError = null;
      return;
    }
    if (stat.size > MAX_FILE_BYTES) {
      this.status.lastError = '旧履歴のファイルが大きすぎます';
      return;
    }
    let rows: unknown[];
    try {
      rows = readFileSync(this.opts.file, 'utf8')
        .replace(/^\uFEFF/, '')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l) as unknown;
          } catch {
            return null;
          }
        });
    } catch {
      this.status.lastError = '旧履歴のファイルを読めません';
      return;
    }
    try {
      this.status.lastReport = this.opts.store.transact((s) => {
        const report = applyHistoryRows(s, this.opts.accountId, rows, at);
        s.historyImport = stat;
        return report;
      });
      this.status.lastImportAt = at;
      this.status.lastError = null;
    } catch {
      this.status.lastError = '旧履歴を保存できませんでした';
    }
  }
}
