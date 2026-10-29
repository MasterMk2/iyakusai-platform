import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../src/server/domain/store.js';
import { MockInboundConnector, type MockConnectorOptions } from '../../src/server/connector/mock.js';
import type { FetchResult, InboundConnector } from '../../src/server/connector/types.js';
import { isAllowedHost } from '../../src/server/http/app.js';
import { ADMIN, EDITOR_A, EDITOR_C, makeApp, NOACCESS_D, R, TEST_HOST, VIEWER_B, type TestApp } from '../helpers.js';

const ALL_USERS = [EDITOR_A, VIEWER_B, EDITOR_C, NOACCESS_D, ADMIN];
const ACCESS: Record<string, Record<string, 'read' | 'edit'>> = {
  [EDITOR_A]: { 'mbx-support': 'edit', 'mbx-sales': 'edit' },
  [VIEWER_B]: { 'mbx-support': 'read', 'mbx-billing': 'read' },
  [EDITOR_C]: { 'mbx-billing': 'edit', 'mbx-sales': 'read' },
  [NOACCESS_D]: {},
  [ADMIN]: {},
};
const RECEIPT_MAILBOX: Record<string, string> = {
  [R.supportLogin]: 'mbx-support',
  [R.supportHtml]: 'mbx-support',
  [R.supportAttachment]: 'mbx-support',
  [R.salesQuote]: 'mbx-sales',
  [R.salesContract]: 'mbx-sales',
  [R.billingContract]: 'mbx-billing',
  [R.billingLate]: 'mbx-billing',
};
const HIDDEN = /mock-src-|mock-(support|sales|billing)-\d|Delivered-To|deliveredTo|providerMessageId|sourceMailboxKey|sourceKey|rawHeaders|contentHash|internetMessageId|messageId|msg_/;

const hasNote = (app: TestApp, body: string) => app.store.current.receipts.some((r) => r.notes.some((n) => n.body === body));

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});

describe('demo authentication', () => {
  it('labels the session as demo authentication and requires a persona', async () => {
    expect((await t.call(null, 'GET', '/api/session')).json).toEqual({ demoAuthentication: true, user: null });
    for (const url of ['/api/mailboxes', '/api/threads', `/api/receipts/${R.supportLogin}`, '/api/labels', '/api/admin/access', '/api/demo/faults']) {
      expect((await t.call(null, 'GET', url)).status, url).toBe(401);
    }
    const login = await t.app.inject({ method: 'POST', url: '/api/session', headers: { host: TEST_HOST }, payload: { userId: VIEWER_B } });
    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await t.call(null, 'POST', '/api/session', { userId: 'u-nobody' })).status).toBe(422);
    expect((await t.call('u-nobody', 'GET', '/api/mailboxes')).status).toBe(401);
  });

  it('rejects cross-origin state changes', async () => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/receipts/${R.supportLogin}/triage`,
      headers: { host: TEST_HOST, cookie: `smm_demo_persona=${EDITOR_A}`, origin: 'http://evil.example' },
      payload: { expectedVersion: 1, status: 'done' },
    });
    expect(res.statusCode).toBe(403);
    expect((await t.call(EDITOR_A, 'GET', `/api/receipts/${R.supportLogin}`)).json.triage.status).toBe('in_progress');
  });

  it('rejects cross-site fetch metadata on state changes', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/receipts/${R.supportLogin}/notes`,
      headers: { host: TEST_HOST, cookie: `smm_demo_persona=${EDITOR_A}`, 'sec-fetch-site': 'cross-site' },
      payload: { body: '別サイトからのメモ' },
    });
    expect(res.statusCode).toBe(403);
    expect(hasNote(t, '別サイトからのメモ')).toBe(false);
  });
});

