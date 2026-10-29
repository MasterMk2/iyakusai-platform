import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPhoto } from '../../src/server/rental/image-probe.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { canonical, MAX_PHOTO_BYTES, RentalError, validateMetadata } from '../../src/server/rental/validate.js';
import { ACTOR, BLUE, demoStore, metadata, pngHeader, RED, statusOf, variant } from './helpers.js';

// Port of reference/rental-python/server/test_backend.py (StoreTests and PreassignmentTests). The Python
// suite ran some cases from eight threads; the TypeScript ledger is synchronous within one process, so
// the same cases run as repeated calls and check the same outcome (one operation, one loan).

let ctx: ReturnType<typeof demoStore>;
const photos = () => [RED, BLUE];

beforeEach(() => {
  ctx = demoStore();
});
afterEach(() => ctx.cleanup());

describe('loans and returns', () => {
  it('stores a durable receipt and takes the actor from the session, not the request', () => {
    const meta = metadata({ actor: { id: 'forged' } });
    const result = ctx.store.submit(meta, photos(), ACTOR);
    expect(result).toMatchObject({ status: 'local_saved', photos_count: 2, drive_synced_count: 0 });
    expect(ctx.store.item(meta.item_code).status).toBe('loaned');
    const archived = JSON.parse(String((ctx.store.db.prepare('SELECT metadata FROM operations').get() as { metadata: string }).metadata));
    expect(archived.actor.id).toBe('demo');
    expect(archived.client_read_at).toBe(meta.client_read_at);
    for (const row of ctx.store.db.prepare('SELECT * FROM files').all() as { path: string; size: number }[]) {
      expect(statSync(path.join(ctx.store.root, row.path)).size).toBe(row.size);
    }
    const reopened = new RentalStore(ctx.dir, { demo: true });
    expect(reopened.operation(meta.operation_id)).toEqual(result);
    reopened.close();
  });

  it('replays a duplicate unchanged even after a later return', () => {
    const meta = metadata();
    const first = ctx.store.submit(meta, photos(), ACTOR);
    ctx.store.submit(metadata({ action: 'return', item_version: 1, borrower: '' }), [], ACTOR);
    expect(ctx.store.submit(meta, photos(), ACTOR)).toEqual(first);
    expect(ctx.store.item(meta.item_code).version).toBe(2);
    expect(ctx.store.db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 2 });
  });

  it('rejects the same operation ID with a different photo or metadata', () => {
    const meta = metadata();
    ctx.store.submit(meta, photos(), ACTOR);
    expect(statusOf(() => ctx.store.submit(meta, [variant('green'), BLUE], ACTOR))).toBe(409);
    expect(statusOf(() => ctx.store.submit({ ...meta, note: 'changed' }, photos(), ACTOR))).toBe(409);
  });

  it('results in one operation for repeated sends of one operation ID', () => {
    const meta = metadata();
    const results = Array.from({ length: 8 }, () => ctx.store.submit(meta, photos(), ACTOR));
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true);
    expect(ctx.store.item(meta.item_code).version).toBe(1);
  });

  it('cannot lend one item twice with different operation IDs', () => {
    const results = Array.from({ length: 8 }, () => {
      try {
        ctx.store.submit(metadata(), photos(), ACTOR);
        return 200;
      } catch (err) {
        return err instanceof RentalError ? err.status : 0;
      }
    });
    expect(results.filter((s) => s === 200)).toHaveLength(1);
    expect(results.filter((s) => s === 409)).toHaveLength(7);
  });

  it('rejects stale versions and holds an item returned with a problem', () => {
    ctx.store.submit(metadata(), photos(), ACTOR);
    expect(statusOf(() => ctx.store.submit(metadata({ item_version: 1 }), photos(), ACTOR))).toBe(409);
    ctx.store.submit(metadata({ action: 'return', item_version: 1, borrower: '', condition: 'damage', note: '脚に破損' }), [], ACTOR);
    expect(ctx.store.item('IY-000123').status).toBe('review');
    expect(statusOf(() => ctx.store.submit(metadata({ item_version: 2 }), photos(), ACTOR))).toBe(409);
  });

  it('rolls back a partial photo write and accepts the same operation on retry', () => {
    const original = ctx.store.writeFile;
    ctx.store.writeFile = (target, data) => {
      original(target, data.subarray(0, 50));
      throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
    };
    const meta = metadata();
    expect(() => ctx.store.submit(meta, photos(), ACTOR)).toThrow(/disk full/);
    expect(ctx.store.item('IY-000123').version).toBe(0);
    expect(statusOf(() => ctx.store.operation(meta.operation_id))).toBe(404);
    ctx.store.writeFile = original;
    expect(ctx.store.submit(meta, photos(), ACTOR).status).toBe('local_saved');
  });

  it('rejects unreadable images, too few or too many photos, and oversized files', () => {
    for (const images of [[RED], [Buffer.from('fake JPEG'), RED], Array.from({ length: 6 }, () => RED)]) {
      expect(statusOf(() => ctx.store.submit(metadata(), images, ACTOR))).toBe(400);
    }
    expect(statusOf(() => checkPhoto(Buffer.alloc(MAX_PHOTO_BYTES + 1, 0x78)))).toBe(413);
    expect(ctx.store.item('IY-000123').version).toBe(0);
  });

  it('enforces the pixel limit and rejects animated images', () => {
    expect(statusOf(() => checkPhoto(pngHeader(4100, 4100)))).toBe(400);
    expect(statusOf(() => checkPhoto(pngHeader(100, 80, 'acTL')))).toBe(400);
    expect(checkPhoto(pngHeader(100, 80))).toMatchObject({ mime: 'image/png', width: 100, height: 80 });
    expect(checkPhoto(RED)).toMatchObject({ mime: 'image/jpeg', width: 100, height: 80 });
  });

  it('accepts only registered borrowers and strict field types', () => {
    for (const changes of [{ borrower: 'unknown' }, { item_version: true }, { note: [] }, { item_code: '../escape' }, { client_at: '2026-10-12' }]) {
      expect(statusOf(() => ctx.store.submit(metadata(changes), photos(), ACTOR))).toBe(400);
    }
  });

  it('does not let another account replay an operation', () => {
    const meta = metadata();
    ctx.store.submit(meta, photos(), ACTOR);
    expect(statusOf(() => ctx.store.submit(meta, photos(), { id: 'other', name: 'Other' }))).toBe(403);
  });

  it('keeps demo and real ledgers in different folders', () => {
    expect(() => new RentalStore(ctx.dir, { demo: false })).toThrow(/different data directories/);
  });

  it('writes canonical JSON with sorted keys and no spaces', () => {
    expect(canonical({ b: [1, true, null], a: '日本\n"x"', Z: { y: 0, x: -5 } })).toBe('{"Z":{"x":-5,"y":0},"a":"日本\\n\\"x\\"","b":[1,true,null]}');
  });
});

