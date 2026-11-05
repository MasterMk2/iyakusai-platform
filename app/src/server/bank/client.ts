import { z } from 'zod';
import { BANK_SCOPES } from '../../shared/bank.js';
import type { BankConfig } from './config.js';

// The calls to the bank (GMO あおぞらネット銀行 API, as in its OAuth2.0 specification and the sunabar Postman set):
// the authorization address, the token endpoint (code and refresh), and two read APIs. There is no general
// "call any path" function and no transfer call: what the app can ask the bank is exactly what is written here.
// Errors carry a kind and words for the screen, never the bank's raw answer, a token or the code.

export type BankFetch = typeof fetch;

export type BankErrorKind =
  /** The bank refused the code or the refresh token (expired, used, or Redirect_uri differs). */
  | 'invalid_grant'
  /** The bank refused the client id / secret. */
  | 'client_rejected'
  /** The bank granted more than the read scopes; nothing was kept. */
  | 'scope'
  /** The access token was refused by a read API. */
  | 'unauthorized'
  /** The bank could not be reached or answered 5xx. */
  | 'unavailable'
  /** Any other refusal or an answer that could not be read. */
  | 'unexpected';

export class BankApiError extends Error {
  constructor(
    readonly kind: BankErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BankApiError';
  }
}

const TIMEOUT_MS = 15_000;
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

const tokenAnswer = z.object({
  access_token: z.string().min(1).max(4096),
  token_type: z.string().max(40).optional(),
  // The specification gives seconds as a number; accept a numeric string too.
  expires_in: z.union([z.number(), z.string().regex(/^\d{1,10}$/)]).optional(),
  refresh_token: z.string().min(1).max(4096).optional(),
  scope: z.string().max(1000).optional(),
});

export interface TokenGrant {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds, or null when the bank did not say. */
  expiresIn: number | null;
  scopes: string[];
}

/** Query value: percent-encoded, but ":" kept as in the bank's own examples (scope=private:account%20private:…). */
const encodeScope = (scope: string) => encodeURIComponent(scope).replace(/%3A/gi, ':');

/** The bank's authorization page for this client, asking only for the configured read scopes. */
export function authorizeUrl(config: BankConfig, state: string): string {
  const params = [
    `response_type=code`,
    `client_id=${encodeURIComponent(config.clientId)}`,
    `redirect_uri=${encodeURIComponent(config.redirectUri)}`,
    // Spaces as %20, never "+": the gateway compares scopes literally.
    `scope=${config.scopes.map(encodeScope).join('%20')}`,
    `state=${encodeURIComponent(state)}`,
  ];
  return `${config.endpoints.authorize}?${params.join('&')}`;
}

async function readAnswer(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_ANSWER_BYTES) throw new BankApiError('unexpected', '銀行の応答が大きすぎます。');
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

async function send(fetchImpl: BankFetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new BankApiError('unavailable', '銀行に接続できませんでした。時間をおいてもう一度試してください。');
  }
}

