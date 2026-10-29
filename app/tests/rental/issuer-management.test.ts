import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssuerManagement } from '../../src/server/rental/issuer-management.js';
import { CardHistory } from '../../src/server/rental/card-history.js';
import { createHash } from 'node:crypto';
import { RentalStore } from '../../src/server/rental/store.js';
import { ACTOR, metadata, RED, statusOf } from './helpers.js';

const ORIGIN = 'https://app.example.test';
let dir: string, store: RentalStore, manager: IssuerManagement;
const items = [1, 2].map(i => ({ code: `IY-10000${i}`, name: `試験用の机${i}`, url: `${ORIGIN}/i/IY-10000${i}`, borrower_name: '模擬店A', item_scope: '学外', item_owner: '試験レンタル会社' }));
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iy-issuer-'));
  store = new RentalStore(dir, { demo: true });
  manager = new IssuerManagement(store, ORIGIN);
  const borrower = store.createBorrower('模擬店A').borrower;
  store.preassign(items.map(i => ({ ...i, borrower_id: borrower.id })), ACTOR, ORIGIN);
});
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(dir, { recursive: true, force: true }); });
const apply = (p: ReturnType<IssuerManagement['preview']>, allowed = true) => manager.apply({ token: p.token, confirmation: p.mode === 'force_reset' ? '物品台帳を強制リセット' : p.mode === 'reset' ? '物品台帳をリセット' : p.mode === 'overwrite' ? '上書きを実行' : '変更を反映' }, ACTOR, allowed);

describe('issuer edits, with reviewed identity and optimistic concurrency', () => {
  it('exports exact codes, URL, planned groups, owner and status without changing versions', () => {
    const before = manager.snapshot();
    expect(before.items).toHaveLength(2);
    expect(before.items[0]).toMatchObject({ ...items[0], status: 'ready', planned_state: 'pending' });
    expect(manager.snapshot().revision).toBe(before.revision);
  });
  it('previews a name conflict without writing, and permits it only in explicit overwrite mode', () => {
    const changed = [{ ...items[0]!, name: '変更後の机' }];
    const before = manager.snapshot();
    const blocked = manager.preview({ mode: 'update', items: changed }, ACTOR, true);
    expect(blocked.blocked_count).toBe(1);
    expect(statusOf(() => apply(blocked))).toBe(409);
    expect(manager.snapshot().revision).toBe(before.revision);
    const preview = manager.preview({ mode: 'overwrite', items: changed }, ACTOR, true);
    expect(preview.changes[0]!.fields).toContain('name');
    apply(preview);
    expect(store.issuance(items[0]!.code).name).toBe('変更後の机');
    expect(store.item(items[1]!.code).name).toBe(items[1]!.name);
    expect(store.db.prepare('SELECT count(*) AS n FROM issuer_management_events').get()!.n).toBe(1);
  });
  it('keeps the old preassignment API from silently overwriting a name', () => {
    const group = store.borrowerGroups()[0]!;
    expect(statusOf(() => store.preassign([{ ...items[0], name: '別の物品', borrower_id: group.id }], ACTOR, ORIGIN))).toBe(409);
  });
  it('refuses a preview after another request changed the ledger', () => {
    const preview = manager.preview({ mode: 'overwrite', items: [{ ...items[0], name: '更新' }] }, ACTOR, true);
    store.db.prepare('UPDATE items SET version=version+1 WHERE code=?').run(items[1]!.code);
    expect(statusOf(() => apply(preview))).toBe(409);
    expect(store.item(items[0]!.code).name).toBe(items[0]!.name);
  });
  it.each(['loaned','review'])('blocks the whole batch when an item is %s', status => {
    store.db.prepare('UPDATE items SET status=? WHERE code=?').run(status, items[1]!.code);
    const preview = manager.preview({ mode: 'overwrite', items: items.map(i => ({ ...i, name: '更新' })) }, ACTOR, true);
    expect(preview.blocked_count).toBe(1);
    expect(statusOf(() => apply(preview))).toBe(409);
    expect(store.item(items[0]!.code).name).toBe(items[0]!.name);
  });
  it('rejects foreign URL changes even in overwrite mode', () => {
    expect(statusOf(() => manager.preview({ mode: 'overwrite', items: [{ ...items[0], url: 'https://other.example/i/IY-100001' }] }, ACTOR, true))).toBe(400);
  });
  it('allows an existing legacy URL to be explicitly changed to the configured canonical URL', () => {
    store.db.prepare('UPDATE issuance SET url=? WHERE code=?').run('https://legacy.example/i/IY-100001', items[0]!.code);
    const p = manager.preview({ mode: 'overwrite', items: [items[0]] }, ACTOR, true);
    expect(p.changes[0]!.fields).toContain('url');
    apply(p);
    expect(store.issuance(items[0]!.code).url).toBe(items[0]!.url);
  });
  it('requires the preview owner, exact confirmation, and a nonexpired preview', () => {
    const p = manager.preview({ mode: 'reset' }, ACTOR, true);
    expect(statusOf(() => manager.apply({ token: p.token, confirmation: '物品台帳をリセット' }, { id: 'other', name: '別担当' }, true))).toBe(409);
    expect(statusOf(() => manager.apply({ token: p.token, confirmation: 'yes' }, ACTOR, true))).toBe(400);
    const clock = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(clock + 11 * 60 * 1000);
    expect(statusOf(() => apply(p))).toBe(409);
    expect(manager.snapshot().items).toHaveLength(2);
  });
  it('rolls back item/group edits if saving the audit fails', () => {
    store.db.exec("CREATE TRIGGER reject_issuer_audit BEFORE INSERT ON issuer_management_events BEGIN SELECT RAISE(FAIL,'test-audit-failure'); END;");
    const before = manager.snapshot();
    const p = manager.preview({ mode: 'overwrite', items: [{ ...items[0], borrower_name: '新しい団体', name: '更新' }] }, ACTOR, true);
    expect(() => apply(p)).toThrow('test-audit-failure');
    expect(manager.snapshot().revision).toBe(before.revision);
    expect(store.borrowers()).not.toContain('新しい団体');
  });
  it('preserves metadata omitted by a caller and does not bump an unchanged row', () => {
    const minimal = { code: items[0]!.code, name: items[0]!.name, url: items[0]!.url, borrower_name: items[0]!.borrower_name };
    const before = store.item(minimal.code).version;
    const p = manager.preview({ mode: 'update', items: [minimal] }, ACTOR, true);
    expect(p.changed_count).toBe(0);
    apply(p);
    expect(store.item(minimal.code)).toMatchObject({ version: before, item_scope: '学外', item_owner: '試験レンタル会社' });
  });
});