describe('DNS-rebinding Host guard', () => {
  const HOSTILE = ['rebind.example:5178', 'evil.example', '127.0.0.1.rebind.example:5178', 'localhost.rebind.example:5178', '127.0.0.1:5179', 'localhost:80', '127.0.0.1:5178@evil.example', '[::2]:5178', ''];

  it('rejects hostile or mismatched Host headers on reads, static files and mutations', async () => {
    const before = JSON.stringify(t.store.current);
    for (const host of HOSTILE) {
      for (const [method, url] of [['GET', '/api/session'], ['GET', '/api/health'], ['GET', '/'], ['GET', '/api/mailboxes']] as const) {
        const res = await t.app.inject({ method, url, headers: { host, cookie: `smm_demo_persona=${EDITOR_A}` } });
        expect(res.statusCode, `${host} ${url}`).toBe(421);
        expect(res.body).not.toContain('合成');
      }
      // The rebinding attack: the page origin and Host agree, but name the attacker's domain.
      const reset = await t.app.inject({
        method: 'POST',
        url: '/api/demo/reset',
        headers: { host, origin: `http://${host}`, cookie: `smm_demo_persona=${ADMIN}` },
      });
      expect(reset.statusCode, host).toBe(421);
      const note = await t.app.inject({
        method: 'POST',
        url: `/api/receipts/${R.supportLogin}/notes`,
        headers: { host, origin: `http://${host}`, cookie: `smm_demo_persona=${EDITOR_A}` },
        payload: { body: '再バインド経由のメモ' },
      });
      expect(note.statusCode, host).toBe(421);
    }
    expect(JSON.stringify(t.store.current)).toBe(before);
  });

  it('accepts loopback names on the listening port, with a matching Origin for mutations', async () => {
    for (const host of [TEST_HOST, 'localhost:5178', 'LOCALHOST:5178', '[::1]:5178']) {
      const session = await t.app.inject({ method: 'GET', url: '/api/session', headers: { host } });
      expect(session.statusCode, host).toBe(200);
      const note = await t.app.inject({
        method: 'POST',
        url: `/api/receipts/${R.supportLogin}/notes`,
        headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', cookie: `smm_demo_persona=${EDITOR_A}` },
        payload: { body: `ループバック ${host}` },
      });
      expect(note.statusCode, host).toBe(201);
    }
    // A loopback Host with another loopback Origin is still cross-origin.
    const mismatch = await t.app.inject({
      method: 'POST',
      url: `/api/receipts/${R.supportLogin}/notes`,
      headers: { host: TEST_HOST, origin: 'http://localhost:5178', cookie: `smm_demo_persona=${EDITOR_A}` },
      payload: { body: '不一致' },
    });
    expect(mismatch.statusCode).toBe(403);
  });

  it('isAllowedHost requires an exact loopback name and the configured port', () => {
    expect(isAllowedHost('127.0.0.1:5178', 5178)).toBe(true);
    expect(isAllowedHost('localhost:5178', 5178)).toBe(true);
    expect(isAllowedHost('[::1]:5178', 5178)).toBe(true);
    expect(isAllowedHost(undefined, 5178)).toBe(false);
    expect(isAllowedHost('127.0.0.1', 5178)).toBe(false);
    expect(isAllowedHost('127.0.0.1:5178', 5179)).toBe(false);
    expect(isAllowedHost('127.0.0.2:5178', 5178)).toBe(false);
    expect(isAllowedHost('rebind.example:5178', 5178)).toBe(false);
  });
});

