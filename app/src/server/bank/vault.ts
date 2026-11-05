import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import { writeFileDurable } from '../durable-file.js';

// The bank's tokens at rest (2026-11-06). One small file in the data folder, encrypted with AES-256-GCM:
// - The key is derived (HKDF-SHA256) from the operator's token key, which lives in the configuration folder, not here.
//   A copy of the data folder alone (a backup, a rescue copy) reveals nothing; the backup leaves this file out anyway.
// - The additional data binds the file to the environment and the client id: a file written for sunabar, or for
//   another client, fails to open instead of being used.
// - Written whole and atomically (writeFileDurable, 0600). A file that fails to open is reported, never repaired.
// Nothing here logs, and no error message carries a token, the key or the file's contents.

export interface BankTokens {
  accessToken: string;
  /** Null when the bank gave none: the access token is used until it expires, then the member connects again. */
  refreshToken: string | null;
  /** Epoch milliseconds, or null when the bank did not say (expires_in absent). */
  expiresAt: number | null;
  scopes: string[];
  connectedAt: string;
  /** App user id of the member who connected. */
  connectedBy: string;
  refreshedAt: string | null;
}

const tokensSchema = z.object({
  accessToken: z.string().min(1).max(4096),
  refreshToken: z.string().min(1).max(4096).nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
  scopes: z.array(z.string().max(100)).max(20),
  connectedAt: z.string().max(40),
  connectedBy: z.string().max(100),
  refreshedAt: z.string().max(40).nullable(),
});

const fileSchema = z.object({ version: z.literal(1), alg: z.literal('A256GCM'), iv: z.string(), tag: z.string(), data: z.string() });

/** The file exists but cannot be opened (another key or client, or changed bytes). */
export class VaultUnreadable extends Error {
  constructor() {
    super('bank token file cannot be opened');
    this.name = 'VaultUnreadable';
  }
}

export class BankVault {
  readonly #file: string;
  readonly #key: Buffer;
  readonly #aad: Buffer;

  constructor(file: string, tokenKey: Buffer, binding: { environment: string; clientId: string }) {
    this.#file = file;
    this.#key = Buffer.from(hkdfSync('sha256', tokenKey, Buffer.from('iyakusai-bank-vault'), Buffer.from('bank-tokens/v1'), 32));
    this.#aad = Buffer.from(`iyakusai-bank-tokens|v1|${binding.environment}|${binding.clientId}`, 'utf8');
  }

  exists(): boolean {
    return existsSync(this.#file);
  }

  /** The tokens, null when none are held; throws VaultUnreadable when the file cannot be opened. */
  read(): BankTokens | null {
    if (!existsSync(this.#file)) return null;
    try {
      const outer = fileSchema.parse(JSON.parse(readFileSync(this.#file, 'utf8')));
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(outer.iv, 'base64'));
      decipher.setAAD(this.#aad);
      decipher.setAuthTag(Buffer.from(outer.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(outer.data, 'base64')), decipher.final()]);
      return tokensSchema.parse(JSON.parse(plain.toString('utf8')));
    } catch {
      throw new VaultUnreadable();
    }
  }

  write(tokens: BankTokens): void {
    const plain = Buffer.from(JSON.stringify(tokensSchema.parse(tokens)), 'utf8');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(this.#aad);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    const outer = { version: 1, alg: 'A256GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    writeFileDurable(this.#file, `${JSON.stringify(outer)}\n`);
  }

  /** Forgets the tokens (the bank's own permission stays until it expires: there is no revoke API). */
  clear(): void {
    try {
      unlinkSync(this.#file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
