import {createHash,randomUUID} from 'node:crypto';
import type {Actor,RentalStore} from './store.js';
import {canonical,RentalError,utcNow} from './validate.js';

const TABLES=['items','issuance','borrowers','preassignment_events','item_metadata_events','card_history_seed','card_history_events','card_history_claims','card_history_locks','card_history_evidence','card_history_recovery'] as const;
type Row=Record<string,unknown>;
export function numberingState(store:RentalStore) {
  const tables:Record<string,Row[]>={};
  for(const name of TABLES) if(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name))
    tables[name]=store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() as Row[];
  tables.__sequences=store.db.prepare("SELECT * FROM sqlite_sequence WHERE name IN ('preassignment_events','item_metadata_events','card_history_events') ORDER BY name").all() as Row[];
  return tables;
}
export function numberingRevision(store:RentalStore) {
  return createHash('sha256').update(canonical({generation:store.ledgerGeneration(),tables:numberingState(store)})).digest('hex');
}
export function resetNumbering(store:RentalStore,actor:Actor,writersStopped=false) {
  const tables=numberingState(store),generation=store.ledgerGeneration();
  if(!writersStopped&&((tables.card_history_locks?.length??0)>0 || tables.card_history_claims?.some(r=>['open','writing'].includes(String(r.state)))))
    throw new RentalError(409,'発行中・未完了の予約があります。完了または取り消してから初期化してください。','card_busy');
  const maxVersion=(tables.items??[]).reduce((n,r)=>Math.max(n,Number(r.version)),store.itemVersionFloor());
  const floor=maxVersion+1000000;
  if(!Number.isSafeInteger(floor)||!Number.isSafeInteger(generation+1)) throw new RentalError(409,'版番号を安全に更新できません。');
  const archive=randomUUID(),at=utcNow(),json=canonical(tables);
  store.db.prepare('INSERT INTO numbering_reset_archives(id,generation,actor_id,server_at,sha256,snapshot_json) VALUES(?,?,?,?,?,?)')
    .run(archive,generation,actor.id,at,createHash('sha256').update(json).digest('hex'),json);
  for(const name of TABLES)if(name in tables)store.db.exec(`DELETE FROM ${name}`);
  // Only the counters being reset; permission and audit counters remain intact.
  for(const name of ['preassignment_events','item_metadata_events','card_history_events'])
    store.db.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(name);
  const config=store.db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  config.run('rental_ledger_generation',String(generation+1));
  config.run('rental_item_version_floor',String(floor));
  if('card_history_seed' in tables)store.db.prepare('INSERT INTO card_history_seed VALUES(1,?,?,?,?)').run('',createHash('sha256').update('').digest('hex'),actor.id,at);
  return {archive_id:archive,ledger_generation:generation+1,reserved_through:100000};
}
