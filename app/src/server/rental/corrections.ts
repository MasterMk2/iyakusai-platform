import { createHash } from 'node:crypto';
import { NOT_VOIDED, type Actor, type CorrectionState, type RentalStore } from './store.js';
import { borrowerName, canonical, itemCode, operationUuid, RentalError, textField, utcNow } from './validate.js';

// Corrections of registrations made by mistake (requested 2026-10-18): undo an item's latest
// registration, fix the group of its latest loan, or release an item left "要確認" by a return.
// The operation rows, their spooled operation.json and the copies on Drive are never rewritten. A
// correction is a new row in operation_corrections (created by store.ts), and the item's current state
// moves forward with version+1, so a phone still holding the older item_version gets the usual 409.

type Row = Record<string, unknown>;
type Kind = 'void' | 'borrower' | 'release';

const KINDS: readonly unknown[] = ['void', 'borrower', 'release'];
const ACTIVE = ['loaned', 'borrowed'];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const parse = (text: unknown): Row | null => (text ? (JSON.parse(String(text)) as Row) : null);

function line(body: Record<string, unknown>, key: string, max: number): string {
  const value = textField(body, key, max);
  if ([...value].some((ch) => ch.codePointAt(0)! < 32 || ch.codePointAt(0) === 127)) throw new RentalError(400, '理由は改行なしで入力してください。');
  return value;
}

function itemState(row: Row) {
  return {
    status: String(row.status),
    current_loan: row.current_loan == null ? null : String(row.current_loan),
    planned_state: String(row.planned_state),
    planned_consumed_operation: row.planned_consumed_operation == null ? null : String(row.planned_consumed_operation),
    version: Number(row.version),
  };
}

interface Plan {
  row: Row;
  generation: number;
  fix: CorrectionState;
  current: Row | null;
  active: boolean;
  latest: Row | undefined;
  latestBorrow: Row | undefined;
  voidBlocked: string | null;
  voidEffect: 'ready' | 'loaned' | 'unchanged' | null;
  restoreLoan: Row | null;
  borrowerBlocked: string | null;
}

export class OperationCorrections {
  constructor(private readonly store: RentalStore) {}

  /** The current row and what each kind of correction would act on now. Read-only. */
  private plan(code: string): Plan {
    const store = this.store;
    store.item(code); // 404 for unknown, 410 for archived items
    const row = store.get('SELECT * FROM items WHERE code=?', code)!;
    const generation = store.ledgerGeneration();
    const fix = store.correctionState();
    const current = parse(row.current_loan);
    const active = ACTIVE.includes(String(row.status));
    const latest = store.get(`SELECT * FROM operations WHERE item_code=? AND ledger_generation=? AND ${NOT_VOIDED} ORDER BY server_at DESC,rowid DESC LIMIT 1`, code, generation);
    const latestBorrow = store.get(`SELECT * FROM operations WHERE item_code=? AND ledger_generation=? AND action='borrow' AND ${NOT_VOIDED} ORDER BY server_at DESC,rowid DESC LIMIT 1`, code, generation);
    let voidBlocked: string | null = null;
    let voidEffect: Plan['voidEffect'] = null;
    let restoreLoan: Row | null = null;
    if (!latest) voidBlocked = '取り消せる登録はありません。';
    else if (store.get("SELECT 1 FROM operation_corrections WHERE item_code=? AND ledger_generation=? AND kind='release' AND server_at>=?", code, generation, String(latest.server_at))) {
      voidBlocked = '要確認を解除した後なので、この登録は取り消せません。';
    } else if (latest.action === 'borrow') {
      if (active && current?.operation_id === latest.id) voidEffect = 'ready';
      else voidBlocked = '物品の現在の貸出と、この貸出の記録が一致しないため取り消せません。';
    } else if (latest.action === 'return') {
      const archive = parse(latest.metadata);
      const previous = archive?.previous_loan && typeof archive.previous_loan === 'object' ? (archive.previous_loan as Row) : null;
      if (!active && row.current_loan == null && previous) {
        voidEffect = 'loaned';
        const fixed = previous.operation_id ? fix.borrowers.get(String(previous.operation_id)) : undefined;
        restoreLoan = fixed ? { ...previous, borrower: fixed.borrower, borrower_id: fixed.borrower_id } : previous;
      } else voidBlocked = '返却前の貸出の記録を確認できないため取り消せません。';
    } else voidEffect = 'unchanged';
    let borrowerBlocked: string | null = null;
    if (!latestBorrow) borrowerBlocked = '訂正できる貸出の記録はありません。';
    else if (active && current?.operation_id !== latestBorrow.id) borrowerBlocked = '物品の現在の貸出と、最新の貸出の記録が一致しないため訂正できません。';
    return { row, generation, fix, current, active, latest, latestBorrow, voidBlocked, voidEffect, restoreLoan, borrowerBlocked };
  }

