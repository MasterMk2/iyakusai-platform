import { createHash, randomUUID } from 'node:crypto';
import type { Actor, RentalPermission, RentalStore } from '../store.js';
import { borrowerName, RentalError, utcNow } from '../validate.js';
import { ensureSupplySchema } from './schema.js';
import {
  arrayOf, attachmentId, CHECK_PHASES, integer, line, MAX_ATTACHMENTS_PER_OWNER, MAX_LINES, MAX_QTY, note, obj, OWNER_KINDS, oneOf,
  ownerKey, supplyId, SUPPLY_KINDS, uuid, type OwnerKind, type SupplyKind,
} from './validate.js';

// The counted supplies (chairs, extension cords, consumables) and the attachments of cards and supplies.
// Every count is a sum over supply_movements. A write checks the item's version (the 版番号 the screen
// read) and the stock or lent count inside one BEGIN IMMEDIATE transaction, so two screens cannot both take
// the last chair. A lend or a return carries the request's own UUID: the same UUID sent again is answered
// with the stored result, so a retry after a lost answer never records the same lend twice. Nothing here is
// copied to Google Drive; see docs/supplies.md.

type Row = Record<string, unknown>;
type MoveKind = 'stock' | 'lend' | 'return' | 'consume' | 'reverse';
type RequestKind = 'lend' | 'return' | 'consume';

/** One change to one item, before it is written. Deltas are signed: they are added to the stored sums. */
interface Move {
  item: string;
  kind: MoveKind;
  group: string | null;
  qty: number;
  lost: number;
  dOnHand: number;
  dLent: number;
  dConsumed: number;
  reverses: number | null;
  note: string;
  expected: number;
}

/** One attachment of a line, as the screen counted it at the lend or the return. */
interface AttachmentInput {
  attachment: string;
  found: number;
  memo: string;
}

export interface SupplyAttachmentRef {
  id: string;
  name: string;
  expected_per_unit: number;
  version: number;
}

export interface SupplyView {
  id: string;
  name: string;
  unit: string;
  kind: SupplyKind;
  low_threshold: number;
  note: string;
  version: number;
  on_hand: number;
  lent: number;
  consumed: number;
  /** on_hand is at or below the item's own threshold (a text label is shown next to it, not only a colour). */
  low: boolean;
  out_of_stock: boolean;
  lent_by_group: { group: string; lent: number }[];
  /** The attachments that come with one unit of this item (active ones only). */
  attachments: SupplyAttachmentRef[];
}

export interface AttachmentView {
  id: string;
  owner_kind: OwnerKind;
  owner_key: string;
  name: string;
  expected: number;
  note: string;
  version: number;
}

/** Which check counts for a group's loan: its own checks and the unassigned ones, from the loan's start. */
interface LoanFilter {
  group: string;
  since: string | null;
}

const pyCompare = (a: string, b: string) => a.localeCompare(b, 'ja');
const fingerprintOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Cards and items still out: the loan is 'loaned', or 'borrowed' in the older ledger. Both count as out. */
const OUT_STATUSES = "('loaned','borrowed')";

/** The attachments a line carries: null when the screen sent none, which is allowed only when the item has none. */
function attachmentInputs(value: unknown): AttachmentInput[] | null {
  if (value === undefined || value === null) return null;
  return arrayOf(value, '付属品の点検', 0, MAX_ATTACHMENTS_PER_OWNER).map((v) => {
    const a = obj(v);
    return { attachment: attachmentId(a.attachment_id), found: integer(a.found, '在った数', 0, MAX_QTY), memo: note(a.note, 'メモ', 200) };
  });
}

export class SupplyStore {
  constructor(private readonly rental: RentalStore) {
    ensureSupplySchema(rental.db);
  }

  // ---- reads

  /** Items with their counts, the groups that have something out, and the groups used most recently. */
  snapshot(): { generated_at: string; items: SupplyView[]; groups: string[]; recent_groups: string[] } {
    const rows = this.rental.all(
      `SELECT i.*, COALESCE(SUM(m.d_on_hand),0) AS on_hand, COALESCE(SUM(m.d_lent),0) AS lent, COALESCE(SUM(m.d_consumed),0) AS consumed
       FROM supply_items i LEFT JOIN supply_movements m ON m.item_id=i.id
       WHERE i.archived_at IS NULL GROUP BY i.id ORDER BY i.kind, i.name, i.id`,
    );
    const lentByGroup = new Map<string, { group: string; lent: number }[]>();
    for (const r of this.rental.all('SELECT item_id, group_name, SUM(d_lent) AS lent FROM supply_movements WHERE group_name IS NOT NULL GROUP BY item_id, group_name HAVING SUM(d_lent)<>0 ORDER BY group_name')) {
      const list = lentByGroup.get(String(r.item_id)) ?? [];
      list.push({ group: String(r.group_name), lent: Number(r.lent) });
      lentByGroup.set(String(r.item_id), list);
    }
    const attachmentsByItem = new Map<string, SupplyAttachmentRef[]>();
    for (const r of this.rental.all("SELECT id,owner_key,name,expected,version FROM supply_attachments WHERE owner_kind='supply' AND archived_at IS NULL ORDER BY created_at, id")) {
      const list = attachmentsByItem.get(String(r.owner_key)) ?? [];
      list.push(this.attachmentRef(r));
      attachmentsByItem.set(String(r.owner_key), list);
    }
    const items = rows.map((r) => this.view(r, lentByGroup.get(String(r.id)) ?? [], attachmentsByItem.get(String(r.id)) ?? []));
    const recent = this.rental.all('SELECT group_name, MAX(id) AS last FROM supply_movements WHERE group_name IS NOT NULL GROUP BY group_name ORDER BY last DESC LIMIT 8').map((r) => String(r.group_name));
    return {
      generated_at: utcNow(),
      items,
      groups: this.rental.borrowers(),
      recent_groups: recent,
    };
  }