describe('demo controls are restricted to the demo administrator', () => {
  const FAULTS = { failNextRequests: 1, delayNextRequests: 0, delayMs: 0, connectorFailMailboxId: 'mbx-support' };

  it('rejects reset and fault injection from every non-administrator persona without side effects', async () => {
    await t.call(EDITOR_A, 'POST', `/api/receipts/${R.salesQuote}/notes`, { body: 'リセットされないメモ' });
    const before = JSON.stringify(t.store.current);
    for (const user of [EDITOR_A, VIEWER_B, EDITOR_C, NOACCESS_D]) {
      expect((await t.call(user, 'POST', '/api/demo/reset')).status, user).toBe(403);
      expect((await t.call(user, 'GET', '/api/demo/faults')).status, user).toBe(403);
      const put = await t.call(user, 'PUT', '/api/demo/faults', FAULTS);
      expect(put.status, user).toBe(403);
      expect(put.json.message).toContain('デモ管理者');
    }
    expect((await t.call(null, 'POST', '/api/demo/reset')).status).toBe(401);
    expect((await t.call(null, 'PUT', '/api/demo/faults', FAULTS)).status).toBe(401);
    expect(JSON.stringify(t.store.current)).toBe(before);
    // No fault was armed: the next ordinary request and sync succeed.
    expect((await t.call(EDITOR_A, 'GET', '/api/mailboxes')).status).toBe(200);
    expect((await t.call(ADMIN, 'POST', '/api/admin/sync', {})).json.failed).toBe(0);
    expect((await t.call(ADMIN, 'GET', '/api/demo/faults')).json).toEqual({ failNextRequests: 0, delayNextRequests: 0, delayMs: 0, connectorFailMailboxId: null });
  });

  it('lets the administrator inject faults that affect other personas and reset the sample', async () => {
    await t.call(EDITOR_A, 'POST', `/api/receipts/${R.salesQuote}/notes`, { body: 'リセットで消えるメモ' });
    expect((await t.call(ADMIN, 'PUT', '/api/demo/faults', { ...FAULTS, connectorFailMailboxId: null })).status).toBe(200);
    expect((await t.call(VIEWER_B, 'GET', '/api/mailboxes')).status).toBe(503);
    expect((await t.call(VIEWER_B, 'GET', '/api/mailboxes')).status).toBe(200);
    expect((await t.call(ADMIN, 'POST', '/api/demo/reset')).status).toBe(200);
    expect(hasNote(t, 'リセットで消えるメモ')).toBe(false);
  });
});

describe('sample reset and mock sync are serialized', () => {
  function gatedConnector() {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const createConnector = (options: MockConnectorOptions): InboundConnector => {
      const inner = new MockInboundConnector(options);
      return {
        id: inner.id,
        kind: inner.kind,
        async fetchSince(key: string, cursor: number): Promise<FetchResult> {
          markStarted();
          await gate;
          return inner.fetchSince(key, cursor);
        },
      };
    };
    return { createConnector, release, started };
  }

  it('rejects a reset with 409 while a sync awaits the connector, then both succeed afterwards', async () => {
    const gated = gatedConnector();
    const g = await makeApp(null, { createConnector: gated.createConnector });
    await g.call(EDITOR_A, 'POST', `/api/receipts/${R.supportLogin}/notes`, { body: '同期中も残るメモ' });
    expect((await g.call(ADMIN, 'POST', '/api/admin/mock/release')).status).toBe(200);

    const sync = g.call(ADMIN, 'POST', '/api/admin/sync', { mode: 'incremental' });
    await gated.started;
    const before = JSON.stringify(g.store.current);
    const reset = await g.call(ADMIN, 'POST', '/api/demo/reset');
    expect(reset.status).toBe(409);
    expect(reset.json.error).toBe('conflict');
    expect(reset.json.message).toContain('同期');
    expect((await g.call(ADMIN, 'POST', '/api/admin/sync', {})).status).toBe(409); // concurrent sync is also refused
    expect(JSON.stringify(g.store.current)).toBe(before);

    gated.release();
    const report = await sync;
    expect(report.status).toBe(200);
    expect(report.json).toMatchObject({ imported: 2, failed: 0 });
    expect(hasNote(g, '同期中も残るメモ')).toBe(true);

    // Idempotent retry after the race keeps every receipt and handling data.
    const receipts = g.store.current.receipts.length;
    expect((await g.call(ADMIN, 'POST', '/api/admin/sync', { mode: 'full' })).json.imported).toBe(0);
    expect(g.store.current.receipts).toHaveLength(receipts);

    // Once the sync has finished, reset works and is not overwritten by stale sync results.
    expect((await g.call(ADMIN, 'POST', '/api/demo/reset')).status).toBe(200);
    expect(g.store.current.mockConnector.releasedBatch).toBe(1);
    expect(hasNote(g, '同期中も残るメモ')).toBe(false);
  });
});

