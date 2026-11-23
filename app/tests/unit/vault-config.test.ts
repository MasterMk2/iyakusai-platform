import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/server/auth.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { VaultCipher, VaultUnreadable } from '../../src/server/vault/cipher.js';
import { loadVaultConfig, validateVaultConfig } from '../../src/server/vault/config.js';
import { VaultStore } from '../../src/server/vault/store.js';

// vault.json and the cipher of the password book (synthetic keys and values only).

const KEY_HEX = 'a1'.repeat(16) + 'b2'.repeat(16);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-vault-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function place(json: unknown, key = KEY_HEX): string {
  const keyFile = path.join(dir, 'vault.key');
  writeFileSync(keyFile, `${key}\n`);
  chmodSync(keyFile, 0o600);
  writeFileSync(path.join(dir, 'vault.json'), JSON.stringify(typeof json === 'function' ? (json as (f: string) => unknown)(keyFile) : json));
  return path.join(dir, 'mail.json');
}

describe('vault.json', () => {
  it('is off without the file', () => {
    expect(loadVaultConfig(path.join(dir, 'mail.json'))).toBeNull();
  });

  it('reads the key file and the window, 10 minutes by default', () => {
    const config = loadVaultConfig(place((keyFile: string) => ({ version: 1, keyFile })));
    expect(config?.revealMinutes).toBe(10);
    expect(config?.key.toString('hex')).toBe(KEY_HEX);
    expect(loadVaultConfig(place((keyFile: string) => ({ version: 1, keyFile, revealMinutes: 3 })))?.revealMinutes).toBe(3);
  });

  it('refuses unknown fields, a bad window, a short key and a missing key file, naming no secret', () => {
    const key = Buffer.from(KEY_HEX, 'hex');
    expect(() => validateVaultConfig({ version: 1, keyFile: 'x', extra: true }, key)).toThrow(ConfigError);
    expect(() => validateVaultConfig({ version: 1, revealMinutes: 0 }, key)).toThrow(/1〜60/);
    expect(() => validateVaultConfig({ version: 1, revealMinutes: 61 }, key)).toThrow(/1〜60/);
    expect(() => validateVaultConfig({ version: 2 }, key)).toThrow(/version/);
    expect(() => loadVaultConfig(place((keyFile: string) => ({ version: 1, keyFile }), 'abcd'))).toThrow(/32 バイト/);
    expect(() => loadVaultConfig(place({ version: 1, keyFile: path.join(dir, 'missing.key') }))).toThrow(/読み込めません/);
    try {
      loadVaultConfig(place((keyFile: string) => ({ version: 1, keyFile }), 'abcd'));
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('abcd');
    }
  });
});

describe('cipher', () => {
  const secret = { name: '合成', url: 'https://example.invalid', username: 'synthetic', password: 'Synthetic-Pass', notes: '' };

  it('opens what it sealed, only for the same section and entry, and only with the same key', () => {
    const cipher = new VaultCipher(Buffer.from(KEY_HEX, 'hex'));
    const sealed = cipher.seal('vs_0000000000000001', 've_0000000000000001', secret);
    expect(sealed.data).not.toContain('Synthetic');
    expect(cipher.open('vs_0000000000000001', 've_0000000000000001', sealed)).toEqual(secret);
    expect(() => cipher.open('vs_0000000000000002', 've_0000000000000001', sealed)).toThrow(VaultUnreadable);
    expect(() => cipher.open('vs_0000000000000001', 've_0000000000000002', sealed)).toThrow(VaultUnreadable);
    const other = new VaultCipher(Buffer.from('c3'.repeat(32), 'hex'));
    expect(other.keyId).not.toBe(cipher.keyId);
    expect(() => other.open('vs_0000000000000001', 've_0000000000000001', sealed)).toThrow(VaultUnreadable);
    expect(() => other.open('vs_0000000000000001', 've_0000000000000001', { ...sealed, keyId: other.keyId })).toThrow(VaultUnreadable);
    const tampered = { ...sealed, data: Buffer.from(Buffer.from(sealed.data, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') };
    expect(() => cipher.open('vs_0000000000000001', 've_0000000000000001', tampered)).toThrow(VaultUnreadable);
  });

  it('gives a key id that does not reveal the key', () => {
    const cipher = new VaultCipher(Buffer.from(KEY_HEX, 'hex'));
    expect(cipher.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(KEY_HEX).not.toContain(cipher.keyId);
  });
});

describe('the backup', () => {
  it('copies vault.sqlite3 next to mail.sqlite3 as it is (sealed), and counts its rows', () => {
    const data = path.join(dir, 'data');
    const out = path.join(dir, 'backups');
    new MailboxStore(path.join(data, 'mailbox')).close();
    const store = new VaultStore(path.join(data, 'mailbox'));
    const cipher = new VaultCipher(Buffer.from(KEY_HEX, 'hex'));
    const at = '2026-11-23T01:00:00.000Z';
    const section = store.createSection('vs_0000000000000001', '合成の区分', '', 'u1', at);
    if (typeof section === 'string') throw new Error(section);
    store.insertEntry('ve_0000000000000001', section.id, cipher.seal(section.id, 've_0000000000000001', { name: '合成', url: '', username: '', password: 'Synthetic-Backup-Pass', notes: '' }), null, 'u1', at);
    store.close();

    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.resolve('src/server/ops/backup.ts')], {
      env: { ...process.env, BACKUP_DATA_DIR: data, BACKUP_OUT_DIR: out },
      stdio: 'pipe',
    });
    const [folder] = readdirSync(out);
    const manifest = JSON.parse(readFileSync(path.join(out, folder!, 'manifest.json'), 'utf8')) as { files: Record<string, unknown>; counts: Record<string, number> };
    expect(Object.keys(manifest.files)).toContain('mailbox/vault.sqlite3');
    expect(manifest.counts).toMatchObject({ 'vault.sections': 1, 'vault.members': 1, 'vault.entries': 1, 'vault.events': 2 });
    expect(readFileSync(path.join(out, folder!, 'mailbox', 'vault.sqlite3')).includes(Buffer.from('Synthetic-Backup-Pass'))).toBe(false);
  }, 30_000);
});