  /** The history of counts, newest first. Used for the item's history and for undoing a mistake. */
  movements(itemId: unknown, limit: number): object[] {
    const id = itemId === undefined || itemId === null || itemId === '' ? null : supplyId(itemId);
    const rows = this.rental.all(
      `SELECT m.*, i.name AS item_name, i.unit AS unit,
         (SELECT COUNT(*) FROM supply_movements r WHERE r.reverses=m.id) AS reversed_count
       FROM supply_movements m JOIN supply_items i ON i.id=m.item_id
       WHERE (? IS NULL OR m.item_id=?) ORDER BY m.id DESC LIMIT ?`,
      id, id, Math.min(Math.max(limit, 1), 200),
    );
    return rows.map((r) => {
      const reversed = Number(r.reversed_count) > 0;
      return {
        id: Number(r.id),
        item_id: String(r.item_id),
        item_name: String(r.item_name),
        unit: String(r.unit),
        kind: String(r.kind),
        group: r.group_name === null ? null : String(r.group_name),
        qty: Number(r.qty),
        lost: Number(r.lost),
        delta_on_hand: Number(r.d_on_hand),
        delta_lent: Number(r.d_lent),
        delta_consumed: Number(r.d_consumed),
        note: String(r.note),
        actor_name: String(r.actor_name),
        server_at: String(r.server_at),
        reverses: r.reverses === null ? null : Number(r.reverses),
        reversed,
        reversible: String(r.kind) !== 'reverse' && !reversed,
      };
    });
  }

  /** The 団体 page: the card loans and the counted supplies this group has now, and the checks of each. */
  board(group: unknown) {
    const name = this.registeredGroup(borrowerName(group));
    const cards = this.rental.all(`SELECT code,name,card_kind,current_loan FROM items WHERE archived_at IS NULL AND status IN ${OUT_STATUSES} AND current_loan IS NOT NULL ORDER BY code`)
      .flatMap((r) => {
        const loan = JSON.parse(String(r.current_loan)) as Record<string, unknown>;
        if (loan.borrower !== name) return [];
        const detail = r.card_kind === 'irregular' ? (loan.irregular as { name?: unknown; quantity?: unknown; unit?: unknown } | undefined) : undefined;
        const lentAt = typeof loan.server_at === 'string' ? loan.server_at : null;
        return [{
          code: String(r.code),
          name: String(detail?.name ?? r.name),
          irregular: detail !== undefined,
          quantity: detail ? Number(detail.quantity) : null,
          unit: detail ? String(detail.unit) : null,
          lent_at: lentAt,
          attachments: this.attachmentsWithStatus('card', String(r.code), 1, { group: name, since: lentAt }),
        }];
      });
    const lentRows = this.rental.all(
      `SELECT i.id, i.name, i.unit, i.version, SUM(m.d_lent) AS lent, COALESCE((SELECT SUM(d_on_hand) FROM supply_movements WHERE item_id=i.id),0) AS on_hand,
         (SELECT MAX(server_at) FROM supply_movements l WHERE l.item_id=i.id AND l.group_name=? AND l.kind='lend') AS lent_at
       FROM supply_movements m JOIN supply_items i ON i.id=m.item_id
       WHERE m.group_name=? AND i.archived_at IS NULL GROUP BY i.id HAVING SUM(m.d_lent)>0 ORDER BY i.name, i.id`,
      name,
      name,
    );
    const supplies = lentRows.map((r) => {
      const lent = Number(r.lent);
      return {
        item_id: String(r.id),
        name: String(r.name),
        unit: String(r.unit),
        lent,
        version: Number(r.version),
        on_hand: Number(r.on_hand),
        attachments: this.attachmentsWithStatus('supply', String(r.id), lent, { group: name, since: r.lent_at === null ? null : String(r.lent_at) }),
      };
    });
    const unitsOut = supplies.reduce((sum, s) => sum + s.lent, 0);
    const shortage = [...cards, ...supplies].reduce((sum, o) => sum + o.attachments.filter((a) => a.missing !== null && a.missing > 0).length, 0);
    return {
      group: name,
      cards,
      supplies,
      cards_out: cards.length,
      units_out: unitsOut,
      collected: cards.length === 0 && unitsOut === 0,
      attachment_shortage: shortage,
      generated_at: utcNow(),
    };
  }

  /** One row per group that has something lent now or ever: 回収済み when nothing is out. */
  collection(): { name: string; cards_out: number; units_out: number; collected: boolean }[] {
    const names = new Set<string>();
    for (const r of this.rental.all('SELECT DISTINCT group_name FROM supply_movements WHERE group_name IS NOT NULL')) names.add(String(r.group_name));
    const cardsOut = new Map<string, number>();
    for (const r of this.rental.all(`SELECT current_loan FROM items WHERE archived_at IS NULL AND status IN ${OUT_STATUSES} AND current_loan IS NOT NULL`)) {
      const loan = JSON.parse(String(r.current_loan)) as { borrower?: unknown };
      if (typeof loan.borrower !== 'string') continue;
      names.add(loan.borrower);
      cardsOut.set(loan.borrower, (cardsOut.get(loan.borrower) ?? 0) + 1);
    }
    const unitsOut = new Map<string, number>();
    for (const r of this.rental.all('SELECT group_name, SUM(d_lent) AS lent FROM supply_movements WHERE group_name IS NOT NULL GROUP BY group_name')) {
      unitsOut.set(String(r.group_name), Number(r.lent));
    }
    return [...names].sort(pyCompare).map((name) => {
      const cards = cardsOut.get(name) ?? 0;
      const units = unitsOut.get(name) ?? 0;
      return { name, cards_out: cards, units_out: units, collected: cards === 0 && units === 0 };
    });
  }