describe('mailbox isolation across every endpoint', () => {
  it('lists only permitted mailboxes with access level and counts', async () => {
    for (const user of ALL_USERS) {
      const res = await t.call(user, 'GET', '/api/mailboxes');
      expect(res.status).toBe(200);
      const got = Object.fromEntries(res.json.map((m: { id: string; access: string }) => [m.id, m.access]));
      expect(got, user).toEqual(ACCESS[user]);
    }
  });

  it('enforces the ACL on direct receipt, thread, attachment, assignee, triage and note IDs', async () => {
    for (const user of ALL_USERS) {
      for (const [receiptId, mailboxId] of Object.entries(RECEIPT_MAILBOX)) {
        const level = ACCESS[user]![mailboxId];
        const label = `${user} ${mailboxId} ${receiptId}`;
        const receipt = await t.call(user, 'GET', `/api/receipts/${receiptId}`);
        expect(receipt.status, label).toBe(level ? 200 : 404);
        const threadId = t.store.current.receipts.find((r) => r.id === receiptId)!.threadId;
        expect((await t.call(user, 'GET', `/api/threads/${threadId}`)).status, label).toBe(level ? 200 : 404);
        expect((await t.call(user, 'GET', `/api/receipts/${receiptId}/attachments/att1`)).status, label).toBe(
          level && receiptId === R.supportAttachment ? 200 : 404,
        );
        expect((await t.call(user, 'GET', `/api/receipts/${receiptId}/assignees`)).status, label).toBe(level === 'edit' ? 200 : level ? 403 : 404);
        const version = t.store.current.receipts.find((r) => r.id === receiptId)!.triage.version;
        const patch = await t.call(user, 'PATCH', `/api/receipts/${receiptId}/triage`, { expectedVersion: version, labels: ['ACL確認'] });
        expect(patch.status, label).toBe(level === 'edit' ? 200 : level ? 403 : 404);
        const note = await t.call(user, 'POST', `/api/receipts/${receiptId}/notes`, { body: 'ACL確認メモ' });
        expect(note.status, label).toBe(level === 'edit' ? 201 : level ? 403 : 404);
      }
    }
  });

  it('returns the same 404 body for unknown and unauthorized IDs and mailbox scopes', async () => {
    const unknown = await t.call(EDITOR_A, 'GET', '/api/receipts/rc_0000000000000000');
    const forbidden = await t.call(EDITOR_A, 'GET', `/api/receipts/${R.billingLate}`);
    expect(forbidden.status).toBe(404);
    expect(forbidden.json).toEqual(unknown.json);
    const unknownScope = await t.call(EDITOR_A, 'GET', '/api/threads?mailboxId=mbx-nothing');
    const forbiddenScope = await t.call(EDITOR_A, 'GET', '/api/threads?mailboxId=mbx-billing');
    expect(forbiddenScope.status).toBe(404);
    expect(forbiddenScope.json).toEqual(unknownScope.json);
    expect((await t.call(EDITOR_A, 'GET', '/api/labels?mailboxId=mbx-billing')).status).toBe(404);
  });

  it('never serializes hidden delivery metadata or shared message identifiers', async () => {
    for (const user of [EDITOR_A, VIEWER_B, EDITOR_C]) {
      const list = await t.call(user, 'GET', '/api/threads?pageSize=50');
      expect(list.raw).not.toMatch(HIDDEN);
      for (const item of list.json.items) {
        const thread = await t.call(user, 'GET', `/api/threads/${item.threadId}`);
        expect(thread.raw, item.subject).not.toMatch(HIDDEN);
      }
    }
  });

  it('scopes search results, snippets, counts, labels and paging to permitted receipts', async () => {
    const keyword = encodeURIComponent('請求限定キーワード');
    expect((await t.call(EDITOR_A, 'GET', `/api/threads?q=${keyword}`)).json).toMatchObject({ total: 0, items: [] });
    const b = await t.call(VIEWER_B, 'GET', `/api/threads?q=${keyword}`);
    expect(b.json.total).toBe(1);
    expect(b.json.items[0].snippet).toContain('請求限定キーワード');

    const a = (await t.call(EDITOR_A, 'GET', '/api/threads?pageSize=50')).json;
    expect(a.items.every((i: { mailbox: { id: string } }) => ['mbx-support', 'mbx-sales'].includes(i.mailbox.id))).toBe(true);
    expect(a.total).toBe(a.items.length);
    const p2 = (await t.call(EDITOR_A, 'GET', '/api/threads?pageSize=3&page=2')).json;
    expect(p2.total).toBe(a.total);
    expect(p2.items.map((i: { threadId: string }) => i.threadId)).toEqual(a.items.slice(3, 6).map((i: { threadId: string }) => i.threadId));

    const labelsA = (await t.call(EDITOR_A, 'GET', '/api/labels')).json.map((l: { label: string }) => l.label);
    expect(labelsA).toEqual(['契約', '要確認']);
    expect((await t.call(EDITOR_A, 'GET', `/api/threads?label=${encodeURIComponent('請求限定ラベル')}`)).json.total).toBe(0);

    const contract = (await t.call(EDITOR_A, 'GET', `/api/threads?q=${encodeURIComponent('契約更新')}`)).json;
    expect(contract.items).toHaveLength(1);
    expect(contract.items[0]).toMatchObject({ receiptCount: 1, labels: ['契約'], statuses: ['unhandled'] });
    const contractC = (await t.call(EDITOR_C, 'GET', `/api/threads?mailboxId=mbx-billing&q=${encodeURIComponent('契約更新')}`)).json;
    expect(contractC.items[0]).toMatchObject({ receiptCount: 2, labels: ['請求'] });

    const supportB = (await t.call(VIEWER_B, 'GET', '/api/mailboxes')).json.find((m: { id: string }) => m.id === 'mbx-support');
    const supportA = (await t.call(EDITOR_A, 'GET', '/api/mailboxes')).json.find((m: { id: string }) => m.id === 'mbx-support');
    expect(supportB).toMatchObject({ threadCount: supportA.threadCount, unhandledCount: supportA.unhandledCount });
  });

  it('keeps metadata separate for the two receipts of one message', async () => {
    await t.call(EDITOR_A, 'PATCH', `/api/receipts/${R.salesContract}/triage`, { expectedVersion: 1, status: 'done', assigneeId: EDITOR_A });
    await t.call(EDITOR_A, 'POST', `/api/receipts/${R.salesContract}/notes`, { body: '営業側のメモ' });
    const billing = (await t.call(EDITOR_C, 'GET', `/api/receipts/${R.billingContract}`)).json;
    expect(billing.triage).toMatchObject({ status: 'on_hold', labels: ['請求'], assignee: { id: EDITOR_C } });
    expect(billing.notes.map((n: { body: string }) => n.body)).not.toContain('営業側のメモ');
    const sales = (await t.call(EDITOR_C, 'GET', `/api/receipts/${R.salesContract}`)).json;
    expect(sales.triage).toMatchObject({ status: 'done', assignee: { id: EDITOR_A } });
    expect(sales.triage.assignee.hasMailboxAccess).toBeUndefined(); // C only reads sales
    expect(sales.to).toEqual([{ name: '営業窓口', address: 'sales@shared-mail.example' }]);
    expect(billing.to).toEqual([{ name: '請求窓口', address: 'billing@shared-mail.example' }]);
  });
});

