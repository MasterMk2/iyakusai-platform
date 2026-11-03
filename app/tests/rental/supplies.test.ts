import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedRentalDemo } from '../../src/server/rental/seed.js';
import { RentalStore, type Actor } from '../../src/server/rental/store.js';
import { SupplyStore } from '../../src/server/rental/supplies/store.js';
import { seedSupplyDemo } from '../../src/server/rental/supplies/seed.js';
import { resetNumbering } from '../../src/server/rental/numbering-reset.js';
import { RentalError } from '../../src/server/rental/validate.js';
import { ACTOR, metadata } from './helpers.js';

// The counted supplies, their attachments and the 団体 board, against a demo ledger. Every number here is
// synthetic. The card ledger is used only where the board must see a real loan (a borrow and a return).

const GROUP_A = '試用 模擬店A';
const GROUP_B = '試用 模擬店B';
const STAFF: Actor = { id: 'u-editor-a', name: '試用スタッフ' };

let dir: string;
let rental: RentalStore;
let supplies: SupplyStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-supplies-'));
  rental = new RentalStore(dir, { demo: true });
  seedRentalDemo(rental);
  supplies = new SupplyStore(rental);
});
afterEach(() => {
  rental.close();
  rmSync(dir, { recursive: true, force: true });
});

function newItem(extra: Record<string, unknown> = {}) {
  return supplies.createItem({ name: `試験 ${randomUUID().slice(0, 8)}`, unit: '個', kind: 'lend', low_threshold: 2, initial_on_hand: 10, ...extra }, STAFF);
}

async function expectError(fn: () => unknown, status: number, code?: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RentalError);
    expect((err as RentalError).status).toBe(status);
    if (code) expect((err as RentalError).code).toBe(code);
    return;
  }
  throw new Error('expected an error');
}

describe('counted items', () => {
  it('starts from the initial stock and marks low and out-of-stock counts with text fields', () => {
    const chair = newItem({ initial_on_hand: 3, low_threshold: 3 });
    expect(chair.on_hand).toBe(3);
    expect(chair.low).toBe(true);
    expect(chair.out_of_stock).toBe(false);
    const empty = newItem({ initial_on_hand: 0 });
    expect(empty.out_of_stock).toBe(true);
    const snapshot = supplies.snapshot();
    expect(snapshot.items.some((i) => i.id === chair.id && i.on_hand === 3)).toBe(true);
  });

  it('refuses a duplicate name among active items and invalid numbers', async () => {
    const chair = newItem();
    await expectError(() => supplies.createItem({ name: chair.name, unit: '脚', kind: 'lend' }, STAFF), 409, 'duplicate_name');
    await expectError(() => supplies.createItem({ name: '試験 数', unit: '脚', kind: 'lend', initial_on_hand: 1.5 }, STAFF), 400);
    await expectError(() => supplies.createItem({ name: '試験 種類', unit: '脚', kind: 'other' }, STAFF), 400);
    await expectError(() => supplies.createItem({ name: 'a\tb', unit: '脚', kind: 'lend' }, STAFF), 400);
  });

  it('keeps the kind fixed and archives only when nothing is in stock or lent out', async () => {
    const item = newItem({ initial_on_hand: 1 });
    await expectError(() => supplies.updateItem(item.id, { kind: 'consumable', expected_version: item.version }, STAFF), 400, 'invalid_kind');
    await expectError(() => supplies.updateItem(item.id, { archived: true, expected_version: item.version }, STAFF), 409, 'not_empty');
    const emptied = supplies.createItem({ name: `試験 空 ${randomUUID().slice(0, 8)}`, unit: '個', kind: 'lend' }, STAFF);
    const archived = supplies.updateItem(emptied.id, { archived: true, expected_version: emptied.version }, STAFF);
    expect(archived.id).toBe(emptied.id);
    expect(supplies.snapshot().items.some((i) => i.id === emptied.id)).toBe(false);
  });
});