  /**
   * The attachments of one card or supply item, with the result of its latest check, and the attachments
   * put away (they can be put back). An unknown card or item is 404, not an empty list.
   */
  attachments(kind: unknown, key: unknown) {
    const k = oneOf(kind, OWNER_KINDS, '対象の種類');
    const owner = ownerKey(k, key);
    this.ownerExists(k, owner);
    const archived = this.rental.all('SELECT id,name,expected,note,version,archived_at FROM supply_attachments WHERE owner_kind=? AND owner_key=? AND archived_at IS NOT NULL ORDER BY archived_at DESC, id', k, owner)
      .map((r) => ({ id: String(r.id), name: String(r.name), expected_per_unit: Number(r.expected), note: String(r.note), version: Number(r.version), archived_at: String(r.archived_at) }));
    return { owner_kind: k, owner_key: owner, attachments: this.attachmentsWithStatus(k, owner, 1), archived, last_checks: this.checkHistory(k, owner) };
  }

  /** Items whose latest check still has a missing attachment. */
  shortages() {
    const rows = this.rental.all(
      `SELECT c.* FROM supply_attachment_checks c
       JOIN (SELECT owner_kind, owner_key, MAX(rowid) AS rid FROM supply_attachment_checks GROUP BY owner_kind, owner_key) l ON l.rid=c.rowid
       WHERE c.missing_total>0 ORDER BY c.server_at DESC, c.rowid DESC`,
    );
    return rows.map((r) => {
      const kind = oneOf(r.owner_kind, OWNER_KINDS, '対象の種類');
      const lines = (JSON.parse(String(r.lines_json)) as { name: string; missing: number; note: string }[]).filter((l) => l.missing > 0);
      return {
        owner_kind: kind,
        owner_key: String(r.owner_key),
        owner_name: this.ownerName(kind, String(r.owner_key)),
        phase: String(r.phase),
        group: r.group_name === null ? null : String(r.group_name),
        server_at: String(r.server_at),
        missing_total: Number(r.missing_total),
        lines,
      };
    });
  }

  // ---- counted supplies: definitions

  createItem(raw: unknown, actor: Actor): SupplyView {
    const body = obj(raw);
    const name = line(body.name, '物品名', 60);
    const unit = line(body.unit, '単位', 10);
    const kind = oneOf(body.kind, SUPPLY_KINDS, '物品の種類');
    const low = body.low_threshold === undefined ? 0 : integer(body.low_threshold, '在庫のしきい値', 0, MAX_QTY);
    const memo = note(body.note, 'メモ', 200);
    const initial = body.initial_on_hand === undefined ? 0 : integer(body.initial_on_hand, '登録時の在庫数', 0, MAX_QTY);
    return this.rental.transaction(() => {
      if (this.rental.get('SELECT id FROM supply_items WHERE name=? AND archived_at IS NULL', name)) {
        throw new RentalError(409, '同じ名前の物品が登録されています。名前を変えるか、既存の物品を使ってください。', 'duplicate_name');
      }
      const id = `S-${randomUUID().replaceAll('-', '')}`;
      const now = utcNow();
      this.rental.run('INSERT INTO supply_items(id,name,unit,kind,low_threshold,note,version,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,0,?,?,?)', id, name, unit, kind, low, memo, now, now, actor.name);
      if (initial > 0) this.commit([this.move(id, 'stock', { dOnHand: initial, qty: initial, note: '登録時の在庫', expected: 0 })], actor);
      return this.itemView(id);
    });
  }

  /** Name, unit, threshold, note, and archiving (only when nothing is left in stock or lent out). The kind is fixed. */
  updateItem(id: unknown, raw: unknown, actor: Actor): SupplyView {
    const itemId = supplyId(id);
    const body = obj(raw);
    const expected = integer(body.expected_version, '表示中の版', 0, Number.MAX_SAFE_INTEGER);
    if (body.kind !== undefined) {
      const kind = oneOf(body.kind, SUPPLY_KINDS, '物品の種類');
      const current = this.rental.get('SELECT kind FROM supply_items WHERE id=?', itemId);
      if (current && String(current.kind) !== kind) throw new RentalError(400, '物品の種類は登録後に変えられません。', 'invalid_kind');
    }
    return this.rental.transaction(() => {
      const row = this.activeItem(itemId);
      this.checkVersion(row, expected);
      const name = body.name === undefined ? String(row.name) : line(body.name, '物品名', 60);
      const unit = body.unit === undefined ? String(row.unit) : line(body.unit, '単位', 10);
      const low = body.low_threshold === undefined ? Number(row.low_threshold) : integer(body.low_threshold, '在庫のしきい値', 0, MAX_QTY);
      const memo = body.note === undefined ? String(row.note) : note(body.note, 'メモ', 200);
      if (name !== row.name && this.rental.get('SELECT id FROM supply_items WHERE name=? AND archived_at IS NULL AND id<>?', name, itemId)) {
        throw new RentalError(409, '同じ名前の物品が登録されています。', 'duplicate_name');
      }
      const archive = body.archived === undefined ? false : body.archived === true;
      if (body.archived !== undefined && typeof body.archived !== 'boolean') throw new RentalError(400, 'archived は true か false で指定してください。');
      if (archive && (this.onHand(itemId) !== 0 || this.lentTotal(itemId) !== 0)) {
        throw new RentalError(409, '在庫または貸出中の数が残っているため、しまえません。数を 0 にしてから操作してください。', 'not_empty');
      }
      const now = utcNow();
      this.rental.run(
        'UPDATE supply_items SET name=?,unit=?,low_threshold=?,note=?,version=version+1,updated_at=?,updated_by=?,archived_at=? WHERE id=?',
        name, unit, low, memo, now, actor.name, archive ? now : null, itemId,
      );
      return this.itemView(itemId);
    });
  }

