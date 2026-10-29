import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { ConfigError } from '../../src/server/auth.js';
import { listInbox } from '../../src/server/domain/inbox.js';
import { listThreads } from '../../src/server/domain/queries.js';
import { SAMPLE_USERS } from '../../src/server/connector/fixtures.js';
import { BOT, LINE_SHOP, LINE_SUPPORT, LINE_USER, UNSENT_TEXT, mockLineId } from '../../src/server/line/fixtures.js';
import { applyEventBatch, applyLegacyBatch } from '../../src/server/line/ingest.js';
import { collectLineItems, lineConversationDetail, namesFrom } from '../../src/server/line/queries.js';
import { beginSend, CONSENT_TTL_MS, discardDraft, evaluateTarget, MAX_CONSENTS, MAX_CONSENTS_PER_ACTOR, previewReply, RECENT_DM_WINDOW_MS, saveDraft } from '../../src/server/line/reply.js';
import { createLineSeedState, releaseLineBatches } from '../../src/server/line/seed.js';
import { isLineState, LineStore } from '../../src/server/line/store.js';
import type { User } from '../../src/server/domain/types.js';
import { seedState, T0 } from '../helpers.js';
import { CONV, envelope, uuid } from '../line-helpers.js';

const user = (id: string): User => SAMPLE_USERS.find((u) => u.id === id)!;
const EDITOR_C = user('u-editor-c');
const VIEWER_B = user('u-viewer-b');
const EDITOR_A = user('u-editor-a');
const ADMIN = user('u-admin');
const NOACCESS_D = user('u-noaccess-d');

const seed = () => createLineSeedState(T0, { replyGrants: true });
const names = (id: string) => id;
const texts = (s: ReturnType<typeof seed>, conv: string) =>
  s.messages.filter((m) => m.conversationId === conv).sort((a, b) => a.sentAt.localeCompare(b.sentAt)).map((m) => (m.content.kind === 'text' ? m.content.text : `[${m.content.kind}]`));