describe('mutations, history and conflicts', () => {
  it('records history and rejects a stale write while keeping the successful state', async () => {
    const ok = await t.call(EDITOR_A, 'PATCH', `/api/receipts/${R.salesQuote}/triage`, { expectedVersion: 1, status: 'in_progress', assigneeId: EDITOR_A, labels: ['見積'] });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ version: 2, status: 'in_progress', labels: ['見積'], assignee: { id: EDITOR_A, hasMailboxAccess: true } });
    const stale = await t.call(EDITOR_A, 'PATCH', `/api/receipts/${R.salesQuote}/triage`, { expectedVersion: 1, status: 'done' });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe('conflict');
    expect(stale.json.current).toMatchObject({ version: 2, status: 'in_progress' });
    const view = (await t.call(EDITOR_A, 'GET', `/api/receipts/${R.salesQuote}`)).json;
    expect(view.triage.status).toBe('in_progress');
    expect(view.history.map((h: { action: string }) => h.action)).toEqual(['assignee', 'status', 'labels']);
    expect(view.history[0]).toMatchObject({ actorName: '編集担当A', from: null, to: '編集担当A' });
  });

  it('rejects malformed and invalid input without changing state', async () => {
    const before = JSON.stringify(t.store.current);
    const url = `/api/receipts/${R.salesQuote}/triage`;
    const cases: [unknown, number][] = [
      [{ expectedVersion: 1, status: 'replied' }, 400],
      [{ expectedVersion: 1 }, 400],
      [{ expectedVersion: '1', status: 'done' }, 400],
      [{ expectedVersion: 1, status: 'done', extra: true }, 400],
      [{ expectedVersion: 1, labels: 'not-array' }, 400],
      [{ expectedVersion: 1, labels: ['x'.repeat(21)] }, 422],
      [{ expectedVersion: 1, labels: [''] }, 422],
      [{ expectedVersion: 1, assigneeId: VIEWER_B }, 422],
      [{ expectedVersion: 1, assigneeId: 'U PPER' }, 400],
    ];
    for (const [body, status] of cases) {
      const res = await t.call(EDITOR_A, 'PATCH', url, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(res.json.message).toBeTruthy();
    }
    const raw = await t.app.inject({
      method: 'PATCH',
      url,
      headers: { host: TEST_HOST, cookie: `smm_demo_persona=${EDITOR_A}`, 'content-type': 'application/json' },
      payload: '{"expectedVersion":1,',
    });
    expect(raw.statusCode).toBe(400);
    expect((await t.call(EDITOR_A, 'POST', `/api/receipts/${R.salesQuote}/notes`, { body: ' ' })).status).toBe(422);
    expect((await t.call(EDITOR_A, 'POST', `/api/receipts/${R.salesQuote}/notes`, { text: 'x' })).status).toBe(400);
    expect((await t.call(EDITOR_A, 'GET', '/api/receipts/not-an-id')).status).toBe(400);
    expect((await t.call(EDITOR_A, 'GET', '/api/threads?pageSize=100')).status).toBe(200);
    for (const q of ['page=0', 'pageSize=101', 'pageSize=500', 'status=closed', `q=${'x'.repeat(101)}`, 'unknown=1', 'mailboxId=../x']) {
      expect((await t.call(EDITOR_A, 'GET', `/api/threads?${q}`)).status, q).toBe(400);
    }
    expect(JSON.stringify(t.store.current)).toBe(before);
  });
});

