import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
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
  const secret = { name: '合成', purpose: '合成の用途', url: 'https://example.invalid', username: 'synthetic', email: 'synthetic@example.invalid', password: 'Synthetic-Pass', notes: '' };

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
    // A tag cut down to 4 bytes is refused, not checked as a shorter tag.
    const short = { ...sealed, tag: Buffer.from(sealed.tag, 'base64').subarray(0, 4).toString('base64') };
    expect(() => cipher.open('vs_0000000000000001', 've_0000000000000001', short)).toThrow(VaultUnreadable);
    const tampered = { ...sealed, data: Buffer.from(Buffer.from(sealed.data, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') };
    expect(() => cipher.open('vs_0000000000000001', 've_0000000000000001', tampered)).toThrow(VaultUnreadable);
  });

  it('opens an entry sealed before 用途 and 登録メールアドレス with both empty', () => {
    // Sealed the way the first version did (2026-11-23, PR #78): the same key derivation and additional data, five fields.
    const master = Buffer.from(KEY_HEX, 'hex');
    const key = Buffer.from(hkdfSync('sha256', master, Buffer.from('iyakusai-vault'), Buffer.from('vault-entries/v1'), 32));
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    c.setAAD(Buffer.from('iyakusai-vault|v1|vs_0000000000000001|ve_0000000000000001', 'utf8'));
    const old = { name: '合成', url: '', username: 'synthetic', password: 'Synthetic-Old-Pass', notes: '' };
    const data = Buffer.concat([c.update(JSON.stringify(old), 'utf8'), c.final()]);
    const cipher = new VaultCipher(master);
    const sealed = { keyId: cipher.keyId, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    expect(cipher.open('vs_0000000000000001', 've_0000000000000001', sealed)).toEqual({ ...old, purpose: '', email: '' });
  });

  it('leaves the two new fields out while empty, so the first version still opens such an entry after a rollback', () => {
    const master = Buffer.from(KEY_HEX, 'hex');
    const cipher = new VaultCipher(master);
    const key = Buffer.from(hkdfSync('sha256', master, Buffer.from('iyakusai-vault'), Buffer.from('vault-entries/v1'), 32));
    const plain = (s: { iv: string; tag: string; data: string }) => {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'), { authTagLength: 16 });
      d.setAAD(Buffer.from('iyakusai-vault|v1|vs_0000000000000001|ve_0000000000000001', 'utf8'));
      d.setAuthTag(Buffer.from(s.tag, 'base64'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8')) as Record<string, string>;
    };
    const empty = cipher.seal('vs_0000000000000001', 've_0000000000000001', { ...secret, purpose: '', email: '' });
    expect(Object.keys(plain(empty)).sort()).toEqual(['name', 'notes', 'password', 'url', 'username']);
    expect(cipher.open('vs_0000000000000001', 've_0000000000000001', empty)).toEqual({ ...secret, purpose: '', email: '' });
    const filled = cipher.seal('vs_0000000000000001', 've_0000000000000001', secret);
    expect(plain(filled)).toMatchObject({ purpose: '合成の用途', email: 'synthetic@example.invalid' });
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
    store.insertEntry('ve_0000000000000001', section.id, cipher.seal(section.id, 've_0000000000000001', { name: '合成', purpose: '', url: '', username: '', email: '', password: 'Synthetic-Backup-Pass', notes: '' }), null, 'u1', at);
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