/** Token endpoint: grant_type=authorization_code or refresh_token, with the configured client authentication. */
export async function requestToken(config: BankConfig, fetchImpl: BankFetch, params: Record<string, string>, requested: readonly string[]): Promise<TokenGrant> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (config.clientAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')}`;
  } else {
    body.set('client_id', config.clientId);
    body.set('client_secret', config.clientSecret);
  }
  const res = await send(fetchImpl, config.endpoints.token, { method: 'POST', headers, body: body.toString() });
  const answer = await readAnswer(res);
  if (!res.ok) {
    const code = answer && typeof answer === 'object' ? (answer as Record<string, unknown>).error : undefined;
    if (code === 'invalid_grant') throw new BankApiError('invalid_grant', '銀行が受け付けませんでした（認可コードの期限 60 秒が過ぎたか、Redirect_uri が銀行の登録と違う可能性があります）。もう一度接続してください。');
    if (code === 'invalid_client' || res.status === 401) throw new BankApiError('client_rejected', '銀行がクライアントID・シークレットを受け付けませんでした。bank.json と銀行の画面の値を確かめてください。');
    if (code === 'invalid_scope') throw new BankApiError('scope', '銀行がスコープを受け付けませんでした。銀行の画面で private:account などが ON になっているか確かめてください。');
    if (res.status >= 500) throw new BankApiError('unavailable', '銀行が一時的に応答できませんでした。時間をおいてもう一度試してください。');
    throw new BankApiError('unexpected', `銀行がトークンの要求を受け付けませんでした（HTTP ${res.status}）。`);
  }
  const parsed = tokenAnswer.safeParse(answer);
  if (!parsed.success) throw new BankApiError('unexpected', '銀行のトークンの応答を読めませんでした。');
  const granted = parsed.data.scope ? parsed.data.scope.split(/[\s+]+/).filter(Boolean) : [...requested];
  if (granted.some((s) => !(BANK_SCOPES as readonly string[]).includes(s))) {
    throw new BankApiError('scope', '銀行の許可に照会以外の権限（振込など）が含まれていたので、保存しませんでした。銀行の画面のアカウント設定で、private:account と private:virtual-account 以外のスコープを OFF にしてから接続し直してください。');
  }
  const expiresIn = parsed.data.expires_in === undefined ? null : Number(parsed.data.expires_in);
  return { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token ?? null, expiresIn: expiresIn !== null && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null, scopes: granted };
}

async function readApi(config: BankConfig, fetchImpl: BankFetch, accessToken: string, path: '/accounts' | '/accounts/balances'): Promise<unknown> {
  const res = await send(fetchImpl, `${config.endpoints.api}${path}`, { method: 'GET', headers: { Accept: 'application/json;charset=UTF-8', 'x-access-token': accessToken } });
  const answer = await readAnswer(res);
  if (res.status === 401) throw new BankApiError('unauthorized', '銀行がトークンを受け付けませんでした。');
  if (res.status >= 500) throw new BankApiError('unavailable', '銀行が一時的に応答できませんでした。時間をおいてもう一度試してください。');
  if (!res.ok) throw new BankApiError('unexpected', `銀行が照会を受け付けませんでした（HTTP ${res.status}）。`);
  if (answer === null) throw new BankApiError('unexpected', '銀行の照会の応答を読めませんでした。');
  return answer;
}

const text = z.string().max(200).optional().nullable();
const accountsAnswer = z.object({
  accounts: z.array(z.object({ accountId: z.string().max(40), branchName: text, accountTypeName: text, accountNumber: text }).passthrough()).max(200),
}).passthrough();
const balancesAnswer = z.object({
  balances: z.array(z.object({ accountId: z.string().max(40), balance: z.union([z.string().max(30), z.number()]).optional().nullable() }).passthrough()).max(200),
}).passthrough();

export interface BankAccountRow {
  accountId: string;
  branchName: string | null;
  accountTypeName: string | null;
  accountNumber: string | null;
}

/** 口座一覧照会 (private:account). */
export async function listAccounts(config: BankConfig, fetchImpl: BankFetch, accessToken: string): Promise<BankAccountRow[]> {
  const parsed = accountsAnswer.safeParse(await readApi(config, fetchImpl, accessToken, '/accounts'));
  if (!parsed.success) throw new BankApiError('unexpected', '銀行の口座一覧の応答を読めませんでした。');
  return parsed.data.accounts.map((a) => ({ accountId: a.accountId, branchName: a.branchName ?? null, accountTypeName: a.accountTypeName ?? null, accountNumber: a.accountNumber ?? null }));
}

/** 残高照会 (private:account): balance in yen per account id, null when the bank gave none. */
export async function listBalances(config: BankConfig, fetchImpl: BankFetch, accessToken: string): Promise<Map<string, number | null>> {
  const parsed = balancesAnswer.safeParse(await readApi(config, fetchImpl, accessToken, '/accounts/balances'));
  if (!parsed.success) throw new BankApiError('unexpected', '銀行の残高照会の応答を読めませんでした。');
  const out = new Map<string, number | null>();
  for (const b of parsed.data.balances) {
    const n = b.balance === undefined || b.balance === null ? NaN : Number(b.balance);
    out.set(b.accountId, Number.isFinite(n) ? n : null);
  }
  return out;
}