describe('lending and returning', () => {
  it('lends to a registered group and returns in stock, with lost counts kept out of stock', () => {
    const chair = newItem({ initial_on_hand: 10 });
    const lent = supplies.lend({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: chair.id, qty: 4, expected_version: chair.version }] }, STAFF);
    expect(lent.lines).toMatchObject([{ on_hand: 6, lent: 4 }]);
    const after = supplies.snapshot().items.find((i) => i.id === chair.id)!;
    expect(after.on_hand).toBe(6);
    expect(after.lent_by_group).toEqual([{ group: GROUP_A, lent: 4 }]);

    const v = after.version;
    const back = supplies.giveBack({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: chair.id, qty: 3, lost: 1, expected_version: v }] }, STAFF);
    expect(back.lines).toMatchObject([{ on_hand: 9, lent: 0 }]);
  });

  it('refuses a stale version, a shortage of stock, and returning more than the group has', async () => {
    const chair = newItem({ initial_on_hand: 2 });
    await expectError(() => supplies.lend({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: chair.id, qty: 1, expected_version: 99 }] }, STAFF), 409, 'version_conflict');
    await expectError(() => supplies.lend({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: chair.id, qty: 3, expected_version: chair.version }] }, STAFF), 409, 'stock_short');
    supplies.lend({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: chair.id, qty: 1, expected_version: chair.version }] }, STAFF);
    await expectError(() => supplies.giveBack({ id: randomUUID(), group: GROUP_B, lines: [{ item_id: chair.id, qty: 1, expected_version: 2 }] }, STAFF), 409, 'lent_short');
    await expectError(() => supplies.lend({ id: randomUUID(), group: '登録されていない団体', lines: [{ item_id: chair.id, qty: 1, expected_version: 1 }] }, STAFF), 400);
  });

  it('writes a batch all or nothing', async () => {
    const a = newItem({ initial_on_hand: 5 });
    const b = newItem({ initial_on_hand: 1 });
    const before = supplies.snapshot().items.find((i) => i.id === a.id)!;
    await expectError(() => supplies.lend({ id: randomUUID(),
      group: GROUP_A,
      lines: [
        { item_id: a.id, qty: 2, expected_version: before.version },
        { item_id: b.id, qty: 5, expected_version: b.version },
      ],
    }, STAFF), 409, 'stock_short');
    const afterA = supplies.snapshot().items.find((i) => i.id === a.id)!;
    expect(afterA.on_hand).toBe(5);
    expect(afterA.version).toBe(before.version);
  });

  it('refuses to lend a consumable, and a lending item to be used up', async () => {
    const tape = newItem({ kind: 'consumable', initial_on_hand: 4 });
    await expectError(() => supplies.lend({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: tape.id, qty: 1, expected_version: tape.version }] }, STAFF), 400, 'invalid_kind');
    const chair = newItem({ initial_on_hand: 4 });
    await expectError(() => supplies.consume({ id: randomUUID(), item_id: chair.id, qty: 1, expected_version: chair.version }, STAFF), 400, 'invalid_kind');
  });
});

describe('consumables and stock corrections', () => {
  it('uses a consumable up, counting the total used, and needs a note for a decrease', async () => {
    const pen = newItem({ kind: 'consumable', initial_on_hand: 5, low_threshold: 1 });
    const used = supplies.consume({ id: randomUUID(), item_id: pen.id, qty: 2, expected_version: pen.version }, STAFF);
    expect(used.on_hand).toBe(3);
    const snap = supplies.snapshot().items.find((i) => i.id === pen.id)!;
    expect(snap.consumed).toBe(2);
    await expectError(() => supplies.adjustStock(pen.id, { delta: -1, expected_version: snap.version }, STAFF), 400, 'note_required');
    const fixed = supplies.adjustStock(pen.id, { delta: 4, expected_version: snap.version, note: '補充' }, STAFF);
    expect(fixed.on_hand).toBe(7);
  });

  it('refuses a correction that would take the stock below zero', async () => {
    const pen = newItem({ kind: 'consumable', initial_on_hand: 1 });
    await expectError(() => supplies.adjustStock(pen.id, { delta: -2, expected_version: pen.version, note: '棚卸し' }, STAFF), 409, 'stock_short');
  });
});

