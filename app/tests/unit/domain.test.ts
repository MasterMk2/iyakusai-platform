import { describe, expect, it } from 'vitest';
import { MOCK_FEED, SAMPLE_MAILBOXES, SAMPLE_USERS } from '../../src/server/connector/fixtures.js';
import { MockInboundConnector } from '../../src/server/connector/mock.js';
import { canRead, permittedReceipts } from '../../src/server/domain/access.js';
import { setGrant } from '../../src/server/domain/admin.js';
import { getReceipt, getThread, labelFacets, listThreads, mailboxSummaries } from '../../src/server/domain/queries.js';
import { displayRecipients } from '../../src/server/domain/recipients.js';
import { StateStore } from '../../src/server/domain/store.js';
import { applyBatches, applyFetchedItems, fetchAll } from '../../src/server/domain/sync.js';
import { addNote, assigneeCandidates, normalizeLabels, updateTriage } from '../../src/server/domain/triage.js';
import { DomainError, type AppState } from '../../src/server/domain/types.js';
import { ADMIN, EDITOR_A, EDITOR_C, NOACCESS_D, R, seedState, T0, userOf, VIEWER_B } from '../helpers.js';

const page = { page: 1, pageSize: 50 };

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  return 'ok';
}

function connectorFor(state: AppState, failing: string | null = null) {
  return new MockInboundConnector({ releasedBatch: () => state.mockConnector.releasedBatch, failingSourceKey: () => failing });
}

describe('synthetic fixtures', () => {
  it('use only reserved .example/.invalid addresses', () => {
    const text = JSON.stringify({ MOCK_FEED, SAMPLE_MAILBOXES, SAMPLE_USERS });
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(10);
    for (const email of emails) expect(email).toMatch(/\.(example|invalid)$/);
    const urls = text.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    for (const url of urls) expect(new URL(url).hostname).toMatch(/\.example$/);
  });
});

describe('message / receipt separation', () => {
  it('stores one message for a two-mailbox delivery but keeps separate receipts and handling data', async () => {
    const state = await seedState();
    const sales = state.receipts.find((r) => r.id === R.salesContract)!;
    const billing = state.receipts.find((r) => r.id === R.billingContract)!;
    expect(sales.messageId).toBe(billing.messageId);
    expect(sales.threadId).not.toBe(billing.threadId);
    expect(sales.triage).toMatchObject({ labels: ['契約'], status: 'unhandled', assigneeId: null });
    expect(billing.triage).toMatchObject({ labels: ['請求'], status: 'on_hold', assigneeId: EDITOR_C });
    expect(sales.notes).toHaveLength(0);
    expect(billing.notes).toHaveLength(1);

    // Editing one receipt never touches the other.
    updateTriage(state, userOf(state, EDITOR_A), R.salesContract, { expectedVersion: 1, status: 'done', labels: ['契約', '完了確認'] }, T0);
    expect(state.receipts.find((r) => r.id === R.billingContract)!.triage).toMatchObject({ labels: ['請求'], status: 'on_hold' });
  });

  it('threads per mailbox from permitted receipts only', async () => {
    const state = await seedState();
    const c = userOf(state, EDITOR_C); // billing edit + sales read
    const billingThread = getThread(state, c, state.receipts.find((r) => r.id === R.billingContract)!.threadId);
    expect(billingThread.receipts.map((r) => r.receiptId)).toEqual([R.billingContract, R.billingContractReply]);
    const salesThread = getThread(state, c, state.receipts.find((r) => r.id === R.salesContract)!.threadId);
    expect(salesThread.receipts).toHaveLength(1);
    const a = userOf(state, EDITOR_A);
    expect(code(() => getThread(state, a, billingThread.threadId))).toBe('not_found');
  });
});

describe('recipient display policy', () => {
  it('shows the own mailbox and external addresses but never other app mailboxes', async () => {
    const state = await seedState();
    const c = userOf(state, EDITOR_C);
    const salesView = getReceipt(state, c, R.salesContract);
    const billingView = getReceipt(state, c, R.billingContract);
    expect(salesView.to.map((a) => a.address)).toEqual(['sales@shared-mail.example']);
    expect(billingView.to.map((a) => a.address)).toEqual(['billing@shared-mail.example']);
    expect(salesView.cc.map((a) => a.address)).toEqual(['partner2@partner.example']);
    // Independent of the viewer's grants: the same rule for everyone.
    const mbx = SAMPLE_MAILBOXES[0]!;
    expect(displayRecipients([{ name: null, address: 'SALES@shared-mail.example' }, { name: null, address: mbx.address }], mbx, SAMPLE_MAILBOXES)).toEqual([
      { name: null, address: mbx.address },
    ]);
  });

  it('never exposes hidden delivery metadata in views', async () => {
    const state = await seedState();
    const json = JSON.stringify(getThread(state, userOf(state, EDITOR_C), state.receipts.find((r) => r.id === R.billingContract)!.threadId));
    expect(json).not.toMatch(/mock-src-|mock-billing-|Delivered-To|providerMessageId|sourceMailboxKey|contract-100@/);
  });
});