describe('LINE ingestion: dedup, conflicts, unsend and provenance', () => {
  it('keeps a stable timeline for out-of-order arrival and separates the same external user under two accounts', () => {
    const s = seed();
    expect(texts(s, CONV.l1)).toEqual(['注文した商品の配送状況を教えてください。', '[unsupported]', UNSENT_TEXT]);
    const support = s.conversations.find((c) => c.id === CONV.l1)!;
    const shop = s.conversations.find((c) => c.id === CONV.shopL1)!;
    expect(support.id).not.toBe(shop.id);
    expect(support.accountId).toBe(LINE_SUPPORT);
    expect(shop.accountId).toBe(LINE_SHOP);
    expect(texts(s, CONV.shopL1).join()).toContain('店舗限定キーワード');
    expect(texts(s, CONV.l1).join()).not.toContain('店舗限定キーワード');
  });

  it('treats a redelivery as a duplicate and a changed body under the same event ID as a conflict, without changes', () => {
    const s = seed();
    const first = envelope(900, 'message', { message: { id: '800000000001', type: 'text', text: '最初の本文（合成）' } });
    expect(applyEventBatch(s, 'b', [first], T0)).toMatchObject({ imported: 1 });
    const before = JSON.stringify({ m: s.messages, c: s.conversations });
    const r = applyEventBatch(s, 'b', [
      { ...first, isRedelivery: true, cursor: 'other' },
      { ...first, message: { id: '800000000001', type: 'text', text: '書き換えた本文（合成）' } },
      // Same message ID under a new event ID but different content: also a conflict.
      envelope(901, 'message', { message: { id: '800000000001', type: 'text', text: '別イベントの別本文（合成）' } }),
    ], T0);
    expect(r).toMatchObject({ imported: 0, duplicates: 1, conflicts: 2 });
    expect(JSON.stringify({ m: s.messages, c: s.conversations })).toBe(before);
    expect(JSON.stringify(s)).not.toContain('書き換えた本文');
  });

  it('unsend removes content from the canonical record and no redelivery or new event resurrects it', () => {
    const s = seed();
    releaseLineBatches(s, 2, T0);
    const json = JSON.stringify(s);
    expect(json).not.toContain('SAMPLE-0001');
    const msg = s.messages.find((m) => m.conversationId === CONV.l1 && m.content.kind === 'unsent')!;
    expect(msg.fingerprint).toBeNull();
    expect(s.processedEvents.filter((p) => p.messageId === msg.externalMessageId).every((p) => p.fingerprint === null)).toBe(true);
    // Later replays: the original event, and a fresh event ID carrying the same message ID.
    const again = applyEventBatch(s, 'late', [
      envelope(13, 'message', { message: { id: msg.externalMessageId, type: 'text', text: UNSENT_TEXT } }, { timestamp: '2026-09-02T01:02:00.000Z' }),
      envelope(950, 'message', { message: { id: msg.externalMessageId, type: 'text', text: UNSENT_TEXT } }),
    ], T0);
    expect(again).toMatchObject({ imported: 0, suppressed: 2 });
    expect(JSON.stringify(s)).not.toContain('SAMPLE-0001');
    // Audit and history keep only safe identifiers.
    expect(s.audit.some((a) => a.action === 'line_unsend' && a.detail.includes(msg.id))).toBe(true);
    expect(s.conversations.find((c) => c.id === CONV.l1)!.history.some((h) => h.action === 'message_unsent' && h.to === msg.id)).toBe(true);
    // Search cannot find it either.
    expect(collectLineItems(s, names, EDITOR_C, { q: 'SAMPLE-0001' })).toEqual([]);
  });

  it('applies an unsend that arrives before its message, so the message never appears', () => {
    const s = seed();
    applyEventBatch(s, 'b', [envelope(960, 'unsend', { unsend: { messageId: '800000000077' } })], T0);
    const r = applyEventBatch(s, 'b', [envelope(961, 'message', { message: { id: '800000000077', type: 'text', text: '先に取り消された本文（合成）' } })], T0);
    expect(r).toMatchObject({ imported: 0, suppressed: 1 });
    expect(JSON.stringify(s)).not.toContain('先に取り消された本文');
  });

  it('rejects envelopes carrying a reply token, unknown accounts, mismatched destinations and malformed IDs without storing them', () => {
    const s = seed();
    const r = applyEventBatch(s, 'b', [
      { ...envelope(970, 'message', { message: { id: '800000000100', type: 'text', text: 'トークン付き' } }), replyToken: 'mock-token-970' },
      envelope(971, 'message', { message: { id: '800000000101', type: 'text', text: '未知アカウント' } }, { account: 'line-oa-unknown' }),
      envelope(972, 'message', { message: { id: '800000000102', type: 'text', text: '宛先不一致' } }, { destination: BOT.shop }),
      envelope(973, 'message', { message: { id: '800000000103', type: 'text', text: '名前を ID 扱い' } }, { userId: 'customer1@customer.example' }),
      { ...envelope(974, 'message', { message: { id: '800000000104', type: 'text', text: '検証済み主張' } }), signatureVerified: true },
    ], T0);
    expect(r).toMatchObject({ imported: 0, rejected: 5 });
    const json = JSON.stringify(s);
    for (const marker of ['mock-token-970', 'トークン付き', '未知アカウント', '宛先不一致', '名前を ID 扱い', '検証済み主張']) expect(json).not.toContain(marker);
  });

  it('never lets an older follow/unfollow override a newer one', () => {
    const s = seed();
    applyEventBatch(s, 'b', [
      envelope(980, 'unfollow', {}, { timestamp: '2026-09-30T00:00:00.000Z' }),
      envelope(981, 'follow', {}, { timestamp: '2026-09-29T00:00:00.000Z' }),
    ], T0);
    expect(s.conversations.find((c) => c.id === CONV.l1)!.eligibility.relation).toBe('unfollowed');
  });

  it('imports legacy history read-only: raw payloads dropped, honest placeholders, never a Messaging API target', () => {
    const s = seed();
    const json = JSON.stringify(s);
    expect(json).not.toContain('synthetic raw payload');
    const legacy = s.conversations.find((c) => c.id === CONV.legacy)!;
    expect(legacy.target.kind).toBe('legacy_chat');
    expect(texts(s, CONV.legacy)).toEqual(['以前のやり取りのサンプルです（旧履歴・合成）。', 'こちらは自分が送った旧履歴のサンプルです。', '[unavailable]', '[unsupported]']);
    expect(evaluateTarget(s, legacy, Date.parse(T0))).toMatchObject({ ok: false });
    // Re-importing is idempotent; a changed row under the same ID is a conflict.
    const row = {
      format: 'legacy-snapshot/v1', exportId: 'x', cursor: 'r1',
      chat: { chat_id: 'legacy-chat-001', kind: 'user', name: '旧履歴の会話サンプル' },
      message: { message_id: 'legacy-msg-0001', sent_at: '2026-08-01T01:00:00.000Z', body: '改ざん（合成）', kind: 'text', is_mine: false, e2ee: false, sender_display_name: null },
    };
    expect(applyLegacyBatch(s, 'again', 'line-legacy', [row], T0)).toMatchObject({ imported: 0, conflicts: 1 });
    // Legacy rows are refused for an official account.
    expect(applyLegacyBatch(s, 'x', LINE_SUPPORT, [row], T0)).toMatchObject({ imported: 0, rejected: 1 });
  });
});