describe('undo', () => {
  it('undoes a loan with a new record, keeps the original, and refuses a second undo', async () => {
    const chair = newItem({ initial_on_hand: 5 });
    supplies.lend({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: chair.id, qty: 2, expected_version: chair.version }] }, STAFF);
    const lendRecord = supplies.movements(chair.id, 10).find((m) => (m as { kind: string }).kind === 'lend') as { id: number; reversible: boolean };
    expect(lendRecord.reversible).toBe(true);
    const version = supplies.snapshot().items.find((i) => i.id === chair.id)!.version;
    const undone = supplies.reverse(lendRecord.id, { reason: '別の団体に貸した', expected_version: version }, STAFF, ['rental.loan']);
    expect(undone.on_hand).toBe(5);
    expect(undone.lent).toBe(0);
    const again = supplies.movements(chair.id, 10).find((m) => (m as { id: number }).id === lendRecord.id) as { reversed: boolean; reversible: boolean };
    expect(again.reversed).toBe(true);
    expect(again.reversible).toBe(false);
    await expectError(() => supplies.reverse(lendRecord.id, { reason: '二度目', expected_version: undone.version }, STAFF, ['rental.loan']), 409, 'already_reversed');
  });

  it('needs the permission that matches the record: loan for loans, issue for stock', async () => {
    const chair = newItem({ initial_on_hand: 5 });
    const stock = supplies.movements(chair.id, 5)[0] as { id: number };
    await expectError(() => supplies.reverse(stock.id, { reason: '取り消し', expected_version: chair.version + 0 }, STAFF, ['rental.loan']), 403, 'forbidden');
  });

  it('refuses to undo a loan after part of it came back', async () => {
    const chair = newItem({ initial_on_hand: 5 });
    supplies.lend({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: chair.id, qty: 2, expected_version: chair.version }] }, STAFF);
    const v1 = supplies.snapshot().items.find((i) => i.id === chair.id)!.version;
    supplies.giveBack({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: chair.id, qty: 1, expected_version: v1 }] }, STAFF);
    const lendRecord = supplies.movements(chair.id, 10).find((m) => (m as { kind: string }).kind === 'lend') as { id: number };
    const v2 = supplies.snapshot().items.find((i) => i.id === chair.id)!.version;
    await expectError(() => supplies.reverse(lendRecord.id, { reason: '取り消し', expected_version: v2 }, STAFF, ['rental.loan']), 409, 'lent_short');
  });
});

