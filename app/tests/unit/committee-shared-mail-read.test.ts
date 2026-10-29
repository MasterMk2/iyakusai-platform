import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editableReceipt, permittedMailboxes, permittedReceipts } from '../../src/server/domain/access.js';
import { getAttachment, getReceipt, getThread, labelFacets, listThreads, mailboxSummaries } from '../../src/server/domain/queries.js';
import { createSeedState } from '../../src/server/domain/seed.js';
import { approvedSharedMailTarget, syntheticCommitteeReader, verifiedCommitteeReader } from '../../src/server/domain/shared-mail-policy.js';
import { applyBatches, applyFetchedItems, fetchAll } from '../../src/server/domain/sync.js';
import type { AppState, CommitteeSharedMailTarget, Mailbox, Receipt, User } from '../../src/server/domain/types.js';
import type { InboundConnector } from '../../src/server/connector/types.js';

let state: AppState;
const user = (id: string): User => state.users.find((u) => u.id === id)!;
const member = (id: string): User => verifiedCommitteeReader(user(id));
const query = { page: 1, pageSize: 100 };
const receipt = (mailboxId: string): Receipt => state.receipts.find((r) => r.mailboxId === mailboxId)!;

function addExcluded(scope: 'personal' | 'unknown'): Receipt {
  const mailbox: Mailbox = { id: `mbx-${scope}`, name: 'Excluded synthetic mailbox', address: `${scope}@staff.invalid`, sourceKey: `mock-src-${scope}`, scope };
  state.mailboxes.push(mailbox);
  const original = state.messages.find((m) => m.id === state.receipts[0]!.messageId)!;
  const message = { ...structuredClone(original), id: `msg-${scope}`, subject: `excluded-${scope}`, text: `secret-${scope}`, attachments: [{ id: 'att-secret', filename: 'private.txt', contentType: 'text/plain', content: 'private-fixture-only' }] };
  state.messages.push(message);
  const delivery = { ...state.receipts[0]!.delivery, sourceMailboxKey: mailbox.sourceKey, deliveredTo: mailbox.address };
  const r: Receipt = { ...structuredClone(state.receipts[0]!), id: `rc-${scope}`, mailboxId: mailbox.id, messageId: message.id, threadId: `th-${scope}`, delivery };
  r.triage.labels = [`label-${scope}`];
  state.receipts.push(r);
  state.grants.push({ userId: 'u-editor-a', mailboxId: mailbox.id, level: 'edit' });
  return r;
}

beforeEach(async () => { state = await createSeedState('2026-10-01T00:00:00.000Z'); });
afterEach(() => { vi.useRealTimers(); });