describe('mock synchronization', () => {
  it('is idempotent and never erases local handling data', async () => {
    const state = await seedState();
    const before = structuredClone(state.receipts);
    const report = applyBatches(state, 'mock-inbound', await fetchAll(state, connectorFor(state), 'full'), ADMIN, T0);
    expect(report.imported).toBe(0);
    expect(report.duplicates).toBe(before.length);
    expect(state.receipts).toEqual(before);
  });

  it('imports released items, counts duplicates and rejects malformed items without aborting', async () => {
    const state = await seedState();
    const receiptsBefore = state.receipts.length;
    state.mockConnector.releasedBatch = 2;
    const report = applyBatches(state, 'mock-inbound', await fetchAll(state, connectorFor(state), 'incremental'), ADMIN, T0);
    expect(report).toMatchObject({ imported: 2, duplicates: 1, rejected: 1, failed: 0 });
    expect(state.receipts.length).toBe(receiptsBefore + 2);
    const login = state.receipts.find((r) => r.id === R.supportLogin)!;
    expect(login.triage).toMatchObject({ status: 'in_progress', assigneeId: EDITOR_A, labels: ['要確認'] });
    // A new reply joins the existing sales thread.
    const quoteThread = state.receipts.find((r) => r.id === R.salesQuote)!.threadId;
    expect(state.receipts.filter((r) => r.threadId === quoteThread)).toHaveLength(2);
  });

  it('keeps the cursor of a failed mailbox so a retry imports exactly the missing items', async () => {
    const state = await seedState();
    state.mockConnector.releasedBatch = 2;
    const failing = applyBatches(state, 'mock-inbound', await fetchAll(state, connectorFor(state, 'mock-src-support'), 'incremental'), ADMIN, T0);
    expect(failing.failed).toBe(1);
    expect(failing.mailboxes.find((m) => m.mailboxId === 'mbx-support')).toMatchObject({ failed: true, imported: 0 });
    expect(failing.imported).toBe(1); // sales reply
    const retry = applyBatches(state, 'mock-inbound', await fetchAll(state, connectorFor(state), 'incremental'), ADMIN, T0);
    expect(retry).toMatchObject({ imported: 1, duplicates: 1, failed: 0 });
    const again = applyBatches(state, 'mock-inbound', await fetchAll(state, connectorFor(state), 'incremental'), ADMIN, T0);
    expect(again).toMatchObject({ imported: 0, duplicates: 0, rejected: 0 });
  });

  it('treats a Message-ID collision with different content as a separate message', async () => {
    const state = await seedState();
    const mailbox = state.mailboxes[0]!;
    const base = {
      receivedAt: '2026-09-10T00:00:00.000Z',
      deliveredTo: mailbox.address,
      headers: { messageId: '<login-001@customer.example>', subject: '別内容', from: { address: 'other@customer.example' } },
      text: 'different',
    };
    const out = applyFetchedItems(state, 'mock-inbound', mailbox, [{ providerMessageId: 'collide-1', ...base }]);
    expect(out.imported).toBe(1);
    const created = state.receipts[state.receipts.length - 1]!;
    expect(created.messageId).not.toBe(state.receipts.find((r) => r.id === R.supportLogin)!.messageId);
  });
});

