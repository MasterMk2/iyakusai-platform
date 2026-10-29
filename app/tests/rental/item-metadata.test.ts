import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RentalStore } from '../../src/server/rental/store.js';
import { ledgerPayload } from '../../src/server/rental/drive-sync.js';
import { ACTOR, demoStore, metadata, statusOf } from './helpers.js';

let ctx: ReturnType<typeof demoStore>;
beforeEach(() => { ctx = demoStore(); });
afterEach(() => ctx.cleanup());
function entry(extra: Record<string, unknown> = {}) {
  const group = ctx.store.borrowerGroups()[0]!;
  return { code: 'IY-100001', name: 'コンロ', url: 'https://app.iyakusai.com/i/IY-100001', borrower_id: group.id, borrower_name: group.name, ...extra };
}

describe('item source metadata', () => {
  it('round-trips the scope and supplier through registration, reopen, overview and the Drive sheet', () => {
    const value = entry({ item_scope: '学外', item_owner: 'サンプル燃料店' });
    expect(ctx.store.preassign([value], ACTOR).items[0]).toMatchObject(value);
    const reopened = new RentalStore(ctx.dir, { demo: true });
    expect(reopened.item(value.code)).toMatchObject({ item_scope: '学外', item_owner: 'サンプル燃料店' });
    expect(reopened.overview().items.find(i => i.code === value.code)).toMatchObject({ item_scope: '学外', item_owner: 'サンプル燃料店' });
    const rows = ledgerPayload(reopened, new Date()).sheets.find(s => s.name === '物品一覧')!.rows;
    expect(rows.find(row => row.includes(value.code))!.slice(-2)).toEqual(['学外', 'サンプル燃料店']);
    reopened.close();
  });

  it('retains metadata when an older client omits it; repeating it has no new events or versions', () => {
    const value = entry({ item_scope: '学外', item_owner: 'サンプル燃料店' });
    ctx.store.preassign([value], ACTOR);
    const version = ctx.store.item(value.code).version;
    ctx.store.preassign([entry()], ACTOR);
    ctx.store.preassign([value], ACTOR);
    expect(ctx.store.item(value.code)).toMatchObject({ version, item_scope: '学外', item_owner: 'サンプル燃料店' });
    expect(ctx.store.db.prepare('SELECT count(*) AS n FROM item_metadata_events').get()).toEqual({ n: 1 });
  });

  it('rolls back every metadata change if one member is loaned', () => {
    const value = entry({ item_scope: '学内' });
    ctx.store.preassign([value], ACTOR);
    ctx.store.submit(metadata({ item_code: value.code, item_version: 1, borrower: value.borrower_name, photo_skip: true }), [], ACTOR);
    expect(statusOf(() => ctx.store.preassign([entry({ code: 'IY-100002', url: 'https://app.iyakusai.com/i/IY-100002', item_scope: '委員会' }), { ...value, item_scope: '学外' }], ACTOR))).toBe(409);
    expect(statusOf(() => ctx.store.item('IY-100002'))).toBe(404);
    expect(ctx.store.item(value.code).item_scope).toBe('学内');
  });

  it('allows exactly the already registered legacy URL and refuses a new legacy label or changed identity', () => {
    const old = entry({ url: 'https://rental.iyakusai.com/i/IY-100001' });
    ctx.store.preassign([old], ACTOR);
    expect(ctx.store.preassign([{ ...old, item_scope: '学内' }], ACTOR, 'https://app.iyakusai.com').items[0]!.url).toBe(old.url);
    expect(statusOf(() => ctx.store.preassign([{ ...old, name: '別物品' }], ACTOR, 'https://app.iyakusai.com'))).toBe(409);
    expect(statusOf(() => ctx.store.preassign([entry({ code: 'IY-100002', url: 'https://rental.iyakusai.com/i/IY-100002' })], ACTOR, 'https://app.iyakusai.com'))).toBe(400);
  });

  it('rejects invalid scope and supplier values before writing', () => {
    for (const scope of [null, true, ['学内'], '不明']) expect(statusOf(() => ctx.store.preassign([entry({ item_scope: scope })], ACTOR))).toBe(400);
    for (const owner of [null, 4, '', '会社\n名', 'x'.repeat(121)]) expect(statusOf(() => ctx.store.preassign([entry({ item_owner: owner })], ACTOR))).toBe(400);
    expect(ctx.store.db.prepare('SELECT count(*) AS n FROM item_metadata_events').get()).toEqual({ n: 0 });
  });
});