describe('LINE push eligibility (stored observations only)', () => {
  it('allows friends, recent 1:1 senders within 7 days and joined groups with a known size; denies everything else', () => {
    const s = seed();
    const now = Date.parse(T0);
    const conv = (id: string) => s.conversations.find((c) => c.id === id)!;
    expect(evaluateTarget(s, conv(CONV.l1), now)).toEqual({ ok: true, billableRecipients: 1 });
    expect(evaluateTarget(s, conv(CONV.group), now)).toEqual({ ok: true, billableRecipients: 4 });
    expect(evaluateTarget(s, conv(CONV.l2Unfollowed), now)).toMatchObject({ ok: false, reason: expect.stringContaining('友だち解除') });
    expect(evaluateTarget(s, conv(CONV.room), now)).toMatchObject({ ok: false, reason: expect.stringContaining('人数が確認できない') });

    // A user who is not a known friend: eligible only within 7 days of their last 1:1 message.
    const dm = mockLineId('U', 'c0d1');
    applyEventBatch(s, 'b', [envelope(990, 'message', { message: { id: '800000000200', type: 'text', text: '友だちではない利用者（合成）' } }, { userId: dm, timestamp: '2026-09-20T00:00:00.000Z' })], T0);
    const c = s.conversations.find((x) => x.target.kind === 'messaging_api' && x.target.id === dm)!;
    const sent = Date.parse('2026-09-20T00:00:00.000Z');
    expect(evaluateTarget(s, c, sent + RECENT_DM_WINDOW_MS).ok).toBe(true);
    expect(evaluateTarget(s, c, sent + RECENT_DM_WINDOW_MS + 1)).toMatchObject({ ok: false, reason: expect.stringContaining('7 日') });

    // Leaving the group revokes eligibility.
    applyEventBatch(s, 'b', [{ ...envelope(991, 'leave', {}), source: { type: 'group', groupId: (conv(CONV.group).target as { id: string }).id } }], T0);
    expect(evaluateTarget(s, conv(CONV.group), now)).toMatchObject({ ok: false });
  });
});

