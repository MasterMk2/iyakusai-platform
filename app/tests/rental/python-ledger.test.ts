import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RentalStore } from '../../src/server/rental/store.js';
import { canonical } from '../../src/server/rental/validate.js';
import { LEDGER, statusOf } from './helpers.js';

// Switching from the Python server: its data folder (written by tests/rental/fixtures/make_python_ledger.py
// with the reference server) is opened as it is. The items, plans and receipts read back unchanged, and a
// loan queued on a phone before the switch, resent afterwards, is the same operation (same fingerprint).

interface Expected {
  actor: { id: string; name: string };
  operations: { meta: Record<string, unknown>; photos: string[]; receipt: Record<string, unknown> }[];
  fingerprints: Record<string, string>;
  items: Record<string, Record<string, unknown>>;
  groups: { id: string; name: string }[];
  canonical_sample: string;
}

const expected = JSON.parse(readFileSync(path.join(LEDGER, 'expected.json'), 'utf8')) as Expected;
const photo = (name: string) => readFileSync(path.join(LEDGER, 'photos', `${name}.jpg`));

let dir: string;
let store: RentalStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-python-ledger-'));
  cpSync(path.join(LEDGER, 'folder'), dir, { recursive: true });
  store = new RentalStore(dir, { demo: true });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a ledger written by the Python server', () => {
  it('reads items, plans, borrower IDs and receipts unchanged', () => {
    for (const [code, item] of Object.entries(expected.items)) expect(store.item(code)).toEqual({ ...item, item_scope: null, item_owner: null, photo_required: null });
    expect(store.borrowerGroups()).toEqual(expected.groups);
    for (const op of expected.operations) expect(store.operation(op.meta.operation_id)).toEqual(op.receipt);
  });

  it('computes the same fingerprint, so a resent queued loan replays instead of conflicting', () => {
    for (const op of expected.operations) {
      const replay = store.submit(op.meta, op.photos.map(photo), expected.actor);
      expect(replay).toEqual(op.receipt);
    }
    expect(store.db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: expected.operations.length });
    const changed = { ...expected.operations[0]!.meta, note: '別の内容' };
    expect(statusOf(() => store.submit(changed, expected.operations[0]!.photos.map(photo), expected.actor))).toBe(409);
  });

  it('writes canonical JSON exactly as Python json.dumps(sort_keys, ensure_ascii=False) does', () => {
    expect(canonical({ b: [1, true, null], a: '日本\n"x"\u0001', é: 2, Z: { y: 0, x: -5 } })).toBe(expected.canonical_sample);
  });

  it('continues the ledger: the item returned damaged stays on hold and the planned loan is fulfilled', () => {
    expect(store.item('IY-000123').status).toBe('review');
    expect(store.item('IY-PLAN-000001')).toMatchObject({ status: 'loaned', planned_state: 'fulfilled' });
    expect(store.item('IY-000124')).toMatchObject({ status: 'ready', version: 0 });
  });
});
