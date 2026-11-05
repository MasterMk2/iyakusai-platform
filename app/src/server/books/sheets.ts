import { createSign, randomInt } from 'node:crypto';
import type { BooksSheetsConfig } from './sheets-config.js';

// Writing the books to the committee's master spreadsheet on the shared drive (2026-11-05). The app mints a short-lived
// access token from the service account's key (a signed JWT, Google's documented flow for server-to-server calls) and
// writes the tabs through the Sheets API v4 on its fixed origin.
//
// The sheet is a copy members read, not a place to write:
// - each tab the app writes is protected so that only the service account can change it (Google lets the file's owner
//   and the shared drive's managers edit a protected range too; they can lift the protection, and a copy of the file
//   made with ファイル → コピーを作成 has none);
// - a tab the app makes carries an invisible mark (developer metadata); a tab of the same name without the mark is
//   somebody else's and is never overwritten (the write stops with 'foreign_tab').
// It is meant to stay readable if the app is gone: values only (RAW, so a cell starting with = stays text), no
// formulas and no internal ids, amounts as numbers, dates as dates, a frozen header row with a filter.
// Neither the token, the key nor a response body is logged or put in an error: a failure carries its kind only.

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SHEETS_ORIGIN = 'https://sheets.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TIMEOUT_MS = 20_000;
const MAX_BODY = 2_000_000;
/** The invisible mark on the tabs the app made. */
export const TAB_MARK = 'iyakusai-books-tab';
export const PROTECTION_NOTE = '医薬祭の基盤システム（会計）が書き込む表です。直すときは基盤の「会計」から。';

export type SheetsFailure = 'credential' | 'token' | 'forbidden' | 'not_found' | 'foreign_tab' | 'rate_limited' | 'server' | 'network' | 'timeout' | 'invalid';

export const SHEETS_FAILURE_LABELS: Record<SheetsFailure, string> = {
  credential: 'サービスアカウントの鍵で署名できませんでした（鍵のファイルを確かめてください）',
  token: 'Google がサービスアカウントの鍵を受け付けませんでした（鍵が無効か、削除されています）',
  forbidden: 'スプレッドシートに書き込む権限がありません（サービスアカウントのアドレスを編集者として共有してください）',
  not_found: 'スプレッドシートが見つかりません（spreadsheetId を確かめてください）',
  foreign_tab: '基盤が書くタブと同じ名前の、基盤が作っていないタブがあります（上書きしないよう止めました。そのタブの名前を変えてください）',
  rate_limited: 'Google の回数の上限に達しました（しばらくして自動でやり直します）',
  server: 'Google 側のエラーです（しばらくして自動でやり直します）',
  network: 'Google に接続できませんでした',
  timeout: 'Google の応答が時間内にありませんでした',
  invalid: 'Google の応答が想定と違いました',
};

/** Failures that pass on their own; the others wait for a person and are tried again less often. */
const TRANSIENT: ReadonlySet<SheetsFailure> = new Set(['rate_limited', 'server', 'network', 'timeout']);

export class SheetsError extends Error {
  constructor(readonly failure: SheetsFailure) {
    super(`sheets write failed: ${failure}`);
  }
}

export type Cell = string | number | null;
export interface SheetTab {
  title: string;
  rows: Cell[][];
  /** Row 1 is a header: frozen, bold, with a filter over the table. Default true. */
  header?: boolean;
  /** Columns (from 0) of amounts in yen: shown as 1,234. */
  yen?: number[];
  /** Columns (from 0) of days (YYYY-MM-DD): written as dates, shown as 2026-07-01. */
  dates?: number[];
  /** Fixed widths in pixels by column (from 0); the other columns fit their contents. */
  widths?: Record<number, number>;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/** The signed assertion of Google's service-account flow (RS256, one hour). */
export function serviceAccountAssertion(config: Pick<BooksSheetsConfig, 'clientEmail' | 'privateKey'>, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: config.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  let signature: Buffer;
  try {
    signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(config.privateKey);
  } catch {
    throw new SheetsError('credential');
  }
  return `${header}.${claims}.${b64url(signature)}`;
}

const failureOf = (status: number): SheetsFailure =>
  status === 401 ? 'token' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : status >= 500 ? 'server' : 'invalid';

/** A day as the spreadsheet's date number (days since 1899-12-30); anything else as it is. */
export function sheetDate(value: Cell): Cell {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return Number.isNaN(t) ? value : Math.round((t - Date.UTC(1899, 11, 30)) / 86_400_000);
}

interface SheetMeta {
  properties?: { sheetId?: unknown; title?: unknown };
  protectedRanges?: { description?: unknown }[];
  developerMetadata?: { metadataKey?: unknown }[];
}

export class SheetsWriter {
  private token: { value: string; until: number } | null = null;