  /** One registration as the correction screen shows it, with the group after any correction. */
  private describe(op: Row, fix: CorrectionState) {
    const a = parse(op.metadata) ?? {};
    const previous = a.previous_loan && typeof a.previous_loan === 'object' ? (a.previous_loan as Row) : null;
    const loanId = op.action === 'borrow' ? String(op.id) : previous?.operation_id ? String(previous.operation_id) : null;
    const fixed = loanId ? fix.borrowers.get(loanId) : undefined;
    const original = op.action === 'borrow' ? a.borrower : previous?.borrower;
    const voided = fix.voided.get(String(op.id));
    const actorName = (a.actor as { name?: unknown } | undefined)?.name;
    return {
      operation_id: String(op.id),
      action: String(op.action),
      server_at: String(op.server_at),
      borrower: String(fixed?.borrower ?? original ?? ''),
      original_borrower: fixed ? String(original ?? '') : null,
      condition: typeof a.condition === 'string' ? a.condition : null,
      note: typeof a.note === 'string' ? a.note : '',
      actor_name: typeof actorName === 'string' ? actorName : '',
      photos: Array.isArray(a.photos) ? a.photos.length : 0,
      photo_skip: a.photo_skip === true,
      ...(a.irregular ? { irregular: a.irregular } : {}),
      voided: voided ? { server_at: voided.server_at, actor_name: voided.actor_name, reason: voided.reason } : null,
    };
  }

  snapshot(code: string) {
    itemCode(code);
    const store = this.store;
    const p = this.plan(code);
    const describe = (op: Row) => this.describe(op, p.fix);
    const operations = store.all('SELECT id,action,metadata,server_at FROM operations WHERE item_code=? AND ledger_generation=? ORDER BY server_at DESC,rowid DESC LIMIT 20', code, p.generation).map(describe);
    const corrections = store
      .all('SELECT kind,operation_id,actor_name,server_at,reason,before_json,after_json FROM operation_corrections WHERE item_code=? AND ledger_generation=? ORDER BY server_at DESC,rowid DESC LIMIT 20', code, p.generation)
      .map((r) => {
        const before = parse(r.before_json) as { item?: { status?: string }; borrower?: { name?: string } } | null;
        const after = parse(r.after_json) as { item?: { status?: string }; borrower?: { name?: string }; action?: string } | null;
        return {
          kind: String(r.kind),
          operation_id: r.operation_id == null ? null : String(r.operation_id),
          actor_name: String(r.actor_name),
          server_at: String(r.server_at),
          reason: String(r.reason),
          before_status: before?.item?.status ?? null,
          after_status: after?.item?.status ?? null,
          ...(r.kind === 'borrower' ? { from: before?.borrower?.name ?? '', to: after?.borrower?.name ?? '' } : {}),
          ...(r.kind === 'void' ? { action: after?.action ?? null } : {}),
        };
      });
    const lastReturn = p.row.status === 'review' ? store.get(`SELECT * FROM operations WHERE item_code=? AND ledger_generation=? AND action='return' AND ${NOT_VOIDED} ORDER BY server_at DESC,rowid DESC LIMIT 1`, code, p.generation) : undefined;
    return {
      item: store.item(code),
      ledger_generation: p.generation,
      operations,
      corrections,
      allowed: {
        void: p.latest && !p.voidBlocked ? { ...describe(p.latest), effect: p.voidEffect, restore_borrower: p.restoreLoan ? String(p.restoreLoan.borrower ?? '') : null } : null,
        void_blocked: p.voidBlocked,
        borrower: p.latestBorrow && !p.borrowerBlocked ? { ...describe(p.latestBorrow), active: p.active } : null,
        borrower_blocked: p.borrowerBlocked,
        release: p.row.status === 'review' ? { last_return: lastReturn ? describe(lastReturn) : null } : null,
      },
    };
  }