describe('demo administration: revocation and mock sync', () => {
  it('restricts administration to the demo administrator and audits grant changes', async () => {
    expect((await t.call(EDITOR_A, 'GET', '/api/admin/access')).status).toBe(403);
    expect((await t.call(EDITOR_A, 'POST', '/api/admin/sync', {})).status).toBe(403);
    const matrix = (await t.call(ADMIN, 'GET', '/api/admin/access')).json;
    expect(matrix.users.map((u: { id: string }) => u.id)).not.toContain(ADMIN);
    expect((await t.call(ADMIN, 'GET', '/api/threads')).json.total).toBe(0);

    const revoke = await t.call(ADMIN, 'PUT', '/api/admin/access', { userId: VIEWER_B, mailboxId: 'mbx-billing', level: 'none', expectedVersion: matrix.version });
    expect(revoke.status).toBe(200);
    expect((await t.call(VIEWER_B, 'GET', `/api/receipts/${R.billingLate}`)).status).toBe(404);
    expect((await t.call(VIEWER_B, 'GET', `/api/threads?q=${encodeURIComponent('請求限定キーワード')}`)).json.total).toBe(0);
    const stale = await t.call(ADMIN, 'PUT', '/api/admin/access', { userId: VIEWER_B, mailboxId: 'mbx-billing', level: 'read', expectedVersion: matrix.version });
    expect(stale.status).toBe(409);
    const audit = (await t.call(ADMIN, 'GET', '/api/admin/audit')).json;
    expect(audit[0]).toMatchObject({ action: 'grant_changed', actorName: 'デモ管理者' });
    expect(audit[0].detail).toContain('閲覧担当B');
  });

  it('downgrading edit to read blocks further edits immediately', async () => {
    const version = (await t.call(ADMIN, 'GET', '/api/admin/access')).json.version;
    await t.call(ADMIN, 'PUT', '/api/admin/access', { userId: EDITOR_A, mailboxId: 'mbx-support', level: 'read', expectedVersion: version });
    expect((await t.call(EDITOR_A, 'PATCH', `/api/receipts/${R.supportLogin}/triage`, { expectedVersion: 1, status: 'done' })).status).toBe(403);
    expect((await t.call(EDITOR_A, 'GET', `/api/receipts/${R.supportLogin}`)).json.access).toBe('read');
  });

  it('syncs idempotently, preserves handling data and recovers from a connector failure', async () => {
    await t.call(EDITOR_A, 'PATCH', `/api/receipts/${R.supportLogin}/triage`, { expectedVersion: 1, status: 'on_hold', labels: ['要確認', '再同期確認'] });
    await t.call(EDITOR_A, 'POST', `/api/receipts/${R.supportLogin}/notes`, { body: '再同期でも消えないメモ' });
    const handled = structuredClone(t.store.current.receipts.find((r) => r.id === R.supportLogin));

    expect((await t.call(ADMIN, 'POST', '/api/admin/sync', { mode: 'incremental' })).json).toMatchObject({ imported: 0, duplicates: 0 });
    expect((await t.call(ADMIN, 'POST', '/api/admin/mock/release')).json).toEqual({ releasedBatch: 2 });
    expect((await t.call(ADMIN, 'POST', '/api/admin/mock/release')).status).toBe(409);

    await t.call(ADMIN, 'PUT', '/api/demo/faults', { failNextRequests: 0, delayNextRequests: 0, delayMs: 0, connectorFailMailboxId: 'mbx-support' });
    const failed = (await t.call(ADMIN, 'POST', '/api/admin/sync', {})).json;
    expect(failed).toMatchObject({ imported: 1, duplicates: 0, rejected: 1, failed: 1 });
    await t.call(ADMIN, 'PUT', '/api/demo/faults', { failNextRequests: 0, delayNextRequests: 0, delayMs: 0, connectorFailMailboxId: null });
    const retry = (await t.call(ADMIN, 'POST', '/api/admin/sync', {})).json;
    expect(retry).toMatchObject({ imported: 1, duplicates: 1, failed: 0 });
    const full = (await t.call(ADMIN, 'POST', '/api/admin/sync', { mode: 'full' })).json;
    expect(full.imported).toBe(0);
    // Every stored receipt plus the provider re-delivery of an already imported item.
    expect(full.duplicates).toBe(t.store.current.receipts.length + 1);
    expect(full.rejected).toBe(1);

    expect(t.store.current.receipts.find((r) => r.id === R.supportLogin)).toEqual(handled);
    const titles = (await t.call(VIEWER_B, 'GET', `/api/threads?mailboxId=mbx-support&q=${encodeURIComponent('パスワード再設定')}`)).json;
    expect(titles.total).toBe(1);
    expect((await t.call(EDITOR_A, 'GET', `/api/threads?q=${encodeURIComponent('パスワード再設定')}`)).json.total).toBe(1);
    expect((await t.call(EDITOR_C, 'GET', `/api/threads?q=${encodeURIComponent('パスワード再設定')}`)).json.total).toBe(0);
  });
});