  // ---- counted supplies: movements

  /** 在庫の補正（補充・棚卸し）。Negative deltas need a note. */
  adjustStock(id: unknown, raw: unknown, actor: Actor): SupplyView {
    const itemId = supplyId(id);
    const body = obj(raw);
    const delta = integer(body.delta, '増減数', -MAX_QTY, MAX_QTY);
    if (delta === 0) throw new RentalError(400, '増減数は 0 以外で入力してください。');
    const memo = note(body.note, 'メモ', 200);
    if (delta < 0 && !memo) throw new RentalError(400, '在庫を減らすときは理由をメモに書いてください。', 'note_required');
    const expected = integer(body.expected_version, '表示中の版', 0, Number.MAX_SAFE_INTEGER);
    return this.write(() => {
      this.commit([this.move(itemId, 'stock', { dOnHand: delta, qty: Math.abs(delta), note: memo || '在庫の補正', expected })], actor);
      return this.itemView(itemId);
    });
  }

  /**
   * 団体に貸す: one group, several items at once. Either every line is written or none is. The request id
   * (`id`, a UUID the screen makes) is kept with the answer, so a retry with the same id gets the same answer.
   * An item with attachments carries their count in the same operation (借用時の点検).
   */
  lend(raw: unknown, actor: Actor): { group: string; lines: object[]; checks: object[] } {
    const body = obj(raw);
    const requestId = uuid(body.id);
    const group = this.registeredGroup(borrowerName(body.group));
    const lines = arrayOf(body.lines, '貸す物品', 1, MAX_LINES).map((v) => {
      const l = obj(v);
      return {
        item: supplyId(l.item_id),
        qty: integer(l.qty, '貸す数', 1, MAX_QTY),
        expected: integer(l.expected_version, '表示中の版', 0, Number.MAX_SAFE_INTEGER),
        attachments: attachmentInputs(l.attachments),
      };
    });
    this.noDuplicates(lines.map((l) => l.item));
    const fingerprint = fingerprintOf(['lend', group, lines]);
    return this.write(() => {
      const replayed = this.replay<{ group: string; lines: object[]; checks: object[] }>(requestId, 'lend', fingerprint, actor);
      if (replayed) return replayed;
      const moves = lines.map((l) => this.move(l.item, 'lend', { group, dOnHand: -l.qty, dLent: l.qty, qty: l.qty, expected: l.expected }));
      this.commit(moves, actor);
      const checks = lines.flatMap((l) => this.lineCheck(l.item, 'borrow', group, l.qty, l.attachments, actor));
      const result = { group, lines: lines.map((l) => this.itemView(l.item)), checks };
      this.remember(requestId, 'lend', fingerprint, actor, result);
      return result;
    });
  }

  /**
   * 団体から返してもらう: returned (in stock again) and lost or broken, per item. Like the lend, the request id
   * keeps the answer, and the attachments of the returned units are checked in the same operation (返却時の点検).
   */
  giveBack(raw: unknown, actor: Actor): { group: string; lines: object[]; checks: object[] } {
    const body = obj(raw);
    const requestId = uuid(body.id);
    const group = this.registeredGroup(borrowerName(body.group));
    const lines = arrayOf(body.lines, '返す物品', 1, MAX_LINES).map((v) => {
      const l = obj(v);
      const ok = integer(l.qty, '返した数', 0, MAX_QTY);
      const lost = integer(l.lost ?? 0, '紛失・破損の数', 0, MAX_QTY);
      if (ok + lost < 1) throw new RentalError(400, '返した数か紛失・破損の数を 1 以上にしてください。');
      return {
        item: supplyId(l.item_id),
        ok,
        lost,
        memo: note(l.note, 'メモ', 200),
        expected: integer(l.expected_version, '表示中の版', 0, Number.MAX_SAFE_INTEGER),
        attachments: attachmentInputs(l.attachments),
      };
    });
    this.noDuplicates(lines.map((l) => l.item));
    const fingerprint = fingerprintOf(['return', group, lines]);
    return this.write(() => {
      const replayed = this.replay<{ group: string; lines: object[]; checks: object[] }>(requestId, 'return', fingerprint, actor);
      if (replayed) return replayed;
      const moves = lines.map((l) => this.move(l.item, 'return', { group, dOnHand: l.ok, dLent: -(l.ok + l.lost), qty: l.ok, lost: l.lost, note: l.memo, expected: l.expected }));
      this.commit(moves, actor);
      const checks = lines.flatMap((l) => this.lineCheck(l.item, 'return', group, l.ok + l.lost, l.attachments, actor));
      const result = { group, lines: lines.map((l) => this.itemView(l.item)), checks };
      this.remember(requestId, 'return', fingerprint, actor, result);
      return result;
    });
  }

