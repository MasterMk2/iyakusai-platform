import { createHash } from 'node:crypto';
import type { LineIngestReport } from '../../shared/line.js';
import type { Fetch } from './messaging-api.js';
import { applyEventBatch } from './ingest.js';
import type { LineEventEnvelope } from './normalize.js';
import type { LineStore } from './store.js';

// Receiving (2026-10-28): the app reads the existing receiver's /export feed, the same one the Drive import
// reads. The receiver verifies LINE's signature and keeps every event as one record; /export returns them in
// arrival order after a cursor that the reader keeps, so this second reader takes nothing from the first.
// Each record becomes a 'line-event/v1' envelope for the existing ingest (duplicates, conflicts, unsend).
//
// The receiver writes a record first and adds the sender's display name a moment later, so records newer than
// `settleSeconds` wait for the next poll. A record that is not an event the inbox shows (postback, a broken
// body) is passed over: the cursor moves past it so it never blocks the feed.

export interface FeedRecord {
  _key?: unknown;
  received_at?: unknown;
  event_type?: unknown;
  timestamp?: unknown;
  source_type?: unknown;
  user_id?: unknown;
  group_id?: unknown;
  display_name?: unknown;
  message_type?: unknown;
  message_id?: unknown;
  text?: unknown;
  media_pending?: unknown;
  error?: unknown;
}

const USER = /^U[0-9a-f]{32}$/;
const GROUP = /^C[0-9a-f]{32}$/;
const ROOM = /^R[0-9a-f]{32}$/;
const MESSAGE_ID = /^\d{1,20}$/;
const MESSAGE_TYPES = new Set(['text', 'image', 'video', 'audio', 'file', 'sticker', 'location']);
const KEY = /^ev:\d{8}:\d{15}:\d{2}:[0-9a-f]{8}$/;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The receiver keeps no webhookEventId: a stable 26-character ID from the record's own key stands in. */
export function eventIdOfKey(key: string): string {
  const digest = createHash('sha256').update(`line-feed|${key}`).digest();
  let out = '';
  for (let i = 0; i < 26; i += 1) out += ALPHABET[digest[i]! % 32];
  return out;
}

const label = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : undefined);

/** One exported record as an envelope for this account, or null when it is nothing the inbox shows. */
export function envelopeOf(record: FeedRecord, account: { id: string; destination: string }): LineEventEnvelope | null {
  const key = record._key;
  if (typeof key !== 'string' || !KEY.test(key) || record.error !== undefined) return null;
  const ms = typeof record.timestamp === 'number' && Number.isFinite(record.timestamp) ? record.timestamp : Date.parse(String(record.received_at));
  if (!Number.isFinite(ms)) return null;
  const user = typeof record.user_id === 'string' && USER.test(record.user_id) ? record.user_id : undefined;
  const chat = typeof record.group_id === 'string' ? record.group_id : '';
  let source: LineEventEnvelope['source'];
  if (record.source_type === 'user' && user) source = { type: 'user', userId: user };
  else if (record.source_type === 'group' && GROUP.test(chat)) source = { type: 'group', groupId: chat, ...(user ? { userId: user } : {}) };
  else if (record.source_type === 'room' && ROOM.test(chat)) source = { type: 'room', roomId: chat, ...(user ? { userId: user } : {}) };
  else return null;

  const senderLabel = label(record.display_name);
  const base = {
    schema: 'line-event/v1' as const,
    accountId: account.id,
    destination: account.destination,
    webhookEventId: eventIdOfKey(key),
    isRedelivery: false,
    timestamp: new Date(ms).toISOString(),
    source,
    cursor: key,
    ...(senderLabel ? { senderLabel } : {}),
    // A 1:1 conversation is named after the person; a group keeps its masked ID (the receiver has no group name).
    ...(senderLabel && source.type === 'user' ? { targetLabel: senderLabel } : {}),
  };
  const messageId = typeof record.message_id === 'string' && MESSAGE_ID.test(record.message_id) ? record.message_id : null;
  switch (record.event_type) {
    case 'message': {
      const type = typeof record.message_type === 'string' && MESSAGE_TYPES.has(record.message_type) ? (record.message_type as 'text') : null;
      if (!type || !messageId) return null;
      const text = type === 'text' && typeof record.text === 'string' ? record.text.slice(0, 5000) : undefined;
      return { ...base, type: 'message', message: { id: messageId, type, ...(text !== undefined ? { text } : {}) } };
    }
    case 'unsend':
      return messageId ? { ...base, type: 'unsend', unsend: { messageId } } : null;
    case 'follow':
    case 'unfollow':
    case 'join':
    case 'leave':
      return { ...base, type: record.event_type };
    default:
      return null;
  }
}

