import { randomBytes, randomUUID } from 'node:crypto';
import { LINE_LIMITS, type LineDraftView, type LinePreviewResponse, type LineTargetView, type OutboxView } from '../../shared/line.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { readableConversation, replyableConversation } from './access.js';
import type { LinePushOutcome, LinePushRequest } from './connector.js';
import { sha256 } from './normalize.js';
import { nextLineId, type AttemptOutcome, type LineAccount, type LineConversation, type LineState, type OutboxIntent } from './types.js';

// Manual reply state machine (the mock connector, or the Messaging API since 2026-10-28).
//
//   draft (versioned, per author) --preview--> consent (hashed token, 5 min, single use,
//   bound to actor + draft version + account + target fingerprint + body hash)
//   --send--> immutable outbox intent persisted BEFORE the connector is called
//   pending --> accepted (platform accepted; NOT delivered/read)
//           --> failed (retryable: not sent / rate limited; or final: permission, config, eligibility)
//           --> unknown (timeout / 5xx / result not saved)
//   failed(retryable) | unknown --explicit retry, same retry key, re-checked--> pending
//   any retry after the safe key window, or after the target changed/became ineligible --> manual_review
//
// Nothing here retries automatically, falls back to another method or channel,
// stores a reply token, or accepts a recipient from the client.

export const CONSENT_TTL_MS = 5 * 60 * 1000;
/** Global bound on live (unexpired) consent records, consumed or not. */
export const MAX_CONSENTS = 100;
/**
 * Provisional (LN09): live, unconsumed consents one actor may hold at once, so a single
 * replier cannot occupy the global capacity. Never evicts anyone's active confirmation.
 */
export const MAX_CONSENTS_PER_ACTOR = 10;
/** Push is allowed to a user who sent a 1:1 message within this window (when not a known friend). */
export const RECENT_DM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Retry keys deduplicate for 24 hours; keep a 10-minute safety margin for clock skew. */
export const RETRY_KEY_SAFE_WINDOW_MS = 24 * 60 * 60 * 1000 - 10 * 60 * 1000;

const RETRYABLE: ReadonlySet<AttemptOutcome> = new Set(['not_sent', 'rate_limited', 'unknown']);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

export function normalizeReplyBody(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (text.length === 0) throw new DomainError('validation', '返信本文を入力してください。', { field: 'body' });
  if (text.length > LINE_LIMITS.replyMaxLength) {
    throw new DomainError('validation', `返信本文は ${LINE_LIMITS.replyMaxLength} 文字以内で入力してください。`, { field: 'body' });
  }
  if (CONTROL.test(text)) throw new DomainError('validation', '返信本文に制御文字は使えません。', { field: 'body' });
  return text;
}

function accountOf(state: LineState, conv: LineConversation): LineAccount {
  const account = state.accounts.find((a) => a.id === conv.accountId);
  if (!account) throw new Error(`integrity: missing LINE account for ${conv.id}`);
  return account;
}

export function targetFingerprint(account: LineAccount, conv: LineConversation): string {
  return sha256(JSON.stringify({ account: account.id, destination: account.destination, outbound: account.outbound, target: conv.target }));
}

/** `countPending`: only the group's member count is unknown, and the preview reads it from LINE (live push). */
export type TargetCheck = { ok: true; billableRecipients: number } | { ok: false; reason: string; countPending?: true };

