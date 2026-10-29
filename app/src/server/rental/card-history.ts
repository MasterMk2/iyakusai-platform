import { createHash, randomUUID } from 'node:crypto';
import { type Actor, type RentalStore } from './store.js';
import { itemCode, RentalError, utcNow } from './validate.js';

type Row = Record<string, unknown>;
type Entry = { idm: string; code: string; url: string; status: 'reserved' | 'passed' | 'released'; [key: string]: unknown };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const conflict = (s: string): never => { throw new RentalError(409, s, 'card_conflict'); };
const text = (s: unknown, max = 180): string => {
  if (typeof s !== 'string' || !s || s.length > max || [...s].some(c => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127)) throw new RentalError(400, '発行データの形式を確認してください。');
  return s;
};
function entry(value: unknown): Entry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RentalError(400, '発行履歴の形式を確認してください。');
  const e = value as Entry;
  if (typeof e.idm !== 'string' || typeof e.code !== 'string' || !/^[0-9A-F]{16}$/.test(e.idm) || !/^IY-[A-Z0-9][A-Z0-9-]{2,39}$/.test(e.code) || !['reserved', 'passed', 'released'].includes(e.status)) throw new RentalError(400, '発行履歴のカード・個体・状態が不正です。');
  let url: URL;
  try { url = new URL(text(e.url)); } catch { throw new RentalError(400, '発行履歴のURLが不正です。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new RentalError(400, '発行履歴のURLが不正です。');
  return e;
}
function indexes(raw: string) {
  if (Buffer.byteLength(raw) > 32 * 1024 * 1024 || (raw && !raw.endsWith('\n'))) throw new RentalError(400, '発行履歴の容量または末尾を確認してください。');
  const byId = new Map<string, Entry>(), byCode = new Map<string, Entry>();
  for (const line of raw.split('\n').filter(Boolean)) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new RentalError(400, '発行履歴のJSONを読み取れません。'); }
    const e = entry(value);
    if (e.status === 'released') {
      if (byId.get(e.idm)?.code === e.code && byId.get(e.idm)?.url === e.url) byId.delete(e.idm);
      if (byCode.get(e.code)?.idm === e.idm && byCode.get(e.code)?.url === e.url) byCode.delete(e.code);
    } else {
      for (const old of [byId.get(e.idm), byCode.get(e.code)]) if (old && (old.idm !== e.idm || old.code !== e.code || old.url !== e.url)) conflict('発行履歴の割り当てが競合しています。');
      byId.set(e.idm, e); byCode.set(e.code, e);
    }
  }
  return { byId, byCode };
}