  constructor(
    private readonly config: BooksSheetsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async call(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new SheetsError(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network');
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new SheetsError(url === TOKEN_URL && res.status === 400 ? 'token' : failureOf(res.status));
    if (text.length > MAX_BODY) throw new SheetsError('invalid');
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new SheetsError('invalid');
    }
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.token && this.token.until > now) return this.token.value;
    const assertion = serviceAccountAssertion(this.config, Math.floor(now / 1000));
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    const out = (await this.call(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })) as { access_token?: unknown; expires_in?: unknown };
    if (typeof out.access_token !== 'string' || !/^[A-Za-z0-9._~+/-]{16,4096}=*$/.test(out.access_token)) throw new SheetsError('invalid');
    const seconds = typeof out.expires_in === 'number' && out.expires_in > 120 ? out.expires_in : 3600;
    this.token = { value: out.access_token, until: now + (seconds - 120) * 1000 };
    return out.access_token;
  }

  private async api(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<unknown> {
    const token = await this.accessToken();
    try {
      return await this.call(`${SHEETS_ORIGIN}/v4/spreadsheets/${encodeURIComponent(this.config.spreadsheetId)}${pathAndQuery}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      // A token Google no longer takes is minted again on the next write.
      if (err instanceof SheetsError && err.failure === 'token') this.token = null;
      throw err;
    }
  }

  /**
   * Writes the tabs whole: makes the missing ones (marked as the app's), stops at a tab of the same name it did not
   * make, clears and writes the values, then puts the order, the header, the formats, the filter and the protection.
   */
  async write(tabs: SheetTab[]): Promise<void> {
    const fields = encodeURIComponent('sheets(properties(sheetId,title),protectedRanges(description),developerMetadata(metadataKey))');
    const meta = (await this.api('GET', `?fields=${fields}`)) as { sheets?: SheetMeta[] };
    if (!Array.isArray(meta.sheets)) throw new SheetsError('invalid');
    const existing = new Map<string, { id: number; ours: boolean; protectedByUs: boolean }>();
    for (const s of meta.sheets) {
      const title = s.properties?.title;
      const id = s.properties?.sheetId;
      if (typeof title !== 'string' || typeof id !== 'number') continue;
      existing.set(title, {
        id,
        ours: (s.developerMetadata ?? []).some((m) => m.metadataKey === TAB_MARK),
        protectedByUs: (s.protectedRanges ?? []).some((p) => p.description === PROTECTION_NOTE),
      });
    }
    if (tabs.some((t) => existing.get(t.title)?.ours === false)) throw new SheetsError('foreign_tab');

    const used = new Set([...existing.values()].map((s) => s.id));
    const ids = new Map<string, number>();
    const create: unknown[] = [];
    for (const t of tabs) {
      const found = existing.get(t.title);
      if (found) {
        ids.set(t.title, found.id);
        continue;
      }
      let id: number;
      do id = randomInt(1, 2_000_000_000);
      while (used.has(id));
      used.add(id);
      ids.set(t.title, id);
      create.push(
        { addSheet: { properties: { sheetId: id, title: t.title } } },
        { createDeveloperMetadata: { developerMetadata: { metadataKey: TAB_MARK, metadataValue: '1', visibility: 'DOCUMENT', location: { sheetId: id } } } },
      );
    }
    if (create.length > 0) await this.api('POST', ':batchUpdate', { requests: create });

    const range = (title: string) => `'${title.replace(/'/g, "''")}'`;
    await this.api('POST', '/values:batchClear', { ranges: tabs.map((t) => range(t.title)) });
    await this.api('POST', '/values:batchUpdate', {
      valueInputOption: 'RAW',
      data: tabs.map((t) => {
        const dates = new Set(t.dates ?? []);
        const first = t.header === false ? 0 : 1;
        return {
          range: `${range(t.title)}!A1`,
          majorDimension: 'ROWS',
          values: t.rows.map((r, i) => r.map((c, col) => (c === null ? '' : i >= first && dates.has(col) ? sheetDate(c) : c))),
        };
      }),
    });

    const look: unknown[] = [];
    tabs.forEach((t, index) => {
      const sheetId = ids.get(t.title)!;
      const header = t.header !== false;
      const width = Math.max(1, ...t.rows.map((r) => r.length));
      const height = Math.max(1, t.rows.length);
      const columns = (col: number) => ({ sheetId, startRowIndex: header ? 1 : 0, endRowIndex: height, startColumnIndex: col, endColumnIndex: col + 1 });
      look.push({ updateSheetProperties: { properties: { sheetId, index, gridProperties: { frozenRowCount: header ? 1 : 0 } }, fields: 'index,gridProperties.frozenRowCount' } });
      if (header) {
        look.push({
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: width },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 } } },
            fields: 'userEnteredFormat(textFormat,backgroundColor)',
          },
        });
        look.push({ setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, endRowIndex: height, startColumnIndex: 0, endColumnIndex: width } } } });
      }
      for (const col of t.yen ?? []) look.push({ repeatCell: { range: columns(col), cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } }, fields: 'userEnteredFormat.numberFormat' } });
      for (const col of t.dates ?? []) look.push({ repeatCell: { range: columns(col), cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } }, fields: 'userEnteredFormat.numberFormat' } });
      look.push({ autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: width } } });
      for (const [col, pixelSize] of Object.entries(t.widths ?? {})) {
        look.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: Number(col), endIndex: Number(col) + 1 }, properties: { pixelSize }, fields: 'pixelSize' } });
      }
      if (!existing.get(t.title)?.protectedByUs) {
        look.push({ addProtectedRange: { protectedRange: { range: { sheetId }, description: PROTECTION_NOTE, warningOnly: false, editors: { users: [this.config.clientEmail] } } } });
      }
    });
    await this.api('POST', ':batchUpdate', { requests: look });
  }
}