/** Push eligibility from stored, verified observations only. Unknown means no. */
export function evaluateTarget(state: LineState, conv: LineConversation, nowMs: number): TargetCheck {
  const account = accountOf(state, conv);
  if (conv.target.kind === 'legacy_chat') {
    return { ok: false, reason: '旧履歴の会話は、公式アカウントの送信先として確認されていないため返信できません（閲覧のみ）。' };
  }
  if (account.kind !== 'official_account' || (account.outbound !== 'push_mock' && account.outbound !== 'push') || !account.destination) {
    return { ok: false, reason: 'この LINE アカウントには返信の送信経路が設定されていません。' };
  }
  const e = conv.eligibility;
  if (conv.target.type === 'user') {
    if (e.relation === 'unfollowed') return { ok: false, reason: 'この相手は友だち解除（ブロックを含む）しているため送信できません。' };
    if (e.relation === 'friend') return { ok: true, billableRecipients: 1 };
    if (e.lastUserMessageAt && nowMs - Date.parse(e.lastUserMessageAt) <= RECENT_DM_WINDOW_MS) return { ok: true, billableRecipients: 1 };
    return { ok: false, reason: '友だち登録が確認できず、最後の 1:1 メッセージから 7 日を過ぎているため送信できません。' };
  }
  if (account.allowGroups === false) return { ok: false, reason: 'グループ・トークルームへの送信は設定で止めています（閲覧のみ）。' };
  if (e.relation === 'left') return { ok: false, reason: 'このグループ・トークルームからは退出済みのため送信できません。' };
  if (e.relation !== 'joined' || e.memberCount === null) {
    return { ok: false, reason: 'グループ・トークルームの参加状況または人数が確認できないため、返信できません（閲覧のみ）。', ...(account.outbound === 'push' ? { countPending: true as const } : {}) };
  }
  return { ok: true, billableRecipients: e.memberCount };
}

/** Calendar month in Japan time ("2026-10"), the month LINE counts messages in. */
const jstMonth = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 7);

/**
 * Messages this app has sent from the account this month: every intent that may have reached LINE (all but the
 * failed ones, which LINE never accepted), a group counted once per member as LINE counts it.
 */
export function monthlyUsage(state: LineState, accountId: string, nowMs: number): number {
  const month = jstMonth(nowMs);
  return state.outbox
    .filter((o) => o.accountId === accountId && o.status !== 'failed' && jstMonth(Date.parse(o.createdAt)) === month)
    .reduce((n, o) => n + o.billableRecipients, 0);
}

/** The app's own monthly limit, set in the account configuration (for example the free plan's 200). */
function checkMonthlyLimit(state: LineState, account: LineAccount, billable: number, nowMs: number): void {
  if (account.monthlyLimit === undefined) return;
  const used = monthlyUsage(state, account.id, nowMs);
  if (used + billable > account.monthlyLimit) {
    throw new DomainError('validation', `今月の送信の上限（${account.monthlyLimit} 通）を超えるため送れません。今月はこのアプリから ${used} 通送っています（グループは人数分）。`);
  }
}

/** A member count read from LINE: the account is in the group or room now (2026-10-28). */
export function observeMemberCount(state: LineState, conversationId: string, count: number, now: string): void {
  const conv = state.conversations.find((c) => c.id === conversationId);
  if (!conv || conv.target.kind !== 'messaging_api' || conv.target.type === 'user') return;
  conv.eligibility.memberCount = count;
  conv.eligibility.memberCountAt = now;
  if (conv.eligibility.relation !== 'joined') {
    conv.eligibility.relation = 'joined';
    conv.eligibility.relationAt = now;
  }
}

/** What LINE itself says about this month, read just before a preview (null: not read). */
export interface PreviewQuota {
  limit: number | null;
  used: number;
}

const TYPE_LABEL = { user: '1:1 トーク', group: 'グループ', room: 'トークルーム', legacy_chat: '旧履歴の会話' } as const;

export function targetView(conv: LineConversation): LineTargetView {
  if (conv.target.kind === 'legacy_chat') return { type: 'legacy_chat', typeLabel: TYPE_LABEL.legacy_chat, maskedId: null, memberCount: null };
  return {
    type: conv.target.type,
    typeLabel: TYPE_LABEL[conv.target.type],
    maskedId: `…${conv.target.id.slice(-4)}`,
    memberCount: conv.target.type === 'user' ? null : conv.eligibility.memberCount,
  };
}

function pruneConsents(state: LineState, nowMs: number): void {
  state.consents = state.consents.filter((c) => Date.parse(c.expiresAt) > nowMs);
}

function draftView(d: { id: string; version: number; body: string; updatedAt: string }): LineDraftView {
  return { id: d.id, version: d.version, body: d.body, updatedAt: d.updatedAt };
}

// ---- 1. draft