export interface FeedStatus {
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  /** Category only (never a URL, token or content). */
  lastError: string | null;
  imported: number;
}

export interface FeedOptions {
  store: LineStore;
  account: { id: string; destination: string };
  receiver: { url: string; pullToken: string; pollSeconds: number; settleSeconds: number };
  fetch?: Fetch;
  now?: () => number;
}

const PAGE = 200;
const MAX_PAGES = 50;
/** 200 records of at most 5,000 characters of text each, with room for the other fields. */
const MAX_PAGE_CHARS = 8_000_000;

export const feedCursorKey = (accountId: string) => `receiver:${accountId}`;

export class LineFeed {
  readonly status: FeedStatus = { lastPollAt: null, lastSuccessAt: null, lastError: null, imported: 0 };
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;

  constructor(private readonly opts: FeedOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      void this.poll().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, this.opts.receiver.pollSeconds * 1000);
      });
    };
    this.timer = setTimeout(tick, 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** One pass over everything new. Concurrent calls share the running pass. */
  poll(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async page(after: string): Promise<FeedRecord[]> {
    const url = `${this.opts.receiver.url}/export?after=${encodeURIComponent(after)}&limit=${PAGE}`;
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.opts.receiver.pullToken}` }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!res.ok) {
      await res.body?.cancel();
      throw new FeedError(res.status === 401 ? '受け口が読み出し用トークンを受け付けませんでした' : `受け口の応答が HTTP ${res.status} でした`);
    }
    const text = await res.text();
    if (text.length > MAX_PAGE_CHARS) throw new FeedError('受け口の応答が大きすぎます');
    const records: FeedRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        records.push(parsed && typeof parsed === 'object' ? (parsed as FeedRecord) : {});
      } catch {
        records.push({});
      }
    }
    return records;
  }

  private async pass(): Promise<void> {
    const { store, account } = this.opts;
    this.status.lastPollAt = new Date(this.now()).toISOString();
    try {
      for (let n = 0; n < MAX_PAGES; n += 1) {
        const after = store.current.feed.cursors[feedCursorKey(account.id)] ?? '';
        const records = await this.page(after);
        const settleBefore = this.now() - this.opts.receiver.settleSeconds * 1000;
        const envelopes: LineEventEnvelope[] = [];
        let cursor = after;
        let held = false;
        let unplaceable = false;
        for (const record of records) {
          const key = typeof record._key === 'string' ? record._key : null;
          // A line that has no key of the receiver's form cannot be placed: stop rather than skip blindly.
          if (!key || !KEY.test(key) || key <= cursor) {
            held = unplaceable = true;
            break;
          }
          // The key carries the receiver's arrival time in milliseconds (ev:<day>:<ms>:…), so every placeable record has one.
          const received = Number(key.split(':')[2]);
          if (received > settleBefore) {
            held = true;
            break;
          }
          const env = envelopeOf(record, account);
          if (env) envelopes.push(env);
          cursor = key;
        }
        if (cursor !== after) {
          const at = new Date(this.now()).toISOString();
          let report: LineIngestReport | null;
          try {
            report = store.transact((s) => {
              const r = envelopes.length > 0 ? applyEventBatch(s, `feed-${cursor.slice(3, 27)}`, envelopes, at) : null;
              s.feed.cursors[feedCursorKey(account.id)] = cursor;
              return r;
            });
          } catch {
            throw new FeedError('受け取った記録を保存できなかったため、その手前で取り込みを止めています');
          }
          this.status.imported += report?.imported ?? 0;
        }
        if (unplaceable) throw new FeedError('受け口の記録の形が想定と違うため、その記録の手前で取り込みを止めています');
        if (held || records.length < PAGE) break;
      }
      this.status.lastSuccessAt = new Date(this.now()).toISOString();
      this.status.lastError = null;
    } catch (err) {
      this.status.lastError = err instanceof FeedError ? err.message : '受け口に接続できませんでした';
    }
  }
}

class FeedError extends Error {}