/** Durable per-card and per-code reservations. A write reservation never times out. */
export class CardHistory {
  constructor(private store: RentalStore) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS card_history_seed(id INTEGER PRIMARY KEY CHECK(id=1),registry TEXT NOT NULL,sha256 TEXT NOT NULL,actor TEXT NOT NULL,server_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS card_history_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation TEXT NOT NULL,phase TEXT NOT NULL,line TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS card_history_claims(id TEXT PRIMARY KEY,actor TEXT NOT NULL,client TEXT NOT NULL,code TEXT NOT NULL,idm TEXT NOT NULL,url TEXT NOT NULL,manifest TEXT NOT NULL,pdf TEXT NOT NULL,force INTEGER NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL,reserve_hash TEXT,pass_hash TEXT);
      CREATE TABLE IF NOT EXISTS card_history_locks(key TEXT PRIMARY KEY,operation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS card_history_evidence(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS card_history_recovery(id TEXT PRIMARY KEY,operation TEXT NOT NULL,actor TEXT NOT NULL,server_at TEXT NOT NULL,prior_state TEXT NOT NULL);
    `);
  }
  private tx<T>(fn: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  private raw(): string {
    const seed = this.store.db.prepare('SELECT registry FROM card_history_seed WHERE id=1').get();
    const lines = this.store.db.prepare('SELECT line FROM card_history_events ORDER BY seq').all();
    return String(seed?.registry ?? '') + lines.map(r => String(r.line)).join('');
  }
  snapshot() {
    const registry = this.raw(), { byCode } = indexes(registry);
    return { ledger_generation:this.store.ledgerGeneration(), initialized: !!this.store.db.prepare('SELECT id FROM card_history_seed WHERE id=1').get(), registry,
      sha256: hash(registry), events: registry.split('\n').filter(Boolean).length,
      passed: [...byCode.values()].filter(e => e.status === 'passed').length,
      reserved: [...byCode.values()].filter(e => e.status === 'reserved').length,
      active: this.store.db.prepare("SELECT id,code,idm,state,client FROM card_history_claims WHERE state IN ('open','writing') ORDER BY code").all() };
  }
  private artifacts(raw: unknown): { name: string; sha: string; data: string }[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RentalError(400, '証跡の形式を確認してください。');
    const entries = Object.entries(raw as Row);
    if (entries.length > 5000) throw new RentalError(413, '証跡ファイルが多すぎます。');
    let total = 0;
    const seen = new Set<string>();
    return entries.map(([name, v]) => {
      if (!/^evidence\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(name) || name.includes('..') || seen.has(name.toLowerCase())) throw new RentalError(400, '証跡の保存先を確認してください。');
      seen.add(name.toLowerCase());
      if (typeof v !== 'string' || v.length > 8 * 1024 * 1024) throw new RentalError(400, '証跡の形式・1ファイルの容量を確認してください。');
      const data = v;
      const bytes = Buffer.from(data, 'base64');
      if (bytes.toString('base64') !== data || (total += bytes.length) > 16 * 1024 * 1024) throw new RentalError(413, '証跡の容量・形式を確認してください。');
      return { name, sha: createHash('sha256').update(bytes).digest('hex'), data };
    });
  }
  private saveArtifacts(files: { name: string; sha: string; data: string }[]) {
    for (const f of files) {
      const old = this.store.db.prepare('SELECT sha256 FROM card_history_evidence WHERE name=?').get(f.name);
      // A per-operation evidence directory grows during write/readback. The files
      // are saved under phase-specific names by the Windows client, never replaced.
      if (old && old.sha256 !== f.sha) conflict('同じ証跡名の内容が異なります。');
      this.store.db.prepare('INSERT OR IGNORE INTO card_history_evidence VALUES(?,?,?)').run(f.name, f.sha, f.data);
    }
  }
  importLegacy(raw: Row, actor: Actor) {
    const registry = typeof raw.registry === 'string' ? raw.registry : (() => { throw new RentalError(400, '発行履歴がありません。'); })();
    indexes(registry);
    if (hash(registry) !== raw.sha256) throw new RentalError(400, '発行履歴のハッシュが一致しません。');
    const files = this.artifacts(raw.evidence ?? {});
    return this.tx(() => {
      const seed = this.store.db.prepare('SELECT sha256 FROM card_history_seed WHERE id=1').get();
      if (seed && seed.sha256 !== raw.sha256) conflict('サーバーは既存履歴を取り込み済みです。別の履歴で置き換えることはできません。');
      this.saveArtifacts(files);
      if (!seed) this.store.db.prepare('INSERT INTO card_history_seed VALUES(1,?,?,?,?)').run(registry, hash(registry), actor.id, utcNow());
      return this.snapshot();
    });
  }
  backup() {
    const evidence: Record<string, string> = {};
    for (const r of this.store.db.prepare('SELECT name,data FROM card_history_evidence ORDER BY name').all()) evidence[String(r.name)] = String(r.data);
    return { ...this.snapshot(), evidence };
  }
  backupIndex() {
    return this.tx(() => ({ ...this.snapshot(), evidence: this.store.db.prepare('SELECT name,sha256,length(data) AS encoded_bytes FROM card_history_evidence ORDER BY name').all() }));
  }
  backupFiles(raw: Row) {
    if (!Array.isArray(raw.names) || !raw.names.length || raw.names.length > 100 || !raw.names.every(n => typeof n === 'string') || new Set(raw.names).size !== raw.names.length) throw new RentalError(400, '証跡の取得一覧を確認してください。');
    const evidence: Record<string, { data: string; sha256: string }> = {};
    let bytes = 0;
    for (const name of raw.names) {
      const file = this.store.db.prepare('SELECT data,sha256 FROM card_history_evidence WHERE name=?').get(name);
      if (!file) throw new RentalError(404, 'バックアップ対象の証跡が見つかりません。');
      if (bytes + String(file.data).length > 10 * 1024 * 1024 && bytes) break;
      bytes += String(file.data).length;
      evidence[name] = { data: String(file.data), sha256: String(file.sha256) };
    }
    return { evidence };
  }
  claim(raw: Row, actor: Actor) {
    const code = itemCode(raw.code), idm = text(raw.idm, 16), url = text(raw.url), client = text(raw.client, 80);
    const manifest = text(raw.manifest_sha256, 64), pdf = text(raw.pdf_sha256, 64);
    if (!/^[0-9A-F]{16}$/.test(idm) || !/^[0-9a-f]{64}$/.test(manifest) || !/^[0-9a-f]{64}$/.test(pdf)) throw new RentalError(400, 'カードまたはラベルの識別情報を確認してください。');
    return this.tx(() => {
      if (!this.snapshot().initialized) conflict('既存の発行履歴をサーバーへ取り込んでから発行してください。');
      const item = this.store.db.prepare('SELECT i.status,i.archived_at,s.url FROM items i JOIN issuance s ON s.code=i.code WHERE i.code=?').get(code);
      if (!item || item.archived_at != null || item.url !== url || item.status !== 'ready') conflict('サーバー台帳のNo.・URL・状態が書き込み用データと一致しません。台帳を読み直してください。');
      const { byId, byCode } = indexes(this.raw());
      const keys = new Set(['card:' + idm, 'code:' + code]);
      for (const e of [byId.get(idm), byCode.get(code)]) if (e) {
        const affected = this.store.db.prepare('SELECT status,archived_at FROM items WHERE code=?').get(e.code);
        // A forced server reset preserves the old loan as archived evidence. It must not
        // prevent explicitly overwriting that physical card for a newly registered code.
        if (affected && affected.archived_at == null && affected.status !== 'ready') conflict('割り当て済みの物品が貸出中・要確認です。カードを変更できません。');
        keys.add('card:' + e.idm); keys.add('code:' + e.code);
      }
      for (const key of keys) {
        const lock = this.store.db.prepare('SELECT c.* FROM card_history_locks l JOIN card_history_claims c ON c.id=l.operation WHERE l.key=?').get(key);
        if (lock && lock.state === 'open' && Number(lock.expires) < Date.now()) {
          this.store.db.prepare("UPDATE card_history_claims SET state='abandoned' WHERE id=?").run(String(lock.id));
          this.store.db.prepare('DELETE FROM card_history_locks WHERE operation=?').run(String(lock.id));
        } else if (lock) conflict(`${code}またはこのカードは別のPCで発行中、または書き込み結果が未確認です。`);
      }
      const id = randomUUID();
      this.store.db.prepare("INSERT INTO card_history_claims(id,actor,client,code,idm,url,manifest,pdf,force,state,expires) VALUES(?,?,?,?,?,?,?,?,?,'open',?)").run(id, actor.id, client, code, idm, url, manifest, pdf, raw.force === true ? 1 : 0, Date.now() + 10 * 60 * 1000);
      for (const key of keys) this.store.db.prepare('INSERT INTO card_history_locks VALUES(?,?)').run(key, id);
      return { operation: id, ...this.snapshot() };
    });
  }
  private operation(id: unknown, actor: Actor): Row {
    const row = this.store.db.prepare('SELECT * FROM card_history_claims WHERE id=?').get(text(id, 36));
    if (!row || row.actor !== actor.id) throw new RentalError(403, 'この発行操作を変更できません。');
    return row;
  }
  transition(raw: Row, actor: Actor) {
    const phase = raw.phase;
    if (phase !== 'reserve' && phase !== 'pass') throw new RentalError(400, '発行段階を確認してください。');
    if (!Array.isArray(raw.entries) || raw.entries.length < 1 || raw.entries.length > 4) throw new RentalError(400, '発行記録を確認してください。');
    const entries = raw.entries.map(entry);
    const files = this.artifacts(raw.evidence ?? {});
    const fingerprint = hash(JSON.stringify({ entries, evidence: raw.evidence ?? {} }));
    return this.tx(() => {
      const op = this.operation(raw.operation, actor), column = phase === 'reserve' ? 'reserve_hash' : 'pass_hash';
      if (op[column]) {
        if ((phase === 'reserve' && op.state !== 'writing') || (phase === 'pass' && op.state !== 'complete')) conflict('この発行操作の予約は既に終了・取り消されています。');
        if (op[column] !== fingerprint) conflict('同じ発行操作の内容が変わっています。');
        return { ...this.snapshot(), entries: this.store.db.prepare('SELECT line FROM card_history_events WHERE operation=? AND phase=? ORDER BY seq').all(String(op.id), phase).map(r => JSON.parse(String(r.line)) as Entry) };
      }
      if ((phase === 'reserve' && op.state !== 'open') || (phase === 'pass' && !['open', 'writing'].includes(String(op.state))) || (op.state === 'open' && Number(op.expires) < Date.now())) conflict('発行予約の有効期限または状態を確認してください。');
      const keys = this.store.db.prepare('SELECT key FROM card_history_locks WHERE operation=?').all(String(op.id)).map(r => String(r.key));
      if (!keys.includes('card:' + String(op.idm)) || !keys.includes('code:' + String(op.code))) conflict('発行予約を確認できません。');
      const last = entries.at(-1)!;
      if (phase === 'reserve') {
        const currentItem = this.store.db.prepare('SELECT i.status,i.archived_at,s.url FROM items i JOIN issuance s ON s.code=i.code WHERE i.code=?').get(String(op.code));
        if (!currentItem || currentItem.status !== 'ready' || currentItem.archived_at != null || currentItem.url !== op.url) conflict('発行予約後に物品の状態が変わりました。カードを書き込まず停止します。');
      }
      if (last.idm !== op.idm || last.code !== op.code || last.url !== op.url || last.status !== (phase === 'reserve' ? 'reserved' : 'passed') || last.manifest_sha256 !== op.manifest || last.pdf_sha256 !== op.pdf) throw new RentalError(400, '予約したカード・No.・URL・ラベルと発行記録が一致しません。');
      if (phase === 'pass' && entries.length !== 1) throw new RentalError(400, '読み戻しの記録は1件です。');
      const old = indexes(this.raw());
      for (const e of entries.slice(0, -1)) {
        if (op.force !== 1 || e.status !== 'released' || !keys.includes('card:' + e.idm) || !keys.includes('code:' + e.code)) throw new RentalError(400, '上書き対象が予約と一致しません。');
        const binding = old.byId.get(e.idm);
        if (!binding || binding.code !== e.code || binding.url !== e.url) conflict('上書き前の割り当てが変更されています。');
      }
      if (phase === 'reserve' && op.force !== 1 && [old.byId.get(last.idm), old.byCode.get(last.code)].some(e => e?.status === 'reserved')) conflict('前回の書き込み結果が未確認です。');
      if (phase === 'pass' && op.state === 'open') {
        const current = old.byId.get(last.idm);
        if (current && (current.status !== 'passed' || current.code !== last.code || current.url !== last.url)) conflict('既存カードの読み戻し対象が発行履歴と一致しません。');
      }
      if (phase === 'pass' && last.verified_readback !== true) throw new RentalError(400, '独立した読み戻し確認の記録がありません。');
      const canonical = entries.map(e => ({ ...e, actor_id: actor.id, operation: String(op.id), server_at: utcNow(), client: String(op.client) }));
      const lines = canonical.map(e => JSON.stringify(e) + '\n');
      indexes(this.raw() + lines.join(''));
      this.saveArtifacts(files);
      for (const line of lines) this.store.db.prepare('INSERT INTO card_history_events(operation,phase,line) VALUES(?,?,?)').run(String(op.id), phase, line);
      this.store.db.prepare(`UPDATE card_history_claims SET state=?,${column}=? WHERE id=?`).run(phase === 'reserve' ? 'writing' : 'complete', fingerprint, String(op.id));
      if (phase === 'pass') this.store.db.prepare('DELETE FROM card_history_locks WHERE operation=?').run(String(op.id));
      return { ...this.snapshot(), entries: canonical };
    });
  }
  cancel(raw: Row, actor: Actor) {
    const files = this.artifacts(raw.evidence ?? {});
    return this.tx(() => {
      const op = this.operation(raw.operation, actor);
      this.saveArtifacts(files);
      // A written or possibly partially written card remains reserved permanently.
      if (op.state === 'open') {
        this.store.db.prepare("UPDATE card_history_claims SET state='cancelled' WHERE id=?").run(String(op.id));
        this.store.db.prepare('DELETE FROM card_history_locks WHERE operation=?').run(String(op.id));
      }
      return { state: op.state === 'open' ? 'cancelled' : op.state };
    });
  }
  recover(raw: Row, actor: Actor) {
    if (raw.confirmation !== '未完了の発行を引き継ぐ') throw new RentalError(400, '元PCの発行停止を確認して、確認文を入力してください。');
    return this.tx(() => {
      const op = this.store.db.prepare('SELECT * FROM card_history_claims WHERE id=?').get(text(raw.operation, 36));
      if (!op || !['open','writing'].includes(String(op.state))) throw new RentalError(409, 'この未完了予約は既に処理されています。');
      this.store.db.prepare("UPDATE card_history_claims SET state='recovery_requested' WHERE id=?").run(String(op.id));
      this.store.db.prepare('DELETE FROM card_history_locks WHERE operation=?').run(String(op.id));
      // The reserved binding and all evidence survive. Ordinary issuance still
      // refuses it; only a confirmed overwrite or physical reconciliation proceeds.
      this.store.db.prepare('INSERT INTO card_history_recovery VALUES(?,?,?,?,?)').run(randomUUID(), String(op.id), actor.id, utcNow(), String(op.state));
      return { recovered: true, code: op.code, actor: actor.id, ...this.snapshot() };
    });
  }
}