describe('attachments and checks', () => {
  it('counts the attachments in the same operation as the lend and the return, and clears a shortage with a later check', () => {
    const chair = newItem({ initial_on_hand: 3 });
    const cover = supplies.createAttachment({ owner_kind: 'supply', owner_key: chair.id, name: '座面カバー', expected: 1 }, STAFF);
    const cable = supplies.createAttachment({ owner_kind: 'supply', owner_key: chair.id, name: '背当て', expected: 2 }, STAFF);
    const lent = supplies.lend({
      id: randomUUID(), group: GROUP_A,
      lines: [{ item_id: chair.id, qty: 2, expected_version: chair.version, attachments: [{ attachment_id: cover.id, found: 2 }, { attachment_id: cable.id, found: 4 }] }],
    }, STAFF);
    expect(lent.checks).toMatchObject([{ phase: 'borrow', units: 2, missing_total: 0, group: GROUP_A }]);

    // One chair back: the cover is 1 per chair (1 expected, 1 found), the back rest 2 per chair (2 expected, 1 found).
    const v = supplies.snapshot().items.find((i) => i.id === chair.id)!.version;
    const returnBody = {
      id: randomUUID(), group: GROUP_A,
      lines: [{ item_id: chair.id, qty: 1, lost: 0, expected_version: v, attachments: [{ attachment_id: cover.id, found: 1 }, { attachment_id: cable.id, found: 1, note: '1 本見当たらない' }] }],
    };
    const back = supplies.giveBack(returnBody, STAFF);
    expect(back.checks).toMatchObject([{ phase: 'return', units: 1, missing_total: 1, group: GROUP_A }]);
    // The same request id again is answered with the stored result, and nothing is written twice.
    expect(supplies.giveBack(returnBody, STAFF)).toEqual(back);
    expect(supplies.snapshot().items.find((i) => i.id === chair.id)!.lent).toBe(1);

    const board = supplies.board(GROUP_A);
    const lentLine = board.supplies.find((s) => s.item_id === chair.id)!;
    expect(lentLine.attachments.find((a) => a.id === cable.id)!.missing).toBe(1);
    expect(board.attachment_shortage).toBe(1);
    expect(supplies.shortages().filter((s) => s.owner_key === chair.id)).toHaveLength(1);

    supplies.recordCheck({
      id: randomUUID(), owner_kind: 'supply', owner_key: chair.id, phase: 'check', units: 1,
      lines: [{ attachment_id: cover.id, found: 1 }, { attachment_id: cable.id, found: 2 }],
    }, STAFF);
    expect(supplies.shortages().some((s) => s.owner_key === chair.id)).toBe(false);
    expect(supplies.board(GROUP_A).attachment_shortage).toBe(0);
  });

  it('refuses a standalone check of a counted item for a loan or a return, and bounds its units by the units that exist', async () => {
    const chair = newItem({ initial_on_hand: 2 });
    const cover = supplies.createAttachment({ owner_kind: 'supply', owner_key: chair.id, name: '座面カバー', expected: 1 }, STAFF);
    await expectError(() => supplies.recordCheck({ id: randomUUID(), owner_kind: 'supply', owner_key: chair.id, phase: 'return', group: GROUP_A, units: 1, lines: [{ attachment_id: cover.id, found: 1 }] }, STAFF), 400);
    await expectError(() => supplies.recordCheck({ id: randomUUID(), owner_kind: 'supply', owner_key: chair.id, phase: 'check', units: 3, lines: [{ attachment_id: cover.id, found: 1 }] }, STAFF), 400);
    expect(supplies.recordCheck({ id: randomUUID(), owner_kind: 'supply', owner_key: chair.id, phase: 'check', units: 2, lines: [{ attachment_id: cover.id, found: 2 }] }, STAFF).replay).toBe(false);
  });

  it('refuses a lend of an item with attachments unless every attachment is counted, and writes nothing then', async () => {
    const chair = newItem({ initial_on_hand: 5 });
    const cover = supplies.createAttachment({ owner_kind: 'supply', owner_key: chair.id, name: '座面カバー', expected: 1 }, STAFF);
    const plain = newItem({ initial_on_hand: 5 });
    await expectError(() => supplies.lend({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: chair.id, qty: 2, expected_version: chair.version }] }, STAFF), 400, 'attachments_required');
    await expectError(() => supplies.lend({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: chair.id, qty: 2, expected_version: chair.version, attachments: [{ attachment_id: cover.id, found: 3 }] }] }, STAFF), 400);
    await expectError(() => supplies.lend({ id: randomUUID(), group: GROUP_A, lines: [{ item_id: plain.id, qty: 1, expected_version: plain.version, attachments: [{ attachment_id: cover.id, found: 1 }] }] }, STAFF), 400, 'attachments_changed');
    expect(supplies.snapshot().items.find((i) => i.id === chair.id)!.on_hand).toBe(5);
    expect(supplies.movements(chair.id, 10).filter((m) => (m as { kind: string }).kind === 'lend')).toHaveLength(0);
  });

  it('answers the same request id with the stored lend and writes the lend once, and refuses an id reused for other content', async () => {
    const chair = newItem({ initial_on_hand: 5 });
    const body = { id: randomUUID(), group: GROUP_A, lines: [{ item_id: chair.id, qty: 2, expected_version: chair.version }] };
    const first = supplies.lend(body, STAFF);
    expect(supplies.lend(body, STAFF)).toEqual(first);
    expect(supplies.snapshot().items.find((i) => i.id === chair.id)!.on_hand).toBe(3);
    expect(supplies.movements(chair.id, 10).filter((m) => (m as { kind: string }).kind === 'lend')).toHaveLength(1);
    await expectError(() => supplies.lend({ ...body, lines: [{ item_id: chair.id, qty: 1, expected_version: chair.version }] }, STAFF), 409, 'request_conflict');
    await expectError(() => supplies.lend(body, { id: 'u-other', name: '別の委員' }), 409, 'request_conflict');
    await expectError(() => supplies.lend({ group: GROUP_A, lines: body.lines }, STAFF), 400);
  });

  it('answers a repeated consume with the stored result, and needs a request id', async () => {
    const pen = newItem({ kind: 'consumable', initial_on_hand: 5 });
    const body = { id: randomUUID(), item_id: pen.id, qty: 2, expected_version: pen.version };
    const first = supplies.consume(body, STAFF);
    expect(supplies.consume(body, STAFF)).toEqual(first);
    expect(first.on_hand).toBe(3);
    await expectError(() => supplies.consume({ item_id: pen.id, qty: 1, expected_version: first.version }, STAFF), 400);
  });

  it('answers an unknown card or counted item with 404 instead of an empty list', async () => {
    await expectError(() => supplies.attachments('card', 'IY-999998'), 404, 'not_found');
    await expectError(() => supplies.attachments('supply', `S-${'0'.repeat(32)}`), 404, 'not_found');
  });

  it('keeps a shortage of another group off this board, and shows the earlier check as the previous one', () => {
    // The demo seed gives IY-000124 one attachment (脚キャップ, 4 per card).
    const cap = supplies.attachments('card', 'IY-000124').attachments[0]!;
    rental.submit(metadata({ borrower: GROUP_A, photo_skip: true, item_code: 'IY-000124', item_version: 0 }), [], ACTOR);
    rental.submit(metadata({ action: 'return', item_code: 'IY-000124', item_version: 1, borrower: '' }), [], ACTOR);
    supplies.recordCheck({ id: randomUUID(), owner_kind: 'card', owner_key: 'IY-000124', phase: 'return', group: GROUP_A, units: 1, lines: [{ attachment_id: cap.id, found: 1 }] }, STAFF);
    rental.submit(metadata({ borrower: GROUP_B, photo_skip: true, item_code: 'IY-000124', item_version: 2 }), [], ACTOR);
    const board = supplies.board(GROUP_B);
    expect(board.cards.map((c) => c.code)).toEqual(['IY-000124']);
    const shown = board.cards[0]!.attachments[0]!;
    expect(shown.missing).toBeNull();
    expect(shown.previous_check).toMatchObject({ group: GROUP_A });
    expect(board.attachment_shortage).toBe(0);
  });

  it('counts a card the ledger marks as borrowed as out, like a loaned one', () => {
    rental.submit(metadata({ borrower: GROUP_B, photo_skip: true, item_code: 'IY-000123', item_version: 0 }), [], ACTOR);
    rental.run("UPDATE items SET status='borrowed' WHERE code='IY-000123'");
    expect(supplies.board(GROUP_B).cards.map((c) => c.code)).toEqual(['IY-000123']);
    expect(supplies.collection().find((g) => g.name === GROUP_B)).toMatchObject({ cards_out: 1, collected: false });
  });

  it('removes the card attachments and checks when the card numbers are reset, and keeps the counted supplies', () => {
    rental.addItems([['IY-000125', '試験の機材']]);
    const cardAtt = supplies.createAttachment({ owner_kind: 'card', owner_key: 'IY-000125', name: '試験バンド', expected: 2 }, STAFF);
    supplies.recordCheck({ id: randomUUID(), owner_kind: 'card', owner_key: 'IY-000125', phase: 'check', lines: [{ attachment_id: cardAtt.id, found: 1 }] }, STAFF);
    const chair = newItem({ initial_on_hand: 3 });
    const supplyAtt = supplies.createAttachment({ owner_kind: 'supply', owner_key: chair.id, name: 'カバー', expected: 1 }, STAFF);
    expect(supplies.attachments('card', 'IY-000125').attachments).toHaveLength(1);
    expect(supplies.attachments('card', 'IY-000125').last_checks).toHaveLength(1);

    resetNumbering(rental, STAFF, true);

    expect(rental.get("SELECT COUNT(*) AS n FROM supply_attachments WHERE owner_kind='card'")!.n).toBe(0);
    expect(rental.get("SELECT COUNT(*) AS n FROM supply_attachment_checks WHERE owner_kind='card'")!.n).toBe(0);
    expect(rental.get('SELECT COUNT(*) AS n FROM supply_attachments WHERE id=?', supplyAtt.id)!.n).toBe(1);
    expect(supplies.snapshot().items.find((i) => i.id === chair.id)!.on_hand).toBe(3);
    // The same number registered again starts with no attachment and no check.
    rental.addItems([['IY-000125', '新しい機材']]);
    expect(supplies.attachments('card', 'IY-000125').attachments).toEqual([]);
    expect(supplies.attachments('card', 'IY-000125').last_checks).toEqual([]);
    // The archive keeps the old rows for the record.
    expect(String(rental.get('SELECT snapshot_json FROM numbering_reset_archives')!.snapshot_json)).toContain('試験バンド');
  });

  it('refuses a check that misses an attachment, counts more than expected, or reuses an id for another item', async () => {
    const chair = newItem({ initial_on_hand: 3 });
    const a = supplies.createAttachment({ owner_kind: 'supply', owner_key: chair.id, name: 'カバー', expected: 1 }, STAFF);
    const b = supplies.createAttachment({ owner_kind: 'supply', owner_key: chair.id, name: 'ネジ', expected: 4 }, STAFF);
    await expectError(() => supplies.recordCheck({ id: randomUUID(), owner_kind: 'supply', owner_key: chair.id, phase: 'check', lines: [{ attachment_id: a.id, found: 1 }] }, STAFF), 400);
    await expectError(() => supplies.recordCheck({ id: randomUUID(), owner_kind: 'supply', owner_key: chair.id, phase: 'check', lines: [{ attachment_id: a.id, found: 2 }, { attachment_id: b.id, found: 4 }] }, STAFF), 400);
    const id = randomUUID();
    supplies.recordCheck({ id, owner_kind: 'supply', owner_key: chair.id, phase: 'check', lines: [{ attachment_id: a.id, found: 1 }, { attachment_id: b.id, found: 4 }] }, STAFF);
    const other = newItem({ initial_on_hand: 1 });
    await expectError(() => supplies.recordCheck({ id, owner_kind: 'supply', owner_key: other.id, phase: 'check', lines: [] }, STAFF), 409, 'conflict');
  });

  it('checks a card with its own attachments, one card at a time', async () => {
    supplies.createAttachment({ owner_kind: 'card', owner_key: 'IY-000124', name: '試験の脚カバー', expected: 4 }, STAFF);
    const attachments = supplies.attachments('card', 'IY-000124').attachments;
    const cover = attachments.find((a) => a.name === '試験の脚カバー')!;
    expect(cover.expected).toBe(4);
    await expectError(() => supplies.recordCheck({ id: randomUUID(), owner_kind: 'card', owner_key: 'IY-000124', phase: 'borrow', units: 2, lines: [] }, STAFF), 400);
  });
});

