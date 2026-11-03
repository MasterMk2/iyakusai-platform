import { randomBytes, randomUUID } from 'node:crypto';
import type { BroadcastOptionsResponse, BroadcastPreviewResponse, OutboxStatus } from '../../shared/line.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { canReadLine, canReplyLine } from './access.js';
import { MULTICAST_MAX } from './connector.js';
import { sha256 } from './normalize.js';
import { messagesOf } from './queries.js';
import {
  checkLineQuota,
  checkMonthlyLimit,
  CONSENT_TTL_MS,
  imageOf,
  imageView,
  MAX_CONSENTS,
  MAX_CONSENTS_PER_ACTOR,
  monthlyUsage,
  normalizeReplyBody,
  recordAttempt,
  targetFingerprint,
  type PreviewQuota,
  type SendContext,
} from './reply.js';
import type { LinePushOutcome } from './connector.js';
import { nextLineId, type LineAccount, type LineBroadcast, type LineConversation, type LineState, type OutboxIntent } from './types.js';

// Broadcast (2026-11-02): the same text (and image) to several 1:1 conversations at once, through the Messaging
// API's multicast (at most 500 people per request, one X-Line-Retry-Key per request). The sender chooses the
// conversations or "everyone it can be sent to"; the confirmation binds the exact list, body and image for five
// minutes, as a reply's does. Each recipient gets its own send record (an outbox intent), bound together by the
// broadcast's ID, so every conversation shows what it was sent and the month's count stays one per person.
//
// Recipients: a 1:1 conversation with a user ID that has not unfollowed (or blocked) the account. LINE delivers a
// multicast to friends only; a person who is not one is counted here anyway (an upper bound), never more.
// A broadcast is never retried one person at a time: the request was shared, so a retry could double-send.

const NOT_SENDABLE = 'この公式LINE からは送れない設定です。';

function account(state: LineState, user: User, accountId: string): LineAccount {
  const a = state.accounts.find((x) => x.id === accountId);
  if (!a || !canReadLine(state, user, accountId)) throw notFound();
  if (a.kind !== 'official_account' || (a.outbound !== 'push' && a.outbound !== 'push_mock')) throw new DomainError('validation', NOT_SENDABLE);
  if (!canReplyLine(state, user, accountId)) throw new DomainError('forbidden', 'この LINE アカウントで送る権限がありません。権限管理者に、LINE の送信権限を依頼してください。');
  return a;
}

const eligible = (c: LineConversation) => c.target.kind === 'messaging_api' && c.target.type === 'user' && c.eligibility.relation !== 'unfollowed';

/** Conversations a broadcast from this account may go to, newest first. */
export function broadcastTargets(state: LineState, accountId: string): LineConversation[] {
  const latest = (c: LineConversation) => messagesOf(state, c).at(-1)?.sentAt ?? c.eligibility.relationAt ?? '';
  return state.conversations
    .filter((c) => c.accountId === accountId && eligible(c))
    .map((c) => ({ c, at: latest(c) }))
    .sort((x, y) => y.at.localeCompare(x.at) || x.c.id.localeCompare(y.c.id))
    .map((x) => x.c);
}

const masked = (c: LineConversation) => (c.target.kind === 'messaging_api' ? `…${c.target.id.slice(-4)}` : '');

export function broadcastOptions(state: LineState, user: User, accountId: string, nowMs: number, ctx: SendContext): BroadcastOptionsResponse {
  const a = account(state, user, accountId);
  return {
    account: { id: a.id, name: a.name },
    recipients: broadcastTargets(state, a.id).map((c) => ({
      conversationId: c.id,
      title: c.title,
      maskedId: masked(c),
      friend: c.eligibility.relation === 'friend',
      latestAt: messagesOf(state, c).at(-1)?.sentAt ?? null,
    })),
    monthUsed: monthlyUsage(state, a.id, nowMs),
    monthlyLimit: a.monthlyLimit ?? null,
    imagesEnabled: ctx.imageBaseUrl !== null,
    mock: a.outbound === 'push_mock',
  };
}

export interface BroadcastInput {
  /** 'all': every conversation it can be sent to now; else the chosen conversation IDs. */
  recipients: 'all' | string[];
  body: string;
  imageId: string | null;
}

