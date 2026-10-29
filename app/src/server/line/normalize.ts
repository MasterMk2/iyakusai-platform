import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LegacyTarget, MessagingTarget, StoredLineContent } from './types.js';

// Source adapters. Both produce normalized records; neither performs I/O.
//
// 1. Event feed ('line-event/v1'): what the EXISTING receiver exports after it has
//    validated the webhook signature itself. This app never receives raw webhooks,
//    never sees the signature and does not trust a "verified" flag from anyone.
//    replyToken is not part of the envelope: an envelope carrying one is rejected.
// 2. Legacy history export: rows of an old local snapshot or mirror. These are
//    history only and carry no verified official-account recipient, so they map to
//    read-only 'legacy_chat' targets that can never be sent to.

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const accountId = z.string().min(1).max(40).regex(/^[a-z0-9-]+$/);
const lineId = (prefix: 'U' | 'C' | 'R') => z.string().regex(new RegExp(`^${prefix}[0-9a-f]{32}$`));
const label = z.string().trim().min(1).max(100);

const source = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('user'), userId: lineId('U') }),
  z.strictObject({ type: z.literal('group'), groupId: lineId('C'), userId: lineId('U').optional() }),
  z.strictObject({ type: z.literal('room'), roomId: lineId('R'), userId: lineId('U').optional() }),
]);

const base = {
  schema: z.literal('line-event/v1'),
  accountId,
  destination: lineId('U'),
  webhookEventId: z.string().regex(/^[0-9A-Z]{26}$/),
  isRedelivery: z.boolean(),
  timestamp: z.iso.datetime(),
  source,
  /** Durable cursor of the receiver's export feed (provenance only). */
  cursor: z.string().min(1).max(100),
  /** Optional display labels from the receiver. Display only, never identity. */
  senderLabel: label.optional(),
  targetLabel: label.optional(),
};

const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'file', 'sticker', 'location'] as const;

export const lineEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...base,
    type: z.literal('message'),
    message: z.strictObject({
      id: z.string().regex(/^\d{1,20}$/),
      type: z.enum(MESSAGE_TYPES),
      text: z.string().max(5000).optional(),
    }),
  }),
  z.strictObject({ ...base, type: z.literal('unsend'), unsend: z.strictObject({ messageId: z.string().regex(/^\d{1,20}$/) }) }),
  z.strictObject({ ...base, type: z.literal('follow') }),
  z.strictObject({ ...base, type: z.literal('unfollow') }),
  z.strictObject({ ...base, type: z.literal('join') }),
  z.strictObject({ ...base, type: z.literal('leave') }),
  z.strictObject({ ...base, type: z.literal('member_count'), memberCount: z.number().int().min(1).max(10_000) }),
]);

export type LineEventEnvelope = z.infer<typeof lineEventSchema>;

export function targetOfEvent(event: LineEventEnvelope): MessagingTarget {
  const s = event.source;
  if (s.type === 'user') return { kind: 'messaging_api', type: 'user', id: s.userId };
  if (s.type === 'group') return { kind: 'messaging_api', type: 'group', id: s.groupId };
  return { kind: 'messaging_api', type: 'room', id: s.roomId };
}

export function contentOfEvent(message: { type: string; text?: string | undefined }): StoredLineContent {
  if (message.type === 'text') {
    return message.text !== undefined ? { kind: 'text', text: message.text } : { kind: 'unavailable', reason: 'missing' };
  }
  // Media is never downloaded here; the record says honestly that content was not imported.
  return { kind: 'unsupported', mediaType: message.type };
}

/** Event identity used for duplicate/conflict detection. Delivery flags and cursors are excluded. */
export function eventFingerprint(event: LineEventEnvelope): string {
  const identity: Record<string, unknown> = { ...event };
  for (const key of ['isRedelivery', 'cursor', 'senderLabel', 'targetLabel']) delete identity[key];
  return sha256(JSON.stringify(identity));
}