export interface SyncState {
  lastOkAt: string | null;
  lastAttemptAt: string | null;
  lastError: SheetsFailure | null;
  syncedRevision: number;
}

/**
 * Keeps the spreadsheet up to date: a change asks for a write after a pause (several changes, one write); one write
 * at a time; a change during a write asks for another. A failure is kept (its kind) and tried again: after the pause
 * when it passes on its own, after `retryMs` when it needs a person (a key, the sharing, a tab's name).
 */
export class SheetsSync {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;

  constructor(
    private readonly writer: Pick<SheetsWriter, 'write'>,
    private readonly build: () => SheetTab[],
    private readonly revision: () => number,
    private readonly state: { get: () => SyncState; set: (s: SyncState) => void },
    private readonly clock: () => string,
    private readonly debounceMs: number,
    private readonly retryMs = Math.max(debounceMs, 10 * 60_000),
  ) {}

  /** A change: write after the pause (a pending write is not pushed back further). */
  request(delayMs = this.debounceMs): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
    this.timer.unref?.();
  }

  pending(): boolean {
    return this.timer !== null || this.running !== null || this.revision() !== this.state.get().syncedRevision;
  }

  /** Writes now (the button), and waits for it. */
  async run(): Promise<SyncState> {
    if (this.closed) return this.state.get();
    if (this.running) {
      this.again = true;
      await this.running;
      return this.state.get();
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = (async () => {
      do {
        this.again = false;
        const revision = this.revision();
        const at = this.clock();
        try {
          await this.writer.write(this.build());
          this.state.set({ lastOkAt: this.clock(), lastAttemptAt: at, lastError: null, syncedRevision: revision });
        } catch (err) {
          const failure = err instanceof SheetsError ? err.failure : 'invalid';
          this.state.set({ ...this.state.get(), lastAttemptAt: at, lastError: failure });
          this.request(TRANSIENT.has(failure) ? this.debounceMs : this.retryMs);
          return;
        }
      } while (this.again || this.revision() !== this.state.get().syncedRevision);
    })().finally(() => {
      this.running = null;
    });
    await this.running;
    return this.state.get();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