export function saveDraft(state: LineState, user: User, conversationId: string, input: { body: string; expectedVersion: number | null }, now: string): LineDraftView {
  const conv = replyableConversation(state, user, conversationId);
  const check = evaluateTarget(state, conv, Date.parse(now));
  // A group's member count is read just before the preview, so a draft may be written before it is known.
  if (!check.ok && !check.countPending) throw new DomainError('validation', check.reason);
  const body = normalizeReplyBody(input.body);
  const existing = state.drafts.find((d) => d.conversationId === conv.id && d.authorId === user.id);
  if ((existing?.version ?? null) !== input.expectedVersion) {
    throw new DomainError('conflict', '下書きが別の画面で更新されています。最新の下書きを確認してください。', existing ? { draft: draftView(existing) } : undefined);
  }
  if (existing) {
    if (existing.body === body) return draftView(existing);
    existing.body = body;
    existing.version += 1;
    existing.updatedAt = now;
    // Any confirmation of the previous version is void.
    state.consents = state.consents.filter((c) => c.draftId !== existing.id || c.consumedByIntentId !== null);
    return draftView(existing);
  }
  const draft = { id: `ld_${randomBytes(8).toString('hex')}`, conversationId: conv.id, accountId: conv.accountId, authorId: user.id, body, version: 1, updatedAt: now };
  state.drafts.push(draft);
  return draftView(draft);
}

export function discardDraft(state: LineState, user: User, conversationId: string): void {
  const conv = readableConversation(state, user, conversationId);
  const draft = state.drafts.find((d) => d.conversationId === conv.id && d.authorId === user.id);
  if (!draft) return;
  state.drafts = state.drafts.filter((d) => d.id !== draft.id);
  state.consents = state.consents.filter((c) => c.draftId !== draft.id || c.consumedByIntentId !== null);
}

// ---- 2. preview + server-issued consent

export function previewReply(state: LineState, user: User, conversationId: string, input: { draftId: string; draftVersion: number }, now: string, quota: PreviewQuota | null = null): LinePreviewResponse {
  const nowMs = Date.parse(now);
  const conv = replyableConversation(state, user, conversationId);
  const draft = state.drafts.find((d) => d.id === input.draftId && d.conversationId === conv.id && d.authorId === user.id);
  if (!draft) throw notFound();
  if (draft.version !== input.draftVersion) throw new DomainError('conflict', '下書きが変更されています。保存した最新の内容でもう一度確認してください。');
  const check = evaluateTarget(state, conv, nowMs);
  if (!check.ok) throw new DomainError('validation', check.reason);
  const account = accountOf(state, conv);
  checkMonthlyLimit(state, account, check.billableRecipients, nowMs);
  if (quota && quota.limit !== null && quota.used + check.billableRecipients > quota.limit) {
    throw new DomainError('validation', `LINE 側の今月の通数の上限（${quota.limit} 通）に届くため送れません（使用済み ${quota.used} 通）。`);
  }

  pruneConsents(state, nowMs);
  state.consents = state.consents.filter((c) => !(c.draftId === draft.id && c.actorId === user.id && c.consumedByIntentId === null));
  const held = state.consents.filter((c) => c.actorId === user.id && c.consumedByIntentId === null).length;
  if (held >= MAX_CONSENTS_PER_ACTOR) {
    throw new DomainError('conflict', `確認待ちの送信が多すぎます（1 人あたり ${MAX_CONSENTS_PER_ACTOR} 件まで）。確認済みの返信を送信するか、期限切れ（5 分）を待ってからやり直してください。`);
  }
  if (state.consents.length >= MAX_CONSENTS) throw new DomainError('conflict', '確認待ちの送信が多すぎます。しばらくしてからやり直してください。');

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(nowMs + CONSENT_TTL_MS).toISOString();
  state.consents.push({
    tokenHash: sha256(token),
    actorId: user.id,
    draftId: draft.id,
    draftVersion: draft.version,
    accountId: account.id,
    conversationId: conv.id,
    targetFingerprint: targetFingerprint(account, conv),
    bodyHash: sha256(draft.body),
    createdAt: now,
    expiresAt,
    consumedByIntentId: null,
  });

  const mock = account.outbound === 'push_mock';
  const used = monthlyUsage(state, account.id, nowMs);
  const notices = mock
    ? [
        '送信方法はプッシュメッセージです（応答トークンによる返信は使いません）。受信から時間が経った返信は応答メッセージでは送れないためです。',
        'プッシュメッセージは月間のメッセージ通数（プランの上限）に数えられます。現在のプラン・残り通数・追加料金の可否はこのアプリでは確認していません。',
        '現在は模擬送信です。実際の LINE への送信は接続されていません。',
      ]
    : [
        `公式アカウント「${account.name}」から、相手の LINE にすぐ届きます。送ったあとで取り消すことはできません。`,
        account.monthlyLimit !== undefined
          ? `月の通数に数えられます。今月このアプリから送ったのは ${used} 通、上限は ${account.monthlyLimit} 通です（この送信で ${used + check.billableRecipients} 通）。`
          : `月の通数に数えられます。今月このアプリから送ったのは ${used} 通です。`,
        quota
          ? `LINE 側の今月の通数：${quota.used} 通${quota.limit !== null ? `／上限 ${quota.limit} 通` : '（上限なしのプラン）'}。公式アカウントの管理画面から送った分も含みます。`
          : 'LINE 側の今月の残り通数は読み取れませんでした。',
      ];
  if (conv.target.kind === 'messaging_api' && conv.target.type !== 'user') {
    notices.unshift(`この返信は${TYPE_LABEL[conv.target.type]}の参加者全員（確認済みの人数: ${check.billableRecipients} 人）に届き、人数分の通数として数えられます。個人宛てには送られません。`);
  }
  return {
    consentId: token,
    expiresAt,
    draftId: draft.id,
    draftVersion: draft.version,
    account: { id: account.id, name: account.name },
    target: { ...targetView(conv), title: conv.title },
    body: draft.body,
    method: 'push',
    mock,
    billableRecipients: check.billableRecipients,
    notices,
  };
}

