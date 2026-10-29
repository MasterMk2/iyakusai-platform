import type { ApiError } from '../shared/api';

export class ApiFailure extends Error {
  readonly status: number;
  readonly body: ApiError | null;
  constructor(status: number, body: ApiError | null, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function toFailure(err: unknown): ApiFailure {
  if (err instanceof ApiFailure) return err;
  return new ApiFailure(0, null, 'サーバーに接続できませんでした。通信状態を確認して再試行してください。');
}

export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal,
      credentials: 'same-origin',
      // The custom header marks a same-origin script request (account mode requires it on every write).
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-SMM-CSRF': '1' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw toFailure(err);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const apiError = json as ApiError | null;
    throw new ApiFailure(res.status, apiError, apiError?.message ?? `サーバーがエラーを返しました（${res.status}）。`);
  }
  if (url === '/api/session') sendTemporaryStaffToRental(json);
  return json as T;
}

/** POST of a form with files (multipart/form-data; the browser sets the boundary). */
export async function apiForm<T>(url: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'X-SMM-CSRF': '1' }, body: form });
  } catch (err) {
    throw toFailure(err);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const apiError = json as ApiError | null;
    throw new ApiFailure(res.status, apiError, apiError?.message ?? `サーバーがエラーを返しました（${res.status}）。`);
  }
  return json as T;
}

// Temporary staff (accounts made for the festival days, 2026-10-17) use only the rental screen. Until
// 2026-10-25 this was patched into the built bundle; it is the same check and the same destinations.
const RENTAL_RETURN_PATH = /^\/(?:rental(?:\?[^#]*)?|i\/IY-[A-Z0-9-]+(?:\?[^#]*)?)$/;
function sendTemporaryStaffToRental(session: unknown) {
  if ((session as { account?: { temporaryStaff?: unknown } } | null)?.account?.temporaryStaff !== true) return;
  let target = '/rental';
  try {
    const saved = sessionStorage.getItem('iyakusai-return');
    if (saved && RENTAL_RETURN_PATH.test(saved)) target = saved;
    sessionStorage.removeItem('iyakusai-return');
  } catch {
    // storage blocked: the rental screen itself
  }
  window.location.replace(target);
}

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Short time for list rows: "14:05" today, "10/24 18:20" this year, else the full date. */
export function fmtListDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = (x: Date) => x.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const time = d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  if (day(d) === day(now)) return time;
  const [y, m, dd] = day(d).split('-');
  return y === day(now).slice(0, 4) ? `${Number(m)}/${Number(dd)} ${time}` : `${y}/${m}/${dd}`;
}