  /** 使った（消耗品）。The group is optional: it only records who the thing was used for. */
  consume(raw: unknown, actor: Actor): SupplyView {
    const body = obj(raw);
    const requestId = uuid(body.id);
    const itemId = supplyId(body.item_id);
    const qty = integer(body.qty, '使った数', 1, MAX_QTY);
    const group = body.group === undefined || body.group === null || body.group === '' ? null : this.registeredGroup(borrowerName(body.group));
    const memo = note(body.note, 'メモ', 200);
    const expected = integer(body.expected_version, '表示中の版', 0, Number.MAX_SAFE_INTEGER);
    const fingerprint = fingerprintOf(['consume', itemId, qty, group, memo, expected]);
    return this.write(() => {
      const replayed = this.replay<SupplyView>(requestId, 'consume', fingerprint, actor);
      if (replayed) return replayed;
      this.commit([this.move(itemId, 'consume', { group, dOnHand: -qty, dConsumed: qty, qty, note: memo, expected })], actor);
      const result = this.itemView(itemId);
      this.remember(requestId, 'consume', fingerprint, actor, result);
      return result;
    });
  }

  /** 取り消し: writes a movement that undoes the given one. The original stays in the history. */
  reverse(id: unknown, raw: unknown, actor: Actor, permissions: readonly RentalPermission[]): SupplyView {
    const movementId = integer(Number(id), '記録の番号', 1, Number.MAX_SAFE_INTEGER);
    const body = obj(raw);
    const reason = line(body.reason, '取り消す理由', 200);
    const expected = integer(body.expected_version, '表示中の版', 0, Number.MAX_SAFE_INTEGER);
    return this.write(() => {
      const original = this.rental.get('SELECT * FROM supply_movements WHERE id=?', movementId);
      if (!original) throw new RentalError(404, 'この記録は見つかりません。', 'not_found');
      if (String(original.kind) === 'reverse') throw new RentalError(400, '取り消しの記録は取り消せません。');
      if (this.rental.get('SELECT id FROM supply_movements WHERE reverses=?', movementId)) throw new RentalError(409, 'この記録は取り消し済みです。', 'already_reversed');
      const needed: RentalPermission = String(original.kind) === 'stock' ? 'rental.issue' : 'rental.loan';
      if (!permissions.includes(needed)) throw new RentalError(403, needed === 'rental.issue' ? '在庫の補正を取り消す権限がありません。' : '貸出・返却の記録を取り消す権限がありません。', 'forbidden');
      this.commit([{
        item: String(original.item_id),
        kind: 'reverse',
        group: original.group_name === null ? null : String(original.group_name),
        qty: Number(original.qty),
        lost: Number(original.lost),
        dOnHand: -Number(original.d_on_hand),
        dLent: -Number(original.d_lent),
        dConsumed: -Number(original.d_consumed),
        reverses: movementId,
        note: reason,
        expected,
      }], actor);
      return this.itemView(String(original.item_id));
    });
  }

  // ---- attachments

  createAttachment(raw: unknown, actor: Actor): AttachmentView {
    const body = obj(raw);
    const kind = oneOf(body.owner_kind, OWNER_KINDS, '対象の種類');
    const key = ownerKey(kind, body.owner_key);
    const name = line(body.name, '付属品の名前', 40);
    const expected = body.expected === undefined ? 1 : integer(body.expected, '付属品の数（1 個あたり）', 1, 99);
    const memo = note(body.note, 'メモ', 200);
    return this.write(() => {
      this.ownerExists(kind, key);
      const count = Number(this.rental.get('SELECT COUNT(*) AS n FROM supply_attachments WHERE owner_kind=? AND owner_key=? AND archived_at IS NULL', kind, key)!.n);
      if (count >= MAX_ATTACHMENTS_PER_OWNER) throw new RentalError(409, `1 つの物品に付けられる付属品は ${MAX_ATTACHMENTS_PER_OWNER} 件までです。`);
      if (this.rental.get('SELECT id FROM supply_attachments WHERE owner_kind=? AND owner_key=? AND name=? AND archived_at IS NULL', kind, key, name)) {
        throw new RentalError(409, '同じ名前の付属品が登録されています。', 'duplicate_name');
      }
      const id = `A-${randomUUID().replaceAll('-', '')}`;
      const now = utcNow();
      this.rental.run('INSERT INTO supply_attachments(id,owner_kind,owner_key,name,expected,note,version,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,0,?,?,?)', id, kind, key, name, expected, memo, now, now, actor.name);
      return this.attachmentView(id);
    });
  }

  updateAttachment(id: unknown, raw: unknown, actor: Actor): AttachmentView {
    const attId = attachmentId(id);
    const body = obj(raw);
    const expected = integer(body.expected_version, '表示中の版', 0, Number.MAX_SAFE_INTEGER);
    return this.write(() => {
      const row = this.rental.get('SELECT * FROM supply_attachments WHERE id=?', attId);
      if (!row) throw new RentalError(404, 'この付属品は見つかりません。', 'not_found');
      if (Number(row.version) !== expected) throw new RentalError(409, '付属品が別の人により更新されています。読み直してから操作してください。', 'version_conflict');
      const name = body.name === undefined ? String(row.name) : line(body.name, '付属品の名前', 40);
      const count = body.expected === undefined ? Number(row.expected) : integer(body.expected, '付属品の数（1 個あたり）', 1, 99);
      const memo = body.note === undefined ? String(row.note) : note(body.note, 'メモ', 200);
      if (body.archived !== undefined && typeof body.archived !== 'boolean') throw new RentalError(400, 'archived は true か false で指定してください。');
      const archived = body.archived === true ? utcNow() : body.archived === false ? null : (row.archived_at as string | null);
      if (name !== row.name && this.rental.get('SELECT id FROM supply_attachments WHERE owner_kind=? AND owner_key=? AND name=? AND archived_at IS NULL AND id<>?', String(row.owner_kind), String(row.owner_key), name, attId)) {
        throw new RentalError(409, '同じ名前の付属品が登録されています。', 'duplicate_name');
      }
      this.rental.run('UPDATE supply_attachments SET name=?,expected=?,note=?,archived_at=?,version=version+1,updated_at=?,updated_by=? WHERE id=?', name, count, memo, archived, utcNow(), actor.name, attId);
      return this.attachmentView(attId);
    });
  }