// ---- 3/4. confirm: atomic single-consume and immutable intent

export interface SendInput {
  consentId: string;
  operationId: string;
  draftId: string;
  draftVersion: number;
  body: string;
}

const INVALID_CONSENT = '送信の確認が無効か、有効期限が切れています。もう一度内容を確認してください。';

/**
 * Runs inside one store transaction. Returns the intent to send, or a replay of an
 * existing intent for the same operation. The connector is called only after this
 * transaction was persisted.
 */
export function beginSend(state: LineState, user: User, conversationId: string, input: SendInput, now: string): { intentId: string; attemptNo: number; replay: boolean } {
  const nowMs = Date.parse(now);
  const body = normalizeReplyBody(input.body);
  const bodyHash = sha256(body);

  const prior = state.outbox.find((o) => o.operationId === input.operationId);
  if (prior) {
    readableConversation(state, user, prior.conversationId);
    if (prior.actorId !== user.id || prior.conversationId !== conversationId || prior.bodyHash !== bodyHash) {
      throw new DomainError('conflict', 'この操作は別の送信内容で既に使われています。画面を再読み込みしてください。');
    }
    return { intentId: prior.id, attemptNo: prior.attempts.length, replay: true };
  }

  const conv = replyableConversation(state, user, conversationId);
  const account = accountOf(state, conv);
  const consent = state.consents.find((c) => c.tokenHash === sha256(input.consentId));
  if (!consent || consent.actorId !== user.id || Date.parse(consent.expiresAt) <= nowMs) throw new DomainError('conflict', INVALID_CONSENT);
  if (consent.consumedByIntentId !== null) {
    throw new DomainError('conflict', 'この確認内容は既に送信処理に使われています。二重送信はしません。', { intentId: consent.consumedByIntentId });
  }
  if (consent.conversationId !== conv.id || consent.accountId !== account.id || consent.draftId !== input.draftId || consent.draftVersion !== input.draftVersion) {
    throw new DomainError('conflict', INVALID_CONSENT);
  }
  const draft = state.drafts.find((d) => d.id === consent.draftId && d.authorId === user.id);
  if (!draft || draft.version !== consent.draftVersion || draft.body !== body || consent.bodyHash !== bodyHash) {
    throw new DomainError('conflict', '確認した後に本文が変更されています。もう一度内容を確認してください。');
  }
  const check = evaluateTarget(state, conv, nowMs);
  if (!check.ok) throw new DomainError('validation', check.reason);
  if (targetFingerprint(account, conv) !== consent.targetFingerprint || conv.target.kind !== 'messaging_api') {
    throw new DomainError('conflict', '確認した後に送信先の設定が変わりました。もう一度内容を確認してください。');
  }
  // Re-checked here: someone else may have sent in the five minutes since the preview.
  checkMonthlyLimit(state, account, check.billableRecipients, nowMs);
  const live = account.outbound === 'push';

  const intent: OutboxIntent = {
    id: `lo_${randomBytes(8).toString('hex')}`,
    operationId: input.operationId,
    actorId: user.id,
    accountId: account.id,
    conversationId: conv.id,
    target: { ...conv.target },
    targetFingerprint: consent.targetFingerprint,
    body,
    bodyHash,
    method: 'push',
    connector: live ? 'messaging_api' : 'mock',
    retryKey: randomUUID(),
    createdAt: now,
    billableRecipients: check.billableRecipients,
    status: 'pending',
    statusReason: null,
    retryNotBefore: null,
    attempts: [{ n: 1, actorId: user.id, startedAt: now, finishedAt: null, outcome: null, requestId: null, httpStatus: null, retryAfterSeconds: null }],
  };
  state.outbox.push(intent);
  consent.consumedByIntentId = intent.id;
  state.drafts = state.drafts.filter((d) => d.id !== draft.id);
  conv.history.push({ id: nextLineId(state, 'lhist'), at: now, actorId: user.id, action: 'reply_started', from: null, to: `${live ? 'プッシュ' : 'プッシュ（模擬）'}・操作 ${input.operationId.slice(0, 8)}` });
  return { intentId: intent.id, attemptNo: 1, replay: false };
}

