import { type Actor, type RentalStore, itemUrlValid } from './store.js';
import { canonical, operationUuid, RentalError, utcNow } from './validate.js';

interface IrregularBatch {
  request_id: string;
  items: { code: string; name: string; url: string; card_kind: string; status: string; version: number }[];
  ledger_generation: number;
  server_at: string;
}

/** Separate namespace and persistent sequence: even a numbering reset cannot reuse an IR code. */
export class IrregularCards {
  constructor(private store: RentalStore, private origin: string | null, private revision: () => string) {}

  create(body: Record<string, unknown>, actor: Actor): IrregularBatch {
    const id = operationUuid(body.request_id);
    const count = body.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100) throw new RentalError(400, 'カード枚数は1〜100枚で指定してください。');
    if (!this.origin) throw new RentalError(409, 'カードの公開URLをサーバーに設定してください。');
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT * FROM irregular_card_batches WHERE id=?').get(id);
      if (prior) {
        if (prior.actor_id !== actor.id) throw new RentalError(403, 'この発行は別のスタッフが登録しています。');
        if (prior.count !== count || prior.generation !== this.store.ledgerGeneration()) throw new RentalError(409, 'この発行IDの内容または台帳世代が変わっています。');
        const result = JSON.parse(String(prior.result_json)) as IrregularBatch;
        if (result.items.some(i => !db.prepare('SELECT code FROM items WHERE code=? AND archived_at IS NULL').get(i.code))) throw new RentalError(409, 'この発行のカードは保管済みです。台帳を読み直してください。');
        db.exec('ROLLBACK');
        return result;
      }
      if (body.expected_revision !== this.revision()) throw new RentalError(409, '台帳が更新されています。読み直してから発行してください。', 'version_conflict');
      const sequence = Number(db.prepare("SELECT value FROM config WHERE key='irregular_card_sequence'").get()?.value ?? 0);
      if (!Number.isSafeInteger(sequence) || sequence + count > 999999) throw new RentalError(409, 'イレギュラーカードの番号上限に達しています。');
      const at = utcNow();
      const items = Array.from({ length: count }, (_, i) => {
        const code = `IY-IR-${String(sequence + i + 1).padStart(6, '0')}`;
        const name = 'イレギュラーカード';
        const url = `${this.origin}/i/${code}`;
        if (!itemUrlValid(url, code, this.origin)) throw new RentalError(409, 'カードの公開URL設定を確認してください。');
        db.prepare("INSERT INTO items(code,name,card_kind,version,photo_required) VALUES(?,?,'irregular',?,0)").run(code, name, this.store.itemVersionFloor());
        db.prepare('INSERT INTO issuance(code,name,url,actor_id,server_at) VALUES(?,?,?,?,?)').run(code, name, url, actor.id, at);
        return { code, name, url, card_kind: 'irregular', status: 'ready', version: this.store.itemVersionFloor() };
      });
      db.prepare("INSERT INTO config(key,value) VALUES('irregular_card_sequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(sequence + count));
      const result = { request_id: id, items, ledger_generation: this.store.ledgerGeneration(), server_at: at };
      db.prepare('INSERT INTO irregular_card_batches(id,actor_id,count,generation,server_at,result_json) VALUES(?,?,?,?,?,?)').run(id, actor.id, count, this.store.ledgerGeneration(), at, canonical(result));
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
}