describe('confirmed committee shared-mail read policy', () => {
  it('gives current members in different departments all shared bodies and attachments', () => {
    const a = member('u-editor-a');
    const c = member('u-editor-c');
    expect(permittedMailboxes(state, a).map((m) => m.id)).toEqual(['mbx-support', 'mbx-sales', 'mbx-billing']);
    expect(permittedMailboxes(state, c).map((m) => m.id)).toEqual(permittedMailboxes(state, a).map((m) => m.id));
    expect(listThreads(state, a, query).items.map((t) => t.threadId)).toEqual(listThreads(state, c, query).items.map((t) => t.threadId));
    for (const r of state.receipts) {
      expect(getReceipt(state, a, r.id).text).toEqual(getReceipt(state, c, r.id).text);
      expect(getThread(state, c, r.threadId).receipts.some((v) => v.receiptId === r.id)).toBe(true);
      for (const attachment of getReceipt(state, a, r.id).attachments) {
        expect(getAttachment(state, c, r.id, attachment.id)).toEqual(getAttachment(state, a, r.id, attachment.id));
      }
    }
  });

  it('allows a current committee member with no old mailbox grant to read every shared mailbox', () => {
    const d = member('u-noaccess-d');
    expect(mailboxSummaries(state, d)).toHaveLength(3);
    expect(mailboxSummaries(state, d).every((m) => m.access === 'read')).toBe(true);
    expect(getReceipt(state, d, state.receipts[0]!.id).text).toBeTruthy();
  });

  it('does not extend handling edits when reading expands', () => {
    const a = member('u-editor-a');
    expect(getReceipt(state, a, receipt('mbx-billing').id).access).toBe('read');
    expect(() => editableReceipt(state, a, receipt('mbx-billing').id)).toThrow();
    expect(editableReceipt(state, a, receipt('mbx-support').id)).toBe(receipt('mbx-support'));
    expect(() => editableReceipt(state, member('u-noaccess-d'), receipt('mbx-support').id)).toThrow();
  });

  it.each(['personal', 'unknown'] as const)('denies %s mailboxes even with an old edit grant or a mistaken allowlist entry', (scope) => {
    const excluded = addExcluded(scope);
    const box = state.mailboxes.find((m) => m.id === excluded.mailboxId)!;
    state.committeeSharedMailReadPolicy!.targets.push({ mailboxId: box.id, address: box.address, sourceKey: box.sourceKey, connectorId: 'mock-inbound' });
    const a = member('u-editor-a');
    expect(() => getReceipt(state, a, excluded.id)).toThrow();
    expect(() => getAttachment(state, a, excluded.id, 'att-secret')).toThrow();
    expect(() => getThread(state, a, excluded.threadId)).toThrow();
    expect(listThreads(state, a, { ...query, q: `secret-${scope}` }).total).toBe(0);
    expect(labelFacets(state, a).some((f) => f.label === `label-${scope}`)).toBe(false);
    expect(mailboxSummaries(state, a)).toHaveLength(3);
  });

  it('does not infer approval from a shared-looking address, an old grant, or a recipient header', () => {
    state.mailboxes[0]!.scope = 'unknown';
    expect(approvedSharedMailTarget(state, state.mailboxes[0]!)).toBeNull();
    expect(() => getReceipt(state, member('u-editor-a'), receipt('mbx-support').id)).toThrow();
  });

  it('denies absent policy instead of migrating a legacy saved state into broader access', () => {
    delete state.committeeSharedMailReadPolicy;
    expect(permittedReceipts(state, member('u-editor-a'))).toEqual([]);
    expect(() => getReceipt(state, member('u-editor-a'), state.receipts[0]!.id)).toThrow();
  });

  it('rejects nonmembers and JSON lookalike membership fields despite old grants', () => {
    const fake = { ...user('u-editor-a'), currentCommitteeMember: true };
    expect(() => permittedReceipts(state, fake)).toThrow();
    expect(() => getReceipt(state, fake, state.receipts[0]!.id)).toThrow();
    const serialized = JSON.parse(JSON.stringify(member('u-editor-a'))) as User;
    expect(() => permittedReceipts(state, serialized)).toThrow();
  });

  it('rejects a disabled or removed principal at the next read', () => {
    const a = member('u-editor-a');
    user(a.id).disabled = true;
    expect(() => permittedReceipts(state, a)).toThrow();
    expect(() => getAttachment(state, a, state.receipts[0]!.id, 'att1')).toThrow();
    state.users = state.users.filter((u) => u.id !== a.id);
    expect(() => permittedMailboxes(state, a)).toThrow();
  });

  it('expires request proof and refuses a clock rollback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const a = member('u-editor-a');
    vi.advanceTimersByTime(5_001);
    expect(() => permittedReceipts(state, a)).toThrow();
    vi.setSystemTime(new Date('2026-09-30T23:59:59Z'));
    expect(() => permittedReceipts(state, a)).toThrow();
  });

  it.each(['sourceMailboxKey', 'connectorId', 'deliveredTo'] as const)('excludes a receipt with mismatched %s before search and counts', (field) => {
    const r = state.receipts[0]!;
    const before = permittedReceipts(state, member('u-editor-a')).length;
    r.delivery[field] = 'private-or-unapproved-fixture';
    const a = member('u-editor-a');
    expect(permittedReceipts(state, a)).toHaveLength(before - 1);
    expect(() => getReceipt(state, a, r.id)).toThrow();
    expect(() => getAttachment(state, a, r.id, 'att1')).toThrow();
  });

  it('rechecks a withdrawn target for existing detail and attachment requests', () => {
    const r = state.receipts[0]!;
    const a = member('u-editor-a');
    state.committeeSharedMailReadPolicy!.targets = state.committeeSharedMailReadPolicy!.targets.filter((t) => t.mailboxId !== r.mailboxId);
    expect(() => getReceipt(state, a, r.id)).toThrow();
    expect(() => getAttachment(state, a, r.id, 'att1')).toThrow();
  });

  it('fails closed for duplicate address/source bindings', () => {
    const target = state.committeeSharedMailReadPolicy!.targets[0]!;
    state.committeeSharedMailReadPolicy!.targets.push({ ...target });
    expect(approvedSharedMailTarget(state, state.mailboxes[0]!)).toBeNull();
  });

  it.each([null, {}, { connectorId: undefined }])('rejects malformed or incomplete persisted delivery metadata: %j', (patch) => {
    const r = state.receipts[0]!;
    r.delivery = (patch && 'connectorId' in patch ? { ...r.delivery, ...patch } : patch) as unknown as Receipt['delivery'];
    expect(() => permittedReceipts(state, member('u-editor-a'))).not.toThrow();
    expect(permittedReceipts(state, member('u-editor-a')).some((v) => v.id === r.id)).toBe(false);
    expect(() => getReceipt(state, member('u-editor-a'), r.id)).toThrow();
  });

  it.each([null, {}, { mailboxId: 'mbx-support' }])('denies malformed persisted target entries without throwing: %j', (bad) => {
    state.committeeSharedMailReadPolicy!.targets.push(bad as unknown as CommitteeSharedMailTarget);
    expect(approvedSharedMailTarget(state, state.mailboxes[0]!)).toBeNull();
    expect(permittedReceipts(state, member('u-editor-a'))).toEqual([]);
  });

  it('limits cookie persona proof to the labelled synthetic fixture composition', () => {
    const a = user('u-editor-a');
    expect(permittedMailboxes(state, syntheticCommitteeReader(state, a))).toHaveLength(3);
    expect(() => permittedMailboxes(state, syntheticCommitteeReader(state, user('u-admin')))).toThrow();
    state.committeeSharedMailReadPolicy!.mode = 'operator-approved';
    expect(() => permittedMailboxes(state, syntheticCommitteeReader(state, a))).toThrow();
  });

  it('does not use synthetic persona verification for an actual-domain target', () => {
    state.mailboxes[0]!.address = 'shared@example.org';
    state.committeeSharedMailReadPolicy!.targets[0]!.address = 'shared@example.org';
    expect(() => permittedMailboxes(state, syntheticCommitteeReader(state, user('u-editor-a')))).toThrow();
  });
});