export function pushRequestOf(intent: OutboxIntent): LinePushRequest {
  return { retryKey: intent.retryKey, accountId: intent.accountId, to: intent.target.id, targetType: intent.target.type, text: intent.body };
}

// ---- 5. result

export const OUTCOME_LABEL: Record<AttemptOutcome, string> = {
  accepted: '受付（模擬・HTTP 200 相当）',
  accepted_duplicate: '受付済みの重複（模擬・HTTP 409 相当）',
  not_sent: '送信前に失敗（未送信）',
  rate_limited: '送信回数の制限（模擬・HTTP 429 相当）',
  permission_denied: '権限なし（模擬・HTTP 403 相当）',
  not_configured: '送信経路が未設定',
  ineligible: '送信先の条件を満たさない（模擬）',
  invalid: '不正な要求',
  unknown: '結果不明（応答を確認できず）',
};

const LIVE_OUTCOME_LABEL: Record<AttemptOutcome, string> = {
  accepted: '受付（HTTP 200）',
  accepted_duplicate: '受付済みの重複（HTTP 409）',
  not_sent: '送信前に失敗（未送信）',
  rate_limited: '送信回数・通数の制限（HTTP 429）',
  permission_denied: '権限なし（HTTP 403）',
  not_configured: 'アクセストークンが無効（HTTP 401）',
  ineligible: '送信先の条件を満たさない',
  invalid: '受け付けられない要求（HTTP 400 など）',
  unknown: '結果不明（応答を確認できず）',
};

const LIVE_STATUS_LABEL: Record<OutboxView['status'], string> = {
  pending: '送信処理中',
  accepted: '受付済み',
  failed: '失敗',
  unknown: '結果不明',
  manual_review: '要確認（自動再送なし）',
};

const outcomeLabel = (o: AttemptOutcome, mock: boolean) => (mock ? OUTCOME_LABEL : LIVE_OUTCOME_LABEL)[o];
const statusLabel = (s: OutboxView['status'], mock: boolean) => (mock ? STATUS_LABEL : LIVE_STATUS_LABEL)[s];

function outcomeOf(result: LinePushOutcome): { outcome: AttemptOutcome; requestId: string | null; httpStatus: number | null; retryAfterSeconds: number | null } {
  switch (result.kind) {
    case 'accepted':
      return { outcome: 'accepted', requestId: result.requestId, httpStatus: 200, retryAfterSeconds: null };
    case 'accepted_duplicate':
      return { outcome: 'accepted_duplicate', requestId: result.acceptedRequestId, httpStatus: 409, retryAfterSeconds: null };
    case 'not_sent':
      return { outcome: 'not_sent', requestId: null, httpStatus: null, retryAfterSeconds: null };
    case 'rejected':
      return { outcome: result.reason, requestId: null, httpStatus: result.httpStatus, retryAfterSeconds: result.retryAfterSeconds ?? null };
    case 'unknown':
      return { outcome: 'unknown', requestId: null, httpStatus: null, retryAfterSeconds: null };
  }
}