describe('mailbox ACL', () => {
  it('scopes receipts per user and never by assignment', async () => {
    const state = await seedState();
    const ids = (u: string) => new Set(permittedReceipts(state, userOf(state, u)).map((r) => r.mailboxId));
    expect(ids(EDITOR_A)).toEqual(new Set(['mbx-support', 'mbx-sales']));
    expect(ids(VIEWER_B)).toEqual(new Set(['mbx-support', 'mbx-billing']));
    expect(ids(EDITOR_C)).toEqual(new Set(['mbx-billing', 'mbx-sales']));
    expect(ids(NOACCESS_D).size).toBe(0);
    expect(ids(ADMIN).size).toBe(0);
    expect(code(() => permittedReceipts(state, userOf(state, EDITOR_A), 'mbx-billing'))).toBe('not_found');
    expect(code(() => permittedReceipts(state, userOf(state, EDITOR_A), 'mbx-unknown'))).toBe('not_found');
  });

  it('rejects edits from readers (403) and hides receipts from non-readers (404)', async () => {
    const state = await seedState();
    expect(code(() => updateTriage(state, userOf(state, VIEWER_B), R.supportLogin, { expectedVersion: 1, status: 'done' }, T0))).toBe('forbidden');
    expect(code(() => addNote(state, userOf(state, VIEWER_B), R.supportLogin, 'x', T0))).toBe('forbidden');
    expect(code(() => updateTriage(state, userOf(state, EDITOR_A), R.billingLate, { expectedVersion: 1, status: 'done' }, T0))).toBe('not_found');
    expect(code(() => getReceipt(state, userOf(state, NOACCESS_D), R.supportLogin))).toBe('not_found');
  });

  it('assigning requires existing read access and does not grant any', async () => {
    const state = await seedState();
    const a = userOf(state, EDITOR_A);
    expect(code(() => updateTriage(state, a, R.salesQuote, { expectedVersion: 1, assigneeId: VIEWER_B }, T0))).toBe('validation');
    expect(code(() => updateTriage(state, a, R.salesQuote, { expectedVersion: 1, assigneeId: 'u-missing' }, T0))).toBe('validation');
    expect(assigneeCandidates(state, a, R.salesQuote).map((u) => u.id).sort()).toEqual([EDITOR_A, EDITOR_C]);
    updateTriage(state, a, R.salesQuote, { expectedVersion: 1, assigneeId: EDITOR_C }, T0);
    expect(canRead(state, EDITOR_C, 'mbx-sales')).toBe(true);
    // Revoke C's sales access: the assignment stays, C loses visibility, editors see the warning flag.
    setGrant(state, userOf(state, ADMIN), { userId: EDITOR_C, mailboxId: 'mbx-sales', level: 'none', expectedVersion: 1 }, T0);
    expect(code(() => getReceipt(state, userOf(state, EDITOR_C), R.salesQuote))).toBe('not_found');
    expect(getReceipt(state, a, R.salesQuote).triage.assignee).toMatchObject({ id: EDITOR_C, hasMailboxAccess: false });
    expect(canRead(state, EDITOR_C, 'mbx-sales')).toBe(false);
  });

  it('applies revocation immediately to every read path', async () => {
    const state = await seedState();
    const b = userOf(state, VIEWER_B);
    expect(listThreads(state, b, { ...page, q: '請求限定キーワード' }).total).toBe(1);
    setGrant(state, userOf(state, ADMIN), { userId: VIEWER_B, mailboxId: 'mbx-billing', level: 'none', expectedVersion: 1 }, T0);
    expect(listThreads(state, b, { ...page, q: '請求限定キーワード' }).total).toBe(0);
    expect(code(() => getReceipt(state, b, R.billingLate))).toBe('not_found');
    expect(labelFacets(state, b).map((l) => l.label)).not.toContain('請求限定ラベル');
    expect(mailboxSummaries(state, b).map((m) => m.id)).toEqual(['mbx-support']);
  });

  it('keeps the demo administrator away from mail', async () => {
    const state = await seedState();
    const admin = userOf(state, ADMIN);
    expect(code(() => setGrant(state, admin, { userId: ADMIN, mailboxId: 'mbx-support', level: 'read', expectedVersion: 1 }, T0))).toBe('validation');
    expect(code(() => setGrant(state, userOf(state, EDITOR_A), { userId: EDITOR_A, mailboxId: 'mbx-billing', level: 'edit', expectedVersion: 1 }, T0))).toBe('forbidden');
    expect(code(() => setGrant(state, admin, { userId: VIEWER_B, mailboxId: 'mbx-sales', level: 'read', expectedVersion: 99 }, T0))).toBe('conflict');
  });
});

