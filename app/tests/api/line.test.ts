import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLinePushConnector } from '../../src/server/line/connector.js';
import { LINE_SHOP, LINE_SUPPORT, LINE_USER } from '../../src/server/line/fixtures.js';
import { applyEventBatch } from '../../src/server/line/ingest.js';
import { RETRY_KEY_SAFE_WINDOW_MS, CONSENT_TTL_MS } from '../../src/server/line/reply.js';
import { LineStore } from '../../src/server/line/store.js';
import { ADMIN, EDITOR_A, EDITOR_C, ID, NOACCESS_D, proxyAuth, T0, VIEWER_B, makeProxyApp } from '../helpers.js';
import { CONV, envelope, FlakyDisk, makeLineApp, prepare, uuid, type LineTestApp } from '../line-helpers.js';

mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'line-api-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BODY = 'お問い合わせありがとうございます。配送状況を確認してご連絡します（合成）。';
const intents = (t: LineTestApp) => t.line.current.outbox;
const grantReply = async (t: LineTestApp, userId: string, accountId: string, level: 'none' | 'read' | 'edit', reply: boolean) => {
  const matrix = await t.call(ADMIN, 'GET', '/api/admin/line/access');
  const res = await t.call(ADMIN, 'PUT', '/api/admin/line/access', { userId, accountId, level, reply, expectedVersion: matrix.json.version });
  expect(res.status, res.raw).toBe(200);
};

let t: LineTestApp;
beforeEach(async () => {
  t = await makeLineApp();
});

describe('integrated inbox coexistence', () => {
  it('lists email and LINE under their own ACLs with per-source counts, filters and paging', async () => {
    const c = await t.call(EDITOR_C, 'GET', '/api/inbox?pageSize=50');
    expect(c.status).toBe(200);
    expect(c.json.counts).toEqual({ email: 6, line: 7 });
    expect(c.json.lineEnabled).toBe(true);
    const sources = new Set(c.json.items.map((i: { source: string }) => i.source));
    expect(sources).toEqual(new Set(['email', 'line']));
    expect((await t.call(EDITOR_C, 'GET', '/api/inbox?source=line&pageSize=3')).json).toMatchObject({ total: 7, counts: { email: 0, line: 7 } });
    expect((await t.call(EDITOR_C, 'GET', `/api/inbox?lineAccountId=${LINE_SHOP}`)).json.total).toBe(1);
    // Same name in both sources is never merged.
    const both = await t.call(EDITOR_C, 'GET', `/api/inbox?q=${encodeURIComponent('顧客サンプル')}&pageSize=50`);
    expect(both.json.counts.line).toBeGreaterThan(0);

    const b = await t.call(VIEWER_B, 'GET', `/api/inbox?q=${encodeURIComponent('店舗限定キーワード')}`);
    expect(b.json).toMatchObject({ total: 0, counts: { email: 0, line: 0 } });
    expect((await t.call(VIEWER_B, 'GET', `/api/inbox?lineAccountId=${LINE_SHOP}`)).status).toBe(404);
    expect((await t.call(VIEWER_B, 'GET', `/api/inbox?lineAccountId=${LINE_SHOP}&mailboxId=mbx-support`)).status).toBe(400);
    for (const u of [EDITOR_A, NOACCESS_D]) expect((await t.call(u, 'GET', '/api/inbox?pageSize=50')).json.counts.line).toBe(0);
    expect((await t.call(EDITOR_A, 'GET', '/api/line/accounts')).json).toEqual([]);

    // Old mail API is unchanged.
    const threads = await t.call(EDITOR_A, 'GET', '/api/threads?pageSize=50');
    const inbox = await t.call(EDITOR_A, 'GET', '/api/inbox?pageSize=50');
    expect(inbox.json.items.map((i: { threadId: string }) => i.threadId)).toEqual(threads.json.items.map((i: { threadId: string }) => i.threadId));
    // Labels merge only permitted facets.
    const labels = await t.call(VIEWER_B, 'GET', '/api/inbox/labels');
    expect(labels.json.map((l: { label: string }) => l.label)).not.toContain('契約');
  });

  it('never exposes external LINE IDs, retry keys or consent hashes', async () => {
    const p = await prepare(t, EDITOR_C, CONV.l1, BODY);
    await p.send(uuid(1));
    for (const url of ['/api/inbox?pageSize=50', `/api/line/conversations/${CONV.l1}`, `/api/line/outbox/${intents(t)[0]!.id}`]) {
      const raw = (await t.call(EDITOR_C, 'GET', url)).raw;
      expect(raw).not.toContain(LINE_USER.l1);
      expect(raw).not.toContain(intents(t)[0]!.retryKey);
      expect(raw).not.toMatch(/tokenHash|retryKey|externalMessageId|destination|webhookEventId|cursor/);
    }
  });
});

