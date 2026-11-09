import type { RentalSwitchResponse } from '../../shared/rental-access.js';
import type { Actor, RentalStore } from './store.js';
import { RentalError, utcNow } from './validate.js';

const KEY = 'rental_enabled';
const HISTORY = 20;

/**
 * Whether the committee uses rental now (2026-11-09: 「しばらく使わない」). Stopped, the rental API answers
 * 503 rental_paused and the screens leave out its tab and home part; the ledger, grants and photos stay as they are,
 * and starting it again brings everything back. No stored value means in use, so a server that never touched it keeps
 * working as before. The record of changes has its own table: the access history's rows are read by the permissions
 * panel of earlier versions, which knows only its own two kinds.
 */
export class RentalSwitch {
  constructor(private readonly store: RentalStore) {}

  enabled(): boolean {
    const value = this.store.db.prepare('SELECT value FROM config WHERE key=?').get(KEY)?.value;
    if (value === undefined || value === 'true') return true;
    if (value === 'false') return false;
    throw new RentalError(500, '物品貸出の利用設定を読み取れません。', 'integrity');
  }

  /** Sets the switch; choosing what is already set changes and records nothing. */
  set(enabled: unknown, actor: Actor): void {
    if (typeof enabled !== 'boolean') throw new RentalError(400, '物品貸出を使うかどうかを、オンまたはオフで指定してください。');
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (this.enabled() !== enabled) {
        db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, String(enabled));
        db.prepare('INSERT INTO rental_switch_events(at,actor_id,actor_name,enabled) VALUES(?,?,?,?)').run(utcNow(), actor.id, actor.name, enabled ? 1 : 0);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  snapshot(nameOf: (id: string) => string | undefined): RentalSwitchResponse {
    const summary = this.store.summary();
    const rows = this.store.db.prepare('SELECT * FROM rental_switch_events ORDER BY id DESC LIMIT ?').all(HISTORY);
    return {
      enabled: this.enabled(),
      loaned: summary.counts.loaned,
      review: summary.counts.review,
      history: rows.map((row) => ({
        id: Number(row.id),
        at: String(row.at),
        actorName: nameOf(String(row.actor_id)) ?? String(row.actor_name),
        enabled: Number(row.enabled) === 1,
      })),
    };
  }
}
