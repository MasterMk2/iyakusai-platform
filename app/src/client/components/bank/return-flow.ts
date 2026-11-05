import type { BankStatusResponse } from '../../../shared/bank';
import { api, toFailure } from '../../api';

// The return from the bank (/bank/callback?code=…&state=… or ?error=…&state=…). main.tsx reads the query, takes it out
// of the address bar and the history at once, and posts it before anything else loads: the bank's code is good for
// 60 seconds and works once. The outcome travels to the settings panel through sessionStorage (one tab, read once).

const RESULT_KEY = 'iyakusai-bank-result';

export interface BankReturnResult {
  text: string;
  error: boolean;
}

export function readBankReturn(search: string): { state: string; code?: string; error?: string } | null {
  const params = new URLSearchParams(search);
  const state = params.get('state');
  const code = params.get('code');
  const error = params.get('error');
  if (!state || (code === null) === (error === null)) return null;
  return code !== null ? { state, code } : { state, error: error! };
}

/** Posts the return at once; never rejects (the outcome is in words for the member). */
export async function completeBankReturn(input: ReturnType<typeof readBankReturn>): Promise<BankReturnResult> {
  if (!input) return { text: '銀行から戻った値が足りません。設定の「銀行と接続する」からもう一度始めてください。', error: true };
  try {
    const status = await api<BankStatusResponse>('POST', '/api/bank/oauth/complete', input);
    return { text: status.state === 'connected' ? '銀行と接続しました。「接続を確かめる」で口座が読めるか確かめられます。' : '銀行から戻りましたが、接続済みになっていません。もう一度試してください。', error: status.state !== 'connected' };
  } catch (err) {
    const failure = toFailure(err);
    if (failure.status === 401) return { text: 'ログインが切れていたので接続できませんでした。ログインしてから、設定の「銀行と接続する」でもう一度始めてください。', error: true };
    return { text: failure.message, error: true };
  }
}

/** Keeps the result for the settings panel; false when the browser refuses storage (the return screen shows it). */
export function storeBankReturnResult(result: BankReturnResult): boolean {
  try {
    sessionStorage.setItem(RESULT_KEY, JSON.stringify(result));
    return true;
  } catch {
    return false;
  }
}

export function takeBankReturnResult(): BankReturnResult | null {
  try {
    const raw = sessionStorage.getItem(RESULT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(RESULT_KEY);
    const parsed = JSON.parse(raw) as Partial<BankReturnResult>;
    return typeof parsed.text === 'string' && typeof parsed.error === 'boolean' ? { text: parsed.text, error: parsed.error } : null;
  } catch {
    return null;
  }
}