describe('ACL on detail, notes, drafts and outbound state', () => {
  it('denies unpermitted users and the administrator; read-only users cannot edit or reply', async () => {
    for (const u of [NOACCESS_D, ADMIN, EDITOR_A]) {
      expect((await t.call(u, 'GET', `/api/line/conversations/${CONV.l1}`)).status, u).toBe(404);
      expect((await t.call(u, 'POST', `/api/line/conversations/${CONV.l1}/notes`, { body: 'x' })).status, u).toBe(404);
      expect((await t.call(u, 'PUT', `/api/line/conversations/${CONV.l1}/reply/draft`, { body: 'x', expectedVersion: null })).status, u).toBe(404);
    }
    expect((await t.call(VIEWER_B, 'GET', `/api/line/conversations/${CONV.shopL1}`)).status).toBe(404);
    expect((await t.call(VIEWER_B, 'POST', `/api/line/conversations/${CONV.l1}/notes`, { body: '閲覧者のメモ' })).status).toBe(403);
    expect((await t.call(VIEWER_B, 'PUT', `/api/line/conversations/${CONV.l1}/reply/draft`, { body: '閲覧者の返信', expectedVersion: null })).status).toBe(403);
    expect((await t.call(VIEWER_B, 'GET', `/api/line/conversations/${CONV.l1}`)).json.reply).toMatchObject({ available: false, canReply: false });

    // Outbound state follows the conversation's read grant.
    const p = await prepare(t, EDITOR_C, CONV.l1, BODY);
    const sent = await p.send(uuid(2));
    expect((await t.call(VIEWER_B, 'GET', `/api/line/outbox/${sent.json.outbox.id}`)).status).toBe(200);
    for (const u of [NOACCESS_D, ADMIN]) expect((await t.call(u, 'GET', `/api/line/outbox/${sent.json.outbox.id}`)).status).toBe(404);
    expect((await t.call(VIEWER_B, 'POST', `/api/line/outbox/${sent.json.outbox.id}/retry`, { expectedAttempts: 1 })).status).toBe(403);
  });

  it('triage and notes work per conversation with versions, and assignment never grants', async () => {
    const r = await t.call(EDITOR_C, 'PATCH', `/api/line/conversations/${CONV.group}/triage`, { expectedVersion: 1, status: 'in_progress', assigneeId: VIEWER_B, labels: ['LINE'] });
    expect(r.status, r.raw).toBe(200);
    expect((await t.call(EDITOR_C, 'PATCH', `/api/line/conversations/${CONV.group}/triage`, { expectedVersion: 1, status: 'done' })).status).toBe(409);
    expect((await t.call(EDITOR_C, 'PATCH', `/api/line/conversations/${CONV.group}/triage`, { expectedVersion: 2, assigneeId: EDITOR_A })).status).toBe(422);
    expect((await t.call(EDITOR_C, 'POST', `/api/line/conversations/${CONV.group}/notes`, { body: 'LINE の内部メモ（合成）' })).status).toBe(201);
    const d = (await t.call(VIEWER_B, 'GET', `/api/line/conversations/${CONV.group}`)).json;
    expect(d.notes.map((n: { body: string }) => n.body)).toContain('LINE の内部メモ（合成）');
    expect(JSON.stringify(d.history)).not.toContain('LINE の内部メモ');
    expect((await t.call(EDITOR_A, 'GET', '/api/inbox?pageSize=50')).json.counts.line).toBe(0);
  });
});