  apply(code: string, body: Record<string, unknown>, actor: Actor) {
    itemCode(code);
    const allowed = new Set(['correction_id', 'kind', 'target_operation_id', 'borrower', 'reason', 'expected_version', 'ledger_generation']);
    if (Object.keys(body).some((key) => !allowed.has(key))) throw new RentalError(400, '訂正できない項目が含まれています。');
    const id = operationUuid(body.correction_id);
    if (!KINDS.includes(body.kind)) throw new RentalError(400, '訂正の種類を指定してください。');
    const kind = body.kind as Kind;
    const expectedVersion = body.expected_version;
    const ledgerGeneration = body.ledger_generation;
    if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || typeof ledgerGeneration !== 'number' || !Number.isSafeInteger(ledgerGeneration) || ledgerGeneration < 0) {
      throw new RentalError(400, '表示中の物品と台帳の版を指定してください。');
    }
    const reason = line(body, 'reason', 200);
    if (kind !== 'borrower' && !reason) throw new RentalError(400, kind === 'void' ? '取り消す理由を入力してください。' : '確認した内容を入力してください。', 'reason_required');
    const target = kind === 'release' ? null : operationUuid(body.target_operation_id);
    if (kind === 'release' && body.target_operation_id != null) throw new RentalError(400, '要確認の解除に登録の指定は要りません。');
    const borrower = kind === 'borrower' ? borrowerName(body.borrower) : null;
    if (kind !== 'borrower' && body.borrower !== undefined) throw new RentalError(400, '貸出先は貸出先の訂正だけで指定します。');
    const fingerprint = sha256(canonical({ code, kind, target, borrower, reason, expected_version: expectedVersion, ledger_generation: ledgerGeneration }));
    const store = this.store;
    return store.transaction(() => {
      store.checkLedgerGeneration(ledgerGeneration);
      const previous = store.get('SELECT actor_id,fingerprint FROM operation_corrections WHERE id=?', id);
      if (previous) {
        if (previous.actor_id !== actor.id || previous.fingerprint !== fingerprint) throw new RentalError(409, '同じ訂正番号で異なる内容は送信できません。', 'conflict');
        return { ...this.snapshot(code), changed: false, replayed: true };
      }
      const p = this.plan(code);
      if (Number(p.row.version) !== expectedVersion) throw new RentalError(409, '物品が先に更新されました。最新の情報を読み直してから操作してください。', 'version_conflict');
      const before: Row = { item: itemState(p.row) };
      const after: Row = {};
      if (kind === 'release') {
        if (p.row.status !== 'review') throw new RentalError(409, 'この物品は要確認になっていません。', 'state_conflict');
        store.run("UPDATE items SET status='ready',version=version+1 WHERE code=? AND version=?", code, expectedVersion);
      } else if (kind === 'void') {
        if (!p.latest || p.latest.id !== target) throw new RentalError(409, '取り消せるのは、この物品の最新の登録だけです。最新の情報を読み直してください。', 'not_latest');
        if (p.voidBlocked) throw new RentalError(409, p.voidBlocked, 'state_conflict');
        after.action = String(p.latest.action);
        if (p.voidEffect === 'ready') {
          // The plan a loan consumed waits again for the real loan.
          const replan = p.row.planned_consumed_operation === target ? ",planned_state='pending',planned_consumed_operation=NULL" : '';
          store.run(`UPDATE items SET status='ready',current_loan=NULL,version=version+1${replan} WHERE code=? AND version=?`, code, expectedVersion);
        } else if (p.voidEffect === 'loaned') {
          store.run("UPDATE items SET status='loaned',current_loan=?,version=version+1 WHERE code=? AND version=?", canonical(p.restoreLoan), code, expectedVersion);
        }
        // A check changes no state: the record is only marked as cancelled.
      } else {
        if (!p.latestBorrow || p.latestBorrow.id !== target) throw new RentalError(409, '訂正できるのは、この物品の最新の貸出だけです。最新の情報を読み直してください。', 'not_latest');
        if (p.borrowerBlocked) throw new RentalError(409, p.borrowerBlocked, 'state_conflict');
        const group = store.get('SELECT id,name FROM borrowers WHERE name=?', borrower);
        if (!group) throw new RentalError(400, '登録済みの貸出先から選んでください。');
        const archive = parse(p.latestBorrow.metadata) ?? {};
        const was: { borrower?: unknown; borrower_id?: unknown } = p.fix.borrowers.get(String(p.latestBorrow.id)) ?? { borrower: archive.borrower, borrower_id: archive.borrower_id };
        if (was.borrower_id === group.id || (!was.borrower_id && was.borrower === group.name)) return { ...this.snapshot(code), changed: false, replayed: false };
        before.borrower = { name: String(was.borrower ?? ''), id: was.borrower_id == null ? null : String(was.borrower_id) };
        after.borrower = { name: String(group.name), id: String(group.id) };
        if (p.active) store.run('UPDATE items SET current_loan=?,version=version+1 WHERE code=? AND version=?', canonical({ ...p.current, borrower: String(group.name), borrower_id: String(group.id) }), code, expectedVersion);
      }
      after.item = itemState(store.get('SELECT * FROM items WHERE code=?', code)!);
      store.run(
        'INSERT INTO operation_corrections(id,item_code,kind,operation_id,ledger_generation,fingerprint,actor_id,actor_name,server_at,reason,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        code,
        kind,
        target,
        p.generation,
        fingerprint,
        actor.id,
        actor.name,
        utcNow(),
        reason,
        JSON.stringify(before),
        JSON.stringify(after),
      );
      return { ...this.snapshot(code), changed: true, replayed: false };
    });
  }
}