/** Records the connector result for one attempt. A missing intent (sample reset) or a recorded attempt is left alone. */
export function recordAttempt(state: LineState, intentId: string, attemptNo: number, result: LinePushOutcome, now: string): void {
  const intent = state.outbox.find((o) => o.id === intentId);
  const attempt = intent?.attempts[attemptNo - 1];
  if (!intent || !attempt || attempt.outcome !== null) return;
  const r = outcomeOf(result);
  Object.assign(attempt, { ...r, finishedAt: now });
  intent.retryNotBefore = null;
  intent.statusReason = null;
  if (r.outcome === 'accepted' || r.outcome === 'accepted_duplicate') intent.status = 'accepted';
  else if (r.outcome === 'unknown') intent.status = 'unknown';
  else {
    intent.status = 'failed';
    if (r.outcome === 'rate_limited') intent.retryNotBefore = new Date(Date.parse(now) + (r.retryAfterSeconds ?? 60) * 1000).toISOString();
    if (!RETRYABLE.has(r.outcome)) intent.statusReason = '権限・設定・送信先の条件により受け付けられませんでした。自動では再送しません。';
  }
  const conv = state.conversations.find((c) => c.id === intent.conversationId);
  conv?.history.push({ id: nextLineId(state, 'lhist'), at: now, actorId: attempt.actorId, action: 'reply_result', from: null, to: `${statusLabel(intent.status, intent.connector === 'mock')}: ${outcomeLabel(r.outcome, intent.connector === 'mock')}` });
}

// ---- explicit retry (same key, same recipient, same body)

export type RetryStart = { kind: 'started'; intentId: string; attemptNo: number } | { kind: 'blocked'; intentId: string; message: string };

export function beginRetry(state: LineState, user: User, intentId: string, expectedAttempts: number, now: string, inFlight: boolean): RetryStart {
  const nowMs = Date.parse(now);
  const intent = state.outbox.find((o) => o.id === intentId);
  if (!intent) throw notFound();
  const conv = replyableConversation(state, user, intent.conversationId);
  if (inFlight) throw new DomainError('conflict', '送信処理中です。結果を待ってください。');
  if (intent.attempts.length !== expectedAttempts) throw new DomainError('conflict', '別の操作で既に再試行されています。最新の状態を確認してください。');
  if (intent.status === 'accepted') throw new DomainError('conflict', '受付済みのため再送しません。');
  if (intent.status === 'manual_review') throw new DomainError('conflict', '要確認の送信は自動では再送できません。内容を確認し、新しい返信として作成してください。');
  const last = intent.attempts[intent.attempts.length - 1]!;
  if (intent.status === 'failed' && (last.outcome === null || !RETRYABLE.has(last.outcome))) {
    throw new DomainError('conflict', 'この失敗は再試行できません。内容を確認し、新しい返信として作成してください。');
  }
  if (intent.retryNotBefore && nowMs < Date.parse(intent.retryNotBefore)) {
    throw new DomainError('conflict', '送信回数の制限中です。表示された時刻以降に再試行してください。');
  }

  const block = (reason: string): RetryStart => {
    if (last.outcome === null) Object.assign(last, { outcome: 'unknown', finishedAt: now });
    intent.status = 'manual_review';
    intent.statusReason = reason;
    conv.history.push({ id: nextLineId(state, 'lhist'), at: now, actorId: user.id, action: 'reply_result', from: null, to: `${STATUS_LABEL.manual_review}: ${reason}` });
    return { kind: 'blocked', intentId: intent.id, message: reason };
  };
  if (nowMs - Date.parse(intent.attempts[0]!.startedAt) >= RETRY_KEY_SAFE_WINDOW_MS) {
    return block('再送キーの有効期間（24 時間）を過ぎたため、同じ要求として再送できません。二重送信を避けるため自動では再送しません。');
  }
  const account = accountOf(state, conv);
  const check = evaluateTarget(state, conv, nowMs);
  if (!check.ok || targetFingerprint(account, conv) !== intent.targetFingerprint) {
    return block(`送信先の状態が変わったため再送しません。${check.ok ? '' : check.reason}`);
  }
  // A failed send is not in this month's count; sending it again counts it once more.
  if (intent.status === 'failed') checkMonthlyLimit(state, account, intent.billableRecipients, nowMs);

  // A pending attempt that is not in flight never got its result saved: it is unknown.
  if (last.outcome === null) Object.assign(last, { outcome: 'unknown', finishedAt: now });
  const n = intent.attempts.length + 1;
  intent.attempts.push({ n, actorId: user.id, startedAt: now, finishedAt: null, outcome: null, requestId: null, httpStatus: null, retryAfterSeconds: null });
  intent.status = 'pending';
  intent.statusReason = null;
  intent.retryNotBefore = null;
  conv.history.push({ id: nextLineId(state, 'lhist'), at: now, actorId: user.id, action: 'reply_retry', from: null, to: `再試行 ${n} 回目（同じ宛先・本文・再送キー）` });
  return { kind: 'started', intentId: intent.id, attemptNo: n };
}