describe('reset archives active items and never recycles their codes', () => {
  it('requires administrator status for both preview and commit', () => {
    expect(statusOf(() => manager.preview({ mode: 'reset' }, ACTOR, false))).toBe(403);
    const p = manager.preview({ mode: 'reset' }, ACTOR, true);
    expect(statusOf(() => apply(p, false))).toBe(403);
    expect(manager.snapshot().items).toHaveLength(2);
  });
  it('resets the visible ledger and planned groups, retaining the full before-state and reserved codes', () => {
    const result = apply(manager.preview({ mode: 'reset' }, ACTOR, true));
    expect(result.items).toEqual([]);
    expect(result.archived_count).toBe(2);
    expect(result.reserved_through).toBe(100002);
    expect(store.summary()).toMatchObject({ total: 0, planned: 0 });
    expect(store.overview().items).toEqual([]);
    expect(statusOf(() => store.item(items[0]!.code))).toBe(410);
    expect(statusOf(() => store.issuance(items[0]!.code))).toBe(410);
    expect(JSON.parse(String(store.db.prepare('SELECT before_json FROM issuer_management_events').get()!.before_json))[0]).toMatchObject({ name: items[0]!.name, planned_state: 'pending' });
    expect(statusOf(() => manager.preview({ mode: 'overwrite', items: [items[0]] }, ACTOR, true))).toBe(409);
  });
  it('preserves prior loan/return receipts, files and replay semantics', () => {
    const borrowed = metadata({ item_code: items[0]!.code, item_version: store.item(items[0]!.code).version, borrower: '模擬店A', photo_skip: true });
    store.submit(borrowed, [RED], ACTOR);
    const returned = metadata({ item_code: items[0]!.code, item_version: store.item(items[0]!.code).version, action: 'return', borrower: '模擬店A' });
    const receipt = store.submit(returned, [RED], ACTOR);
    const files = store.db.prepare('SELECT count(*) AS n FROM files').get()!.n;
    apply(manager.preview({ mode: 'reset' }, ACTOR, true));
    expect(store.operation(returned.operation_id)).toEqual(receipt);
    expect(store.submit(returned, [RED], ACTOR)).toEqual(receipt);
    expect(store.db.prepare('SELECT count(*) AS n FROM files').get()!.n).toBe(files);
    expect(statusOf(() => store.submit(metadata({ item_code: items[0]!.code, item_version: 999, photo_skip: true }), [], ACTOR))).toBe(410);
    const group = store.borrowerGroups()[0]!;
    expect(statusOf(() => store.preassign([{ ...items[0], borrower_id: group.id }], ACTOR, ORIGIN))).toBe(409);
  });
  it('blocks a reset with any outstanding loan, then accepts only new codes after reset', () => {
    store.db.prepare("UPDATE items SET status='loaned' WHERE code=?").run(items[0]!.code);
    const blocked = manager.preview({ mode: 'reset' }, ACTOR, true);
    expect(statusOf(() => apply(blocked))).toBe(409);
    store.db.prepare("UPDATE items SET status='ready' WHERE code=?").run(items[0]!.code);
    apply(manager.preview({ mode: 'reset' }, ACTOR, true));
    const p = manager.preview({ mode: 'update', items: [{ ...items[0], code: 'IY-100003', url: `${ORIGIN}/i/IY-100003` }] }, ACTOR, true);
    expect(apply(p).items.map(i => i.code)).toEqual(['IY-100003']);
  });
});