describe('failure injection, retry and persistence', () => {
  it('fails the next request before any mutation, then succeeds on retry', async () => {
    await t.call(ADMIN, 'PUT', '/api/demo/faults', { failNextRequests: 1, delayNextRequests: 0, delayMs: 0, connectorFailMailboxId: null });
    const failed = await t.call(EDITOR_A, 'PATCH', `/api/receipts/${R.salesQuote}/triage`, { expectedVersion: 1, status: 'done' });
    expect(failed.status).toBe(503);
    expect(failed.json.error).toBe('simulated_failure');
    expect(t.store.current.receipts.find((r) => r.id === R.salesQuote)!.triage).toMatchObject({ version: 1, status: 'unhandled' });
    const retry = await t.call(EDITOR_A, 'PATCH', `/api/receipts/${R.salesQuote}/triage`, { expectedVersion: 1, status: 'done' });
    expect(retry.status).toBe(200);
  });

  it('delays the next request when asked', async () => {
    await t.call(ADMIN, 'PUT', '/api/demo/faults', { failNextRequests: 0, delayNextRequests: 1, delayMs: 150, connectorFailMailboxId: null });
    const started = Date.now();
    expect((await t.call(EDITOR_A, 'GET', '/api/mailboxes')).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('rejects invalid fault settings', async () => {
    expect((await t.call(ADMIN, 'PUT', '/api/demo/faults', { failNextRequests: 99, delayNextRequests: 0, delayMs: 0, connectorFailMailboxId: null })).status).toBe(400);
    expect((await t.call(ADMIN, 'PUT', '/api/demo/faults', { failNextRequests: 0, delayNextRequests: 0, delayMs: 0, connectorFailMailboxId: 'mbx-none' })).status).toBe(422);
  });

  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('persists changes to the local demo file and resets to the synthetic sample', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.tmp', 'api-'));
    dirs.push(dir);
    const file = join(dir, 'state.json');
    const local = await makeApp(file);
    local.store.replace(local.store.current);
    await local.call(EDITOR_A, 'PATCH', `/api/receipts/${R.salesQuote}/triage`, { expectedVersion: 1, status: 'done' });
    const reloaded = StateStore.load(file)!;
    expect(reloaded.receipts.find((r) => r.id === R.salesQuote)!.triage.status).toBe('done');
    expect((await local.call(ADMIN, 'POST', '/api/demo/reset')).status).toBe(200);
    expect(StateStore.load(file)!.receipts.find((r) => r.id === R.salesQuote)!.triage.status).toBe('unhandled');
  });
});

describe('HTTP safety headers and attachment handling', () => {
  it('sends a restrictive CSP and related headers on API responses', async () => {
    const res = await t.call(EDITOR_A, 'GET', '/api/mailboxes');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'.*form-action 'none'.*object-src 'none'/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('serves attachments only as sandboxed downloads', async () => {
    const res = await t.call(VIEWER_B, 'GET', `/api/receipts/${R.supportAttachment}/attachments/att1`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment;.*sample-log\.txt/);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect((await t.call(VIEWER_B, 'GET', `/api/receipts/${R.supportAttachment}/attachments/att9`)).status).toBe(404);
  });

  it('returns sanitized HTML and a plain-text path for the hostile sample', async () => {
    const view = (await t.call(EDITOR_A, 'GET', `/api/receipts/${R.supportHtml}`)).json;
    expect(view.hasHtml).toBe(true);
    expect(view.sanitizedHtml).not.toMatch(/<script|onerror|onload|<form|\ssrc=|\shref=/i);
    expect(view.text).toContain('危険な HTML を含む合成メールです');
    expect(view.blockedRemoteResources).toBeGreaterThan(0);
  });
});
