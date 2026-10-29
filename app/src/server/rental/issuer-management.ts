import { createHash, randomInt, randomUUID } from 'node:crypto';
import { type Actor, itemUrlValid, type RentalStore } from './store.js';
import { borrowerName, canonical, itemCode, RentalError, utcNow } from './validate.js';
import {numberingRevision,numberingState,resetNumbering} from './numbering-reset.js';

type Row = Record<string, unknown>;
type Mode = 'update' | 'overwrite' | 'reset' | 'force_reset' | 'force_reset_all';
interface Wanted { code: string; name: string; url: string; borrower_name: string; item_scope?: string; item_owner?: string; photo_required?: boolean }
interface Change { code: string; before: Row | null; after: Row | null; fields: string[]; blocked: string | null }
interface Preview { id: string; actor: string; expires: number; revision: string; mode: Mode; items: Wanted[]; changes: Change[]; confirmation?: string }
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** Reviewed issuer edits. Card IDs are never recycled, and a reset archives active items in place. */
export class IssuerManagement {
  private previews = new Map<string, Preview>();
  constructor(private store: RentalStore, private origin: string | null) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS issuer_management_events(
      id TEXT PRIMARY KEY,action TEXT NOT NULL,actor_id TEXT NOT NULL,server_at TEXT NOT NULL,
      before_json TEXT NOT NULL,after_json TEXT NOT NULL);`);
  }

  private rows(): Row[] {
    return this.store.db.prepare(`SELECT i.*,s.url,b.name AS borrower_name
      FROM items i LEFT JOIN issuance s ON s.code=i.code
      LEFT JOIN borrowers b ON b.id=i.planned_borrower_id ORDER BY i.code`).all() as Row[];
  }

  snapshot() {
    const rows = this.rows();
    const numeric = rows.map(r => /^IY-\d{6}$/.test(String(r.code)) ? Number(String(r.code).slice(3)) : 0);
    return {
      revision: digest({generation:this.store.ledgerGeneration(),rows}), ledger_generation:this.store.ledgerGeneration(), generated_at: utcNow(), reserved_through: numeric.reduce((max, value) => Math.max(max, value), 100000),
      archived_count: rows.filter(r => r.archived_at != null).length,
      items: rows.filter(r => r.archived_at == null).map(r => ({
        code: String(r.code), name: String(r.name), url: r.url == null ? null : String(r.url),
        card_kind: r.card_kind,
        status: String(r.status), version: Number(r.version), planned_state: String(r.planned_state),
        borrower_id: r.planned_borrower_id == null ? null : String(r.planned_borrower_id),
        borrower_name: r.borrower_name == null ? null : String(r.borrower_name),
        item_scope: r.item_scope ?? null, item_owner: r.item_owner ?? null,
        photo_required: r.photo_required == null ? null : r.photo_required === 1,
      })),
    };
  }

  private normalize(raw: unknown): Wanted[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10000) throw new RentalError(400, '1〜10000個体を指定してください。');
    const seen = new Set<string>();
    return raw.map((v: unknown) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RentalError(400, '物品データの形式を確認してください。');
      const r = v as Row;
      const code = itemCode(r.code);
      if (seen.has(code)) throw new RentalError(400, '同じNo.が重複しています。');
      seen.add(code);
      const text = (key: string, max: number) => {
        const value = r[key];
        if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || [...value].some(c => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127)) throw new RentalError(400, `${key}の内容を確認してください。`);
        return value;
      };
      const result: Wanted = { code, name: text('name', 160), url: text('url', 180), borrower_name: borrowerName(r.borrower_name) };
      if (r.item_scope != null) {
        if (typeof r.item_scope !== 'string' || !['学内','学外','委員会','区分未確認'].includes(r.item_scope)) throw new RentalError(400, '物品区分を確認してください。');
        result.item_scope = r.item_scope;
      }
      if (r.item_owner != null) result.item_owner = text('item_owner', 120);
      if ('photo_required' in r) {
        if (typeof r.photo_required !== 'boolean') throw new RentalError(400, '写真必須は true または false で指定してください。');
        result.photo_required = r.photo_required;
      }
      return result;
    });
  }

  private changes(mode: Mode, wanted: Wanted[]): Change[] {
    const all = this.rows();
    if(mode==='force_reset_all')return all.map(r=>({code:String(r.code),before:r,after:null,fields:['台帳・貸出予定・番号予約を初期化'],blocked:null}));
    if (mode === 'reset' || mode === 'force_reset') return all.filter(r => r.archived_at == null).map(r => ({ code: String(r.code), before: r, after: null,
      fields: ['台帳・貸出予定を保管'], blocked: mode !== 'force_reset' && (r.status !== 'ready' || r.current_loan != null) ? '貸出中・要確認のためリセットできません' : null }));
    const byCode = new Map(all.map(r => [String(r.code), r]));
    return wanted.map(w => {
      const before = byCode.get(w.code) ?? null;
      if (before?.card_kind === 'irregular' || w.code.startsWith('IY-IR-')) throw new RentalError(409, 'イレギュラーカードは通常の物品登録・上書きの対象にできません。');
      if (before?.archived_at != null) throw new RentalError(409, `${w.code}は保管済みの番号です。新しいNo.を使ってください。`, 'archived_code');
      if (!itemUrlValid(w.url, w.code, this.origin) && !(before?.url === w.url && itemUrlValid(w.url, w.code, null))) throw new RentalError(400, `${w.code}のURLはサーバーの公開先と一致させてください。`);
      const after: Row = { code: w.code, name: w.name, url: w.url, borrower_name: w.borrower_name,
        item_scope: w.item_scope ?? before?.item_scope ?? null,
        item_owner: w.item_owner ?? (w.item_scope !== undefined && w.item_scope !== '学外' ? null : before?.item_owner ?? null), planned_state: 'pending' };
      after.photo_required = ['学内','学外','委員会'].includes(String(after.item_scope)) ? (after.item_scope === '学外' ? 1 : 0) : null;
      if (w.photo_required !== undefined && (after.photo_required === null || w.photo_required !== (after.photo_required === 1))) throw new RentalError(400, '物品区分と写真要件が一致していません。');
      const fields = before ? ['name','url','borrower_name','item_scope','item_owner','planned_state'].filter(k => (before[k] ?? null) !== after[k]) : ['新規登録'];
      let blocked: string | null = null;
      if (before && fields.length && (before.status !== 'ready' || before.current_loan != null)) blocked = '貸出中・要確認のため変更できません';
      if (mode !== 'overwrite' && fields.some(k => k === 'name' || k === 'url')) blocked = '物品名・URLの変更には「上書き」を選んでください';
      return { code: w.code, before, after, fields, blocked };
    });
  }

  preview(raw: Row, actor: Actor, resetAllowed: boolean) {
    const mode = raw.mode;
    if (mode !== 'update' && mode !== 'overwrite' && mode !== 'reset' && mode !== 'force_reset' && mode!=='force_reset_all') throw new RentalError(400, '更新方法を選んでください。');
    const resetting = mode === 'reset' || mode === 'force_reset' || mode==='force_reset_all';
    if (resetting && !resetAllowed) throw new RentalError(403, 'サーバーのリセットは物品管理者だけが実行できます。', 'forbidden');
    const items = resetting ? [] : this.normalize(raw.items);
    const snapshot = this.snapshot();
    const revision=mode==='force_reset_all'?numberingRevision(this.store):snapshot.revision;
    const changes = this.changes(mode, items);
    const now = Date.now();
    for (const [key, value] of this.previews) if (value.expires < now) this.previews.delete(key);
    if (this.previews.size >= 100) throw new RentalError(429, '確認画面を開きすぎています。しばらくしてから試してください。');
    const id = randomUUID();
    const confirmation = (mode === 'force_reset' || mode === 'force_reset_all') && raw.confirmation_style === 'digits3'
      ? String(randomInt(100, 1000)) : undefined;
    this.previews.set(id, { id, actor: actor.id, expires: now + 10 * 60 * 1000, revision, mode, items, changes, confirmation });
    return { token: id, revision, mode, expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
      ...(confirmation ? { confirmation_code: confirmation } : {}),
      changes, changed_count: changes.filter(c => c.fields.length).length, blocked_count: changes.filter(c => c.blocked).length,
      unchanged_count: changes.filter(c => !c.fields.length).length,
      ...(resetting ? { reset_counts: {
        total: changes.length,
        loaned: changes.filter(c => c.before?.status === 'loaned' || c.before?.status === 'borrowed' || c.before?.current_loan != null).length,
        review: changes.filter(c => c.before?.status === 'review').length,
      } } : {}),
      ...(mode==='force_reset_all'?{numbering_reset:{first_code:'IY-100001',reserved_through:snapshot.reserved_through,archived_items:snapshot.archived_count,card_events:numberingState(this.store).card_history_events?.length??0,outstanding_claims:(numberingState(this.store).card_history_claims??[]).filter(r=>['open','writing'].includes(String(r.state))).length}}:{}),
      note:mode==='force_reset_all'?'貸出中と保管済みを含む台帳・貸出予定・No.予約・カード重複防止を初期化し、No.100001から再登録します。旧台帳と発行証跡は退避し、貸出記録・写真は保持します。旧カード・QRも再登録先を開くため、ラベルを必ず照合・作り直してください。全PCは新版でログインし直してください。': resetting ? (mode === 'force_reset' ? '貸出中・要確認も含め、' : '') + '現在の台帳と貸出予定を空にします。貸出・返却記録、写真、カード発行履歴とNo.は保管します。旧カードは利用できなくなり、再登録は続きのNo.から行います。実物の返却を登録する操作ではありません。' : '表示されたNo.だけを更新します。一覧にない物品はそのままです。' };
  }

  apply(raw: Row, actor: Actor, resetAllowed: boolean) {
    const p = typeof raw.token === 'string' ? this.previews.get(raw.token) : undefined;
    if (!p || p.actor !== actor.id || p.expires < Date.now()) throw new RentalError(409, '確認画面の有効期限が切れました。差分を読み直してください。', 'preview_expired');
    const resetting = p.mode === 'reset' || p.mode === 'force_reset' || p.mode==='force_reset_all';
    if (resetting && !resetAllowed) throw new RentalError(403, 'サーバーのリセットは物品管理者だけが実行できます。', 'forbidden');
    const required = p.confirmation ?? (p.mode==='force_reset_all'?'連番と重複防止を含めて初期化':p.mode === 'force_reset' ? '物品台帳を強制リセット' : p.mode === 'reset' ? '物品台帳をリセット' : p.mode === 'overwrite' ? '上書きを実行' : '変更を反映');
    if (raw.confirmation !== required) throw new RentalError(400, '確認内容が一致しません。');
    if(p.mode==='force_reset_all'&&raw.all_writers_stopped!==true)throw new RentalError(400,'全PCの発行停止を確認してください。未完了の発行予約も初期化されます。','writers_not_stopped');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      // Check reservations under the write lock, including a new code not yet in the ledger.
      if (this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='card_history_locks'").get()) {
        if (resetting && p.mode!=='force_reset_all' && this.store.db.prepare('SELECT key FROM card_history_locks LIMIT 1').get())
          throw new RentalError(409, 'カード発行中・未完了の予約があります。発行を完了または取り消してからリセットしてください。', 'card_busy');
        for (const c of p.changes.filter(c => c.fields.length)) {
          if (p.mode!=='force_reset_all'&&this.store.db.prepare('SELECT key FROM card_history_locks WHERE key=?').get('code:' + c.code))
            throw new RentalError(409, `${c.code}はカード発行中です。発行が完了してから変更してください。`, 'card_busy');
        }
      }
      if ((p.mode==='force_reset_all'?numberingRevision(this.store):this.snapshot().revision) !== p.revision) throw new RentalError(409, '確認後に台帳・発行履歴が更新されました。差分を読み直してください。', 'stale_preview');
      const changes = this.changes(p.mode, p.items);
      if (changes.some(c => c.blocked)) throw new RentalError(409, '変更できない物品が含まれています。台帳は変更していません。', 'blocked_changes');
      const now = utcNow();
      const run = (sql: string, ...params: (string | number | null)[]) => this.store.db.prepare(sql).run(...params);
      let resetResult:ReturnType<typeof resetNumbering>|null=null;
      if(p.mode==='force_reset_all')resetResult=resetNumbering(this.store,actor,true);
      else if (resetting) {
        run("UPDATE items SET archived_at=?,planned_borrower_id=NULL,planned_state='unassigned',planned_assigned_at=NULL,planned_actor_id=NULL,planned_consumed_operation=NULL,version=version+1 WHERE archived_at IS NULL", now);
      } else {
        for (const c of changes) {
          if (!c.fields.length) continue;
          const a = c.after!;
          const group = this.store.db.prepare('SELECT id,name FROM borrowers WHERE name=?').get(String(a.borrower_name));
          let groupId = group ? String(group.id) : '';
          if (!group) {
            groupId = `B-${randomUUID().replaceAll('-', '')}`;
            run('INSERT INTO borrowers(name,id) VALUES(?,?)', String(a.borrower_name), groupId);
          }
          if (!c.before) run('INSERT INTO items(code,name,version) VALUES(?,?,?)', c.code, String(a.name),this.store.itemVersionFloor());
          run(`INSERT INTO issuance(code,name,url,actor_id,server_at) VALUES(?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,url=excluded.url,actor_id=excluded.actor_id,server_at=excluded.server_at`, c.code, String(a.name), String(a.url), actor.id, now);
          run('INSERT INTO preassignment_events(item_code,borrower_id,previous_borrower_id,previous_state,actor_id,server_at) VALUES(?,?,?,?,?,?)', c.code, groupId, (c.before?.planned_borrower_id as string | null) ?? null, String(c.before?.planned_state ?? 'unassigned'), actor.id, now);
          run(`UPDATE items SET name=?,item_scope=?,item_owner=?,photo_required=?,planned_borrower_id=?,planned_state='pending',planned_assigned_at=?,planned_actor_id=?,planned_consumed_operation=NULL,version=version+1 WHERE code=?`, String(a.name), a.item_scope as string | null, a.item_owner as string | null, a.photo_required as number | null, groupId, now, actor.id, c.code);
        }
      }
      const after = this.snapshot();
      // Audit and edits are in the same transaction. A failed audit rolls everything back.
      run('INSERT INTO issuer_management_events VALUES(?,?,?,?,?,?)', randomUUID(), p.mode, actor.id, now, canonical(changes.map(c => c.before)), canonical(changes.map(c => c.after)));
      this.store.db.exec('COMMIT');
      this.previews.delete(p.id);
      return { ...after,...(resetResult??{}), changed_count: changes.filter(c => c.fields.length).length, action: p.mode };
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
}