export function messageFingerprint(target: string, sentAt: string, content: StoredLineContent): string {
  return sha256(JSON.stringify({ target, sentAt, content }));
}

// ---- legacy history exports (approved formats, read-only)

/** One row of the old snapshot: messages joined with chats and senders. Extra columns are dropped. */
export const legacySnapshotSchema = z.object({
  format: z.literal('legacy-snapshot/v1'),
  exportId: z.string().min(1).max(60),
  cursor: z.string().min(1).max(100),
  chat: z.object({ chat_id: z.string().min(1).max(200), kind: z.string().max(40), name: z.string().max(200).nullable() }),
  message: z.object({
    message_id: z.string().min(1).max(200),
    sent_at: z.iso.datetime(),
    body: z.string().max(20_000).nullable(),
    kind: z.string().min(1).max(40),
    is_mine: z.boolean(),
    e2ee: z.boolean(),
    sender_display_name: z.string().max(200).nullable(),
  }),
});

/** One line of the old normalized mirror (one file per chat; chat reference given by the export). */
export const legacyMirrorSchema = z.object({
  format: z.literal('legacy-mirror/v1'),
  exportId: z.string().min(1).max(60),
  chat: z.object({ ref: z.string().min(1).max(200), kind: z.string().max(40), name: z.string().max(200).nullable() }),
  record: z.object({
    id: z.string().min(1).max(200),
    ts: z.iso.datetime(),
    author: z.string().max(200).nullable(),
    kind: z.string().min(1).max(40),
    content: z.string().max(20_000).nullable(),
    src_line: z.number().int().min(0),
  }),
});

export interface NormalizedLegacyRecord {
  target: LegacyTarget;
  chatName: string;
  externalMessageId: string;
  sentAt: string;
  senderLabel: string;
  direction: 'inbound' | 'outbound_legacy';
  content: StoredLineContent;
  cursor: string;
}

function legacyKind(kind: string): LegacyTarget['legacyKind'] {
  return kind === 'user' || kind === 'group' ? kind : 'unknown';
}

function legacyContent(kind: string, body: string | null, e2ee: boolean): StoredLineContent {
  if (kind === 'text') {
    if (body !== null) return { kind: 'text', text: body };
    return { kind: 'unavailable', reason: e2ee ? 'e2ee' : 'missing' };
  }
  return { kind: 'unsupported', mediaType: kind.slice(0, 40) };
}

/** Normalizes either legacy format; returns null for anything that does not validate. */
export function normalizeLegacyRecord(raw: unknown): NormalizedLegacyRecord | null {
  const snapshot = legacySnapshotSchema.safeParse(raw);
  if (snapshot.success) {
    const { chat, message, cursor } = snapshot.data;
    return {
      target: { kind: 'legacy_chat', legacyKind: legacyKind(chat.kind), ref: chat.chat_id },
      chatName: chat.name?.trim() || '（名称のない旧履歴）',
      externalMessageId: message.message_id,
      sentAt: message.sent_at,
      senderLabel: message.is_mine ? '自分（旧履歴）' : message.sender_display_name?.trim() || '（送信者不明）',
      direction: message.is_mine ? 'outbound_legacy' : 'inbound',
      content: legacyContent(message.kind, message.body, message.e2ee),
      cursor,
    };
  }
  const mirror = legacyMirrorSchema.safeParse(raw);
  if (mirror.success) {
    const { chat, record } = mirror.data;
    return {
      target: { kind: 'legacy_chat', legacyKind: legacyKind(chat.kind), ref: chat.ref },
      chatName: chat.name?.trim() || '（名称のない旧履歴）',
      externalMessageId: record.id,
      sentAt: record.ts,
      senderLabel: record.author?.trim() || '（送信者不明）',
      direction: 'inbound',
      content: legacyContent(record.kind, record.content, false),
      cursor: `line:${record.src_line}`,
    };
  }
  return null;
}