describe('manual reply: preview, consent and confirmation', () => {
  it('previews the exact target, body, method and quota caveat, then sends once through the mock with no network access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const connectSpy = vi.spyOn(net.Socket.prototype, 'connect');
    try {
      const p = await prepare(t, EDITOR_C, CONV.l1, `  ${BODY}\r\n`);
      expect(p.preview).toMatchObject({
        account: { id: LINE_SUPPORT, name: 'LINE公式 サポート（模擬）' },
        target: { type: 'user', title: '顧客サンプルL1', maskedId: '…c001' },
        body: BODY,
        method: 'push',
        mock: true,
        billableRecipients: 1,
      });
      expect(p.preview.notices.join()).toMatch(/プッシュ.*月間のメッセージ通数/s);
      expect(p.preview.notices.join()).toContain('実際の LINE への送信は接続されていません');
      const res = await p.send(uuid(10));
      expect(res.status, res.raw).toBe(200);
      expect(res.json).toMatchObject({ replayed: false, outbox: { status: 'accepted', statusLabel: '受付済み（模擬）', mock: true, method: 'push', body: BODY } });
      expect(res.json.outbox.statusNote).toContain('配信や既読は確認できません');
      expect(t.connector.calls).toHaveLength(1);
      expect(t.connector.calls[0]).toMatchObject({ to: LINE_USER.l1, retryKey: intents(t)[0]!.retryKey });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      connectSpy.mockRestore();
    }
    const d = (await t.call(EDITOR_C, 'GET', `/api/line/conversations/${CONV.l1}`)).json;
    expect(d.reply.draft).toBeNull();
    expect(d.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['reply_started', 'reply_result']));
    // History and audit identify the operation, not the body.
    expect(JSON.stringify(d.history)).not.toContain('配送状況を確認して');
    expect(JSON.stringify(t.line.current.audit)).not.toContain('配送状況を確認して');
    expect(JSON.stringify(d)).not.toMatch(/"delivered"|"status":"delivered"/);
  });

  it('a group target keeps its kind and fan-out notice; unknown rooms, unfollowed users and legacy history cannot be replied to', async () => {
    const p = await prepare(t, EDITOR_C, CONV.group, 'グループへの返信（合成）');
    expect(p.preview).toMatchObject({ target: { type: 'group', memberCount: 4 }, billableRecipients: 4 });
    expect(p.preview.notices[0]).toMatch(/参加者全員.*4 人.*個人宛てには送られません/);
    await p.send(uuid(20));
    expect(t.connector.calls[0]!.to).toMatch(/^C/);
    expect(intents(t)[0]).toMatchObject({ target: { type: 'group' }, billableRecipients: 4 });

    for (const conv of [CONV.room, CONV.l2Unfollowed, CONV.legacy]) {
      const d = (await t.call(EDITOR_C, 'GET', `/api/line/conversations/${conv}`)).json;
      expect(d.reply.available, conv).toBe(false);
      expect(d.reply.reason, conv).toBeTruthy();
      expect((await t.call(EDITOR_C, 'PUT', `/api/line/conversations/${conv}/reply/draft`, { body: '送れない返信', expectedVersion: null })).status, conv).toBe(422);
    }
  });

  it('refuses client-supplied recipients, methods and bare confirmation flags', async () => {
    const p = await prepare(t, EDITOR_C, CONV.l1, BODY);
    for (const extra of [{ to: LINE_USER.l2 }, { method: 'reply' }, { replyToken: 'x' }, { confirmed: true }]) {
      expect((await p.send(uuid(30), extra)).status, JSON.stringify(extra)).toBe(400);
    }
    const bare = await t.call(EDITOR_C, 'POST', `/api/line/conversations/${CONV.l1}/reply/send`, { confirmed: true, body: BODY });
    expect(bare.status).toBe(400);
    expect(t.connector.calls).toHaveLength(0);
    expect(intents(t)).toHaveLength(0);
  });

  it('binds the consent to actor, conversation, draft version and exact body', async () => {
    await grantReply(t, VIEWER_B, LINE_SUPPORT, 'read', true);
    const p = await prepare(t, EDITOR_C, CONV.l1, BODY);
    // Another authorized replier cannot use it.
    const stolen = await t.call(VIEWER_B, 'POST', `/api/line/conversations/${CONV.l1}/reply/send`, {
      consentId: p.preview.consentId, operationId: uuid(40), draftId: p.preview.draftId, draftVersion: p.preview.draftVersion, body: p.preview.body,
    });
    expect(stolen.status).toBe(409);
    // Not on another conversation, not with another body.
    const other = await t.call(EDITOR_C, 'POST', `/api/line/conversations/${CONV.group}/reply/send`, {
      consentId: p.preview.consentId, operationId: uuid(41), draftId: p.preview.draftId, draftVersion: p.preview.draftVersion, body: p.preview.body,
    });
    expect(other.status).toBe(409);
    expect((await p.send(uuid(42), { body: `${BODY}追記` })).status).toBe(409);
    expect(t.connector.calls).toHaveLength(0);
    // The untouched consent still works once.
    expect((await p.send(uuid(43))).status).toBe(200);
  });

  it('any edit after preview needs a new confirmation; an expired confirmation is refused', async () => {
    const p = await prepare(t, EDITOR_C, CONV.l1, BODY);
    const draft = (await t.call(EDITOR_C, 'GET', `/api/line/conversations/${CONV.l1}`)).json.reply.draft;
    const edited = await t.call(EDITOR_C, 'PUT', `/api/line/conversations/${CONV.l1}/reply/draft`, { body: `${BODY}（修正）`, expectedVersion: draft.version });
    expect(edited.json.version).toBe(draft.version + 1);
    expect((await p.send(uuid(50))).status).toBe(409);
    expect((await p.send(uuid(51), { draftVersion: edited.json.version, body: edited.json.body })).status).toBe(409);
    // Stale draft writes are rejected too.
    expect((await t.call(EDITOR_C, 'PUT', `/api/line/conversations/${CONV.l1}/reply/draft`, { body: '古い版', expectedVersion: draft.version })).status).toBe(409);

    const q = await prepare(t, EDITOR_C, CONV.l1, `${BODY}（再確認）`);
    t.advance(CONSENT_TTL_MS);
    expect((await q.send(uuid(52))).status).toBe(409);
    expect(t.connector.calls).toHaveLength(0);
  });

  it('parallel clicks and replays produce one intent and one connector call', async () => {
    const p = await prepare(t, EDITOR_C, CONV.l1, BODY);
    const [a, b, c] = await Promise.all([p.send(uuid(60)), p.send(uuid(60)), p.send(uuid(61))]);
    expect([a.status, b.status, c.status].sort()).toEqual([200, 200, 409]);
    expect(intents(t)).toHaveLength(1);
    expect(t.connector.calls).toHaveLength(1);
    const replay = await p.send(uuid(60));
    expect(replay.json).toMatchObject({ replayed: true, outbox: { id: intents(t)[0]!.id, status: 'accepted' } });
    // The same operation ID with another body is a conflict, not a new send.
    expect((await p.send(uuid(60), { body: '別の本文' })).status).toBe(409);
    expect(t.connector.calls).toHaveLength(1);
  });

  it('rechecks the actor at confirmation: revoked reply capability or a disabled user cannot send', async () => {
    const p = await prepare(t, EDITOR_C, CONV.l1, BODY);
    await grantReply(t, EDITOR_C, LINE_SUPPORT, 'edit', false);
    expect((await p.send(uuid(70))).status).toBe(403);
    await grantReply(t, EDITOR_C, LINE_SUPPORT, 'edit', true);
    t.mail.transact((s) => {
      s.users.find((u) => u.id === EDITOR_C)!.disabled = true;
    });
    expect((await p.send(uuid(71))).status).toBe(404);
    expect(t.connector.calls).toHaveLength(0);
    expect(intents(t)).toHaveLength(0);
  });
});