function chosen(state: LineState, accountId: string, recipients: BroadcastInput['recipients']): LineConversation[] {
  const targets = broadcastTargets(state, accountId);
  if (recipients === 'all') {
    if (targets.length === 0) throw new DomainError('validation', '送れる相手がいません。');
    return targets;
  }
  const byId = new Map(targets.map((c) => [c.id, c]));
  const ids = [...new Set(recipients)];
  if (ids.length === 0) throw new DomainError('validation', '宛先を選んでください。');
  const out: LineConversation[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) throw new DomainError('validation', '一斉送信できない宛先が含まれています（1:1 の会話で、友だち解除・ブロックされていない相手だけに送れます）。画面を読み込み直してください。');
    out.push(c);
  }
  return out;
}

export function previewBroadcast(state: LineState, user: User, accountId: string, input: BroadcastInput, now: string, quota: PreviewQuota | null, ctx: SendContext): BroadcastPreviewResponse {
  const nowMs = Date.parse(now);
  const a = account(state, user, accountId);
  const body = normalizeReplyBody(input.body);
  const image = imageOf(state, user, a.id, input.imageId, nowMs, ctx);
  const list = chosen(state, a.id, input.recipients);
  checkMonthlyLimit(state, a, list.length, nowMs);
  checkLineQuota(quota, list.length);

  const consents = (state.broadcastConsents ?? []).filter((c) => Date.parse(c.expiresAt) > nowMs);
  if (consents.filter((c) => c.actorId === user.id && c.consumedByBroadcastId === null).length >= MAX_CONSENTS_PER_ACTOR) {
    throw new DomainError('conflict', `確認待ちの一斉送信が多すぎます（1 人あたり ${MAX_CONSENTS_PER_ACTOR} 件まで）。5 分待ってからやり直してください。`);
  }
  if (consents.length >= MAX_CONSENTS) throw new DomainError('conflict', '確認待ちの送信が多すぎます。しばらくしてからやり直してください。');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(nowMs + CONSENT_TTL_MS).toISOString();
  consents.push({
    tokenHash: sha256(token),
    actorId: user.id,
    accountId: a.id,
    conversationIds: list.map((c) => c.id),
    bodyHash: sha256(body),
    imageId: input.imageId,
    createdAt: now,
    expiresAt,
    consumedByBroadcastId: null,
  });
  state.broadcastConsents = consents;

  const used = monthlyUsage(state, a.id, nowMs);
  const mock = a.outbound === 'push_mock';
  const notices = [
    mock ? '現在は模擬送信です。実際の LINE への送信は接続されていません。' : `公式アカウント「${a.name}」から、選んだ ${list.length} 人の LINE にすぐ届きます。送ったあとで取り消すことはできません。`,
    a.monthlyLimit !== undefined
      ? `月の通数に 1 人 1 通ずつ数えられます。今月このアプリから送ったのは ${used} 通、上限は ${a.monthlyLimit} 通です（この送信で ${used + list.length} 通）。`
      : `月の通数に 1 人 1 通ずつ数えられます。今月このアプリから送ったのは ${used} 通です。`,
    quota
      ? `LINE 側の今月の通数：${quota.used} 通${quota.limit !== null ? `／上限 ${quota.limit} 通` : '（上限なしのプラン）'}。公式アカウントの管理画面・Bot から送った分も含みます。`
      : 'LINE 側の今月の残り通数は読み取れませんでした。',
    '友だちでない相手（友だち登録が確認できていない相手を含む）には LINE が届けません。届いたか・読まれたかはこのアプリでは分かりません。',
  ];
  if (image) notices.push('文字のあとに画像を 1 枚送ります（1 回の送信なので通数は 1 人 1 通です）。画像は 7 日間、推測できない URL で公開されます。');
  return {
    consentId: token,
    expiresAt,
    account: { id: a.id, name: a.name },
    recipients: list.map((c) => ({ conversationId: c.id, title: c.title, maskedId: masked(c) })),
    count: list.length,
    body,
    image: imageView(image),
    monthUsed: used,
    monthlyLimit: a.monthlyLimit ?? null,
    lineUsage: quota?.used ?? null,
    lineLimit: quota?.limit ?? null,
    mock,
    notices,
  };
}

export interface BroadcastStart {
  broadcastId: string;
  replay: boolean;
  /** Requests of at most 500 people, each with its own retry key. */
  requests: { retryKey: string; intentIds: string[]; to: string[] }[];
}

const INVALID_CONSENT = '一斉送信の確認が無効か、有効期限が切れています。もう一度内容を確認してください。';