  /**
   * Records one standalone check (随時) of a card or a counted item, with every active attachment of it once.
   * `found` is the number present, and the missing count is computed here. The same id sent twice is answered
   * with the stored check. A counted item's lend and return checks are not sent here: they are recorded inside
   * the lend and the return themselves, in the same operation.
   */
  recordCheck(raw: unknown, actor: Actor) {
    const body = obj(raw);
    const id = uuid(body.id);
    const kind = oneOf(body.owner_kind, OWNER_KINDS, '対象の種類');
    const key = ownerKey(kind, body.owner_key);
    const phase = oneOf(body.phase, CHECK_PHASES, '点検の種類');
    if (kind === 'supply' && phase !== 'check') {
      throw new RentalError(400, '数の物品の貸出時・返却時の点検は、団体への貸出・返却と一緒に記録してください。', 'invalid_request');
    }
    const group = body.group === undefined || body.group === null || body.group === '' ? null : this.registeredGroup(borrowerName(body.group));
    const units = body.units === undefined ? 1 : integer(body.units, '数', 1, MAX_QTY);
    if (kind === 'card' && units !== 1) throw new RentalError(400, '個体の点検は 1 件ごとに記録してください。', 'invalid_request');
    const given = arrayOf(body.lines, '点検の行', 0, MAX_LINES).map((v) => {
      const l = obj(v);
      return { attachment: attachmentId(l.attachment_id), found: integer(l.found, '在った数', 0, MAX_QTY), memo: note(l.note, 'メモ', 200) };
    });
    return this.write(() => {
      const existing = this.rental.get('SELECT * FROM supply_attachment_checks WHERE id=?', id);
      if (existing) {
        if (String(existing.owner_kind) !== kind || String(existing.owner_key) !== key) throw new RentalError(409, 'この点検の番号は別の物品に使われています。', 'conflict');
        return { check: this.checkView(existing), replay: true };
      }
      this.ownerExists(kind, key);
      if (kind === 'supply') {
        // The units checked cannot be more than the units that exist (in stock plus lent out).
        const total = this.onHand(key) + this.lentTotal(key);
        if (units > total) throw new RentalError(400, `数は、在庫と貸出中を合わせた ${total} 以下で入力してください。`, 'invalid_request');
      }
      const check = this.insertCheck({ id, kind, key, phase, group, units, given, actor });
      return { check, replay: false };
    });
  }

  // ---- internals

  private write<T>(fn: () => T): T {
    return this.rental.transaction(fn);
  }

  /** The answer kept for a request id: the same id and the same content get it again; another content is refused. */
  private replay<T>(id: string, kind: RequestKind, fingerprint: string, actor: Actor): T | null {
    const row = this.rental.get('SELECT kind,actor_id,fingerprint,result_json FROM supply_requests WHERE id=?', id);
    if (!row) return null;
    if (String(row.kind) !== kind || String(row.fingerprint) !== fingerprint || String(row.actor_id) !== actor.id) {
      throw new RentalError(409, 'この操作の番号は別の内容で使われています。画面を読み直してからもう一度操作してください。', 'request_conflict');
    }
    return JSON.parse(String(row.result_json)) as T;
  }

  private remember(id: string, kind: RequestKind, fingerprint: string, actor: Actor, result: object): void {
    this.rental.run(
      'INSERT INTO supply_requests(id,kind,actor_id,fingerprint,result_json,server_at) VALUES(?,?,?,?,?,?)',
      id, kind, actor.id, fingerprint, JSON.stringify(result), utcNow(),
    );
  }

  private move(item: string, kind: MoveKind, p: Partial<Move> & { expected: number }): Move {
    return {
      item,
      kind,
      group: p.group ?? null,
      qty: p.qty ?? 0,
      lost: p.lost ?? 0,
      dOnHand: p.dOnHand ?? 0,
      dLent: p.dLent ?? 0,
      dConsumed: p.dConsumed ?? 0,
      reverses: p.reverses ?? null,
      note: p.note ?? '',
      expected: p.expected,
    };
  }

  /** Applies moves inside the caller's transaction. Each one is checked against the stock and lent count as they are then. */
  private commit(moves: Move[], actor: Actor): void {
    const batch = randomUUID();
    const now = utcNow();
    for (const m of moves) {
      const row = this.activeItem(m.item);
      if (Number(row.version) !== m.expected) throw new RentalError(409, '物品の数が別の人により更新されています。最新の数を読み直してから操作してください。', 'version_conflict');
      if ((m.kind === 'lend' || m.kind === 'return') && row.kind !== 'lend') {
        throw new RentalError(400, 'この物品は消耗品です。貸し出す物品ではありません。', 'invalid_kind');
      }
      if (m.kind === 'consume' && row.kind !== 'consumable') {
        throw new RentalError(400, 'この物品は消耗品ではありません。貸出・返却で記録してください。', 'invalid_kind');
      }
      const onHand = this.onHand(m.item);
      if (onHand + m.dOnHand < 0) throw new RentalError(409, `「${String(row.name)}」の在庫が足りません（いまの在庫 ${onHand}）。`, 'stock_short');
      if (m.group !== null && m.dLent < 0) {
        const lent = this.lentTo(m.item, m.group);
        if (lent + m.dLent < 0) throw new RentalError(409, `「${String(row.name)}」は ${m.group} への貸出数（${lent}）より多くは返せません。`, 'lent_short');
      }
      this.rental.run(
        'INSERT INTO supply_movements(item_id,kind,group_name,qty,lost,d_on_hand,d_lent,d_consumed,reverses,note,batch_id,actor_id,actor_name,server_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        m.item, m.kind, m.group, m.qty, m.lost, m.dOnHand, m.dLent, m.dConsumed, m.reverses, m.note, batch, actor.id, actor.name, now,
      );
      this.rental.run('UPDATE supply_items SET version=version+1, updated_at=? WHERE id=?', now, m.item);
    }
  }

