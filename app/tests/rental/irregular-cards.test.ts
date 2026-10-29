import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IrregularCards } from '../../src/server/rental/irregular-cards.js';
import { IssuerManagement } from '../../src/server/rental/issuer-management.js';
import { resetNumbering } from '../../src/server/rental/numbering-reset.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { ACTOR, demoStore, metadata, RED, statusOf } from './helpers.js';

let ctx: ReturnType<typeof demoStore>;
let issuer: IssuerManagement;
let cards: IrregularCards;
const detail = { name: '延長コード 5m', quantity: 3, unit: '本', item_scope: '学内', item_owner: '大学' };
const request = (count = 1) => ({ request_id: randomUUID(), count, expected_revision: issuer.snapshot().revision });
const create = () => cards.create(request(), ACTOR).items[0]!.code;
const lend = (code: string, changes = {}) => ctx.store.submit(metadata({ item_code: code, irregular: detail, ...changes }), [], ACTOR);
beforeEach(() => {
  ctx = demoStore(); issuer = new IssuerManagement(ctx.store, 'https://example.invalid');
  cards = new IrregularCards(ctx.store, 'https://example.invalid', () => issuer.snapshot().revision);
});
afterEach(() => ctx.cleanup());

describe('reusable irregular cards', () => {
  it('allocates distinct cards, no group, and replays an uncertain creation exactly once', () => {
    const req = request(2), first = cards.create(req, ACTOR);
    expect(cards.create(req, ACTOR)).toEqual(first);
    expect(first.items.map(i => i.code)).toEqual(['IY-IR-000001', 'IY-IR-000002']);
    expect(ctx.store.item(first.items[0]!.code)).toMatchObject({ card_kind: 'irregular', planned_state: 'unassigned', current_loan: null });
    expect(create()).toBe('IY-IR-000003');
    expect(statusOf(() => cards.create({ ...req, count: 3 }, ACTOR))).toBe(409);
    expect(statusOf(() => cards.create(req, { id: 'other', name: '別人' }))).toBe(403);
  });
  it.each([0, 101, 1.5, true, '3'])('rejects invalid count %s', count => {
    expect(statusOf(() => cards.create({ ...request(), count }, ACTOR))).toBe(400);
  });
  it('rejects a stale revision without allocating a number', () => {
    const req = request(); create();
    expect(statusOf(() => cards.create(req, ACTOR))).toBe(409);
    expect(create()).toBe('IY-IR-000002');
  });
  it('requires fresh details on every loan and preserves both loans through return and check', () => {
    const code = create();
    expect(statusOf(() => ctx.store.submit(metadata({ item_code: code }), [], ACTOR))).toBe(400);
    const first = metadata({ item_code: code, irregular: detail });
    ctx.store.submit(first, [], ACTOR);
    expect(ctx.store.item(code)).toMatchObject({ name: detail.name, photo_required: false, current_loan: { irregular: detail } });
    const before = ctx.store.item(code).current_loan;
    ctx.store.submit(metadata({ item_code: code, item_version: 1, action: 'check', borrower: '' }), [], ACTOR);
    expect(ctx.store.item(code).current_loan).toEqual(before);
    ctx.store.submit(metadata({ item_code: code, item_version: 2, action: 'return', borrower: '' }), [], ACTOR);
    expect(ctx.store.item(code)).toMatchObject({ name: 'イレギュラーカード', current_loan: null, status: 'ready' });
    expect(statusOf(() => ctx.store.submit(metadata({ item_code: code, item_version: 3 }), [], ACTOR))).toBe(400);
    lend(code, { item_version: 3, irregular: { ...detail, name: '台車', quantity: 1, unit: '台' } });
    expect(ctx.store.item(code).name).toBe('台車');
    const history = ctx.store.inspection(code).irregular_history!;
    expect(history).toHaveLength(4);
    expect(history.filter(a => a.action !== 'borrow').every(a => (a.irregular as { name: string })?.name === detail.name)).toBe(true);
    ctx.store.submit(first, [], ACTOR); // old replay cannot replace the new loan
    expect(ctx.store.item(code).name).toBe('台車');
    expect(statusOf(() => ctx.store.submit({ ...first, irregular: { ...detail, quantity: 4 } }, [], ACTOR))).toBe(409);
  });
  it('counts quantities with their units in the borrower inventory', () => {
    const code = create(); lend(code);
    expect(ctx.store.inspection(code).group?.inventory).toEqual([{ name: detail.name, item_scope: '学内', item_owner: '大学', quantity: 3, unit: '本', codes: [code] }]);
    expect(ctx.store.overview().items.find(i => i.code === code)?.name).toContain('3本');
  });
  it('keeps external photo requirements for borrow, return and check', () => {
    const code = create(), ext = { ...detail, item_scope: '学外', item_owner: '試験業者' };
    const meta = metadata({ item_code: code, irregular: ext });
    expect(statusOf(() => ctx.store.submit(meta, [], ACTOR))).toBe(400);
    ctx.store.submit(meta, [RED], ACTOR);
    for (const action of ['return','check']) expect(statusOf(() => ctx.store.submit(metadata({ item_code: code, item_version: 1, action }), [], ACTOR))).toBe(400);
    ctx.store.submit(metadata({ item_code: code, item_version: 1, action: 'return' }), [RED], ACTOR);
    expect(ctx.store.item(code).photo_required).toBe(false);
  });
  it.each([{ quantity: 0 }, { quantity: 1.1 }, { quantity: true }, { name: '' }, { name: 'a\nb' }, { unit: '' }, { item_scope: '区分未確認' }, { item_scope: '学外', item_owner: '' }])('rejects invalid loan details %j', changes => {
    const code = create(); expect(statusOf(() => lend(code, { irregular: { ...detail, ...changes } }))).toBe(400);
    expect(ctx.store.item(code).version).toBe(0);
  });
  it('rejects changing loan details in a return/check or on a regular card', () => {
    const code = create(); lend(code);
    expect(statusOf(() => lend('IY-000123'))).toBe(400);
    for (const action of ['return','check']) expect(statusOf(() => lend(code, { item_version: 1, action }))).toBe(400);
    expect(statusOf(() => lend(code))).toBe(409);
  });
  it('blocks ordinary preassignment and overwrite of irregular cards', () => {
    const code = create(), group = ctx.store.borrowerGroups()[0]!;
    const row = { code, name: '別品名', url: `https://example.invalid/i/${code}`, borrower_id: group.id, borrower_name: group.name };
    expect(statusOf(() => ctx.store.preassign([row], ACTOR))).toBe(409);
    expect(statusOf(() => issuer.preview({ mode: 'overwrite', items: [row] }, ACTOR, true))).toBe(409);
  });
  it('holds a damaged return and prevents reusing it', () => {
    const code = create(); lend(code);
    ctx.store.submit(metadata({ item_code: code, item_version: 1, action: 'return', condition: 'damage', note: '車輪の破損' }), [], ACTOR);
    expect(ctx.store.item(code).status).toBe('review');
    expect(statusOf(() => lend(code, { item_version: 2 }))).toBe(409);
  });
  it('persists the last loan and never recycles IR codes after a full numbering reset', () => {
    const req = request(); const code = cards.create(req, ACTOR).items[0]!.code;
    lend(code);
    const reopened = new RentalStore(ctx.dir, { demo: true });
    try { expect(reopened.item(code).name).toBe(detail.name); } finally { reopened.close(); }
    expect(ctx.store.item(code).name).toBe(detail.name);
    ctx.store.submit(metadata({ item_code: code, item_version: 1, action: 'return' }), [], ACTOR);
    ctx.store.db.exec('BEGIN IMMEDIATE'); resetNumbering(ctx.store, ACTOR, true); ctx.store.db.exec('COMMIT');
    issuer = new IssuerManagement(ctx.store, 'https://example.invalid');
    cards = new IrregularCards(ctx.store, 'https://example.invalid', () => issuer.snapshot().revision);
    expect(statusOf(() => cards.create(req, ACTOR))).toBe(409);
    expect(create()).toBe('IY-IR-000002');
  });
});
