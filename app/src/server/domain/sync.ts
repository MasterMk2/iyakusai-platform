import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SyncReport } from '../../shared/api.js';
import type { InboundConnector } from '../connector/types.js';
import { nextId, type AppState, type Mailbox, type Message, type Receipt } from './types.js';
import { approvedSharedMailTarget } from './shared-mail-policy.js';

const addressSchema = z.object({
  name: z.string().max(200).nullish(),
  address: z.string().min(3).max(320).regex(/^[^\s@<>]+@[^\s@<>]+$/),
});

const rawSchema = z.object({
  providerMessageId: z.string().min(1).max(200),
  receivedAt: z.iso.datetime(),
  deliveredTo: z.string().min(3).max(320),
  headers: z.object({
    messageId: z.string().max(500).optional(),
    subject: z.string().max(1000).optional(),
    from: addressSchema,
    to: z.array(addressSchema).max(200).optional(),
    cc: z.array(addressSchema).max(200).optional(),
    bcc: z.array(addressSchema).max(200).optional(),
    date: z.iso.datetime().optional(),
    inReplyTo: z.string().max(500).optional(),
    references: z.array(z.string().max(500)).max(100).optional(),
  }),
  rawHeaders: z.record(z.string(), z.string()).optional(),
  text: z.string().max(200_000).optional(),
  html: z.string().max(500_000).optional(),
  attachments: z
    .array(z.object({ filename: z.string().min(1).max(200), contentType: z.string().min(1).max(100), content: z.string().max(100_000) }))
    .max(20)
    .optional(),
});

type RawParsed = z.infer<typeof rawSchema>;

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function receiptIdFor(connectorId: string, sourceKey: string, providerMessageId: string): string {
  return `rc_${sha(`${connectorId}|${sourceKey}|${providerMessageId}`).slice(0, 16)}`;
}

export function threadIdFor(mailboxId: string, threadKey: string): string {
  return `th_${sha(`${mailboxId}|${threadKey}`).slice(0, 16)}`;
}

function normalizeAddr(a: { name?: string | null | undefined; address: string }) {
  return { name: a.name?.trim() || null, address: a.address.trim().toLowerCase() };
}

/** Normalized message content without app identifiers. Bcc is discarded here. */
function normalizeContent(raw: RawParsed): Omit<Message, 'id' | 'threadKey'> {
  const h = raw.headers;
  const content = {
    internetMessageId: h.messageId?.trim() || null,
    subject: h.subject?.trim() || '（件名なし）',
    from: normalizeAddr(h.from),
    to: (h.to ?? []).map(normalizeAddr),
    cc: (h.cc ?? []).map(normalizeAddr),
    sentAt: h.date ?? raw.receivedAt,
    text: raw.text ?? null,
    html: raw.html ?? null,
    inReplyTo: h.inReplyTo?.trim() || null,
    references: (h.references ?? []).map((r) => r.trim()).filter(Boolean),
  };
  const attachments = (raw.attachments ?? []).map((a, i) => ({ id: `att${i + 1}`, ...a }));
  const contentHash = sha(JSON.stringify({ ...content, attachments }));
  return { ...content, attachments, contentHash };
}

function threadKeyOf(m: Omit<Message, 'id' | 'threadKey'>, fallbackId: string): string {
  return m.references[0] ?? m.inReplyTo ?? m.internetMessageId ?? fallbackId;
}

export interface ApplyOutcome {
  imported: number;
  duplicates: number;
  rejected: number;
}

/**
 * Applies fetched raw items for one mailbox. Idempotent on
 * (connector, source mailbox, provider message ID): an existing receipt is
 * never modified, so local triage, labels, notes and history survive resync.
 */