  /**
   * The check that goes with one line of a lend or a return. An item with active attachments must be sent with
   * all of them counted; an item without any must not be sent any. Runs inside the lend or return transaction.
   */
  private lineCheck(item: string, phase: 'borrow' | 'return', group: string, units: number, given: AttachmentInput[] | null, actor: Actor): object[] {
    const active = this.rental.all("SELECT id FROM supply_attachments WHERE owner_kind='supply' AND owner_key=? AND archived_at IS NULL", item);
    if (active.length === 0) {
      if (given && given.length > 0) throw new RentalError(400, 'この物品には付属品が登録されていません。点検の入力を外してください。', 'attachments_changed');
      return [];
    }
    if (!given || given.length === 0) {
      const name = String(this.activeItem(item).name);
      throw new RentalError(400, `「${name}」の付属品を点検してから記録してください。`, 'attachments_required');
    }
    return [this.insertCheck({ id: randomUUID(), kind: 'supply', key: item, phase, group, units, given, actor })];
  }

  /**
   * Writes one check. Each active attachment of the owner must appear exactly once in `given`; the expected count is
   * the per-unit count times the units checked. Runs inside the caller's transaction.
   */
  private insertCheck(p: { id: string; kind: OwnerKind; key: string; phase: string; group: string | null; units: number; given: { attachment: string; found: number; memo: string }[]; actor: Actor }) {
    const attachments = this.rental.all('SELECT * FROM supply_attachments WHERE owner_kind=? AND owner_key=? AND archived_at IS NULL ORDER BY created_at, id', p.kind, p.key);
    if (attachments.length === 0) throw new RentalError(400, 'この物品には付属品が登録されていません。');
    const byId = new Map(p.given.map((g) => [g.attachment, g]));
    if (byId.size !== p.given.length) throw new RentalError(400, '同じ付属品を重複して点検できません。');
    if (p.given.length !== attachments.length) throw new RentalError(400, '付属品が変わりました。画面を読み直してから点検してください。', 'attachments_changed');
    const lines = attachments.map((a) => {
      const g = byId.get(String(a.id));
      if (!g) throw new RentalError(400, '付属品が変わりました。画面を読み直してから点検してください。', 'attachments_changed');
      const expectedTotal = Number(a.expected) * p.units;
      if (g.found > expectedTotal) throw new RentalError(400, `付属品「${String(a.name)}」は最大 ${expectedTotal} 個までです。`);
      return { attachment_id: String(a.id), name: String(a.name), expected: expectedTotal, found: g.found, missing: expectedTotal - g.found, note: g.memo };
    });
    const missing = lines.reduce((sum, l) => sum + l.missing, 0);
    const now = utcNow();
    this.rental.run(
      'INSERT INTO supply_attachment_checks(id,owner_kind,owner_key,phase,group_name,units,missing_total,lines_json,actor_id,actor_name,server_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      p.id, p.kind, p.key, p.phase, p.group, p.units, missing, JSON.stringify(lines), p.actor.id, p.actor.name, now,
    );
    return this.checkView(this.rental.get('SELECT * FROM supply_attachment_checks WHERE id=?', p.id)!);
  }

  private activeItem(id: string): Row {
    const row = this.rental.get('SELECT * FROM supply_items WHERE id=?', id);
    if (!row || row.archived_at !== null) throw new RentalError(404, 'この物品は登録されていません。', 'not_found');
    return row;
  }

  private checkVersion(row: Row, expected: number): void {
    if (Number(row.version) !== expected) throw new RentalError(409, '物品の情報が別の人により更新されています。読み直してから操作してください。', 'version_conflict');
  }

  private noDuplicates(ids: string[]): void {
    if (new Set(ids).size !== ids.length) throw new RentalError(400, '同じ物品を 1 回の操作に重複して入れられません。');
  }

  private onHand(id: string): number {
    return Number(this.rental.get('SELECT COALESCE(SUM(d_on_hand),0) AS n FROM supply_movements WHERE item_id=?', id)!.n);
  }

  private lentTo(id: string, group: string): number {
    return Number(this.rental.get('SELECT COALESCE(SUM(d_lent),0) AS n FROM supply_movements WHERE item_id=? AND group_name=?', id, group)!.n);
  }

  private lentTotal(id: string): number {
    return Number(this.rental.get('SELECT COALESCE(SUM(d_lent),0) AS n FROM supply_movements WHERE item_id=?', id)!.n);
  }

  private registeredGroup(name: string): string {
    if (!this.rental.get('SELECT name FROM borrowers WHERE name=?', name)) throw new RentalError(400, '登録済みの貸出先から選んでください。', 'invalid_request');
    return name;
  }

  private ownerExists(kind: OwnerKind, key: string): void {
    if (kind === 'card') {
      if (!this.rental.get('SELECT code FROM items WHERE code=? AND archived_at IS NULL', key)) throw new RentalError(404, 'この個体は登録されていません。', 'not_found');
    } else {
      this.activeItem(key);
    }
  }

  private ownerName(kind: OwnerKind, key: string): string {
    if (kind === 'supply') return String(this.rental.get('SELECT name FROM supply_items WHERE id=?', key)?.name ?? '');
    const row = this.rental.get('SELECT name FROM items WHERE code=?', key);
    return String(row?.name ?? key);
  }

