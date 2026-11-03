import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OutboxView } from '../../shared/line.js';
import { DomainError, type User } from '../domain/types.js';
import { MAX_SKEW_MS, verifySignature } from '../tasks/signing.js';
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
// Authorization (line.json discord.auth, 2026-11-03 review M3):
// - "signed" (recommended): svc-auth/v1 like every other call between the parts (client "iyakusai-bot-line", no
//   actor, the key from discord.keyFile of 32 bytes or more, time within 30 seconds, nonce once). A request on the
//   internal network can then neither be replayed from a capture nor made by a container that only knows the path.
// - "bearer" (the first version): Authorization: Bearer <key>, compared in constant time and never logged.
// The routes exist only when discord.enabled; a request that came through the trusted reverse proxy (the internet)
// is answered 404 whatever it carries, so the routes are reachable only from inside.

export const DISCORD_LINE_PATHS = ['/internal/line/discord/preview', '/internal/line/discord/send'] as const;
export const DISCORD_LINE_CLIENT = 'iyakusai-bot-line';
const BODY_MAX = 32 * 1024;
const MAX_NONCES = 1024;

export type DiscordLineAuth = { mode: 'bearer'; key: string } | { mode: 'signed'; key: Buffer };

export interface DiscordLineOptions {
  auth: DiscordLineAuth;
  threadMapFile: string;
  /** The committee member signed in with this Discord account (not temporary staff, not disabled), or null. */
  memberByDiscordId: (discordUserId: string) => User | null;
  /** The request came through the trusted reverse proxy (by the socket address, never a header). */
  fromTrustedProxy: (request: FastifyRequest) => boolean;
  now?: () => number;
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

/** Spends svc-auth/v1 nonces once, remembered in this process for as long as their timestamp is accepted. */
export class NonceMemory {
  private readonly seen = new Map<string, number>();

  spend(nonce: string, timestamp: number, at: number): boolean {
    for (const [k, expires] of this.seen) if (expires <= at) this.seen.delete(k);
    if (this.seen.has(nonce) || this.seen.size >= MAX_NONCES) return false;
    this.seen.set(nonce, Math.max(at + 60_001, timestamp + MAX_SKEW_MS + 1));
    return true;
  }
}

/**
 * Checks a signed internal request (svc-auth/v1, client "iyakusai-bot-line", no actor) over the exact path and the raw
 * body, then spends the nonce. Returns the body text, or null for anything else (one answer for every failure).
 */
export function signedBody(request: { url: string; headers: Record<string, unknown>; rawHeaders: string[]; body: Buffer }, key: Buffer, path: string, nonces: NonceMemory, at: number): string | null {
  if (request.headers.origin !== undefined || request.url !== path) return null;
  const seen = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const k = request.rawHeaders[i]!.toLowerCase();
    if (!k.startsWith('x-svc-')) continue;
    if (seen.has(k)) return null;
    seen.add(k);
  }
  const allowed = ['x-svc-client', 'x-svc-timestamp', 'x-svc-nonce', 'x-svc-actor', 'x-svc-signature'];
  if ([...seen].some((k) => !allowed.includes(k))) return null;
  const read = (name: string) => (typeof request.headers[name] === 'string' ? (request.headers[name] as string) : null);
  const client = read('x-svc-client');
  const timestamp = read('x-svc-timestamp');
  const nonce = read('x-svc-nonce');
  const signature = read('x-svc-signature');
  const actor = read('x-svc-actor') ?? '';
  if (client !== DISCORD_LINE_CLIENT || actor !== '' || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(at - Number(timestamp)) > MAX_SKEW_MS || !nonce || !/^[-_A-Za-z0-9]{24,128}$/.test(nonce) || !signature) return null;
  const text = request.body.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(request.body)) return null;
  if (!verifySignature(key, { client, method: 'POST', path, timestamp, nonce, actor: '', body: text }, signature)) return null;
  if (!nonces.spend(nonce, Number(timestamp), at)) return null;
  return text;
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
  const now = options.now ?? Date.now;
  const threads = new ThreadMap(options.threadMapFile);
  const nonces = new NonceMemory();
  // The organization's name for the answer of a send (the screen shows the conversation's title instead).
  const names = new Map<string, { name: string; until: number }>();
  const notFound = (reply: FastifyReply) => reply.code(404).header('Cache-Control', 'no-store').send({ error: 'not_found', message: 'API が見つかりません。' });
  const unauthorized = (reply: FastifyReply) => reply.code(401).header('Cache-Control', 'no-store').send({ ok: false, code: 'unauthorized', message: '鍵が正しくありません。' });

  /** The request's body once the caller proved itself, or null (the reply was already sent). */
  function admitted(request: FastifyRequest, reply: FastifyReply, path: string): unknown | null {
    // Through the reverse proxy means from the internet: as if there were no such route, key or not.
    if (options.fromTrustedProxy(request)) {
      void notFound(reply);
      return null;
    }
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    let text: string | null;
    if (options.auth.mode === 'signed') {
      text = signedBody({ url: request.url, headers: request.headers, rawHeaders: request.raw.rawHeaders, body }, options.auth.key, path, nonces, now());
    } else {
      text = bearerMatches(request.headers.authorization, options.auth.key) ? body.toString('utf8') : null;
    }
    if (text === null) {
      void unauthorized(reply);
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      void reply.code(400).header('Cache-Control', 'no-store').send({ ok: false, code: 'invalid', message: '要求の形が正しくありません。' });
      return null;
    }
  }

  async function handle(reply: FastifyReply, fn: () => Promise<Record<string, unknown>>) {
    reply.header('Cache-Control', 'no-store');
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

  // The body is read as bytes (the signature covers them); a body over the limit or of another type is refused like a bad key.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: BODY_MAX }, (_request, body, done) => done(null, body));
    scope.setErrorHandler((error, request, reply) => {
      if (options.fromTrustedProxy(request)) return notFound(reply);
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== undefined && status >= 400 && status < 500) return unauthorized(reply);
      return reply.code(500).send({ ok: false, code: 'unavailable', message: 'サーバー内部でエラーが発生しました。' });
    });

    scope.post(DISCORD_LINE_PATHS[0], { bodyLimit: BODY_MAX }, async (request, reply) => {
      const body = admitted(request, reply, DISCORD_LINE_PATHS[0]);
      if (body === null) return reply;
      return handle(reply, async () => {
        const parsed = previewBody.safeParse(body);
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
      });
    });

    scope.post(DISCORD_LINE_PATHS[1], { bodyLimit: BODY_MAX }, async (request, reply) => {
      const body = admitted(request, reply, DISCORD_LINE_PATHS[1]);
      if (body === null) return reply;
      return handle(reply, async () => {
        const parsed = sendBody.safeParse(body);
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
      });
    });
  });
}
