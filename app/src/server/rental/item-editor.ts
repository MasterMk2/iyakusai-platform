import { createHash } from 'node:crypto';
import type { Actor, RentalStore } from './store.js';
import { canonical, itemCode, operationUuid, RentalError, utcNow } from './validate.js';

// Editing an item's catalogue data from the phone (2026-10-17). Issued card records and the records
// archived with each loan stay as they were; every edit is a row in item_edit_events.

type Row = Record<string, unknown>;

const FIELDS = ['name', 'item_scope', 'item_owner', 'photo_required'] as const;
const values = (row: Row) => Object.fromEntries(FIELDS.map((key) => [key, row[key] ?? null]));

function text(value: unknown, label: string, max: number, required = false): string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || [...value].length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new RentalError(400, `${label}の形式が正しくありません。`);
  const clean = value.trim();
  if (required && !clean) throw new RentalError(400, `${label}を入力してください。`);
  return clean;
}

/** Edits current catalogue data only; issued card records and loan snapshots stay immutable. */
export class ItemEditor {
  constructor(private readonly store: RentalStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS item_edit_events(
          id TEXT PRIMARY KEY,item_code TEXT NOT NULL,ledger_generation INTEGER NOT NULL,
          fingerprint TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,
          server_at TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS item_edit_history ON item_edit_events(item_code,ledger_generation,server_at);`);
  }

  snapshot(code: unknown) {
    const item = this.store.item(code);
    const generation = this.store.ledgerGeneration();
    const history = this.store
      .all('SELECT actor_name,server_at,before_json,after_json FROM item_edit_events WHERE item_code=? AND ledger_generation=? ORDER BY server_at DESC,rowid DESC LIMIT 20', String(item.code), generation)
      .map((row) => ({ actor_name: row.actor_name, server_at: row.server_at, before: JSON.parse(String(row.before_json)) as unknown, after: JSON.parse(String(row.after_json)) as unknown }));
    return { item, ledger_generation: generation, history };
  }

  update(code: string, body: Record<string, unknown>, actor: Actor) {
    itemCode(code);
    const allowed = new Set(['operation_id', 'expected_version', 'ledger_generation', 'name', 'item_scope', 'item_owner']);
    if (Object.keys(body).some((key) => !allowed.has(key))) throw new RentalError(400, '編集できない項目が含まれています。');
    const id = operationUuid(body.operation_id);
    const expectedVersion = body.expected_version;
    const ledgerGeneration = body.ledger_generation;
    if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || typeof ledgerGeneration !== 'number' || !Number.isSafeInteger(ledgerGeneration) || ledgerGeneration < 0) {
      throw new RentalError(400, '表示中の物品と台帳の版を指定してください。');
    }
    const name = text(body.name, '物品名', 200, true);
    const scope = body.item_scope;
    if (scope !== null && scope !== '学内' && scope !== '学外' && scope !== '委員会') throw new RentalError(400, '物品区分を選んでください。');
    const owner = text(body.item_owner, '借用元', 120);
    if (scope === '学外' && !owner) throw new RentalError(400, '学外物品の借用元を入力してください。');
    const fingerprint = createHash('sha256').update(canonical({ code, ...body })).digest('hex');
    return this.store.transaction(() => {
      this.store.checkLedgerGeneration(ledgerGeneration);
      const previous = this.store.get('SELECT * FROM item_edit_events WHERE id=?', id);
      if (previous) {
        if (previous.actor_id !== actor.id || previous.fingerprint !== fingerprint) throw new RentalError(409, '同じ保存番号で異なる内容は送信できません。', 'conflict');
        return { ...this.snapshot(code), changed: false, replayed: true };
      }
      this.store.item(code); // Reject missing or archived items before writing anything.
      const row = this.store.get('SELECT * FROM items WHERE code=?', code)!;
      if (row.card_kind === 'irregular') throw new RentalError(400, 'イレギュラーカードの品名・数量は貸出時の入力画面で設定してください。');
      if (Number(row.version) !== expectedVersion) throw new RentalError(409, '物品が先に更新されました。入力を残しています。「最新の情報を確認」で照合してください。', 'version_conflict');
      const before = values(row);
      const after = {
        name,
        item_scope: scope,
        item_owner: owner || null,
        photo_required: scope === row.item_scope ? row.photo_required : scope === null ? null : Number(scope === '学外'),
      };
      if (canonical(before) === canonical(after)) return { ...this.snapshot(code), changed: false, replayed: false };
      this.store.run(
        'UPDATE items SET name=?,item_scope=?,item_owner=?,photo_required=?,version=version+1 WHERE code=? AND version=?',
        name,
        scope,
        after.item_owner,
        after.photo_required as number | null,
        code,
        expectedVersion,
      );
      this.store.run(
        'INSERT INTO item_edit_events(id,item_code,ledger_generation,fingerprint,actor_id,actor_name,server_at,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?)',
        id,
        code,
        ledgerGeneration,
        fingerprint,
        actor.id,
        actor.name,
        utcNow(),
        JSON.stringify(before),
        JSON.stringify(after),
      );
      return { ...this.snapshot(code), changed: true, replayed: false };
    });
  }
}
