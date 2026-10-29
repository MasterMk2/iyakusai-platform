import type { RentalStore } from './store.js';

// Synthetic rental sample for the loopback demo and mock compositions only (never a hosted ledger).
// The items and borrowers are the Python server's demo set; the permissions go to demo personas so
// both kinds of rental work can be tried: u-editor-a loans and issues, u-editor-c only loans.
export function seedRentalDemo(store: RentalStore): void {
  store.addItems([
    ['IY-000123', '試用 延長コード'],
    ['IY-000124', '試用 折りたたみ机'],
  ]);
  store.addBorrowers(['試用 模擬店A', '試用 模擬店B', '試用 本部']);
  if (store.listPermissions().length === 0) {
    const by = { id: 'demo-seed', name: '試用データ' };
    store.setPermissions('u-editor-a', ['rental.loan', 'rental.issue'], by);
    store.setPermissions('u-editor-c', ['rental.loan'], by);
  }
}
