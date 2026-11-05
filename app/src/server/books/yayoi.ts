import { createHash } from 'node:crypto';
import { CsvError, decodeCsvBytes, parseCsvRecords } from '../../shared/organizations.js';
import { BOOKS_LIMITS, isCalendarDate } from '../../shared/books.js';

// 弥生会計's import format (弥生インポート形式, the format 弥生会計 Next writes and reads: support pages ida29611 and
// ida29526): no header row, 27 columns, a journal in one row (識別フラグ 2000) or in several (2110 first, 2100 between,
// 2101 last), the debit side in E–J and the credit side in K–P, 摘要 in Q, 付箋1 in W, 取引先名 in Z and AA. 弥生
// writes Shift_JIS with CRLF; the names (科目, 補助科目) must match 弥生's character for character.
// Our journals carry their number in 摘要 ([KB J-000123]) so a 弥生 file read back knows them and imports them once.

export const YAYOI_COLUMNS = 27;
const FLAG_SINGLE = ['2000', '2111'];
const FLAG_FIRST = '2110';
const FLAG_MIDDLE = '2100';
const FLAG_LAST = '2101';
export const MARKER = /\[KB (J-\d{6})\]/;
export const markerOf = (number: string) => `[KB ${number}]`;

// ---- Shift_JIS (Windows-31J) ---------------------------------------------------------------------------

let encodeTable: Map<string, number> | null = null;

/**
 * The encoder, built once from the platform's Shift_JIS decoder (the WHATWG one, which is Windows-31J): every
 * two-byte code decoded, the first code of a character kept, and the IBM duplicates of NEC's rows (pointers 8272–8835)
 * left out, as the WHATWG encoder does. Single bytes: ASCII and the half-width katakana.
 */
function table(): Map<string, number> {
  if (encodeTable) return encodeTable;
  const decoder = new TextDecoder('shift_jis');
  const map = new Map<string, number>();
  for (let lead = 0x81; lead <= 0xfc; lead += 1) {
    if (lead >= 0xa0 && lead <= 0xdf) continue;
    for (let trail = 0x40; trail <= 0xfc; trail += 1) {
      if (trail === 0x7f) continue;
      const pointer = (lead < 0xa0 ? lead - 0x81 : lead - 0xc1) * 188 + (trail < 0x7f ? trail - 0x40 : trail - 0x41);
      if (pointer >= 8272 && pointer <= 8835) continue;
      const ch = decoder.decode(new Uint8Array([lead, trail]));
      if (ch.length !== 1 || ch === '�') continue;
      if (!map.has(ch)) map.set(ch, (lead << 8) | trail);
    }
  }
  encodeTable = map;
  return map;
}

/** The characters of `text` Shift_JIS cannot hold (each once). */
export function unencodable(text: string): string[] {
  const t = table();
  const out = new Set<string>();
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xff61 && c <= 0xff9f) || c === 0xa5 || c === 0x203e) continue;
    if (!t.has(ch)) out.add(ch);
  }
  return [...out];
}

/** Text as Shift_JIS bytes. Characters it cannot hold become '?' (the export checks them first and refuses). */
export function encodeShiftJis(text: string): Buffer {
  const t = table();
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c >= 0xff61 && c <= 0xff9f) out.push(c - 0xff61 + 0xa1);
    else if (c === 0xa5) out.push(0x5c);
    else if (c === 0x203e) out.push(0x7e);
    else {
      const code = t.get(ch);
      if (code === undefined) out.push(0x3f);
      else out.push(code >> 8, code & 0xff);
    }
  }
  return Buffer.from(out);
}

// ---- writing -------------------------------------------------------------------------------------------

export interface ExportLine {
  side: 'debit' | 'credit';
  account: string;
  sub: string;
  department: string;
  taxClass: string;
  amountYen: number;
  partner: string;
}