  private view(row: Row, lentByGroup: { group: string; lent: number }[], attachments: SupplyAttachmentRef[]): SupplyView {
    const onHand = Number(row.on_hand);
    const threshold = Number(row.low_threshold);
    return {
      id: String(row.id),
      name: String(row.name),
      unit: String(row.unit),
      kind: row.kind as SupplyKind,
      low_threshold: threshold,
      note: String(row.note),
      version: Number(row.version),
      on_hand: onHand,
      lent: Number(row.lent),
      consumed: Number(row.consumed),
      low: onHand <= threshold,
      out_of_stock: onHand === 0,
      lent_by_group: lentByGroup,
      attachments,
    };
  }

  private itemView(id: string): SupplyView {
    const row = this.rental.get(
      `SELECT i.*, COALESCE(SUM(m.d_on_hand),0) AS on_hand, COALESCE(SUM(m.d_lent),0) AS lent, COALESCE(SUM(m.d_consumed),0) AS consumed
       FROM supply_items i LEFT JOIN supply_movements m ON m.item_id=i.id WHERE i.id=? GROUP BY i.id`,
      id,
    );
    if (!row) throw new RentalError(404, 'この物品は登録されていません。', 'not_found');
    const groups = this.rental.all('SELECT group_name, SUM(d_lent) AS lent FROM supply_movements WHERE item_id=? AND group_name IS NOT NULL GROUP BY group_name HAVING SUM(d_lent)<>0 ORDER BY group_name', id)
      .map((r) => ({ group: String(r.group_name), lent: Number(r.lent) }));
    const attachments = this.rental.all("SELECT id,owner_key,name,expected,version FROM supply_attachments WHERE owner_kind='supply' AND owner_key=? AND archived_at IS NULL ORDER BY created_at, id", id)
      .map((r) => this.attachmentRef(r));
    return this.view(row, groups, attachments);
  }

  private attachmentRef(r: Row): SupplyAttachmentRef {
    return { id: String(r.id), name: String(r.name), expected_per_unit: Number(r.expected), version: Number(r.version) };
  }

  private attachmentView(id: string): AttachmentView {
    const r = this.rental.get('SELECT * FROM supply_attachments WHERE id=?', id);
    if (!r) throw new RentalError(404, 'この付属品は見つかりません。', 'not_found');
    return {
      id: String(r.id),
      owner_kind: r.owner_kind as OwnerKind,
      owner_key: String(r.owner_key),
      name: String(r.name),
      expected: Number(r.expected),
      note: String(r.note),
      version: Number(r.version),
    };
  }

  /**
   * Attachments of an owner, each with the missing count of its latest check (null: not checked for this loan).
   * With a loan filter, only this group's checks (and the unassigned ones) since the loan began count; the latest
   * check of any other group is shown as `previous_check`, not as a shortage of this loan.
   */
  private attachmentsWithStatus(kind: OwnerKind, key: string, units: number, filter?: LoanFilter) {
    const relevant = this.latestCheck(kind, key, filter);
    const prior = filter && !relevant ? this.latestCheck(kind, key) : null;
    const found = new Map<string, { missing: number; note: string }>();
    for (const l of relevant?.lines ?? []) found.set(l.attachment_id, { missing: l.missing, note: l.note });
    const previous = prior ? { group: prior.group, server_at: prior.server_at } : null;
    return this.rental.all('SELECT * FROM supply_attachments WHERE owner_kind=? AND owner_key=? AND archived_at IS NULL ORDER BY created_at, id', kind, key).map((a) => {
      const status = found.get(String(a.id));
      return {
        id: String(a.id),
        name: String(a.name),
        expected: Number(a.expected) * units,
        expected_per_unit: Number(a.expected),
        note: String(a.note),
        version: Number(a.version),
        missing: status ? status.missing : null,
        check_note: status?.note ?? '',
        checked_at: relevant?.server_at ?? null,
        previous_check: status ? null : previous,
      };
    });
  }

  private latestCheck(kind: OwnerKind, key: string, filter?: LoanFilter): { server_at: string; group: string | null; lines: { attachment_id: string; name: string; missing: number; note: string }[] } | null {
    const row = filter
      ? this.rental.get(
        'SELECT server_at, group_name, lines_json FROM supply_attachment_checks WHERE owner_kind=? AND owner_key=? AND (group_name IS NULL OR group_name=?) AND (? IS NULL OR server_at>=?) ORDER BY rowid DESC LIMIT 1',
        kind, key, filter.group, filter.since, filter.since,
      )
      : this.rental.get('SELECT server_at, group_name, lines_json FROM supply_attachment_checks WHERE owner_kind=? AND owner_key=? ORDER BY rowid DESC LIMIT 1', kind, key);
    if (!row) return null;
    return {
      server_at: String(row.server_at),
      group: row.group_name === null ? null : String(row.group_name),
      lines: JSON.parse(String(row.lines_json)) as { attachment_id: string; name: string; missing: number; note: string }[],
    };
  }

  private checkHistory(kind: OwnerKind, key: string) {
    return this.rental.all('SELECT * FROM supply_attachment_checks WHERE owner_kind=? AND owner_key=? ORDER BY rowid DESC LIMIT 10', kind, key).map((r) => this.checkView(r));
  }

  private checkView(row: Row) {
    return {
      id: String(row.id),
      owner_kind: String(row.owner_kind),
      owner_key: String(row.owner_key),
      phase: String(row.phase),
      group: row.group_name === null ? null : String(row.group_name),
      units: Number(row.units),
      missing_total: Number(row.missing_total),
      lines: JSON.parse(String(row.lines_json)) as unknown[],
      actor_name: String(row.actor_name),
      server_at: String(row.server_at),
    };
  }
}
