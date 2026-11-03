import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OutboxView } from '../../shared/line.js';
import { DomainError, type User } from '../domain/types.js';
import { conversationIdFor, ensureConversation } from './ingest.js';
import { sha256 } from './normalize.js';
import { beginSend, isQuotaError, previewReply, saveDraft, type PreviewQuota, type SendContext } from './reply.js';
import type { LineStore } from './store.js';
import type { MessagingTarget } from './types.js';

// Replies from the Discord threads of the relayed official LINE messages (2026-11-02, contract C). The Bot's
// slash command asks the app over the internal Docker network; the app does everything else as the screen does:
// the person (the committee member signed in with that Discord account), the send grant, the monthly limits,
// the draft, the five-minute confirmation and the send record. The Bot holds no LINE token and counts nothing.
//
//   POST /internal/line/discord/preview  {threadId, discordUserId, text} -> a confirmation (consentId)
//   POST /internal/line/discord/send     {consentId, discordUserId}      -> the send, as the screen's
//
// Authorization: Bearer <key> (line.json discord.keyFile), compared in constant time and never logged. The routes
// exist only when discord.enabled; a request that came through the trusted reverse proxy (the internet) is
// answered 404 whatever it carries, so the routes are reachable only from inside.

export const DISCORD_LINE_PATHS = ['/internal/line/discord/preview', '/internal/line/discord/send'] as const;

export interface DiscordLineOptions {
  key: string;
  threadMapFile: string;
  /** The committee member signed in with this Discord account (not temporary staff, not disabled), or null. */
  memberByDiscordId: (discordUserId: string) => User | null;
  /** The request came through the trusted reverse proxy (by the socket address, never a header). */
  fromTrustedProxy: (request: FastifyRequest) => boolean;
}

interface Deps {
  options: DiscordLineOptions;
  store: LineStore;
  clock: () => string;
  sendContext: () => SendContext;
  observeBeforePreview: (user: User, conversationId: string) => Promise<PreviewQuota | null>;
  attempt: (user: User, intentId: string, attemptNo: number) => Promise<{ saved: true; outbox: OutboxView } | { saved: false; intentId: string }>;
}

type Code = 'unknown_thread' | 'unknown_member' | 'forbidden' | 'quota' | 'invalid' | 'unavailable' | 'expired' | 'unauthorized';

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: Code,
    message: string,
  ) {
    super(message);
  }
}

const snowflake = z.string().regex(/^\d{1,25}$/);
const previewBody = z.strictObject({ threadId: snowflake, discordUserId: snowflake, text: z.string().max(20_000) });
// The contract allows 1-64 of [A-Za-z0-9._~-] (Discord custom_id); this app issues 43 base64url characters.
const sendBody = z.strictObject({ consentId: z.string().regex(/^[A-Za-z0-9._~-]{1,64}$/), discordUserId: snowflake });

const SOURCE_ID = { user: /^U[0-9a-f]{32}$/, group: /^C[0-9a-f]{32}$/, room: /^R[0-9a-f]{32}$/ } as const;

export interface ThreadEntry {
  target: MessagingTarget;
  orgName: string | null;
}

/** Contract B: the relay's map of Discord threads to verified LINE sources (read only, re-read when it changes). */
export class ThreadMap {
  private cache: { mtimeMs: number; size: number; threads: Map<string, ThreadEntry> } | null = null;

  constructor(private readonly file: string) {}