describe('thread list, search, counts and paging', () => {
  it('forms search results, snippets, counts and pages from permitted receipts only', async () => {
    const state = await seedState();
    const a = userOf(state, EDITOR_A);
    const b = userOf(state, VIEWER_B);
    expect(listThreads(state, a, { ...page, q: '請求限定キーワード' })).toMatchObject({ total: 0, items: [] });
    const hit = listThreads(state, b, { ...page, q: '請求限定キーワード' });
    expect(hit.total).toBe(1);
    expect(hit.items[0]!.snippet).toContain('請求限定キーワード');

    // Editor A sees the contract thread in sales with 1 receipt; C sees the billing one with 2.
    const contractA = listThreads(state, a, { ...page, q: '契約更新' });
    expect(contractA.items.map((i) => [i.mailbox.id, i.receiptCount])).toEqual([['mbx-sales', 1]]);
    const contractC = listThreads(state, userOf(state, EDITOR_C), { ...page, q: '契約更新', mailboxId: 'mbx-billing' });
    expect(contractC.items.map((i) => [i.mailbox.id, i.receiptCount])).toEqual([['mbx-billing', 2]]);

    const all = listThreads(state, a, page);
    const permittedThreads = new Set(permittedReceipts(state, a).map((r) => r.threadId));
    expect(all.total).toBe(permittedThreads.size);
    const paged = [1, 2, 3].flatMap((p) => listThreads(state, a, { page: p, pageSize: 2 }).items.map((i) => i.threadId));
    expect(paged).toEqual(all.items.map((i) => i.threadId));
    expect(listThreads(state, a, { page: 99, pageSize: 2 }).items).toEqual([]);
  });

  it('filters by status, label and assignee, with label facets limited to permitted receipts', async () => {
    const state = await seedState();
    const a = userOf(state, EDITOR_A);
    expect(listThreads(state, a, { ...page, status: 'in_progress' }).items.map((i) => i.subject)).toEqual(['ログインできません']);
    expect(listThreads(state, a, { ...page, assignee: 'me' }).total).toBe(1);
    expect(listThreads(state, a, { ...page, label: '請求' }).total).toBe(0);
    expect(labelFacets(state, a).map((l) => l.label)).toEqual(['契約', '要確認']);
    expect(labelFacets(state, userOf(state, EDITOR_C)).map((l) => l.label).sort()).toEqual(['契約', '請求', '請求限定ラベル'].sort());
  });

  it('searches HTML-only content through the plain-text path without matching script text', async () => {
    const state = await seedState();
    const a = userOf(state, EDITOR_A);
    expect(listThreads(state, a, { ...page, q: 'イベント属性' }).total).toBe(1);
    expect(listThreads(state, a, { ...page, q: '__smmXss' }).total).toBe(0);
  });
});

describe('triage mutations', () => {
  it('validates, versions and records history; rejects stale writes keeping the newer state', async () => {
    const state = await seedState();
    const a = userOf(state, EDITOR_A);
    const first = updateTriage(state, a, R.salesQuote, { expectedVersion: 1, status: 'in_progress', labels: [' 見積 ', '見積', 'ＶＩＰ'] }, T0);
    expect(first).toMatchObject({ version: 2, status: 'in_progress', labels: ['見積', 'VIP'] });
    expect(code(() => updateTriage(state, a, R.salesQuote, { expectedVersion: 1, status: 'done' }, T0))).toBe('conflict');
    expect(getReceipt(state, a, R.salesQuote).triage).toMatchObject({ version: 2, status: 'in_progress' });
    const history = getReceipt(state, a, R.salesQuote).history.map((h) => [h.action, h.from, h.to]);
    expect(history).toEqual([
      ['status', '未対応', '対応中'],
      ['labels', null, '見積, VIP'],
    ]);
    // No-op save neither bumps the version nor adds history.
    expect(updateTriage(state, a, R.salesQuote, { expectedVersion: 2, status: 'in_progress' }, T0).version).toBe(2);
    // done is reachable and reversible; it is only an internal state.
    expect(updateTriage(state, a, R.salesQuote, { expectedVersion: 2, status: 'done' }, T0).status).toBe('done');
    expect(updateTriage(state, a, R.salesQuote, { expectedVersion: 3, status: 'unhandled', assigneeId: null }, T0).status).toBe('unhandled');
  });

  it('rejects invalid labels and notes', async () => {
    const state = await seedState();
    const a = userOf(state, EDITOR_A);
    expect(code(() => normalizeLabels(['']))).toBe('validation');
    expect(code(() => normalizeLabels(['x'.repeat(21)]))).toBe('validation');
    expect(code(() => normalizeLabels(['a\u0007']))).toBe('validation');
    expect(code(() => normalizeLabels(['1', '2', '3', '4', '5', '6', '7', '8', '9']))).toBe('validation');
    expect(code(() => addNote(state, a, R.salesQuote, '   ', T0))).toBe('validation');
    expect(code(() => addNote(state, a, R.salesQuote, 'x'.repeat(2001), T0))).toBe('validation');
    const note = addNote(state, a, R.salesQuote, '  合成メモ  ', T0);
    expect(note.body).toBe('合成メモ');
    const view = getReceipt(state, a, R.salesQuote);
    expect(view.history.at(-1)).toMatchObject({ action: 'note_added', from: null, to: null });
    // Note on the sales receipt is invisible from the billing receipt of the same message.
    const c = userOf(state, EDITOR_C);
    expect(getReceipt(state, c, R.billingContract).notes.map((n) => n.body)).toEqual(['サンプルメモ: 請求窓口だけの内部メモです。']);
  });
});

describe('state store', () => {
  it('leaves state untouched when a transaction throws', async () => {
    const store = new StateStore(await seedState(), null);
    const before = JSON.stringify(store.current);
    expect(() =>
      store.transact((s) => {
        s.receipts[0]!.triage.status = 'done';
        throw new DomainError('validation', 'boom');
      }),
    ).toThrow('boom');
    expect(JSON.stringify(store.current)).toBe(before);
  });
});
