import { randomUUID } from 'node:crypto';
import type { RentalStore } from '../store.js';
import { SupplyStore } from './store.js';

// Synthetic counted supplies for the loopback demo only: a few lendable items, consumables, attachments on
// the demo cards, and one loan to a demo group so the 団体 page has something to show. Runs once: when the
// demo ledger already has counted items, nothing is added again.
export function seedSupplyDemo(rental: RentalStore): void {
  const supplies = new SupplyStore(rental);
  if (rental.get('SELECT COUNT(*) AS n FROM supply_items')!.n !== 0) return;
  const actor = { id: 'demo-seed', name: '試用データ' };
  const chair = supplies.createItem({ name: '試用 パイプ椅子', unit: '脚', kind: 'lend', low_threshold: 5, initial_on_hand: 40, note: '合成データ' }, actor);
  supplies.createItem({ name: '試用 延長コード 10m', unit: '本', kind: 'lend', low_threshold: 2, initial_on_hand: 12, note: '合成データ' }, actor);
  supplies.createItem({ name: '試用 小机', unit: '台', kind: 'lend', low_threshold: 2, initial_on_hand: 10, note: '合成データ' }, actor);
  supplies.createItem({ name: '試用 養生テープ', unit: '巻', kind: 'consumable', low_threshold: 5, initial_on_hand: 20, note: '合成データ' }, actor);
  supplies.createItem({ name: '試用 黒ペン', unit: '本', kind: 'consumable', low_threshold: 10, initial_on_hand: 30, note: '合成データ' }, actor);
  const cover = supplies.createAttachment({ owner_kind: 'supply', owner_key: chair.id, name: '座面カバー', expected: 1, note: '1 脚につき 1 枚' }, actor);
  supplies.createAttachment({ owner_kind: 'card', owner_key: 'IY-000123', name: 'ケーブルバンド', expected: 3 }, actor);
  supplies.createAttachment({ owner_kind: 'card', owner_key: 'IY-000124', name: '脚キャップ', expected: 4 }, actor);
  // The loan carries its own check: all 10 covers came back with the chairs (借用時の点検 in the same operation).
  supplies.lend({
    id: randomUUID(),
    group: '試用 模擬店A',
    lines: [{ item_id: chair.id, qty: 10, expected_version: chair.version, attachments: [{ attachment_id: cover.id, found: 10 }] }],
  }, actor);
}