describe('manual reply: results, retries and boundaries', () => {
  async function sendWith(outcomes: Parameters<MockLinePushConnector['script']>[0], n: number, conv = CONV.l1) {
    t.connector.script(outcomes);
    const p = await prepare(t, EDITOR_C, conv, `${BODY} #${n}`);
    return p.send(uuid(n));
  }
  const retry = (id: string, expectedAttempts: number, user = EDITOR_C) => t.call(user, 'POST', `/api/line/outbox/${id}/retry`, { expectedAttempts });

  it('response lost after acceptance is unknown, never delivered; an explicit retry uses the same key and gets an accepted duplicate', async () => {
    const res = await sendWith(['accept_response_lost'], 100);
    expect(res.json.outbox).toMatchObject({ status: 'unknown', statusLabel: '結果不明', retryable: true });
    expect(t.connector.acceptedCount).toBe(1);
    const r = await retry(res.json.outbox.id, 1);
    expect(r.json.outbox).toMatchObject({ status: 'accepted' });
    expect(r.json.outbox.attempts.map((a: { outcome: string }) => a.outcome)).toEqual(['unknown', 'accepted_duplicate']);
    expect(new Set(t.connector.calls.map((c) => c.retryKey)).size).toBe(1);
    expect(t.connector.acceptedCount).toBe(1);
    expect(t.connector.violations).toBe(0);
    expect((await retry(res.json.outbox.id, 2)).status).toBe(409); // accepted: never resent
  });

  it('failure before acceptance is retryable with the same key; concurrent retries have one winner', async () => {
    const res = await sendWith(['fail_before_accept'], 110);
    expect(res.json.outbox).toMatchObject({ status: 'failed', retryable: true });
    const [a, b] = await Promise.all([retry(res.json.outbox.id, 1), retry(res.json.outbox.id, 1)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(t.connector.calls).toHaveLength(2);
    expect(t.connector.calls[0]!.retryKey).toBe(t.connector.calls[1]!.retryKey);
    expect(t.connector.calls[0]!.textHash).toBe(t.connector.calls[1]!.textHash);
  });

  it('rate limit (429) waits for the retry time; permission/config/eligibility failures are final', async () => {
    const res = await sendWith(['rate_limited'], 120);
    expect(res.json.outbox).toMatchObject({ status: 'failed', retryable: true });
    expect(res.json.outbox.retryNotBefore).toBeTruthy();
    expect((await retry(res.json.outbox.id, 1)).status).toBe(409);
    expect(t.connector.calls).toHaveLength(1);
    t.advance(61_000);
    expect((await retry(res.json.outbox.id, 1)).json.outbox.status).toBe('accepted');

    for (const [i, outcome] of (['permission_denied', 'not_configured', 'ineligible'] as const).entries()) {
      const r = await sendWith([outcome], 130 + i);
      expect(r.json.outbox, outcome).toMatchObject({ status: 'failed', retryable: false });
      const calls = t.connector.calls.length;
      expect((await retry(r.json.outbox.id, 1)).status, outcome).toBe(409);
      expect(t.connector.calls).toHaveLength(calls);
    }
  });

  it('blocks retries at the 24-hour key boundary and after the target became ineligible (manual review, no new key)', async () => {
    const early = await sendWith(['server_error'], 140);
    const late = await sendWith(['server_error'], 141);
    t.advance(RETRY_KEY_SAFE_WINDOW_MS - 1);
    expect((await retry(early.json.outbox.id, 1)).json.outbox.status).toBe('accepted');
    t.advance(1);
    const calls = t.connector.calls.length;
    const blocked = await retry(late.json.outbox.id, 1);
    expect(blocked.status).toBe(409);
    expect(blocked.json.details.outbox).toMatchObject({ status: 'manual_review', retryable: false });
    expect((await retry(late.json.outbox.id, 1)).status).toBe(409);
    expect(t.connector.calls).toHaveLength(calls);

    // Target change: the user unfollows after an unknown result.
    const t2 = await makeLineApp();
    t2.connector.script(['server_error']);
    const p = await prepare(t2, EDITOR_C, CONV.l1, BODY);
    const sent = await p.send(uuid(150));
    t2.line.transact((s) => applyEventBatch(s, 'test', [envelope(9150, 'unfollow', {}, { timestamp: '2026-09-30T00:00:00.000Z' })], T0));
    const r = await t2.call(EDITOR_C, 'POST', `/api/line/outbox/${sent.json.outbox.id}/retry`, { expectedAttempts: 1 });
    expect(r.status).toBe(409);
    expect(r.json.details.outbox.status).toBe('manual_review');
    expect(t2.connector.calls).toHaveLength(1);
  });

  it('revoked or disabled actors cannot retry', async () => {
    const res = await sendWith(['server_error'], 160);
    await grantReply(t, EDITOR_C, LINE_SUPPORT, 'edit', false);
    expect((await retry(res.json.outbox.id, 1)).status).toBe(403);
    expect(t.connector.calls).toHaveLength(1);
  });
});

describe('persistence: save failures, restart and replay', () => {
  it('a failed intent save calls no connector and leaves the confirmation usable', async () => {
    const disk = new FlakyDisk();
    const app = await makeLineApp({ file: 'mem://line', writer: disk.writer });
    const p = await prepare(app, EDITOR_C, CONV.l1, BODY);
    disk.failNth(1);
    const res = await p.send(uuid(200));
    expect(res.status).toBe(500);
    expect(app.connector.calls).toHaveLength(0);
    expect(app.line.current.outbox).toHaveLength(0);
    expect(disk.load('mem://line').outbox).toHaveLength(0);
    expect((await p.send(uuid(200))).json.outbox.status).toBe('accepted');
    expect(app.connector.calls).toHaveLength(1);
  });

  it('accepted then local save failure: unknown state survives restart and recovery uses the same key without a duplicate', async () => {
    const disk = new FlakyDisk();
    const connector = new MockLinePushConnector();
    const first = await makeLineApp({ file: 'mem://line', writer: disk.writer, connector });
    const p = await prepare(first, EDITOR_C, CONV.l1, BODY);
    disk.failNth(2); // write 1 = intent, write 2 = result
    const res = await p.send(uuid(210));
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ error: 'result_not_saved' });
    expect(connector.acceptedCount).toBe(1);
    const persisted = disk.load('mem://line');
    expect(persisted.outbox).toHaveLength(1);
    expect(persisted.outbox[0]!.status).toBe('pending');
    expect((await first.call(EDITOR_C, 'GET', `/api/line/outbox/${persisted.outbox[0]!.id}`)).json.status).toBe('unknown');

    // Restart from what was persisted, with the provider-side mock state retained.
    const second = await makeLineApp({ lineState: persisted, file: 'mem://line', writer: disk.writer, connector });
    expect((await p.send(uuid(210))).json.replayed).toBe(true); // replay on the old instance: same intent
    const view = await second.call(EDITOR_C, 'GET', `/api/line/conversations/${CONV.l1}`);
    expect(view.json.outbox[0]).toMatchObject({ status: 'unknown', retryable: true });
    const r = await second.call(EDITOR_C, 'POST', `/api/line/outbox/${persisted.outbox[0]!.id}/retry`, { expectedAttempts: 1 });
    expect(r.json.outbox.status).toBe('accepted');
    expect(connector.acceptedCount).toBe(1);
    expect(connector.calls.map((c) => c.outcome)).toEqual(['accepted', 'accepted_duplicate']);
    expect(new Set(connector.calls.map((c) => c.retryKey)).size).toBe(1);
  });

  it('a real file survives restart: replays return the same result and re-imported events add nothing', async () => {
    const file = join(dir, 'line-state.json');
    const connector = new MockLinePushConnector();
    const first = await makeLineApp({ file, connector });
    first.line.replace(first.line.current);
    const p = await prepare(first, EDITOR_C, CONV.l1, BODY);
    const sent = await p.send(uuid(220));
    const stored = LineStore.inspect(file);
    expect(stored.kind).toBe('ok');
    if (stored.kind !== 'ok') return;
    const second = await makeLineApp({ lineState: stored.state, file, connector });
    const replay = await second.call(EDITOR_C, 'POST', `/api/line/conversations/${CONV.l1}/reply/send`, {
      consentId: p.preview.consentId, operationId: uuid(220), draftId: p.preview.draftId, draftVersion: p.preview.draftVersion, body: p.preview.body,
    });
    expect(replay.json).toMatchObject({ replayed: true, outbox: { id: sent.json.outbox.id, status: 'accepted' } });
    expect(connector.calls).toHaveLength(1);
    const before = second.line.current.messages.length;
    const again = await second.call(ADMIN, 'POST', '/api/demo/line/release');
    expect(again.status).toBe(200);
    const twice = second.line.transact((s) => applyEventBatch(s, 'replay', [envelope(11, 'message', { message: { id: '900000000011', type: 'text', text: '注文した商品の配送状況を教えてください。' } }, { timestamp: '2026-09-02T01:00:00.000Z' })], T0));
    expect(twice.imported).toBe(0);
    expect(second.line.current.messages.length).toBe(before + 2);
  });
});

