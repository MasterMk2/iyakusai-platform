// The bank connection (GMO あおぞらネット銀行 API, 2026-11-06): types shared by the server and the settings screen.
// No secret ever crosses this boundary: the screen sees the state of the connection, never a token or a code.

/** The only scopes this app asks for or accepts: read the accounts and the virtual accounts (振込入金口座). No transfers. */
export const BANK_SCOPES = ['private:account', 'private:virtual-account'] as const;
export type BankScope = (typeof BANK_SCOPES)[number];

/** Where the bank sends the browser back after the member allows the connection (a screen, not an API path). */
export const BANK_CALLBACK_PATH = '/bank/callback';

export type BankEnvironment = 'sunabar';
export const BANK_ENVIRONMENT_LABELS: Record<BankEnvironment, string> = { sunabar: 'sunabar（試験用の銀行・架空のお金）' };

/**
 * disconnected: no token held. connected: a token that can be used now. expired: the token passed its time and
 * cannot be renewed here (no refresh token), connect again. reconnect_required: the bank refused the renewal.
 */
export type BankConnectionState = 'disconnected' | 'connected' | 'expired' | 'reconnect_required';

export interface BankStatusResponse {
  /** bank.json is in place and valid; when false nothing else here is meaningful. */
  configured: boolean;
  environment: BankEnvironment | null;
  environmentLabel: string | null;
  state: BankConnectionState;
  /** The scopes the bank granted (a subset of BANK_SCOPES). */
  scopes: string[];
  connectedAt: string | null;
  /** Display name of the member who connected. */
  connectedBy: string | null;
  accessTokenExpiresAt: string | null;
  /** The bank gave a refresh token: the app renews the access token by itself before it expires. */
  refreshable: boolean;
  lastRefreshedAt: string | null;
  /** The last failure, in words (never the bank's raw answer). */
  lastError: { at: string; message: string } | null;
  /** 権限管理者: may connect and disconnect. */
  canConnect: boolean;
  /** 会計を見る: may check the connection (accounts and balances). */
  canCheck: boolean;
  /** The Redirect_uri to register at the bank (for the administrator's eyes). */
  redirectUri: string | null;
}

export interface BankStartResponse {
  /** The bank's authorization page. The browser goes there; the bank sends it back to BANK_CALLBACK_PATH. */
  authorizeUrl: string;
}

export interface BankCheckAccount {
  branchName: string | null;
  accountTypeName: string | null;
  /** Last four digits only. */
  accountNumberLast4: string | null;
  balanceYen: number | null;
}

export interface BankCheckResponse {
  checkedAt: string;
  accounts: BankCheckAccount[];
}