describe('planned borrowers', () => {
  const group = (name = '事前割当 団体A') => ctx.store.createBorrower(name).borrower;
  const entry = (code = 'IY-PLAN-000001', g = group(), changes: Record<string, unknown> = {}) => ({
    code,
    name: '事前割当 机',
    url: `https://rental.example.jp/i/${code}`,
    borrower_id: g.id,
    borrower_name: g.name,
    ...changes,
  });

  it('reuses one ID when the same group is created repeatedly', () => {
    const results = Array.from({ length: 8 }, () => ctx.store.createBorrower(' 同じ団体 '));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.borrower.id)).size).toBe(1);
  });

  it('is idempotent and never a loan', () => {
    const e = entry();
    const first = ctx.store.preassign([e], ACTOR);
    const again = ctx.store.preassign([e], ACTOR);
    expect(first.registered_count).toBe(1);
    expect(again.reused_count).toBe(1);
    expect(first.items[0]!.version).toBe(again.items[0]!.version);
    const item = ctx.store.item(e.code);
    expect(item).toMatchObject({ planned_state: 'pending', status: 'ready', current_loan: null });
    expect(ctx.store.issuance(e.code).url).toBe(e.url);
    expect(ctx.store.db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 });
    expect(ctx.store.db.prepare('SELECT count(*) AS n FROM preassignment_events').get()).toEqual({ n: 1 });
  });

  it('rolls back a whole batch when a later entry conflicts', () => {
    const good = entry();
    const conflict = entry('IY-000123', undefined, { name: '勝手に名前変更' });
    expect(statusOf(() => ctx.store.preassign([good, conflict], ACTOR))).toBe(409);
    expect(statusOf(() => ctx.store.item(good.code))).toBe(404);
    expect(statusOf(() => ctx.store.issuance(good.code))).toBe(404);
    expect(ctx.store.db.prepare('SELECT count(*) AS n FROM preassignment_events').get()).toEqual({ n: 0 });
  });

  it('lets the actual borrower differ, consumes the plan and re-arms it only when asked', () => {
    const planned = group();
    const actual = group('実際の団体B');
    const e = entry(undefined, planned);
    const version = ctx.store.preassign([e], ACTOR).items[0]!.version as number;
    const meta = metadata({ item_code: e.code, item_version: version, borrower: actual.name });
    ctx.store.submit(meta, photos(), ACTOR);
    const item = ctx.store.item(e.code);
    expect(item.planned_state).toBe('fulfilled');
    expect(item.planned_borrower_id).toBe(planned.id);
    expect((item.current_loan as { borrower_id: string }).borrower_id).toBe(actual.id);
    const archive = JSON.parse(String((ctx.store.db.prepare('SELECT metadata FROM operations WHERE id=?').get(meta.operation_id as string) as { metadata: string }).metadata));
    expect(archive.borrower_id).toBe(actual.id);
    expect(archive.preassignment.borrower_id).toBe(planned.id);
    expect(statusOf(() => ctx.store.preassign([e], ACTOR))).toBe(409);
    ctx.store.submit(metadata({ item_code: e.code, item_version: item.version, action: 'return', borrower: '' }), [], ACTOR);
    expect(ctx.store.item(e.code).planned_state).toBe('fulfilled');
    const rearmed = ctx.store.preassign([e], ACTOR);
    expect(rearmed.items[0]!.updated).toBe(true);
    expect(ctx.store.item(e.code).planned_state).toBe('pending');
    expect(ctx.store.operation(meta.operation_id).action).toBe('borrow');
  });

  it('invalidates a cached version when the plan changes and keeps the plan when a loan fails', () => {
    const g = group();
    const assigned = ctx.store.preassign([entry('IY-000123', g, { name: '試用 延長コード' })], ACTOR);
    expect(statusOf(() => ctx.store.submit(metadata({ borrower: g.name }), photos(), ACTOR))).toBe(409);
    expect(statusOf(() => ctx.store.submit(metadata({ item_version: assigned.items[0]!.version, borrower: g.name }), [RED], ACTOR))).toBe(400);
    expect(ctx.store.item('IY-000123').planned_state).toBe('pending');
  });

  it('rejects unknown groups, name mismatches, duplicates and URLs off the item origin', () => {
    const e = entry();
    for (const entries of [[{ ...e, borrower_id: `B-${'0'.repeat(32)}` }], [{ ...e, borrower_name: '違う団体' }], [e, e], [{ ...e, url: `${e.url}?iy=${e.code}` }]]) {
      expect(statusOf(() => ctx.store.preassign(entries, ACTOR))).toBe(400);
    }
    expect(statusOf(() => ctx.store.preassign([e], ACTOR, 'https://different.example.jp'))).toBe(400);
    expect(statusOf(() => ctx.store.preassign(Array.from({ length: 10001 }, () => e), ACTOR))).toBe(400);
  });

  it('registers ten thousand items in one batch without any operation history', () => {
    const g = group();
    const entries = Array.from({ length: 10000 }, (_, i) => entry(`IY-MASS-${String(i).padStart(5, '0')}`, g));
    const result = ctx.store.preassign(entries, ACTOR);
    expect(result.registered_count).toBe(10000);
    expect(result.items).toHaveLength(10000);
    expect(ctx.store.db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 });
    expect(ctx.store.db.prepare("SELECT count(*) AS n FROM items WHERE planned_state='pending'").get()).toEqual({ n: 10000 });
  });
});