export function applyFetchedItems(state: AppState, connectorId: string, mailbox: Mailbox, items: unknown[]): ApplyOutcome {
  const outcome: ApplyOutcome = { imported: 0, duplicates: 0, rejected: 0 };
  const target = typeof connectorId === 'string' && connectorId ? approvedSharedMailTarget(state, mailbox, connectorId) : null;
  if (!target) return { ...outcome, rejected: items.length };
  for (const item of items) {
    const parsed = rawSchema.safeParse(item);
    if (!parsed.success) {
      outcome.rejected += 1;
      continue;
    }
    const raw = parsed.data;
    // Delivery provenance, never To/Cc/Bcc, determines whether this is shared mail.
    if (raw.deliveredTo !== target.address) {
      outcome.rejected += 1;
      continue;
    }
    const receiptId = receiptIdFor(connectorId, mailbox.sourceKey, raw.providerMessageId);
    if (state.receipts.some((r) => r.id === receiptId)) {
      outcome.duplicates += 1;
      continue;
    }
    const content = normalizeContent(raw);
    // Reuse a message only when both Message-ID and content match. A Message-ID
    // collision with different content becomes a separate message.
    let message = content.internetMessageId
      ? state.messages.find((m) => m.internetMessageId === content.internetMessageId && m.contentHash === content.contentHash)
      : undefined;
    if (!message) {
      const id = `msg_${sha(`${content.contentHash}|${state.messages.length}|${receiptId}`).slice(0, 16)}`;
      message = { id, threadKey: threadKeyOf(content, id), ...content };
      state.messages.push(message);
    }
    const receipt: Receipt = {
      id: receiptId,
      mailboxId: mailbox.id,
      messageId: message.id,
      threadId: threadIdFor(mailbox.id, message.threadKey),
      receivedAt: raw.receivedAt,
      delivery: {
        connectorId,
        sourceMailboxKey: mailbox.sourceKey,
        providerMessageId: raw.providerMessageId,
        deliveredTo: raw.deliveredTo,
        rawHeaders: raw.rawHeaders ?? {},
      },
      triage: { version: 1, status: 'unhandled', assigneeId: null, labels: [] },
      notes: [],
      history: [],
    };
    state.receipts.push(receipt);
    outcome.imported += 1;
  }
  return outcome;
}

export type SyncMode = 'incremental' | 'full';

export interface FetchedBatch {
  mailbox: Mailbox;
  ok: boolean;
  items: unknown[];
  nextCursor: number;
  error?: string;
}

/** Network-free fetch phase (the mock connector). Runs outside the state transaction. */
export async function fetchAll(state: AppState, connector: InboundConnector, mode: SyncMode, signal?: AbortSignal): Promise<FetchedBatch[]> {
  const batches: FetchedBatch[] = [];
  if (typeof connector.id !== 'string' || !connector.id) return batches;
  for (const mailbox of state.mailboxes) {
    if (!approvedSharedMailTarget(state, mailbox, connector.id)) continue;
    signal?.throwIfAborted();
    const cursor = mode === 'full' ? 0 : (state.mockConnector.cursors[mailbox.sourceKey] ?? 0);
    try {
      const result = await connector.fetchSince(mailbox.sourceKey, cursor);
      batches.push({ mailbox, ok: true, items: result.items, nextCursor: result.nextCursor });
    } catch (err) {
      batches.push({ mailbox, ok: false, items: [], nextCursor: cursor, error: err instanceof Error ? err.message : '取得に失敗しました' });
    }
  }
  return batches;
}

/** Apply phase. A failed mailbox keeps its cursor so a retry fetches the same items again. */
export function applyBatches(state: AppState, connectorId: string, batches: FetchedBatch[], actorId: string, now: string): SyncReport {
  const report: SyncReport = { mailboxes: [], imported: 0, duplicates: 0, rejected: 0, failed: 0 };
  for (const b of batches) {
    if (typeof connectorId !== 'string' || !connectorId || !approvedSharedMailTarget(state, b.mailbox, connectorId)) {
      report.failed += 1;
      report.mailboxes.push({ mailboxId: b.mailbox.id, imported: 0, duplicates: 0, rejected: b.items.length, failed: true, error: '共有受信箱の取得対象が未承認です。' });
      report.rejected += b.items.length;
      continue;
    }
    if (!b.ok) {
      report.failed += 1;
      report.mailboxes.push({ mailboxId: b.mailbox.id, imported: 0, duplicates: 0, rejected: 0, failed: true, error: b.error ?? '取得に失敗しました' });
      continue;
    }
    const outcome = applyFetchedItems(state, connectorId, b.mailbox, b.items);
    state.mockConnector.cursors[b.mailbox.sourceKey] = Math.max(state.mockConnector.cursors[b.mailbox.sourceKey] ?? 0, b.nextCursor);
    report.imported += outcome.imported;
    report.duplicates += outcome.duplicates;
    report.rejected += outcome.rejected;
    report.mailboxes.push({ mailboxId: b.mailbox.id, ...outcome, failed: false });
  }
  state.audit.push({
    id: nextId(state, 'audit'),
    at: now,
    actorId,
    action: 'sync',
    detail: `取り込み ${report.imported} 件 / 重複 ${report.duplicates} 件 / 不正 ${report.rejected} 件 / 失敗した受信箱 ${report.failed} 件`,
  });
  return report;
}