describe('explicit forced reset after a demonstration', () => {
  function borrow(code: string) {
    const input = metadata({ item_code: code, item_version: store.item(code).version, borrower: '模擬店A' });
    return { input, receipt: store.submit(input, [RED], ACTOR) };
  }
  it('archives outstanding and review items, preserving receipts, photos and every published identity', () => {
    const a = borrow(items[0]!.code);
    borrow(items[1]!.code);
    const returned = metadata({ item_code: items[1]!.code, item_version: store.item(items[1]!.code).version,
      action: 'return', borrower: '模擬店A', condition: 'damage', note: '試験の傷' });
    const receipt = store.submit(returned, [RED], ACTOR);
    const preserved = ['operations','files','issuance','borrowers','preassignment_events','item_metadata_events'];
    const snapshot = () => JSON.stringify(preserved.map(t => store.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = snapshot();
    const p = manager.preview({ mode: 'force_reset' }, ACTOR, true);
    expect(p).toMatchObject({ blocked_count: 0, changed_count: 2, reset_counts: { total: 2, loaned: 1, review: 1 } });
    const result = apply(p);
    expect(result).toMatchObject({ items: [], archived_count: 2, reserved_through: 100002, action: 'force_reset' });
    expect(store.summary()).toMatchObject({ total: 0, planned: 0, counts: { ready: 0, loaned: 0, review: 0 } });
    expect(snapshot()).toBe(before);
    expect(store.operation(a.input.operation_id)).toEqual(a.receipt);
    expect(store.operation(returned.operation_id)).toEqual(receipt);
    expect(store.loanPhoto(String(a.input.operation_id), '1').data).toEqual(RED);
    expect(store.submit(a.input, [RED], ACTOR)).toEqual(a.receipt);
    expect(statusOf(() => store.submit(metadata({ item_code: items[0]!.code }), [], ACTOR))).toBe(410);
    expect(statusOf(() => manager.preview({ mode: 'overwrite', items: [items[0]] }, ACTOR, true))).toBe(409);
    const audit = store.db.prepare('SELECT * FROM issuer_management_events').get()!;
    expect(audit.action).toBe('force_reset');
    expect(JSON.parse(String(audit.before_json)).map((r: { status: string }) => r.status)).toEqual(['loaned','review']);
    expect(statusOf(() => apply(p))).toBe(409);
    const newItem = { ...items[0], code: 'IY-100003', url: `${ORIGIN}/i/IY-100003` };
    expect(apply(manager.preview({ mode: 'update', items: [newItem] }, ACTOR, true)).items[0]!.code).toBe(newItem.code);
  });
  it('keeps ordinary reset blocked and cannot elevate a reset by changing its apply body', () => {
    borrow(items[0]!.code);
    const p = manager.preview({ mode: 'reset', force: true }, ACTOR, true);
    expect(p.blocked_count).toBe(1);
    expect(statusOf(() => manager.apply({ token: p.token, confirmation: '物品台帳をリセット', mode: 'force_reset' }, ACTOR, true))).toBe(409);
    expect(manager.snapshot().items).toHaveLength(2);
  });
  it('requires admin at preview and apply, the same actor, and a distinct exact confirmation', () => {
    borrow(items[0]!.code);
    expect(statusOf(() => manager.preview({ mode: 'force_reset' }, ACTOR, false))).toBe(403);
    const p = manager.preview({ mode: 'force_reset' }, ACTOR, true);
    expect(statusOf(() => apply(p, false))).toBe(403);
    expect(statusOf(() => manager.apply({ token: p.token, confirmation: '物品台帳を強制リセット' }, { id:'other', name:'他PC' }, true))).toBe(409);
    expect(statusOf(() => manager.apply({ token: p.token, confirmation: '物品台帳をリセット' }, ACTOR, true))).toBe(400);
    const clock = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(clock + 11 * 60 * 1000);
    expect(statusOf(() => apply(p))).toBe(409);
  });
  it('refuses a stale preview after another PC lends or edits an item', () => {
    const p = manager.preview({ mode: 'force_reset' }, ACTOR, true);
    borrow(items[0]!.code);
    expect(statusOf(() => apply(p))).toBe(409);
    expect(store.item(items[0]!.code).status).toBe('loaned');
  });
  it('blocks card reservations and stray locks, and preserves shared card history after cancellation', () => {
    const cards = new CardHistory(store);
    const registry = '';
    cards.importLegacy({ registry, sha256: createHash('sha256').update(registry).digest('hex'), evidence: {} }, ACTOR);
    const claim = cards.claim({ code:'IY-100001', idm:'0123456789ABCDEF', url:`${ORIGIN}/i/IY-100001`, client:'別PC', manifest_sha256:'a'.repeat(64), pdf_sha256:'b'.repeat(64) }, ACTOR);
    const p = manager.preview({ mode: 'force_reset' }, ACTOR, true);
    expect(statusOf(() => apply(p))).toBe(409);
    expect(manager.snapshot().items).toHaveLength(2);
    cards.cancel({ operation: claim.operation }, ACTOR);
    store.db.prepare('INSERT INTO card_history_locks VALUES(?,?)').run('code:IY-999999','stray-lock');
    expect(statusOf(() => apply(p))).toBe(409);
    store.db.prepare('DELETE FROM card_history_locks WHERE operation=?').run('stray-lock');
    const before = cards.backup();
    apply(p);
    expect(cards.backup()).toEqual(before);
  });
  it('rolls back the whole forced reset when the before-state audit cannot be saved', () => {
    borrow(items[0]!.code);
    const before = manager.snapshot();
    const p = manager.preview({ mode: 'force_reset' }, ACTOR, true);
    store.db.exec("CREATE TRIGGER reject_force_audit BEFORE INSERT ON issuer_management_events BEGIN SELECT RAISE(FAIL,'audit-failure'); END;");
    expect(() => apply(p)).toThrow('audit-failure');
    expect(manager.snapshot().revision).toBe(before.revision);
    expect(store.item(items[0]!.code).status).toBe('loaned');
    expect(store.db.prepare('SELECT count(*) AS n FROM issuer_management_events').get()!.n).toBe(0);
  });
  it('can explicitly reissue the same physical card to a new code after archiving its demo loan', () => {
    const cards = new CardHistory(store), idm = '0123456789ABCDEF';
    const record = (code: string, status: string) => ({ time: new Date().toISOString(), code, idm, url: `${ORIGIN}/i/${code}`, status, evidence: 'synthetic', manifest_sha256:'a'.repeat(64), pdf_sha256:'b'.repeat(64) });
    const registry = JSON.stringify(record('IY-100001','passed')) + '\n';
    cards.importLegacy({ registry, sha256: createHash('sha256').update(registry).digest('hex'), evidence: {} }, ACTOR);
    borrow('IY-100001');
    apply(manager.preview({ mode: 'force_reset' }, ACTOR, true));
    apply(manager.preview({ mode: 'update', items: [{ ...items[0], code:'IY-100003', url:`${ORIGIN}/i/IY-100003` }] }, ACTOR, true));
    const { operation } = cards.claim({ code:'IY-100003', idm, url:`${ORIGIN}/i/IY-100003`, client:'試験PC', manifest_sha256:'a'.repeat(64), pdf_sha256:'b'.repeat(64), force:true }, ACTOR);
    cards.transition({ operation, phase:'reserve', entries:[record('IY-100001','released'), record('IY-100003','reserved')], evidence:{} }, ACTOR);
    cards.transition({ operation, phase:'pass', entries:[{ ...record('IY-100003','passed'), verified_readback:true }], evidence:{} }, ACTOR);
    expect(cards.snapshot()).toMatchObject({ passed:1, reserved:0, active:[] });
    expect(cards.snapshot().registry.startsWith(registry)).toBe(true);
    expect(store.db.prepare('SELECT status,archived_at FROM items WHERE code=?').get('IY-100001')).toMatchObject({ status:'loaned', archived_at:expect.any(String) });
  });
});