// The loan: read → current photos (skippable for chairs and the like) → damaged or not →
// done; and an information view of each group's items, so the cards a group hands back can be counted.
describe('photo skip and damage at the loan', () => {
  const archiveOf = (opId: unknown) => JSON.parse(String((ctx.store.db.prepare('SELECT metadata FROM operations WHERE id=?').get(opId as string) as { metadata: string }).metadata));

  it('lends without photos only when the photo skip is chosen, and records that it was', () => {
    expect(statusOf(() => ctx.store.submit(metadata(), [], ACTOR))).toBe(400);
    const meta = metadata({ photo_skip: true });
    expect(ctx.store.submit(meta, [], ACTOR)).toMatchObject({ status: 'local_saved', photos_count: 0 });
    expect(archiveOf(meta.operation_id).photo_skip).toBe(true);
    expect(statusOf(() => ctx.store.submit(metadata({ item_code: 'IY-000124', photo_skip: 'yes' }), [], ACTOR))).toBe(400);
    expect(statusOf(() => ctx.store.submit(metadata({ action: 'return', item_version: 1, borrower: '', photo_skip: true }), [], ACTOR))).toBe(400);
  });

  it('keeps the fingerprint of operations sent without the photo skip', () => {
    expect('photo_skip' in validateMetadata(metadata())).toBe(false);
    expect(validateMetadata(metadata({ photo_skip: false, operation_id: '9b2d3b9e-3f57-4c1e-9d3a-3c7a1f0e8b21' }))).toEqual(
      validateMetadata(metadata({ operation_id: '9b2d3b9e-3f57-4c1e-9d3a-3c7a1f0e8b21' })),
    );
  });

  it('records damage found at the loan with its note and carries it to the return', () => {
    expect(statusOf(() => ctx.store.submit(metadata({ condition: 'damage' }), photos(), ACTOR))).toBe(400);
    expect(statusOf(() => ctx.store.submit(metadata({ condition: 'maintenance', note: '汚れ' }), photos(), ACTOR))).toBe(400);
    ctx.store.submit(metadata({ condition: 'damage', note: '天板の角に傷' }), photos(), ACTOR);
    const item = ctx.store.item('IY-000123');
    expect(item.status).toBe('loaned');
    expect(item.current_loan).toMatchObject({ condition: 'damage', note: '天板の角に傷' });
    ctx.store.submit(metadata({ action: 'return', item_version: 1, borrower: '' }), [], ACTOR);
    expect(ctx.store.item('IY-000123')).toMatchObject({ status: 'ready', current_loan: null });
  });

  it('stores a loan without damage exactly as before', () => {
    ctx.store.submit(metadata({ note: '延長コード 1本' }), photos(), ACTOR);
    expect(Object.keys(ctx.store.item('IY-000123').current_loan as object).sort()).toEqual(['actor', 'borrower', 'borrower_id', 'operation_id', 'server_at']);
  });
});