describe('LINE pending-consent limits', () => {
  it('caps live unconsumed consents per actor without blocking other repliers; expiry, consume, discard and replacement free slots', () => {
    const s = seed();
    // Synthetic: a second authorized replier on the same account, and distinct eligible 1:1 conversations.
    s.grants.find((g) => g.userId === VIEWER_B.id && g.accountId === LINE_SUPPORT)!.reply = true;
    const convs = Array.from({ length: MAX_CONSENTS_PER_ACTOR + 3 }, (_, i) => {
      const id = mockLineId('U', `c1${i.toString(16).padStart(2, '0')}`);
      applyEventBatch(s, 'cap', [envelope(1200 + i, 'message', { message: { id: String(800_000_000_300 + i), type: 'text', text: `合成の問い合わせ ${i}` } }, { userId: id, timestamp: T0 })], T0);
      return s.conversations.find((c) => c.target.kind === 'messaging_api' && c.target.id === id)!.id;
    });
    let now = Date.parse(T0);
    const at = () => new Date(now).toISOString();
    const preview = (u: User, conv: string) => {
      const draft = saveDraft(s, u, conv, { body: `合成の返信 ${conv.slice(-4)}`, expectedVersion: s.drafts.find((d) => d.conversationId === conv && d.authorId === u.id)?.version ?? null }, at());
      return previewReply(s, u, conv, { draftId: draft.id, draftVersion: draft.version }, at());
    };
    const live = (u: User) => s.consents.filter((c) => c.actorId === u.id && c.consumedByIntentId === null && Date.parse(c.expiresAt) > now).length;

    for (const conv of convs.slice(0, MAX_CONSENTS_PER_ACTOR)) preview(EDITOR_C, conv);
    expect(live(EDITOR_C)).toBe(MAX_CONSENTS_PER_ACTOR);
    const limit = new RegExp(`1 人あたり ${MAX_CONSENTS_PER_ACTOR} 件まで`);
    expect(() => preview(EDITOR_C, convs[MAX_CONSENTS_PER_ACTOR]!)).toThrow(limit);

    // Another authorized replier is unaffected, and nobody's active confirmation was evicted.
    expect(preview(VIEWER_B, convs[0]!).consentId).toBeTruthy();
    expect(live(EDITOR_C)).toBe(MAX_CONSENTS_PER_ACTOR);
    expect(MAX_CONSENTS).toBe(100);

    // Re-previewing the same draft replaces the actor's own consent: no extra slot, still at the limit.
    const replaced = preview(EDITOR_C, convs[0]!);
    expect(live(EDITOR_C)).toBe(MAX_CONSENTS_PER_ACTOR);
    expect(() => preview(EDITOR_C, convs[MAX_CONSENTS_PER_ACTOR]!)).toThrow(limit);

    // Consuming a consent (send) frees its slot.
    beginSend(s, EDITOR_C, convs[0]!, { consentId: replaced.consentId, operationId: uuid(901), draftId: replaced.draftId, draftVersion: replaced.draftVersion, body: replaced.body }, at());
    preview(EDITOR_C, convs[MAX_CONSENTS_PER_ACTOR]!);
    expect(() => preview(EDITOR_C, convs[MAX_CONSENTS_PER_ACTOR + 1]!)).toThrow(limit);

    // Discarding a draft frees its slot.
    discardDraft(s, EDITOR_C, convs[1]!);
    preview(EDITOR_C, convs[MAX_CONSENTS_PER_ACTOR + 1]!);
    expect(() => preview(EDITOR_C, convs[MAX_CONSENTS_PER_ACTOR + 2]!)).toThrow(limit);

    // Expiry frees every slot.
    now += CONSENT_TTL_MS;
    preview(EDITOR_C, convs[MAX_CONSENTS_PER_ACTOR + 2]!);
    expect(live(EDITOR_C)).toBe(1);
  });
});

