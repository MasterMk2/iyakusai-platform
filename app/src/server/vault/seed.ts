import { randomBytes } from 'node:crypto';
import type { VaultSecret } from '../../shared/vault.js';
import { VaultCipher } from './cipher.js';
import type { VaultStore } from './store.js';

// Synthetic sections and entries for the demo (SMM_AUTH_MODE=demo): every name, address, ID and password is made up
// (reserved .invalid addresses). The demo has no key file: its key is this fixed, public text, so the demo's file opens
// after a restart. It protects nothing and is never used outside the demo (runtime.ts).

export const DEMO_VAULT_KEY = Buffer.from('iyakusai-demo-vault-key|synthetic-data-only|not-a-secret', 'utf8');

export function demoVaultCipher(): VaultCipher {
  return new VaultCipher(DEMO_VAULT_KEY);
}

const entry = (name: string, url: string, username: string, password: string, notes: string): VaultSecret => ({ name, url, username, password, notes });

/** Fills an empty password book with two demo sections. Does nothing otherwise. */
export function seedVaultDemo(store: VaultStore, cipher: VaultCipher, people: { admin: string; others: string[]; department: string | null }, at: string): void {
  if (store.sections().length > 0) return;
  const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;
  const add = (sectionId: string, secret: VaultSecret) => {
    const entryId = id('ve');
    store.insertEntry(entryId, sectionId, cipher.seal(sectionId, entryId, secret), null, people.admin, at);
  };
  const system = store.createSection(id('vs'), 'システム（合成）', '合成データです。サーバーと管理画面の入り口。', people.admin, at);
  if (typeof system !== 'string') {
    let version = system.version;
    const grant = (kind: 'user' | 'department', target: string, role: 'view' | 'edit' | 'manage') => {
      const out = store.setMember(system.id, version, kind, target, role, people.admin, at);
      if (out && typeof out !== 'string') version = out.version;
    };
    if (people.others[0]) grant('user', people.others[0], 'edit');
    if (people.department) grant('department', people.department, 'view');
    add(system.id, entry('サーバーの管理画面（合成）', 'https://console.example.invalid', 'demo-admin', 'Demo-Only-Pass-0001', '合成データです。\n実在のサービスではありません。'));
    add(system.id, entry('ドメインの管理（合成）', 'https://domains.example.invalid', 'demo-owner', 'Demo-Only-Pass-0002', ''));
  }
  const accounting = store.createSection(id('vs'), '会計（合成）', '合成データです。', people.admin, at);
  if (typeof accounting !== 'string') {
    if (people.others[1]) store.setMember(accounting.id, accounting.version, 'user', people.others[1], 'manage', people.admin, at);
    add(accounting.id, entry('経費精算のサービス（合成）', 'https://expenses.example.invalid', 'demo-kaikei', 'Demo-Only-Pass-0003', '合成データです。予備コード：0000-0000（合成）'));
  }
}