describe('overview for the information tab', () => {
  it('puts each item under the group holding it: the loan, else the waiting plan, else the last loan', () => {
    const a = ctx.store.createBorrower('情報 団体A').borrower;
    const b = ctx.store.createBorrower('情報 団体B').borrower;
    const entry = (code: string, g: { id: string; name: string }) => ({ code, name: `机 ${code}`, url: `https://rental.example.jp/i/${code}`, borrower_id: g.id, borrower_name: g.name });
    ctx.store.preassign([entry('IY-100001', a), entry('IY-100002', a), entry('IY-100003', a), entry('IY-100004', b)], ACTOR);
    const lend = (code: string, borrower: string, changes: Record<string, unknown> = {}, images: Buffer[] = photos()) =>
      ctx.store.submit(metadata({ item_code: code, item_version: ctx.store.item(code).version, borrower, ...changes }), images, ACTOR);
    const giveBack = (code: string, changes: Record<string, unknown> = {}) =>
      ctx.store.submit(metadata({ item_code: code, item_version: ctx.store.item(code).version, action: 'return', borrower: '', ...changes }), [], ACTOR);
    lend('IY-100001', a.name, { condition: 'damage', note: '脚にへこみ' });
    giveBack('IY-100001');
    lend('IY-100002', a.name, { photo_skip: true }, []);
    lend('IY-100004', a.name); // planned for B, actually lent to A
    giveBack('IY-100004', { condition: 'damage', note: '天板割れ' });

    const byCode = Object.fromEntries(ctx.store.overview().items.map((i) => [i.code, i]));
    expect(byCode['IY-100001']).toMatchObject({ phase: 'returned', group: a, lent_condition: 'damage', lent_note: '脚にへこみ', return_condition: 'normal' });
    expect(byCode['IY-100002']).toMatchObject({ phase: 'loaned', group: a, lent_condition: 'normal', lent_photo_skip: true, returned_at: null });
    expect(byCode['IY-100003']).toMatchObject({ phase: 'planned', group: a, lent_at: null, returned_at: null });
    expect(byCode['IY-100004']).toMatchObject({ phase: 'review', group: a, return_condition: 'damage', return_note: '天板割れ' });
    expect(byCode['IY-000123']).toMatchObject({ phase: 'unassigned', group: null });

    lend('IY-100001', b.name);
    expect(ctx.store.overview().items.find((i) => i.code === 'IY-100001')).toMatchObject({ phase: 'loaned', group: b, lent_condition: 'normal', returned_at: null, return_condition: null });
  });
});

describe('rental permissions', () => {
  it('holds only the two explicit permissions per account', () => {
    expect(ctx.store.permissionsOf('u-1')).toEqual([]);
    expect(ctx.store.setPermissions('u-1', ['rental.loan'], ACTOR)).toEqual(['rental.loan']);
    expect(ctx.store.setPermissions('u-1', ['rental.issue', 'rental.loan', 'rental.loan'], ACTOR)).toEqual(['rental.issue', 'rental.loan']);
    expect(statusOf(() => ctx.store.setPermissions('u-1', ['admin' as never], ACTOR))).toBe(400);
    expect(ctx.store.setPermissions('u-1', [], ACTOR)).toEqual([]);
    expect(existsSync(path.join(ctx.dir, 'rental.sqlite3'))).toBe(true);
  });
});
