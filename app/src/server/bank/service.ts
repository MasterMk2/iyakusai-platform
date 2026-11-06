import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { BankCheckResponse, BankConnectionState } from '../../shared/bank.js';
import { writeFileDurable } from '../durable-file.js';
import { authorizeUrl, BankApiError, listAccounts, listBalances, requestToken, type BankFetch, type TokenGrant } from './client.js';
import type { BankConfig } from './config.js';
import { BankVault, VaultUnreadable, type BankTokens } from './vault.js';

// The bank connection's lifecycle (2026-11-06):
//   start    -> a one-time state for the member who pressed 接続 (in memory, 10 minutes)
//   complete -> the same member's browser hands back the code; the state is used up whatever happens; the code is
//               exchanged at once (the bank gives it 60 seconds) and the tokens go into the vault
//   use      -> the access token, renewed with the refresh token in the second half of its life; one renewal at a time,
//               and the new tokens are saved before they are used (a bank that rotates refresh tokens loses nothing)
//   refused  -> the bank refused the refresh token: the vault is cleared and the screen says 要再接続
//   disconnect -> the vault is cleared (the bank has no revoke API; its permission stays until it expires)
//   sweep    -> every few minutes (2026-11-07): an access token past its expiry is renewed, or deleted when it cannot
//               be, so no expired token stays on disk (the bank's API checklist, Sec-37)
// The audit file records who did what and the outcome, never a token, a code or the bank's answer.

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[\x21-\x7e]{1,2048}$/;
/** Renew when this little is left whatever the lifetime. */
const MIN_REMAINING_MS = 60_000;
/** How often the server looks for expired tokens to renew or delete. */
export const BANK_SWEEP_INTERVAL_MS = 10 * 60_000;

export const BANK_STATE_FILE = 'bank-state.json';

/** What one sweep did. */
export type BankSweepOutcome = 'none' | 'valid' | 'unreadable' | 'renewed' | 'deleted' | 'failed';

/** A refusal for the member, with words for the screen (no secret in it). */
export class BankFlowError extends Error {
  constructor(
    readonly reason: 'not_connected' | 'expired' | 'reconnect' | 'state' | 'busy' | 'bank',
    message: string,
    readonly bankKind: BankApiError['kind'] | null = null,
  ) {
    super(message);
    this.name = 'BankFlowError';
  }
}

const metaSchema = z.object({
  version: z.literal(1),
  reconnectRequired: z.boolean(),
  lastError: z.object({ at: z.string().max(40), message: z.string().max(500) }).nullable(),
});
type Meta = z.infer<typeof metaSchema>;

export interface BankServiceDeps {
  fetch: BankFetch;
  now: () => number;
  clock: () => string;
}

export interface BankStatusCore {
  state: BankConnectionState;
  scopes: string[];
  connectedAt: string | null;
  connectedBy: string | null;
  accessTokenExpiresAt: string | null;
  refreshable: boolean;
  lastRefreshedAt: string | null;
  lastError: { at: string; message: string } | null;
}

const stateKey = (state: string) => createHash('sha256').update(state, 'utf8').digest('hex');

export class BankService {
  readonly config: BankConfig;
  readonly #deps: BankServiceDeps;
  readonly #vault: BankVault;
  readonly #metaFile: string;
  readonly #pending = new Map<string, { userId: string; createdAt: number }>();
  #meta: Meta;
  #renewing: Promise<BankTokens> | null = null;
  #checking = false;

  constructor(config: BankConfig, deps: BankServiceDeps) {
    this.config = config;
    this.#deps = deps;
    this.#vault = new BankVault(config.tokenFile, config.tokenKey, { environment: config.environment, clientId: config.clientId });
    this.#metaFile = join(dirname(config.tokenFile), BANK_STATE_FILE);
    this.#meta = this.#readMeta();
  }

  // ---- connect