describe('the 団体 board and collection', () => {
  it('shows the cards and counts a group has, and is collected only when everything is back', () => {
    const chair = newItem({ initial_on_hand: 4 });
    supplies.lend({ id: randomUUID(), group: GROUP_B, lines: [{ item_id: chair.id, qty: 2, expected_version: chair.version }] }, STAFF);
    const card = metadata({ borrower: GROUP_B, photo_skip: true, item_code: 'IY-000123', item_version: 0 });
    rental.submit(card, [], ACTOR);
    const boardOut = supplies.board(GROUP_B);
    expect(boardOut.cards.map((c) => c.code)).toEqual(['IY-000123']);
    expect(boardOut.units_out).toBe(2);
    expect(boardOut.collected).toBe(false);

    const v = supplies.snapshot().items.find((i) => i.id === chair.id)!.version;
    supplies.giveBack({ id: randomUUID(), group: GROUP_B, lines: [{ item_id: chair.id, qty: 2, expected_version: v }] }, STAFF);
    rental.submit(metadata({ action: 'return', item_code: 'IY-000123', item_version: 1, borrower: '' }), [], ACTOR);
    const boardDone = supplies.board(GROUP_B);
    expect(boardDone.cards).toEqual([]);
    expect(boardDone.collected).toBe(true);
    expect(supplies.collection().find((g) => g.name === GROUP_B)).toMatchObject({ cards_out: 0, units_out: 0, collected: true });
  });

  it('keeps a group that is not registered off the board', async () => {
    await expectError(() => supplies.board('登録されていない団体'), 400);
  });

  it('keeps the card of a different group off this board', () => {
    rental.submit(metadata({ borrower: GROUP_A, photo_skip: true, item_code: 'IY-000124', item_version: 0 }), [], ACTOR);
    expect(supplies.board(GROUP_B).cards).toEqual([]);
    expect(supplies.board(GROUP_A).cards.map((c) => c.code)).toEqual(['IY-000124']);
  });
});

describe('demo data', () => {
  it('adds the synthetic supplies once, even when the demo starts again', () => {
    seedSupplyDemo(rental);
    const first = supplies.snapshot().items.length;
    seedSupplyDemo(rental);
    expect(supplies.snapshot().items.length).toBe(first);
    expect(first).toBeGreaterThanOrEqual(5);
    expect(supplies.board(GROUP_A).supplies.length).toBeGreaterThanOrEqual(1);
    expect(supplies.movements(null, 200).length).toBeGreaterThan(0);
  });
});
