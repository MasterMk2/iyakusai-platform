import type { DatabaseSync } from 'node:sqlite';

// Tables of the supply extension: items counted by number (chairs, cords, consumables), their attachments
// (付属品), the checks made at a loan or a return, and the movements behind every count. The tables sit in
// the same rental.sqlite3 as the card ledger and are only added (IF NOT EXISTS). The card tables, the card
// history and the Google Drive copy do not read or write them.
//
// Counts are never stored as a number that can drift: stock, lent and consumed counts are sums over
// supply_movements, which is append-only. A mistake is undone by a new movement that reverses it.
const SUPPLY_SCHEMA = `
CREATE TABLE IF NOT EXISTS supply_items(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('lend','consumable')),
  low_threshold INTEGER NOT NULL DEFAULT 0 CHECK(low_threshold>=0),
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS supply_movements(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES supply_items(id),
  kind TEXT NOT NULL CHECK(kind IN ('stock','lend','return','consume','reverse')),
  group_name TEXT,
  qty INTEGER NOT NULL CHECK(qty>=0),
  lost INTEGER NOT NULL DEFAULT 0 CHECK(lost>=0),
  d_on_hand INTEGER NOT NULL,
  d_lent INTEGER NOT NULL,
  d_consumed INTEGER NOT NULL,
  reverses INTEGER,
  note TEXT NOT NULL DEFAULT '',
  batch_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  server_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supply_movements_item ON supply_movements(item_id,id);
CREATE INDEX IF NOT EXISTS supply_movements_group ON supply_movements(group_name,item_id);
CREATE INDEX IF NOT EXISTS supply_movements_reverses ON supply_movements(reverses);
CREATE TABLE IF NOT EXISTS supply_attachments(
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('card','supply')),
  owner_key TEXT NOT NULL,
  name TEXT NOT NULL,
  expected INTEGER NOT NULL CHECK(expected>=1),
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS supply_attachments_owner ON supply_attachments(owner_kind,owner_key);
CREATE TABLE IF NOT EXISTS supply_attachment_checks(
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('card','supply')),
  owner_key TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('borrow','return','check')),
  group_name TEXT,
  units INTEGER NOT NULL CHECK(units>=1),
  missing_total INTEGER NOT NULL CHECK(missing_total>=0),
  lines_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  server_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supply_checks_owner ON supply_attachment_checks(owner_kind,owner_key);
CREATE TABLE IF NOT EXISTS supply_requests(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('lend','return','consume')),
  actor_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  server_at TEXT NOT NULL
);
`;

/** Creates the supply tables when they are missing. Safe to call on every start. */
export function ensureSupplySchema(db: DatabaseSync): void {
  db.exec(SUPPLY_SCHEMA);
}