  /** A new one-time state for this member and the bank's page to send the browser to. */
  start(userId: string): string {
    this.#prune();
    while (this.#pending.size >= MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value!);
    const state = randomBytes(32).toString('base64url');
    this.#pending.set(stateKey(state), { userId, createdAt: this.#deps.now() });
    this.#audit('connect_started', userId, 'ok');
    return authorizeUrl(this.config, state);
  }

  /** The browser came back: with a code (allowed) or an error (not allowed). The state is used up either way. */
  async complete(userId: string, input: { state: string; code?: string; error?: string }): Promise<void> {
    const entry = STATE_PATTERN.test(input.state) ? this.#take(input.state) : null;
    if (!entry || entry.userId !== userId || this.#deps.now() - entry.createdAt > STATE_TTL_MS) {
      this.#audit('connect_failed', userId, 'state');
      throw new BankFlowError('state', '接続の手続きが見つからないか、時間が切れています。設定の「銀行と接続する」からもう一度始めてください。');
    }
    if (input.code === undefined) {
      this.#audit('connect_failed', userId, input.error === 'access_denied' ? 'denied' : 'bank_error');
      throw new BankFlowError('bank', input.error === 'access_denied' ? '銀行の画面で接続が許可されませんでした。' : '銀行の画面で接続できませんでした。もう一度試してください。');
    }
    if (!CODE_PATTERN.test(input.code)) {
      this.#audit('connect_failed', userId, 'code');
      throw new BankFlowError('bank', '銀行から戻った値の形が正しくありません。もう一度試してください。');
    }
    let grant: TokenGrant;
    try {
      grant = await requestToken(this.config, this.#deps.fetch, { grant_type: 'authorization_code', code: input.code, redirect_uri: this.config.redirectUri }, this.config.scopes);
    } catch (err) {
      if (err instanceof BankApiError) {
        this.#audit('connect_failed', userId, err.kind);
        this.#setError(err.message);
        throw new BankFlowError('bank', err.message, err.kind);
      }
      throw err;
    }
    const at = this.#deps.clock();
    this.#vault.write({ accessToken: grant.accessToken, refreshToken: grant.refreshToken, expiresAt: this.#expiresAt(grant), scopes: grant.scopes, connectedAt: at, connectedBy: userId, refreshedAt: null });
    this.#pending.clear();
    this.#writeMeta({ version: 1, reconnectRequired: false, lastError: null });
    this.#audit('connected', userId, 'ok');
  }

  disconnect(userId: string): void {
    this.#vault.clear();
    this.#pending.clear();
    this.#writeMeta({ version: 1, reconnectRequired: false, lastError: null });
    this.#audit('disconnected', userId, 'ok');
  }

  // ---- use

  /** A usable access token, renewed first when it is in the second half of its life. */
  async accessToken(): Promise<string> {
    const tokens = this.#tokens();
    if (!this.#dueForRenewal(tokens)) return tokens.accessToken;
    if (!tokens.refreshToken) {
      if (tokens.expiresAt !== null && tokens.expiresAt <= this.#deps.now()) throw new BankFlowError('expired', 'トークンの期限が切れました。権限管理者が「銀行と接続する」からつなぎ直してください。');
      return tokens.accessToken;
    }
    return (await this.#renew(tokens)).accessToken;
  }

  /** 接続を確かめる: the accounts and their balances, account numbers cut to the last four digits. */
  async check(userId: string): Promise<BankCheckResponse> {
    if (this.#checking) throw new BankFlowError('busy', 'ほかの人が確かめているところです。少し待ってからもう一度押してください。');
    this.#checking = true;
    try {
      const rows = await this.#withToken(async (token) => {
        const accounts = await listAccounts(this.config, this.#deps.fetch, token);
        const balances = await listBalances(this.config, this.#deps.fetch, token);
        return { accounts, balances };
      });
      this.#audit('checked', userId, 'ok');
      if (this.#meta.lastError) this.#writeMeta({ ...this.#meta, lastError: null });
      return {
        checkedAt: this.#deps.clock(),
        accounts: rows.accounts.map((a) => ({
          branchName: a.branchName,
          accountTypeName: a.accountTypeName,
          accountNumberLast4: a.accountNumber ? a.accountNumber.replace(/\D/g, '').slice(-4) || null : null,
          balanceYen: rows.balances.get(a.accountId) ?? null,
        })),
      };
    } catch (err) {
      this.#audit('check_failed', userId, err instanceof BankApiError ? err.kind : err instanceof BankFlowError ? err.reason : 'error');
      if (err instanceof BankApiError) {
        this.#setError(err.message);
        throw new BankFlowError('bank', err.message, err.kind);
      }
      throw err;
    } finally {
      this.#checking = false;
    }
  }

  status(): BankStatusCore {
    let tokens: BankTokens | null = null;
    let unreadable = false;
    try {
      tokens = this.#vault.read();
    } catch (err) {
      if (!(err instanceof VaultUnreadable)) throw err;
      unreadable = true;
    }
    const lastError = unreadable ? { at: this.#deps.clock(), message: '保存したトークンを開けません（鍵か client_id が変わった可能性があります）。つなぎ直してください。' } : this.#meta.lastError;
    if (!tokens) {
      return { state: unreadable || this.#meta.reconnectRequired ? 'reconnect_required' : 'disconnected', scopes: [], connectedAt: null, connectedBy: null, accessTokenExpiresAt: null, refreshable: false, lastRefreshedAt: null, lastError };
    }
    const expired = tokens.expiresAt !== null && tokens.expiresAt <= this.#deps.now() && !tokens.refreshToken;
    return {
      state: expired ? 'expired' : 'connected',
      scopes: tokens.scopes,
      connectedAt: tokens.connectedAt,
      connectedBy: tokens.connectedBy,
      accessTokenExpiresAt: tokens.expiresAt === null ? null : new Date(tokens.expiresAt).toISOString(),
      refreshable: tokens.refreshToken !== null,
      lastRefreshedAt: tokens.refreshedAt,
      lastError,
    };
  }

  /**
   * Removes tokens that have run out, so none outlives its expiry on disk. Without a refresh token, an expired
   * access token is deleted. With one, it is renewed (the new tokens replace the file), and a refresh token the bank
   * no longer takes is deleted by the renewal itself. A network failure keeps the tokens for the next sweep. A file
   * this server cannot open (another key or client) is left for the member to reconnect over.
   */
  async sweep(): Promise<BankSweepOutcome> {
    let tokens: BankTokens | null;
    try {
      tokens = this.#vault.read();
    } catch (err) {
      if (err instanceof VaultUnreadable) return 'unreadable';
      throw err;
    }
    if (!tokens) return 'none';
    if (tokens.expiresAt === null || tokens.expiresAt > this.#deps.now()) return 'valid';
    if (!tokens.refreshToken) {
      this.#vault.clear();
      this.#writeMeta({ version: 1, reconnectRequired: true, lastError: { at: this.#deps.clock(), message: 'トークンの期限が切れたので、保存していたトークンを削除しました。つなぎ直してください。' } });
      this.#audit('expired_deleted', null, 'ok');
      return 'deleted';
    }
    try {
      await this.#renew(tokens, true);
      return 'renewed';
    } catch (err) {
      if (err instanceof BankFlowError && err.reason === 'reconnect') return 'deleted';
      return 'failed';
    }
  }

  // ---- internals

  async #withToken<T>(use: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken();
    try {
      return await use(token);
    } catch (err) {
      // A token the bank no longer takes: renew once if we can, otherwise ask for a new connection.
      if (!(err instanceof BankApiError) || err.kind !== 'unauthorized') throw err;
      const tokens = this.#tokens();
      if (!tokens.refreshToken) {
        this.#writeMeta({ version: 1, reconnectRequired: true, lastError: { at: this.#deps.clock(), message: '銀行がトークンを受け付けなくなりました。つなぎ直してください。' } });
        this.#vault.clear();
        throw new BankFlowError('reconnect', '銀行がトークンを受け付けなくなりました。権限管理者が「銀行と接続する」からつなぎ直してください。');
      }
      return use((await this.#renew(tokens, true)).accessToken);
    }
  }

  #tokens(): BankTokens {
    let tokens: BankTokens | null;
    try {
      tokens = this.#vault.read();
    } catch (err) {
      if (err instanceof VaultUnreadable) throw new BankFlowError('reconnect', '保存したトークンを開けません。権限管理者が「銀行と接続する」からつなぎ直してください。');
      throw err;
    }
    if (!tokens) throw new BankFlowError(this.#meta.reconnectRequired ? 'reconnect' : 'not_connected', this.#meta.reconnectRequired ? '銀行との接続が切れています。権限管理者が「銀行と接続する」からつなぎ直してください。' : '銀行とまだ接続していません。');
    return tokens;
  }

  #dueForRenewal(tokens: BankTokens): boolean {
    if (tokens.expiresAt === null) return false;
    const now = this.#deps.now();
    const issued = Date.parse(tokens.refreshedAt ?? tokens.connectedAt);
    const half = Number.isFinite(issued) ? issued + (tokens.expiresAt - issued) / 2 : tokens.expiresAt;
    return now >= half || tokens.expiresAt - now <= MIN_REMAINING_MS;
  }

  /** One renewal at a time; everyone waiting gets the same new tokens. */
  #renew(current: BankTokens, force = false): Promise<BankTokens> {
    if (this.#renewing) return this.#renewing;
    const run = (async () => {
      // Another caller may have renewed while this one waited for the file.
      const latest = this.#tokens();
      if (!force && latest.accessToken !== current.accessToken && !this.#dueForRenewal(latest)) return latest;
      if (!latest.refreshToken) throw new BankFlowError('expired', 'トークンの期限が切れました。権限管理者が「銀行と接続する」からつなぎ直してください。');
      let grant: TokenGrant;
      try {
        grant = await requestToken(this.config, this.#deps.fetch, { grant_type: 'refresh_token', refresh_token: latest.refreshToken }, latest.scopes);
      } catch (err) {
        if (err instanceof BankApiError && (err.kind === 'invalid_grant' || err.kind === 'scope')) {
          this.#vault.clear();
          this.#writeMeta({ version: 1, reconnectRequired: true, lastError: { at: this.#deps.clock(), message: err.kind === 'scope' ? err.message : '銀行がトークンの更新を断りました。つなぎ直してください。' } });
          this.#audit('refresh_rejected', null, err.kind);
          throw new BankFlowError('reconnect', '銀行がトークンの更新を断りました。権限管理者が「銀行と接続する」からつなぎ直してください。', err.kind);
        }
        if (err instanceof BankApiError) {
          this.#setError(`トークンを更新できませんでした: ${err.message}`);
          this.#audit('refresh_failed', null, err.kind);
        }
        throw err;
      }
      const renewed: BankTokens = {
        ...latest,
        accessToken: grant.accessToken,
        // A bank that does not rotate keeps the old refresh token.
        refreshToken: grant.refreshToken ?? latest.refreshToken,
        expiresAt: this.#expiresAt(grant),
        scopes: grant.scopes,
        refreshedAt: this.#deps.clock(),
      };
      // Saved before anyone uses it: a crash after this point loses nothing.
      this.#vault.write(renewed);
      this.#audit('refreshed', null, 'ok');
      return renewed;
    })();
    this.#renewing = run;
    return run.finally(() => {
      if (this.#renewing === run) this.#renewing = null;
    });
  }

  #expiresAt(grant: TokenGrant): number | null {
    return grant.expiresIn === null ? null : this.#deps.now() + grant.expiresIn * 1000;
  }

  #take(state: string): { userId: string; createdAt: number } | null {
    const key = stateKey(state);
    const entry = this.#pending.get(key) ?? null;
    this.#pending.delete(key);
    return entry;
  }

  #prune(): void {
    const now = this.#deps.now();
    for (const [key, entry] of this.#pending) if (now - entry.createdAt > STATE_TTL_MS) this.#pending.delete(key);
  }

  #readMeta(): Meta {
    try {
      if (existsSync(this.#metaFile)) return metaSchema.parse(JSON.parse(readFileSync(this.#metaFile, 'utf8')));
    } catch {
      // An unreadable state file only loses the last error; the tokens are separate.
    }
    return { version: 1, reconnectRequired: false, lastError: null };
  }

  #writeMeta(meta: Meta): void {
    this.#meta = meta;
    writeFileDurable(this.#metaFile, `${JSON.stringify(meta)}\n`);
  }

  #setError(message: string): void {
    this.#writeMeta({ ...this.#meta, lastError: { at: this.#deps.clock(), message: message.slice(0, 500) } });
  }

  #audit(action: string, actor: string | null, outcome: string): void {
    try {
      appendFileSync(this.config.auditFile, `${JSON.stringify({ at: this.#deps.clock(), action, actor, outcome })}\n`, { mode: 0o600 });
    } catch {
      // The audit line is best effort; the action itself already succeeded or failed on its own.
    }
  }
}
