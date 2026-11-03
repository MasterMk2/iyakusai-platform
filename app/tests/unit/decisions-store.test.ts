import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionInput } from '../../src/shared/decisions.js';
import { DomainError } from '../../src/server/domain/types.js';
import { DECISIONS_FILE, DecisionsStore, changedDecisionFields } from '../../src/server/decisions/store.js';
import { seedDecisionsDemo } from '../../src/server/decisions/seed.js';

// The decision register's store: changes, revokes, restores, the chain, history and search. Synthetic text only.

let dir: string;
let store: DecisionsStore;
const ACTOR = 'user-a';
const OTHER = 'user-b';
let clock = Date.parse('2026-11-01T00:00:00.000Z');
const tick = () => new Date((clock += 60_000)).toISOString();

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  title: '合成の決定',
  body: '',
  departments: ['planning'],
  decidedOn: '2026-10-01',
  venue: 'board',
  venueOther: '',
  sources: [],
  taskIds: [],
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-decisions-store-'));
  store = new DecisionsStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('decisions store: registration', () => {
  it('creates an active decision with its history row and the registrant', () => {
    const { row, replayed } = store.create(input({ title: '案内図は 3 色刷りにする' }), ACTOR, tick(), null);
    expect(replayed).toBe(false);
    expect(row.id).toMatch(/^dc_[0-9a-f]{16}$/);
    expect(row.status).toBe('active');
    expect(row.version).toBe(1);
    expect(row.input.title).toBe('案内図は 3 色刷りにする');
    expect(store.history(row.id)).toEqual([expect.objectContaining({ action: 'created', actorId: ACTOR, changed: [] })]);
  });

  it('answers a retry with the same client token and the same content from the first registration (no second decision)', () => {
    const token = 'token-abcdefgh-0001';
    const first = store.create(input(), ACTOR, tick(), token);
    const retry = store.create(input(), OTHER, tick(), token);
    expect(retry.replayed).toBe(true);
    expect(retry.row.id).toBe(first.row.id);
    expect(store.count()).toBe(1);
    expect(store.history(first.row.id)).toHaveLength(1);
  });

  it('refuses a retry with the same token but other content, and writes nothing (the change is never dropped silently)', () => {
    const token = 'token-abcdefgh-0002';
    const first = store.create(input(), ACTOR, tick(), token);
    let caught: unknown = null;
    try {
      store.create(input({ title: '別の内容' }), OTHER, tick(), token);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('conflict');
    expect(store.count()).toBe(1);
    expect(store.get(first.row.id)!.input.title).toBe('合成の決定');
  });

  it('answers a token of a minutes item with the decision made for it, whatever the content (reuse: first)', () => {
    const token = 'minutes-mt_0123456789abcdef-0';
    const first = store.create(input(), ACTOR, tick(), token, 'first');
    const again = store.create(input({ title: '別の内容' }), OTHER, tick(), token, 'first');
    expect(again).toMatchObject({ replayed: true, row: { id: first.row.id } });
    expect(store.count()).toBe(1);
  });

  it('keeps the input of one decision with its departments, sources and task IDs', () => {
    const { row } = store.create(
      input({
        departments: ['naimu', 'gaimu'],
        venue: 'other',
        venueOther: '合成の準備会',
        sources: [{ kind: 'mail', refId: 'th_0123456789abcdef', label: '合成の案内メール', link: '#/all?thread=th_0123456789abcdef' }],
        taskIds: ['task-12'],
      }),
      ACTOR,
      tick(),
      null,
    );
    expect(row.input.departments).toEqual(['naimu', 'gaimu']);
    expect(row.input.venueOther).toBe('合成の準備会');
    expect(row.input.sources[0]).toEqual({ kind: 'mail', refId: 'th_0123456789abcdef', label: '合成の案内メール', link: '#/all?thread=th_0123456789abcdef' });
    expect(row.input.taskIds).toEqual(['task-12']);
  });
});

describe('decisions store: edits', () => {
  it('edits an active decision and records the changed fields and the record before', () => {
    const { row } = store.create(input({ title: '旧い内容' }), ACTOR, tick(), null);
    const edited = store.update(row.id, row.version, input({ title: '新しい内容', body: '補足' }), OTHER, tick());
    expect(edited).not.toBeNull();
    expect(typeof edited).toBe('object');
    const after = edited as NonNullable<typeof edited> & object;
    expect(after).toMatchObject({ version: 2, status: 'active' });
    const [latest] = store.history(row.id);
    expect(latest).toMatchObject({ action: 'updated', actorId: OTHER, changed: ['title', 'body'] });
    const before = store.db.prepare('SELECT before_json FROM decision_history WHERE decision_id=? AND action=?').get(row.id, 'updated') as { before_json: string };
    expect(JSON.parse(before.before_json).input.title).toBe('旧い内容');
  });

  it('leaves the version alone when nothing changed', () => {
    const { row } = store.create(input(), ACTOR, tick(), null);
    const same = store.update(row.id, row.version, input(), OTHER, tick());
    expect(same).toMatchObject({ version: 1 });
    expect(store.history(row.id)).toHaveLength(1);
  });

  it('refuses a stale version with a conflict, and refuses to edit a non-active decision', () => {
    const { row } = store.create(input(), ACTOR, tick(), null);
    expect(store.update(row.id, 99, input({ title: 'x' }), OTHER, tick())).toBe('conflict');
    expect(store.update('dc_0000000000000000', 1, input(), OTHER, tick())).toBeNull();
    store.revoke(row.id, row.version, '', ACTOR, tick());
    expect(store.update(row.id, 2, input({ title: 'y' }), OTHER, tick())).toBe('not_active');
  });
});

describe('decisions store: changes (a new decision replaces an active one)', () => {
  it('makes the old record changed and points it at the new one, with the change note on the new one', () => {
    const { row: old } = store.create(input({ title: '2,000 部' }), ACTOR, tick(), null);
    const result = store.supersede(old.id, old.version, input({ title: '2,500 部' }), '500 部増やした', OTHER, tick());
    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');
    const { old: changedOld, row: fresh } = result as { old: typeof old; row: typeof old };
    expect(changedOld).toMatchObject({ status: 'changed', supersededBy: fresh.id, version: 2 });
    expect(fresh).toMatchObject({ status: 'active', supersedes: old.id, changeNote: '500 部増やした', version: 1 });
    expect(store.chain(fresh.id).map((r) => r.id)).toEqual([old.id, fresh.id]);
    expect(store.chain(old.id).map((r) => r.id)).toEqual([old.id, fresh.id]);
    expect(store.history(old.id)[0]).toMatchObject({ action: 'replaced' });
  });

  it('refuses a second change of the same decision (the first one already moved it)', () => {
    const { row: old } = store.create(input(), ACTOR, tick(), null);
    store.supersede(old.id, old.version, input({ title: 'A' }), '一つ目', ACTOR, tick());
    // A stale version is a conflict; the current version (2) finds the decision already changed.
    expect(store.supersede(old.id, 1, input({ title: 'B' }), '二つ目', ACTOR, tick())).toBe('conflict');
    expect(store.supersede(old.id, 2, input({ title: 'B' }), '二つ目', ACTOR, tick())).toBe('not_active');
    expect(store.count()).toBe(2);
  });

  it('refuses a change made from a stale version', () => {
    const { row: old } = store.create(input(), ACTOR, tick(), null);
    store.update(old.id, old.version, input({ title: '直した' }), ACTOR, tick());
    expect(store.supersede(old.id, old.version, input({ title: 'x' }), '古い版から', ACTOR, tick())).toBe('conflict');
  });

  it('follows a chain of several changes in both directions', () => {
    const a = store.create(input({ title: 'A' }), ACTOR, tick(), null).row;
    const b = (store.supersede(a.id, a.version, input({ title: 'B' }), 'A→B', ACTOR, tick()) as { row: typeof a }).row;
    store.supersede(b.id, b.version, input({ title: 'C' }), 'B→C', ACTOR, tick());
    expect(store.chain(b.id).map((r) => r.input.title)).toEqual(['A', 'B', 'C']);
    expect(store.chain(a.id).map((r) => r.status)).toEqual(['changed', 'changed', 'active']);
  });
});

describe('decisions store: revoke and restore', () => {
  it('revokes an active decision with a note and keeps the record', () => {
    const { row } = store.create(input(), ACTOR, tick(), null);
    const revoked = store.revoke(row.id, row.version, '会場が変わったため', OTHER, tick());
    expect(revoked).toMatchObject({ status: 'revoked', revokeNote: '会場が変わったため', version: 2 });
    expect(store.history(row.id)[0]).toMatchObject({ action: 'revoked', actorId: OTHER });
  });

  it('reactivates the decision a revoked change had replaced', () => {
    const { row: old } = store.create(input({ title: '元の決定' }), ACTOR, tick(), null);
    const { row: fresh } = store.supersede(old.id, old.version, input({ title: '変更後' }), '変えた', ACTOR, tick()) as { row: typeof old; old: typeof old };
    store.revoke(fresh.id, fresh.version, '違った', ACTOR, tick());
    expect(store.get(old.id)).toMatchObject({ status: 'active', supersededBy: null });
    expect(store.history(old.id)[0]).toMatchObject({ action: 'reactivated' });
  });

  it('keeps a revoked change in the chain of the decision it replaced', () => {
    const { row: old } = store.create(input({ title: '元の決定' }), ACTOR, tick(), null);
    const { row: fresh } = store.supersede(old.id, old.version, input({ title: '変更後' }), '変えた', ACTOR, tick()) as { row: typeof old; old: typeof old };
    store.revoke(fresh.id, fresh.version, '違った', ACTOR, tick());
    expect(store.chain(old.id).map((r) => [r.input.title, r.status])).toEqual([
      ['元の決定', 'active'],
      ['変更後', 'revoked'],
    ]);
    expect(store.chain(fresh.id).map((r) => r.id)).toEqual([old.id, fresh.id]);
    // A later change of the same decision keeps the revoked one in its chain too.
    const current = store.get(old.id)!;
    store.supersede(current.id, current.version, input({ title: '取り直した決定' }), '取り直した', ACTOR, tick());
    expect(store.chain(old.id).map((r) => r.input.title)).toEqual(['元の決定', '変更後', '取り直した決定']);
  });

  it('refuses to revoke a decision that is not active', () => {
    const { row: old } = store.create(input(), ACTOR, tick(), null);
    store.supersede(old.id, old.version, input({ title: 'B' }), '変更', ACTOR, tick());
    expect(store.revoke(old.id, 2, '', ACTOR, tick())).toBe('not_active');
  });

  it('restores a revoked decision and replaces the old one again', () => {
    const { row: old } = store.create(input({ title: 'A' }), ACTOR, tick(), null);
    const { row: fresh } = store.supersede(old.id, old.version, input({ title: 'B' }), 'A→B', ACTOR, tick()) as { row: typeof old; old: typeof old };
    store.revoke(fresh.id, fresh.version, '', ACTOR, tick());
    const restored = store.restore(fresh.id, fresh.version + 1, ACTOR, tick());
    expect(restored).toMatchObject({ status: 'active', revokeNote: '' });
    expect(store.get(old.id)).toMatchObject({ status: 'changed', supersededBy: fresh.id });
  });

  it('refuses to restore when the replaced decision has been changed by someone else in the meantime', () => {
    const { row: old } = store.create(input({ title: 'A' }), ACTOR, tick(), null);
    const { row: fresh } = store.supersede(old.id, old.version, input({ title: 'B' }), 'A→B', ACTOR, tick()) as { row: typeof old; old: typeof old };
    store.revoke(fresh.id, fresh.version, '', ACTOR, tick());
    const reactivated = store.get(old.id)!;
    store.supersede(reactivated.id, reactivated.version, input({ title: 'C' }), 'A→C', OTHER, tick());
    expect(store.restore(fresh.id, fresh.version + 1, ACTOR, tick())).toBe('chain_busy');
  });

  it('refuses to restore a decision that is not revoked', () => {
    const { row } = store.create(input(), ACTOR, tick(), null);
    expect(store.restore(row.id, row.version, ACTOR, tick())).toBe('not_revoked');
  });
});

describe('decisions store: lists, filters and the Bot view', () => {
  beforeEach(() => {
    store.create(input({ title: '案内図の色', departments: ['planning'], decidedOn: '2026-09-01', venue: 'board' }), ACTOR, tick(), null);
    store.create(input({ title: '案内所の位置', departments: ['gaimu', 'naimu'], decidedOn: '2026-10-05', venue: 'regular', body: 'テントの隣' }), ACTOR, tick(), null);
    store.create(input({ title: '打ち上げの日', departments: ['somu'], decidedOn: '2026-10-20', venue: 'mail' }), ACTOR, tick(), null);
  });

  it('filters by department, status, decided-on period and search words', () => {
    expect(store.page({ terms: [], department: 'naimu' }, 'decided', 10, 0).rows.map((r) => r.input.title)).toEqual(['案内所の位置']);
    expect(store.page({ terms: ['テント'] }, 'decided', 10, 0).rows).toHaveLength(1);
    expect(store.page({ terms: [], from: '2026-10-01', to: '2026-10-10' }, 'decided', 10, 0).total).toBe(1);
    expect(store.page({ terms: [], status: 'revoked' }, 'decided', 10, 0).total).toBe(0);
  });

  it('lists the newest decided first, or the newest changed first when asked', () => {
    const decided = store.page({ terms: [] }, 'decided', 10, 0).rows.map((r) => r.input.decidedOn);
    expect(decided).toEqual(['2026-10-20', '2026-10-05', '2026-09-01']);
    const first = store.page({ terms: [] }, 'changed', 1, 0).rows[0]!;
    expect(first.input.title).toBe('打ち上げの日');
  });

  it('lists the department keys in use, and the latest changes for the Bot', () => {
    expect(store.departmentKeys()).toEqual(['gaimu', 'naimu', 'planning', 'somu']);
    expect(store.latestChanged(2).map((r) => r.input.title)).toEqual(['打ち上げの日', '案内所の位置']);
  });

  it('seeds the demo register once and only into an empty register', () => {
    const fresh = new DecisionsStore(mkdtempSync(path.join(tmpdir(), 'iyakusai-decisions-seed-')));
    try {
      seedDecisionsDemo(fresh, ACTOR, tick());
      const count = fresh.count();
      expect(count).toBeGreaterThan(3);
      expect(fresh.chain(fresh.page({ terms: [] }, 'decided', 1, 0).rows[0]!.id).length).toBeGreaterThanOrEqual(1);
      seedDecisionsDemo(fresh, ACTOR, tick());
      expect(fresh.count()).toBe(count);
    } finally {
      const dirOf = fresh.root;
      fresh.close();
      rmSync(dirOf, { recursive: true, force: true });
    }
  });
});

describe('decisions store: helpers', () => {
  it('names the fields that differ and nothing else', () => {
    expect(changedDecisionFields(input({ title: 'A' }), input({ title: 'B', taskIds: ['task-1'] }))).toEqual(['title', 'taskIds']);
    expect(changedDecisionFields(input(), input())).toEqual([]);
  });

  it('keeps the file name stable (the backup and the restore refer to it)', () => {
    expect(DECISIONS_FILE).toBe('decisions.sqlite3');
  });
});
