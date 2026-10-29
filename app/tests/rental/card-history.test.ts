import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CardHistory } from '../../src/server/rental/card-history.js';
import { IssuerManagement } from '../../src/server/rental/issuer-management.js';
import { RentalStore } from '../../src/server/rental/store.js';

const A = { id: 'a', name: 'PC-A' }, B = { id: 'b', name: 'PC-B' };
const ORIGIN = 'https://app.example.test';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
let dir: string, store: RentalStore, other: RentalStore, first: CardHistory, second: CardHistory;
const item = (n: number) => ({ code: `IY-10000${n}`, idm: `0123456789ABCDE${n}`, url: `${ORIGIN}/i/IY-10000${n}`, client: `PC-${n}`, manifest_sha256: 'a'.repeat(64), pdf_sha256: 'b'.repeat(64) });
const seed = (registry = '') => first.importLegacy({ registry, sha256: digest(registry), evidence: {} }, A);
const record = (i = item(1), status = 'reserved') => ({ time: new Date().toISOString(), ...i, status, evidence: 'test' });
const transition = (manager: CardHistory, actor: typeof A, operation: string, i = item(1), phase = 'reserve', entries = [record(i, phase === 'reserve' ? 'reserved' : 'passed')]) => manager.transition({ operation, phase, entries: entries.map(e => phase === 'pass' ? { ...e, verified_readback: true } : e), evidence: {} }, actor);
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iy-card-server-'));
  store = new RentalStore(dir, { demo: true });
  const borrower = store.createBorrower('本部').borrower;
  store.preassign([1,2,3].map(n => ({ ...item(n), name: `試験物品${n}`, borrower_id: borrower.id })), A, ORIGIN);
  first = new CardHistory(store);
  other = new RentalStore(dir, { demo: true }); second = new CardHistory(other);
});
afterEach(() => { vi.restoreAllMocks(); other.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('shared physical card history across independent PCs and DB connections', () => {
  it('requires the legacy history import before any claim', () => {
    expect(() => first.claim(item(1), A)).toThrow('取り込んで');
    expect(first.snapshot().initialized).toBe(false);
  });
  it('keeps imported registry bytes and evidence exact and makes import idempotent', () => {
    const raw = JSON.stringify(record(item(1), 'passed')) + '\n';
    first.importLegacy({ registry: raw, sha256: digest(raw), evidence: { 'evidence/old/audit.jsonl': Buffer.from('原証跡').toString('base64') } }, A);
    expect(seed(raw).registry).toBe(raw);
    expect(first.backup().evidence['evidence/old/audit.jsonl']).toBe(Buffer.from('原証跡').toString('base64'));
    expect(() => seed()).toThrow('置き換える');
    expect(first.snapshot().registry).toBe(raw);
  });
  it('lets two PCs reserve different cards and codes simultaneously and preserves both passes', () => {
    seed();
    const a = first.claim(item(1), A), b = second.claim(item(2), B);
    transition(first, A, a.operation); transition(second, B, b.operation, item(2));
    expect(first.snapshot().reserved).toBe(2);
    transition(second, B, b.operation, item(2), 'pass'); transition(first, A, a.operation, item(1), 'pass');
    expect(second.snapshot()).toMatchObject({ passed: 2, reserved: 0, active: [] });
  });
  it('blocks the same code on different cards and the same card on different codes', () => {
    seed(); first.claim(item(1), A);
    expect(() => second.claim({ ...item(1), idm: item(2).idm }, B)).toThrow('別のPC');
    expect(() => second.claim({ ...item(2), idm: item(1).idm }, B)).toThrow('別のPC');
    expect(first.snapshot().registry).toBe('');
  });
  it('a lost response and the same reservation replay do not create duplicate events', () => {
    seed(); const claim = first.claim(item(1), A);
    const e = [record()];
    const raw = transition(first, A, claim.operation, item(1), 'reserve', e).registry;
    expect(transition(first, A, claim.operation, item(1), 'reserve', e).registry).toBe(raw);
    expect(() => transition(first, A, claim.operation, item(1), 'reserve', [record(item(1), 'passed')])).toThrow('内容が変わ');
  });
  it('cannot expire a possibly written reservation, even after server restart', () => {
    seed(); const claim = first.claim(item(1), A); transition(first, A, claim.operation);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
    expect(() => second.claim(item(1), B)).toThrow('未確認');
    expect(first.cancel({ operation: claim.operation }, A).state).toBe('writing');
    expect(() => second.claim(item(1), B)).toThrow('未確認');
  });
  it('can reclaim an expired unwritten claim; the stale PC cannot start its write', () => {
    seed(); const old = first.claim(item(1), A);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
    second.claim(item(1), B);
    expect(() => transition(first, A, old.operation)).toThrow('状態');
    expect(first.snapshot().registry).toBe('');
  });
  it('does not accept another operator, wrong IDm, wrong URL or missing readback proof', () => {
    seed(); const claim = first.claim(item(1), A);
    expect(() => transition(first, B, claim.operation)).toThrow('変更できません');
    expect(() => transition(first, A, claim.operation, item(2))).toThrow('一致');
    transition(first, A, claim.operation);
    expect(() => first.transition({ operation: claim.operation, phase: 'pass', entries: [record(item(1), 'passed')], evidence: {} }, A)).toThrow('読み戻し');
    expect(first.snapshot().reserved).toBe(1);
  });
  it('rolls back the entire reservation if durable audit storage fails', () => {
    seed(); const claim = first.claim(item(1), A);
    store.db.exec("CREATE TRIGGER reject_card_event BEFORE INSERT ON card_history_events BEGIN SELECT RAISE(FAIL,'test-failure'); END;");
    expect(() => transition(first, A, claim.operation)).toThrow('test-failure');
    expect(first.snapshot()).toMatchObject({ registry: '', active: [{ state: 'open' }] });
  });
  it('blocks changing labels or resetting items while a card claim is active', () => {
    seed(); first.claim(item(1), A);
    const manager = new IssuerManagement(store, ORIGIN);
    const preview = manager.preview({ mode: 'reset' }, A, true);
    expect(() => manager.apply({ token: preview.token, confirmation: '物品台帳をリセット' }, A, true)).toThrow('カード発行中');
    expect(store.item(item(1).code).status).toBe('ready');
  });
  it('locks all replaced bindings while an explicitly confirmed overwrite is reserved', () => {
    seed(JSON.stringify(record(item(1), 'passed')) + '\n');
    const wanted = { ...item(2), idm: item(1).idm, force: true };
    const claim = first.claim(wanted, A);
    expect(() => second.claim(item(1), B)).toThrow('別のPC');
    transition(first, A, claim.operation, wanted, 'reserve', [record(item(1), 'released'), record(wanted)]);
    transition(first, A, claim.operation, wanted, 'pass');
    expect(first.snapshot()).toMatchObject({ passed: 1, reserved: 0 });
  });
  it('retains failed reservations and records an explicit recovery without erasing bindings', () => {
    seed(); const claim = first.claim(item(1), A); transition(first, A, claim.operation);
    expect(() => first.recover({ operation: claim.operation, confirmation: 'yes' }, B)).toThrow('確認文');
    first.recover({ operation: claim.operation, confirmation: '未完了の発行を引き継ぐ' }, B);
    expect(first.snapshot()).toMatchObject({ reserved: 1, active: [] });
    expect(() => transition(first, A, claim.operation, item(1), 'pass')).toThrow('状態');
    expect(() => transition(first, A, claim.operation)).toThrow('終了');
    expect(store.db.prepare('SELECT actor FROM card_history_recovery').get()!.actor).toBe(B.id);
    const next = second.claim({ ...item(1), force: true }, B);
    transition(second, B, next.operation, item(1), 'reserve', [record(item(1), 'released'), record()]);
    transition(second, B, next.operation, item(1), 'pass');
    expect(first.snapshot().passed).toBe(1);
  });
  it('preserves rental item names, status, history and issuance URLs during card operations', () => {
    const before = store.db.prepare('SELECT * FROM items ORDER BY code').all();
    seed(); const claim = first.claim(item(1), A); transition(first, A, claim.operation); transition(first, A, claim.operation, item(1), 'pass');
    expect(store.db.prepare('SELECT * FROM items ORDER BY code').all()).toEqual(before);
  });
  it('rejects a mismatched import checksum and directory traversal in evidence', () => {
    expect(() => first.importLegacy({ registry: '', sha256: randomUUID(), evidence: {} }, A)).toThrow('ハッシュ');
    expect(() => first.importLegacy({ registry: '', sha256: digest(''), evidence: { 'evidence/../../x': 'YQ==' } }, A)).toThrow('保存先');
    expect(first.snapshot().initialized).toBe(false);
  });
  it('stops before writing if a claimed item became loaned while awaiting its card', () => {
    seed(); const claim = first.claim(item(1), A);
    store.db.prepare("UPDATE items SET status='loaned' WHERE code=?").run(item(1).code);
    expect(() => transition(first, A, claim.operation)).toThrow('状態が変わ');
    expect(first.snapshot().reserved).toBe(0);
  });
});