/** Persists the broadcast and one intent per recipient before anything is sent (one store transaction). */
export function beginBroadcast(state: LineState, user: User, input: { consentId: string; operationId: string; body: string }, now: string, ctx: SendContext): BroadcastStart {
  const nowMs = Date.parse(now);
  const prior = (state.broadcasts ?? []).find((b) => b.operationId === input.operationId);
  if (prior) {
    if (prior.actorId !== user.id || prior.body !== normalizeReplyBody(input.body)) throw new DomainError('conflict', 'この操作は別の送信内容で既に使われています。画面を再読み込みしてください。');
    return { broadcastId: prior.id, replay: true, requests: [] };
  }
  const consent = (state.broadcastConsents ?? []).find((c) => c.tokenHash === sha256(input.consentId));
  if (!consent || consent.actorId !== user.id || Date.parse(consent.expiresAt) <= nowMs) throw new DomainError('conflict', INVALID_CONSENT);
  if (consent.consumedByBroadcastId !== null) throw new DomainError('conflict', 'この確認内容は既に送信処理に使われています。二重送信はしません。');
  const a = account(state, user, consent.accountId);
  const body = normalizeReplyBody(input.body);
  if (sha256(body) !== consent.bodyHash) throw new DomainError('conflict', '確認した後に本文が変更されています。もう一度内容を確認してください。');
  const image = imageOf(state, user, a.id, consent.imageId, nowMs, ctx);
  const targets = new Map(broadcastTargets(state, a.id).map((c) => [c.id, c]));
  const list = consent.conversationIds.map((id) => targets.get(id));
  if (list.some((c) => !c)) throw new DomainError('conflict', '確認した後に宛先の状態が変わりました（友だち解除など）。もう一度内容を確認してください。');
  // Re-checked here: someone else may have sent in the five minutes since the preview.
  checkMonthlyLimit(state, a, list.length, nowMs);

  const broadcast: LineBroadcast = { id: `lb_${randomBytes(8).toString('hex')}`, operationId: input.operationId, actorId: user.id, accountId: a.id, createdAt: now, body, image, intentIds: [] };
  const live = a.outbound === 'push';
  const requests: BroadcastStart['requests'] = [];
  list.forEach((conv, i) => {
    if (i % MULTICAST_MAX === 0) requests.push({ retryKey: randomUUID(), intentIds: [], to: [] });
    const request = requests.at(-1)!;
    const c = conv!;
    if (c.target.kind !== 'messaging_api') throw new Error('integrity: broadcast to a legacy chat');
    const intent: OutboxIntent = {
      id: `lo_${randomBytes(8).toString('hex')}`,
      operationId: `${input.operationId}:${i}`,
      actorId: user.id,
      accountId: a.id,
      conversationId: c.id,
      target: { ...c.target },
      targetFingerprint: targetFingerprint(a, c),
      body,
      bodyHash: consent.bodyHash,
      method: 'push',
      connector: live ? 'messaging_api' : 'mock',
      retryKey: request.retryKey,
      createdAt: now,
      billableRecipients: 1,
      status: 'pending',
      statusReason: null,
      retryNotBefore: null,
      attempts: [{ n: 1, actorId: user.id, startedAt: now, finishedAt: null, outcome: null, requestId: null, httpStatus: null, retryAfterSeconds: null }],
      image,
      broadcastId: broadcast.id,
    };
    state.outbox.push(intent);
    broadcast.intentIds.push(intent.id);
    request.intentIds.push(intent.id);
    request.to.push(c.target.id);
    c.history.push({ id: nextLineId(state, 'lhist'), at: now, actorId: user.id, action: 'reply_started', from: null, to: `一斉送信（${list.length} 人）${image ? '・画像あり' : ''}・操作 ${input.operationId.slice(0, 8)}` });
  });
  state.broadcasts = [...(state.broadcasts ?? []), broadcast];
  consent.consumedByBroadcastId = broadcast.id;
  return { broadcastId: broadcast.id, replay: false, requests };
}

/** The result of one multicast request, for each of its recipients. */
export function recordBroadcastAttempt(state: LineState, intentIds: string[], result: LinePushOutcome, now: string): void {
  for (const id of intentIds) recordAttempt(state, id, 1, result, now);
}

export function broadcastSummary(state: LineState, broadcastId: string, inFlight: ReadonlySet<string>): { count: number; statuses: Record<OutboxStatus, number> } {
  const b = (state.broadcasts ?? []).find((x) => x.id === broadcastId);
  const statuses: Record<OutboxStatus, number> = { pending: 0, accepted: 0, failed: 0, unknown: 0, manual_review: 0 };
  for (const id of b?.intentIds ?? []) {
    const o = state.outbox.find((x) => x.id === id);
    if (!o) continue;
    const s = o.status === 'pending' && !inFlight.has(o.id) ? 'unknown' : o.status;
    statuses[s] += 1;
  }
  return { count: b?.intentIds.length ?? 0, statuses };
}