export interface ExportJournal {
  number: string;
  date: string;
  memo: string;
  sticky: number;
  lines: ExportLine[];
}

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** 摘要 as 弥生 gets it: the memo (and the other side's name when there is no 取引先 column for it), then our number. */
export function exportMemo(memo: string, number: string): string {
  const mark = markerOf(number);
  const room = 256 - mark.length - 1;
  const text = memo.replace(/[\r\n\t]+/g, ' ').trim();
  const cut = [...text].length > room ? [...text].slice(0, room).join('') : text;
  return cut ? `${cut} ${mark}` : mark;
}

/**
 * The rows of one journal. Two lines: one row (2000). More: the debits and the credits side by side, row by row
 * (2110, 2100…, 2101); a side with no line on a row is left empty with 0, as 弥生 allows.
 */
export function journalRows(j: ExportJournal): string[][] {
  const debits = j.lines.filter((l) => l.side === 'debit');
  const credits = j.lines.filter((l) => l.side === 'credit');
  const n = Math.max(debits.length, credits.length);
  const date = j.date.replaceAll('-', '/');
  const memo = exportMemo(j.memo, j.number);
  const rows: string[][] = [];
  for (let i = 0; i < n; i += 1) {
    const d = debits[i];
    const c = credits[i];
    const flag = n === 1 ? '2000' : i === 0 ? FLAG_FIRST : i === n - 1 ? FLAG_LAST : FLAG_MIDDLE;
    rows.push([
      flag,
      '',
      '',
      date,
      d?.account ?? '',
      d?.sub ?? '',
      d?.department ?? '',
      d ? d.taxClass : '対象外',
      String(d?.amountYen ?? 0),
      '0',
      c?.account ?? '',
      c?.sub ?? '',
      c?.department ?? '',
      c ? c.taxClass : '対象外',
      String(c?.amountYen ?? 0),
      '0',
      i === 0 ? memo : '',
      '',
      '',
      '0',
      '',
      '',
      i === 0 && j.sticky > 0 ? String(j.sticky) : '',
      '',
      'no',
      d?.partner ?? '',
      c?.partner ?? '',
    ]);
  }
  return rows;
}

export function yayoiCsv(journals: ExportJournal[]): string {
  return journals.flatMap(journalRows).map((r) => `${r.map(cell).join(',')}\r\n`).join('');
}

// ---- reading -------------------------------------------------------------------------------------------

const ERA_START: Record<string, number> = { R: 2018, H: 1988 };

/** A 弥生 date: 20250701, 2025/07/01, 2025/7/1, 2025-07-01, R.07/07/01, R07/7/1, H31/4/30. Null when it is none. */
export function parseYayoiDate(value: string): string | null {
  const v = value.normalize('NFKC').trim();
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{4})(\d{2})(\d{2})$/.exec(v))) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^([RH])\.?(\d{1,2})[/.](\d{1,2})[/.](\d{1,2})$/i.exec(v))) {
    y = ERA_START[match[1]!.toUpperCase()]! + Number(match[2]);
    [m, d] = [Number(match[3]), Number(match[4])];
  } else return null;
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isCalendarDate(iso) ? iso : null;
}

const AMOUNT = /^-?\d{1,12}$/;

export interface ParsedLine {
  side: 'debit' | 'credit';
  account: string;
  sub: string;
  department: string;
  taxClass: string;
  amountYen: number;
  partner: string;
}

export interface ParsedJournal {
  /** The file's line the journal starts on. */
  line: number;
  date: string;
  yayoiNo: string;
  memo: string;
  sticky: number;
  /** Our number when 摘要 carries it (a journal sent from here, read back). */
  ours: string | null;
  lines: ParsedLine[];
  /** The duplicate check's key: 弥生's 伝票No and the date, or the content when there is no 伝票No. */
  key: string;
  /** The content (for "changed in 弥生" when the key is known). */
  digest: string;
}

export interface ParseProblem {
  line: number;
  reason: string;
}