  lookup(threadId: string): ThreadEntry | null {
    let stat: { mtimeMs: number; size: number };
    try {
      const s = statSync(this.file);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
    if (!this.cache || this.cache.mtimeMs !== stat.mtimeMs || this.cache.size !== stat.size) {
      const threads = new Map<string, ThreadEntry>();
      try {
        if (stat.size > 8 * 1024 * 1024) throw new Error('too large');
        const doc = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')) as { version?: unknown; threads?: unknown };
        if (doc.version === 1 && doc.threads && typeof doc.threads === 'object' && !Array.isArray(doc.threads)) {
          for (const [id, raw] of Object.entries(doc.threads as Record<string, unknown>)) {
            const e = raw as { sourceType?: unknown; sourceId?: unknown; orgName?: unknown } | null;
            const type = e?.sourceType;
            if (!/^\d{1,25}$/.test(id) || (type !== 'user' && type !== 'group' && type !== 'room')) continue;
            if (typeof e?.sourceId !== 'string' || !SOURCE_ID[type].test(e.sourceId)) continue;
            const orgName = typeof e.orgName === 'string' && e.orgName.trim() ? e.orgName.trim().slice(0, 100) : null;
            threads.set(id, { target: { kind: 'messaging_api', type, id: e.sourceId }, orgName });
          }
        }
      } catch {
        // An unreadable map is an empty one: every thread is unknown until the relay writes it again.
      }
      this.cache = { ...stat, threads };
    }
    return this.cache.threads.get(threadId) ?? null;
  }
}

/** Constant-time comparison of the bearer key (both sides hashed first, so the lengths never leak). */
export function bearerMatches(header: unknown, key: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = createHash('sha256').update(header.slice(7)).digest();
  const expected = createHash('sha256').update(key).digest();
  return timingSafeEqual(given, expected);
}

/** The screen's statuses in the contract's words. */
export function contractStatus(o: OutboxView): 'accepted' | 'failed_retryable' | 'unknown' | 'needs_review' {
  if (o.status === 'accepted') return 'accepted';
  if (o.status === 'unknown' || o.status === 'pending') return 'unknown';
  if (o.status === 'failed' && o.retryable) return 'failed_retryable';
  return 'needs_review';
}

/** A domain error of the shared draft/preview/send code, in the contract's codes. */
function refusalOf(err: unknown): Refusal {
  if (err instanceof Refusal) return err;
  if (isQuotaError(err)) return new Refusal(422, 'quota', (err as DomainError).message);
  if (err instanceof DomainError) {
    switch (err.code) {
      case 'forbidden':
        return new Refusal(403, 'forbidden', err.message);
      case 'validation':
        return (err.details as { field?: unknown } | undefined)?.field === 'body' ? new Refusal(400, 'invalid', err.message) : new Refusal(422, 'unavailable', err.message);
      case 'conflict':
        return new Refusal(409, 'unavailable', err.message);
      case 'not_found':
        return new Refusal(404, 'unknown_thread', 'この相手の会話が見つかりません。');
      default:
        return new Refusal(503, 'unavailable', '今は送れません。しばらくしてからやり直してください。');
    }
  }
  return new Refusal(503, 'unavailable', '今は送れません。しばらくしてからやり直してください。');
}

const fraction = (used: number | null | undefined, limit: number | null | undefined) => (used === null || used === undefined ? '読み取れず' : limit === null || limit === undefined ? `${used} 通` : `${used}/${limit} 通`);

export function registerDiscordLineRoutes(app: FastifyInstance, deps: Deps): void {
  const { options, store, clock } = deps;
  const threads = new ThreadMap(options.threadMapFile);
  // The organization's name for the answer of a send (the screen shows the conversation's title instead).
  const names = new Map<string, { name: string; until: number }>();

  async function handle(request: FastifyRequest, reply: FastifyReply, fn: () => Promise<Record<string, unknown>>) {
    // Through the reverse proxy means from the internet: as if there were no such route, key or not.
    if (options.fromTrustedProxy(request)) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'not_found', message: 'API が見つかりません。' });
    reply.header('Cache-Control', 'no-store');
    if (!bearerMatches(request.headers.authorization, options.key)) return reply.code(401).send({ ok: false, code: 'unauthorized', message: '鍵が正しくありません。' });
    try {
      return reply.code(200).send({ ok: true, ...(await fn()) });
    } catch (err) {
      const r = refusalOf(err);
      return reply.code(r.status).send({ ok: false, code: r.code, message: r.message });
    }
  }

  function member(discordUserId: string): User {
    const user = options.memberByDiscordId(discordUserId);
    if (!user) throw new Refusal(403, 'unknown_member', 'この Discord アカウントは統合アプリの委員として登録されていません（臨時スタッフは使えません）。');
    return user;
  }

  app.post(DISCORD_LINE_PATHS[0], async (request, reply) =>
    handle(request, reply, async () => {
      const parsed = previewBody.safeParse(request.body);
      if (!parsed.success) throw new Refusal(400, 'invalid', '要求の形が正しくありません。');
      const { threadId, discordUserId, text } = parsed.data;
      const entry = threads.lookup(threadId);
      if (!entry) throw new Refusal(404, 'unknown_thread', 'このスレッドは公式LINE の相手に結び付いていません。');
      const user = member(discordUserId);
      const account = store.current.accounts.find((a) => a.kind === 'official_account');
      if (!account) throw new Refusal(503, 'unavailable', '公式LINE が設定されていません。');
      const conversationId = conversationIdFor(account.id, entry.target);
      const orgName = entry.orgName ?? store.current.conversations.find((c) => c.id === conversationId)?.title ?? '相手';
      // The person's conversation, made as the receiver would make it when there is none yet.
      if (!store.current.conversations.some((c) => c.id === conversationId)) {
        store.transact((s) => void ensureConversation(s, account.id, entry.target, orgName));
      }
      const quota = await deps.observeBeforePreview(user, conversationId);
      const ctx = deps.sendContext();
      const preview = store.transact((s) => {
        const existing = s.drafts.find((d) => d.conversationId === conversationId && d.authorId === user.id && d.via === 'discord');
        const draft = saveDraft(s, user, conversationId, { body: text, expectedVersion: existing?.version ?? null }, clock(), ctx);
        return previewReply(s, user, conversationId, { draftId: draft.id, draftVersion: draft.version }, clock(), quota, ctx);
      });
      const nowMs = Date.parse(clock());
      for (const [k, v] of names) if (v.until <= nowMs) names.delete(k);
      names.set(sha256(preview.consentId), { name: orgName, until: Date.parse(preview.expiresAt) });
      const monthUsed = preview.monthUsed ?? 0;
      const monthlyLimit = preview.monthlyLimit ?? null;
      return {
        consentId: preview.consentId,
        expiresAt: preview.expiresAt,
        orgName,
        recipients: preview.billableRecipients,
        monthUsed,
        monthlyLimit,
        lineUsage: preview.lineUsage ?? null,
        lineLimit: preview.lineLimit ?? null,
        message: `${orgName} に ${preview.billableRecipients} 通送ります（今月このアプリから ${fraction(monthUsed, monthlyLimit)}、LINE 全体 ${fraction(preview.lineUsage, preview.lineLimit)}）。`,
      };
    }),
  );

  app.post(DISCORD_LINE_PATHS[1], async (request, reply) =>
    handle(request, reply, async () => {
      const parsed = sendBody.safeParse(request.body);
      if (!parsed.success) throw new Refusal(400, 'invalid', '要求の形が正しくありません。');
      const { consentId, discordUserId } = parsed.data;
      const user = member(discordUserId);
      const consent = store.current.consents.find((c) => c.tokenHash === sha256(consentId) && c.via === 'discord');
      const expired = new Refusal(409, 'expired', '確認の有効期限（5 分）が切れたか、もう使われています。もう一度 /line返信 からやり直してください。');
      if (!consent) throw expired;
      if (consent.actorId !== user.id) throw new Refusal(403, 'forbidden', '確認を作った本人だけが送れます。');
      if (consent.consumedByIntentId !== null || Date.parse(consent.expiresAt) <= Date.parse(clock())) throw expired;
      const draft = store.current.drafts.find((d) => d.id === consent.draftId);
      if (!draft) throw expired;
      const started = store.transact((s) =>
        beginSend(s, user, consent.conversationId, { consentId, operationId: randomUUID(), draftId: draft.id, draftVersion: draft.version, body: draft.body }, clock(), deps.sendContext()),
      );
      const orgName = names.get(sha256(consentId))?.name ?? store.current.conversations.find((c) => c.id === consent.conversationId)?.title ?? '相手';
      const result = await deps.attempt(user, started.intentId, started.attemptNo);
      if (!result.saved) {
        return { status: 'unknown', statusLabel: '結果不明', message: `${orgName} への送信の結果を保存できませんでした。結果不明として扱います（画面の送信記録から同じ内容で再試行できます）。` };
      }
      const o = result.outbox;
      const status = contractStatus(o);
      return {
        status,
        statusLabel: o.statusLabel,
        message:
          status === 'accepted'
            ? `${orgName} に送りました（LINE が受け付けました。届いた・読まれたの意味ではありません）。`
            : `${orgName} への送信は「${o.statusLabel}」です。${o.statusNote}`,
      };
    }),
  );
}