describe('LINE ACL, integrated inbox and counts', () => {
  it('filters by account grants before search, counts and paging; administrators and unauthorized users see nothing', async () => {
    const mail = await seedState();
    const s = seed();
    const items = (u: User, q?: string) => collectLineItems(s, names, u, { q }).map((i) => i.conversationId).sort();
    expect(items(EDITOR_C)).toHaveLength(7);
    expect(items(VIEWER_B)).toEqual([CONV.l1, CONV.l2Unfollowed, CONV.group, CONV.room, CONV.legacy, s.conversations.find((c) => c.accountId === 'line-legacy' && c.id !== CONV.legacy)!.id].sort());
    expect(items(VIEWER_B, '店舗限定キーワード')).toEqual([]);
    expect(items(EDITOR_C, '店舗限定キーワード')).toEqual([CONV.shopL1]);
    for (const u of [EDITOR_A, ADMIN, NOACCESS_D]) expect(items(u)).toEqual([]);
    expect(() => lineConversationDetail(s, mail, VIEWER_B, CONV.shopL1, T0, new Set())).toThrow(/閲覧権限/);
    expect(() => lineConversationDetail(s, mail, ADMIN, CONV.l1, T0, new Set())).toThrow(/閲覧権限/);

    // Integrated paging: totals and per-source counts include only permitted, matching items.
    const page1 = listInbox(mail, s, VIEWER_B, { source: 'all', page: 1, pageSize: 5 });
    const all = listInbox(mail, s, VIEWER_B, { source: 'all', page: 1, pageSize: 50 });
    expect(page1.total).toBe(all.items.length);
    expect(all.counts.line).toBe(6);
    expect(all.counts.email).toBe(all.items.filter((i) => i.source === 'email').length);
    expect(page1.items).toEqual(all.items.slice(0, 5));
    expect(listInbox(mail, s, VIEWER_B, { source: 'line', page: 1, pageSize: 50 }).counts.email).toBe(0);
    expect(() => listInbox(mail, s, VIEWER_B, { source: 'all', lineAccountId: LINE_SHOP, page: 1, pageSize: 5 })).toThrow(/閲覧権限/);

    // A mail-only user keeps exactly the previous mail list.
    const legacyList = listThreads(mail, EDITOR_A, { page: 1, pageSize: 50 });
    const inbox = listInbox(mail, s, EDITOR_A, { source: 'all', page: 1, pageSize: 50 });
    expect(inbox.items.map((i) => (i.source === 'email' ? i.threadId : null))).toEqual(legacyList.items.map((i) => i.threadId));
  });

  it('denies a disabled user every LINE path', async () => {
    const mail = await seedState();
    const s = seed();
    const disabled = { ...EDITOR_C, disabled: true };
    expect(collectLineItems(s, namesFrom(mail), disabled, {})).toEqual([]);
    expect(() => lineConversationDetail(s, mail, disabled, CONV.l1, T0, new Set())).toThrow(/閲覧権限/);
  });

  it('shows only the viewer’s own draft and never a reply-capable state without the capability', async () => {
    const mail = await seedState();
    const s = seed();
    s.drafts.push({ id: 'ld_00000000000000aa', conversationId: CONV.l1, accountId: LINE_SUPPORT, authorId: 'u-editor-c', body: '他人の下書き（合成）', version: 1, updatedAt: T0 });
    const viewer = lineConversationDetail(s, mail, VIEWER_B, CONV.l1, T0, new Set());
    expect(viewer.reply).toMatchObject({ available: false, canReply: false, draft: null });
    expect(JSON.stringify(viewer)).not.toContain('他人の下書き');
    expect(JSON.stringify(viewer)).not.toContain(LINE_USER.l1);
  });
});

describe('LINE persistence and configuration', () => {
  it('accepts only its own kind and version (mail state and future versions are invalid)', async () => {
    expect(isLineState(seed())).toBe(true);
    expect(isLineState(await seedState())).toBe(false);
    expect(isLineState({ ...seed(), schemaVersion: 2 })).toBe(false);
    expect(isLineState({ ...seed(), outbox: undefined })).toBe(false);
  });

  it('a failed write leaves memory unchanged', () => {
    const store = new LineStore(seed(), 'mem', () => {
      throw new Error('disk');
    });
    const before = JSON.stringify(store.current);
    expect(() => store.transact((s) => applyEventBatch(s, 'b', [envelope(999, 'follow', {}, { userId: mockLineId('U', 'f001') })], T0))).toThrow('disk');
    expect(JSON.stringify(store.current)).toBe(before);
  });

  it('enables LINE by default only in demo mode and requires a separate file to enable it behind the proxy', () => {
    const demo = loadConfig({ SMM_DATA_FILE: 'tmp/x/state.json' });
    expect(demo.line).toMatchObject({ mode: 'mock' });
    expect(demo.line.mode === 'mock' && demo.line.dataFile.endsWith('state.line.json')).toBe(true);
    expect(loadConfig({ SMM_LINE_MODE: 'off' }).line).toEqual({ mode: 'off' });
    for (const env of [{ SMM_LINE_MODE: 'live' }, { SMM_LINE_MODE: 'off', SMM_LINE_DATA_FILE: 'a.json' }, { SMM_DATA_FILE: 'same.json', SMM_LINE_DATA_FILE: 'same.json' }]) {
      expect(() => loadConfig(env), JSON.stringify(env)).toThrow(ConfigError);
    }
  });
});