function side(cells: string[], at: number, s: 'debit' | 'credit', partnerAt: number): ParsedLine | 'invalid' | null {
  const account = cells[at] ?? '';
  const amountText = (cells[at + 4] ?? '').trim();
  if (!AMOUNT.test(amountText)) return 'invalid';
  const amountYen = Number(amountText);
  if (account === '' && amountYen === 0) return null;
  if (account === '' || amountYen < 0) return 'invalid';
  if ([...account].length > BOOKS_LIMITS.accountName || [...(cells[at + 1] ?? '')].length > BOOKS_LIMITS.accountName) return 'invalid';
  return {
    side: s,
    account,
    sub: cells[at + 1] ?? '',
    department: cells[at + 2] ?? '',
    taxClass: (cells[at + 3] ?? '').trim() || '対象外',
    amountYen,
    partner: (cells[partnerAt] ?? '').trim(),
  };
}

function digestOf(date: string, lines: ParsedLine[], memo: string): string {
  const key = [date, memo, ...lines.map((l) => [l.side, l.account, l.sub, l.amountYen, l.taxClass, l.department].join('\u001f')).sort()].join('\u001e');
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** Reads a 弥生 journal file. Journals that cannot be read are returned as problems with their line and why. */
export function parseYayoiJournals(bytes: Uint8Array): { journals: ParsedJournal[]; problems: ParseProblem[]; encoding: 'utf-8' | 'shift_jis' } {
  const { text, encoding } = decodeCsvBytes(bytes);
  let records;
  try {
    records = parseCsvRecords(text);
  } catch (err) {
    if (err instanceof CsvError) return { journals: [], problems: [{ line: 0, reason: err.message }], encoding };
    throw err;
  }
  const journals: ParsedJournal[] = [];
  const problems: ParseProblem[] = [];
  let group: { line: number; rows: string[][] } | null = null;

  const finish = (g: { line: number; rows: string[][] }) => {
    const first = g.rows[0]!;
    const date = parseYayoiDate(first[3] ?? '');
    if (!date) return problems.push({ line: g.line, reason: `取引日付「${(first[3] ?? '').trim()}」が読めません` });
    const lines: ParsedLine[] = [];
    for (const r of g.rows) {
      const d = side(r, 4, 'debit', 25);
      const c = side(r, 10, 'credit', 26);
      if (d === 'invalid' || c === 'invalid') return problems.push({ line: g.line, reason: '科目か金額が読めない行があります（金額は整数、科目は 24 文字まで）' });
      if (d) lines.push(d);
      if (c) lines.push(c);
    }
    const debit = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amountYen, 0);
    const credit = lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amountYen, 0);
    if (lines.length < 2 || debit !== credit || debit === 0) return problems.push({ line: g.line, reason: `借方（${debit.toLocaleString('ja-JP')}円）と貸方（${credit.toLocaleString('ja-JP')}円）が合いません` });
    if (lines.length > BOOKS_LIMITS.journalLines * 2) return problems.push({ line: g.line, reason: '明細が多すぎます（100 行まで）' });
    const memos = g.rows.map((r) => (r[16] ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const rawMemo = memos.join(' / ');
    const ours = MARKER.exec(rawMemo)?.[1] ?? null;
    const memo = [...rawMemo.replace(MARKER, '').trim()].slice(0, BOOKS_LIMITS.memo).join('');
    const yayoiNo = (first[1] ?? '').trim();
    const stickyText = (first[22] ?? '').trim();
    const sticky = /^[0-5]$/.test(stickyText) ? Number(stickyText) : 0;
    const digest = digestOf(date, lines, memo);
    journals.push({ line: g.line, date, yayoiNo, memo, sticky, ours, lines, key: yayoiNo ? `no:${date}:${yayoiNo}` : `dg:${digest}`, digest });
    return 0;
  };

  for (const record of records) {
    const cells = record.cells;
    if (cells.length !== 25 && cells.length !== YAYOI_COLUMNS) {
      problems.push({ line: record.line, reason: `項目の数が ${cells.length} です（弥生の形式は 25 か 27）` });
      continue;
    }
    if (cells.length === 25) cells.push('', '');
    const flag = (cells[0] ?? '').trim();
    if (FLAG_SINGLE.includes(flag)) {
      if (group) {
        problems.push({ line: group.line, reason: '複数行の仕訳が最終行（2101）で終わっていません' });
        group = null;
      }
      finish({ line: record.line, rows: [cells] });
    } else if (flag === FLAG_FIRST) {
      if (group) problems.push({ line: group.line, reason: '複数行の仕訳が最終行（2101）で終わっていません' });
      group = { line: record.line, rows: [cells] };
    } else if (flag === FLAG_MIDDLE || flag === FLAG_LAST) {
      if (!group) {
        problems.push({ line: record.line, reason: '複数行の仕訳の 1 行目（2110）がありません' });
        continue;
      }
      group.rows.push(cells);
      if (group.rows.length > BOOKS_LIMITS.journalLines) {
        problems.push({ line: group.line, reason: '明細が 100 行を超えています' });
        group = null;
        continue;
      }
      if (flag === FLAG_LAST) {
        finish(group);
        group = null;
      }
    } else {
      problems.push({ line: record.line, reason: `識別フラグ「${flag}」は弥生の仕訳の形式ではありません（2000・2110・2100・2101）` });
    }
  }
  if (group) problems.push({ line: group.line, reason: '複数行の仕訳が最終行（2101）で終わっていません' });
  return { journals, problems, encoding };
}

export interface ParsedOpening {
  line: number;
  date: string;
  account: string;
  sub: string;
  /** Signed as a debit balance (貸方 is negative). */
  amountYen: number;
}

/** Reads 弥生's opening balances (期首残高: 期首日, 勘定科目, 貸借区分, 補助科目, 部門, 前期繰越残高). */
export function parseYayoiOpenings(bytes: Uint8Array): { rows: ParsedOpening[]; problems: ParseProblem[]; encoding: 'utf-8' | 'shift_jis' } {
  const { text, encoding } = decodeCsvBytes(bytes);
  let records;
  try {
    records = parseCsvRecords(text);
  } catch (err) {
    if (err instanceof CsvError) return { rows: [], problems: [{ line: 0, reason: err.message }], encoding };
    throw err;
  }
  const rows: ParsedOpening[] = [];
  const problems: ParseProblem[] = [];
  let firstDate: string | null = null;
  for (const record of records) {
    const c = record.cells;
    if (c.length !== 6) {
      problems.push({ line: record.line, reason: `項目の数が ${c.length} です（期首残高の形式は 6）` });
      continue;
    }
    const date = parseYayoiDate(c[0] ?? '');
    if (!date) {
      problems.push({ line: record.line, reason: `期首日「${(c[0] ?? '').trim()}」が読めません` });
      continue;
    }
    firstDate ??= date;
    const account = c[1] ?? '';
    const sideText = (c[2] ?? '').trim();
    const amountText = (c[5] ?? '').trim();
    if (!account || [...account].length > BOOKS_LIMITS.accountName || [...(c[3] ?? '')].length > BOOKS_LIMITS.accountName) {
      problems.push({ line: record.line, reason: '勘定科目が空か長すぎます' });
      continue;
    }
    if (sideText !== '借方' && sideText !== '貸方') {
      problems.push({ line: record.line, reason: `貸借区分「${sideText}」は「借方」か「貸方」です` });
      continue;
    }
    if (!AMOUNT.test(amountText)) {
      problems.push({ line: record.line, reason: `残高「${amountText}」が整数ではありません` });
      continue;
    }
    const amount = Number(amountText);
    rows.push({ line: record.line, date: firstDate, account, sub: c[3] ?? '', amountYen: sideText === '借方' ? amount : -amount });
  }
  return { rows, problems, encoding };
}