// ---- views

export const STATUS_LABEL: Record<OutboxView['status'], string> = {
  pending: '送信処理中（模擬）',
  accepted: '受付済み（模擬）',
  failed: '失敗',
  unknown: '結果不明',
  manual_review: '要確認（自動再送なし）',
};

export function outboxView(intent: OutboxIntent, names: (id: string) => string, nowMs: number, inFlight: boolean): OutboxView {
  const last = intent.attempts[intent.attempts.length - 1]!;
  // A pending intent whose attempt is not running had its result lost: show it as unknown.
  const status = intent.status === 'pending' && !inFlight ? 'unknown' : intent.status;
  const lastOutcome = last.outcome ?? (status === 'unknown' ? 'unknown' : null);
  const windowOpen = nowMs - Date.parse(intent.attempts[0]!.startedAt) < RETRY_KEY_SAFE_WINDOW_MS;
  const retryable = !inFlight && (status === 'unknown' || (status === 'failed' && lastOutcome !== null && RETRYABLE.has(lastOutcome)));
  const mock = intent.connector === 'mock';
  let note: string;
  switch (status) {
    case 'pending':
      note = mock ? '模擬送信の結果を待っています。' : 'LINE の応答を待っています。';
      break;
    case 'accepted':
      note = mock
        ? 'LINE 側が要求を受け付けたことを示す模擬結果です。相手への配信や既読は確認できません。実際の LINE には送信されていません。'
        : 'LINE が送信を受け付けました。相手に届いたか・読んだかはこのアプリでは分かりません。';
      break;
    case 'unknown':
      note = '受け付けられたかどうか確認できていません。配信済みとは扱いません。再試行は同じ再送キーを使うため、受付済みなら二重には送られません。';
      break;
    case 'failed':
      note = intent.statusReason ?? (lastOutcome === 'rate_limited' ? '送信回数の制限により受け付けられませんでした（未送信）。' : '送信されていません。同じ内容・同じ再送キーで再試行できます。');
      break;
    case 'manual_review':
      note = intent.statusReason ?? '自動では再送しません。';
      break;
  }
  if (retryable && !windowOpen) note += ' 再送キーの有効期間を過ぎているため、再試行すると要確認になります。';
  return {
    id: intent.id,
    conversationId: intent.conversationId,
    createdAt: intent.createdAt,
    actorName: names(intent.actorId),
    method: 'push',
    mock,
    body: intent.body,
    status,
    statusLabel: statusLabel(status, mock),
    statusNote: note,
    retryable,
    retryNotBefore: intent.retryNotBefore,
    attempts: intent.attempts.map((a) => ({
      n: a.n,
      startedAt: a.startedAt,
      actorName: names(a.actorId),
      outcome: a.outcome,
      outcomeLabel: a.outcome ? outcomeLabel(a.outcome, mock) : inFlight && a === last ? '処理中' : outcomeLabel('unknown', mock),
    })),
    billableRecipients: intent.billableRecipients,
  };
}
