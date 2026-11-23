import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { VAULT_LIMITS, type VaultSecret } from '../../shared/vault.js';

// The entries of the password book at rest (2026-11-23): each entry is one AES-256-GCM message.
// - The key is derived (HKDF-SHA256) from the operator's key file in the configuration folder. A copy of the data
//   folder alone (the app's backup, a rescue copy) reveals nothing, the names of the entries included.
// - Each message carries the id of the key that sealed it (an HMAC of the key, which tells nothing about it), so a key
//   that was replaced is reported instead of producing garbage, and a later rotation can tell old from new.
// - The additional data binds the message to its section and entry: a row moved to another section, or swapped with
//   another entry, fails to open instead of being shown there.
// Nothing here logs, and no error message carries a value, the key or the stored bytes.

export interface Sealed {
  keyId: string;
  iv: string;
  tag: string;
  data: string;
}

const secretSchema = z.strictObject({
  name: z.string().max(VAULT_LIMITS.entryName),
  url: z.string().max(VAULT_LIMITS.url),
  username: z.string().max(VAULT_LIMITS.username),
  password: z.string().max(VAULT_LIMITS.password),
  notes: z.string().max(VAULT_LIMITS.notes),
});

/** A stored entry that cannot be opened (another key, another section or entry, or changed bytes). */
export class VaultUnreadable extends Error {
  constructor() {
    super('vault entry cannot be opened');
    this.name = 'VaultUnreadable';
  }
}

export class VaultCipher {
  readonly keyId: string;
  readonly #key: Buffer;

  constructor(master: Buffer) {
    this.#key = Buffer.from(hkdfSync('sha256', master, Buffer.from('iyakusai-vault'), Buffer.from('vault-entries/v1'), 32));
    this.keyId = createHmac('sha256', master).update('iyakusai-vault-key-id/v1').digest('hex').slice(0, 16);
  }

  static #aad(sectionId: string, entryId: string): Buffer {
    return Buffer.from(`iyakusai-vault|v1|${sectionId}|${entryId}`, 'utf8');
  }

  seal(sectionId: string, entryId: string, secret: VaultSecret): Sealed {
    const plain = Buffer.from(JSON.stringify(secretSchema.parse(secret)), 'utf8');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv, { authTagLength: 16 });
    cipher.setAAD(VaultCipher.#aad(sectionId, entryId));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { keyId: this.keyId, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  open(sectionId: string, entryId: string, sealed: Sealed): VaultSecret {
    if (sealed.keyId !== this.keyId) throw new VaultUnreadable();
    const iv = Buffer.from(sealed.iv, 'base64');
    const tag = Buffer.from(sealed.tag, 'base64');
    // A full 128-bit tag only: a cut-down tag would weaken the check against changed bytes.
    if (iv.length !== 12 || tag.length !== 16) throw new VaultUnreadable();
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv, { authTagLength: 16 });
      decipher.setAAD(VaultCipher.#aad(sectionId, entryId));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
      return secretSchema.parse(JSON.parse(plain.toString('utf8')));
    } catch {
      throw new VaultUnreadable();
    }
  }
}