describe('shared-only acquisition', () => {
  const raw = (deliveredTo = 'support@shared-mail.example') => ({
    providerMessageId: 'synthetic-privacy-001', receivedAt: '2026-10-01T00:00:00.000Z', deliveredTo,
    headers: { subject: 'Synthetic shared message', from: { address: 'sender@sender.example' }, to: [{ address: 'support@shared-mail.example' }] },
    text: 'Shared message may mention a personal contact in its body.',
    attachments: [{ filename: 'fixture.txt', contentType: 'text/plain', content: 'synthetic attachment' }],
  });

  it('never fetches personal or unapproved sources', async () => {
    addExcluded('personal'); addExcluded('unknown');
    const fetchSince = vi.fn(async (_sourceKey: string, _cursor: number) => ({ items: [], nextCursor: 1 }));
    const connector: InboundConnector = { id: 'mock-inbound', kind: 'mock', fetchSince };
    expect(await fetchAll(state, connector, 'full')).toHaveLength(3);
    expect(fetchSince.mock.calls.map((a) => a[0])).toEqual(['mock-src-support', 'mock-src-sales', 'mock-src-billing']);
  });

  it('rejects a private delivery even when To names an approved shared address', () => {
    const before = { messages: state.messages.length, receipts: state.receipts.length };
    expect(applyFetchedItems(state, 'mock-inbound', state.mailboxes[0]!, [raw('personal@staff.invalid')])).toEqual({ imported: 0, duplicates: 0, rejected: 1 });
    expect(state.messages).toHaveLength(before.messages);
    expect(state.receipts).toHaveLength(before.receipts);
  });

  it('allows a verified shared delivery whose body mentions a personal contact', () => {
    const result = applyFetchedItems(state, 'mock-inbound', state.mailboxes[0]!, [raw()]);
    expect(result.imported).toBe(1);
    expect(getReceipt(state, member('u-viewer-b'), state.receipts.at(-1)!.id).text).toContain('personal contact');
  });

  it('refuses connector mismatch without materializing messages', () => {
    const before = state.messages.length;
    expect(applyFetchedItems(state, 'unapproved-connector', state.mailboxes[0]!, [raw()]).rejected).toBe(1);
    expect(state.messages).toHaveLength(before);
  });

  it.each([undefined, null, '', 0])('rejects a missing or invalid connector identity at fetch and both apply boundaries: %j', async (bad) => {
    const mailbox = state.mailboxes[0]!;
    const before = { messages: state.messages.length, receipts: state.receipts.length, cursor: state.mockConnector.cursors[mailbox.sourceKey] };
    const fetchSince = vi.fn(async () => ({ items: [raw()], nextCursor: 99 }));
    const connector: InboundConnector = { id: bad as unknown as string, kind: 'mock', fetchSince };
    expect(await fetchAll(state, connector, 'full')).toEqual([]);
    expect(fetchSince).not.toHaveBeenCalled();
    expect(applyFetchedItems(state, connector.id, mailbox, [raw()])).toEqual({ imported: 0, duplicates: 0, rejected: 1 });
    const result = applyBatches(state, connector.id, [{ mailbox, ok: true, items: [raw()], nextCursor: 99 }], 'system', '2026-10-01T00:00:00.000Z');
    expect(result.failed).toBe(1);
    expect(result.imported).toBe(0);
    expect(state.messages).toHaveLength(before.messages);
    expect(state.receipts).toHaveLength(before.receipts);
    expect(state.mockConnector.cursors[mailbox.sourceKey]).toBe(before.cursor);
  });

  it('rechecks a revoked source after fetch and does not advance its cursor', async () => {
    const connector: InboundConnector = { id: 'mock-inbound', kind: 'mock', fetchSince: async () => ({ items: [raw()], nextCursor: 99 }) };
    const batch = (await fetchAll(state, connector, 'full'))[0]!;
    const before = state.mockConnector.cursors[batch.mailbox.sourceKey];
    state.committeeSharedMailReadPolicy!.targets = [];
    const result = applyBatches(state, connector.id, [batch], 'system', '2026-10-01T00:00:00.000Z');
    expect(result.failed).toBe(1);
    expect(result.imported).toBe(0);
    expect(state.mockConnector.cursors[batch.mailbox.sourceKey]).toBe(before);
  });
});