describe('existing protections and modes', () => {
  it('rejects cross-origin and rebinding requests before any LINE mutation', async () => {
    const p = await prepare(t, EDITOR_C, CONV.l1, BODY);
    const body = { consentId: p.preview.consentId, operationId: uuid(300), draftId: p.preview.draftId, draftVersion: p.preview.draftVersion, body: p.preview.body };
    const url = `/api/line/conversations/${CONV.l1}/reply/send`;
    expect((await t.call(EDITOR_C, 'POST', url, body, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await t.call(EDITOR_C, 'POST', url, body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await t.call(EDITOR_C, 'POST', url, body, { host: 'rebind.example:5178' })).status).toBe(421);
    expect(t.connector.calls).toHaveLength(0);
    expect(intents(t)).toHaveLength(0);
  });

  it('demo-only controls are administrator-only; the administrator cannot read contents', async () => {
    for (const u of [EDITOR_C, VIEWER_B]) {
      expect((await t.call(u, 'POST', '/api/demo/line/release')).status).toBe(403);
      expect((await t.call(u, 'PUT', '/api/demo/line/connector', { next: ['accept'] })).status).toBe(403);
      expect((await t.call(u, 'GET', '/api/admin/line/access')).status).toBe(403);
    }
    const release = await t.call(ADMIN, 'POST', '/api/demo/line/release');
    expect(release.json.report).toMatchObject({ imported: 2, duplicates: 1, conflicts: 1, suppressed: 1, rejected: 2, unsent: 1 });
    expect((await t.call(ADMIN, 'POST', '/api/demo/line/release')).status).toBe(409);
    const audit = await t.call(ADMIN, 'GET', '/api/admin/line/audit');
    expect(audit.raw).not.toContain('SAMPLE-0001');
    expect(audit.raw).not.toContain('配送先を変更');
    expect((await t.call(ADMIN, 'PUT', '/api/admin/line/access', { userId: ADMIN, accountId: LINE_SUPPORT, level: 'read', reply: false, expectedVersion: 1 })).status).toBe(422);
    expect((await t.call(ADMIN, 'PUT', '/api/admin/line/access', { userId: VIEWER_B, accountId: LINE_SUPPORT, level: 'none', reply: true, expectedVersion: 1 })).status).toBe(422);
    // Sample reset restores LINE too.
    expect((await t.call(ADMIN, 'POST', '/api/demo/reset')).status).toBe(200);
    expect(t.line.current.feed.releasedBatch).toBe(1);
  });

  it('trusted-proxy mode without LINE configured has no LINE routes; the inbox still works for mail', async () => {
    const proxy = await makeProxyApp();
    for (const url of ['/api/line/accounts', `/api/line/conversations/${CONV.l1}`, '/api/admin/line/access']) {
      expect((await proxy.call(ID.editorC, 'GET', url)).status, url).toBe(404);
    }
    const inbox = await proxy.call(ID.editorC, 'GET', '/api/inbox');
    expect(inbox.json).toMatchObject({ lineEnabled: false, counts: { line: 0 } });
  });

  it('trusted-proxy mode with mock LINE: reply denied by default, no demo controls, Origin enforced', async () => {
    const proxy = await makeLineApp({ auth: proxyAuth(), replyGrants: false });
    const accounts = await proxy.call(ID.editorC, 'GET', '/api/line/accounts');
    expect(accounts.status).toBe(200);
    expect(accounts.json.every((a: { canReply: boolean }) => !a.canReply)).toBe(true);
    expect((await proxy.call(ID.editorC, 'PUT', `/api/line/conversations/${CONV.l1}/reply/draft`, { body: BODY, expectedVersion: null })).status).toBe(403);
    for (const [m, url] of [['POST', '/api/demo/line/release'], ['GET', '/api/demo/line/connector']] as const) {
      expect((await proxy.call(ID.admin, m, url)).status, url).toBe(404);
    }
    const noOrigin = await proxy.call(ID.editorC, 'POST', `/api/line/conversations/${CONV.l1}/notes`, { body: 'x' }, { origin: 'https://evil.example' });
    expect(noOrigin.status).toBe(403);
  });
});

afterEach(() => vi.restoreAllMocks());
