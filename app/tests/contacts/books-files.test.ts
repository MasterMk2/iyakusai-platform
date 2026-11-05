import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/server/domain/types.js';
import { seedDemoLedger } from '../../src/server/books/demo.js';
import { sheetTabs } from '../../src/server/books/sheet-tabs.js';
import { BooksStore } from '../../src/server/books/store.js';
import { booksOf } from '../../src/server/books/views.js';
import { encodeShiftJis, journalRows, parseYayoiDate, parseYayoiJournals, parseYayoiOpenings, unencodable, yayoiCsv, YAYOI_COLUMNS, type ExportJournal } from '../../src/server/books/yayoi.js';

// The files the books exchange (2026-11-05): 弥生's import format both ways, and the master spreadsheet's tabs, which
// have to read on their own if the app is gone. Synthetic data only.

const line = (side: 'debit' | 'credit', account: string, amountYen: number, extra: Partial<ExportJournal['lines'][number]> = {}) => ({ side, account, sub: '', department: '', taxClass: '対象外', amountYen, partner: '', ...extra });

describe('弥生インポート形式', () => {
  it('writes a two-line journal as one row of 27 columns, with our number in 摘要 and the partners in Z and AA', () => {
    const rows = journalRows({ number: 'J-000007', date: '2026-07-01', memo: 'ポスター印刷', sticky: 2, lines: [line('debit', '広告宣伝費', 55_000, { partner: '合成印刷株式会社' }), line('credit', '普通預金', 55_000, { sub: '合成銀行' })] });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r).toHaveLength(YAYOI_COLUMNS);
    expect([r[0], r[3], r[4], r[8], r[10], r[11], r[14]]).toEqual(['2000', '2026/07/01', '広告宣伝費', '55000', '普通預金', '合成銀行', '55000']);
    expect(r[16]).toBe('ポスター印刷 [KB J-000007]');
    expect([r[22], r[24], r[25], r[26]]).toEqual(['2', 'no', '合成印刷株式会社', '']);
  });

  it('writes a compound journal as 2110 … 2101, the shorter side left empty with 0', () => {
    const rows = journalRows({ number: 'J-000008', date: '2026-07-02', memo: '', sticky: 0, lines: [line('debit', '消耗品費', 700), line('debit', '会議費', 300), line('credit', '現金', 1_000)] });
    expect(rows.map((r) => r[0])).toEqual(['2110', '2101']);
    expect([rows[1]![4], rows[1]![8], rows[1]![10], rows[1]![14], rows[1]![16]]).toEqual(['会議費', '300', '', '0', '']);
  });

  it('reads its own file back unchanged, quotes included, and knows the journals as ours', () => {
    const journals: ExportJournal[] = [
      { number: 'J-000001', date: '2026-07-01', memo: '受付用の机、"A" 型', sticky: 0, lines: [line('debit', '賃借料', 4_400), line('credit', '現金', 4_400)] },
      { number: 'J-000002', date: '2026-07-02', memo: '文具', sticky: 0, lines: [line('debit', '消耗品費', 700), line('debit', '会議費', 300), line('credit', '現金', 1_000)] },
    ];
    const bytes = encodeShiftJis(yayoiCsv(journals));
    const parsed = parseYayoiJournals(bytes);
    expect(parsed.encoding).toBe('shift_jis');
    expect(parsed.problems).toEqual([]);
    expect(parsed.journals.map((j) => [j.ours, j.date, j.memo, j.lines.length])).toEqual([
      ['J-000001', '2026-07-01', '受付用の机、"A" 型', 2],
      ['J-000002', '2026-07-02', '文具', 3],
    ]);
    expect(new TextDecoder('shift_jis').decode(bytes).endsWith('\r\n')).toBe(true);
  });

  it('keys a journal by 弥生’s 伝票No and date, or by its content when there is none', () => {
    const row = (no: string, memo: string) => ['2000', no, '', '2026/08/01', '雑費', '', '', '対象外', '500', '0', '現金', '', '', '対象外', '500', '0', memo, '', '', '0', '', '', '', '', 'no', '', ''].join(',');
    const a = parseYayoiJournals(encodeShiftJis(`${row('15', '切手')}\r\n${row('', '切手')}\r\n${row('', '切手')}\r\n`)).journals;
    expect(a[0]!.key).toBe('no:2026-08-01:15');
    expect(a[1]!.key).toMatch(/^dg:/);
    expect(a[2]!.key).toBe(a[1]!.key);
  });

  it('names the lines it cannot read and why', () => {
    const cells = (flag: string, debit: string, credit: string) => [flag, '', '', '2026/08/01', '雑費', '', '', '対象外', debit, '0', '現金', '', '', '対象外', credit, '0', '', '', '', '0', '', '', '', '', 'no', '', ''].join(',');
    const text = [cells('2000', '500', '400'), cells('9999', '1', '1'), 'a,b,c', cells('2110', '1', '1')].join('\r\n') + '\r\n';
    const { journals, problems } = parseYayoiJournals(encodeShiftJis(text));
    expect(journals).toEqual([]);
    expect(problems.map((p) => p.line)).toEqual([1, 2, 3, 4]);
    expect(problems[0]!.reason).toContain('合いません');
    expect(problems[1]!.reason).toContain('識別フラグ');
    expect(problems[2]!.reason).toContain('項目の数');
    expect(problems[3]!.reason).toContain('2101');
  });

  it('reads the date forms 弥生 writes, and refuses a day that does not exist', () => {
    expect(['2026/7/1', '20260701', '2026-07-01', 'R.08/07/01', 'R08/7/1'].map(parseYayoiDate)).toEqual(Array(5).fill('2026-07-01'));
    expect(parseYayoiDate('H31/4/30')).toBe('2019-04-30');
    expect(parseYayoiDate('2026/02/30')).toBeNull();
    expect(parseYayoiDate('来週')).toBeNull();
  });

  it('finds the characters Shift_JIS cannot hold before a file is written', () => {
    expect(unencodable('①ｱ髙橋 ABC')).toEqual([]);
    expect(unencodable('合成😀𠮷')).toEqual(['😀', '𠮷']);
  });

  it('reads opening balances with 貸方 as negative', () => {
    const { rows, problems } = parseYayoiOpenings(encodeShiftJis('2026/01/01,普通預金,借方,合成銀行,,800000\r\n2026/01/01,繰越利益,貸方,,,800000\r\n2026/01/01,現金,左,,,1\r\n'));
    expect(rows.map((r) => [r.account, r.sub, r.amountYen])).toEqual([
      ['普通預金', '合成銀行', 800_000],
      ['繰越利益', '', -800_000],
    ]);
    expect(problems).toEqual([{ line: 3, reason: expect.stringContaining('貸借区分') }]);
  });
});

describe('the master spreadsheet’s tabs', () => {
  let dir: string;
  let store: BooksStore;
  const NOW = '2026-11-05T03:00:00.000Z';
  const users = [{ id: 'u-admin-a', displayName: '管理担当', canManageAccess: true }, { id: 'u-viewer-b', displayName: '閲覧担当B' }] as User[];
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-books-files-'));
    store = new BooksStore(dir);
    seedDemoLedger(store, users, NOW);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens with the guide, keeps every row complete, and the book adds up', () => {
    const tabs = sheetTabs(store, booksOf(store, (id) => (id === 'u-viewer-b' ? '閲覧担当B' : '管理担当')), '', 2026, NOW);
    expect(tabs.map((t) => t.title)).toEqual(['案内', '収支一覧', '口座残高', '予算と実績', '立替精算', '仕訳帳', '残高試算表', '期首残高', '科目', '取り消した仕訳']);
    const byTitle = new Map(tabs.map((t) => [t.title, t.rows]));
    const guide = byTitle.get('案内')!;
    expect(guide.find((r) => r[0] === '帳簿の確かめ')![1]).toContain('一致しています');
    expect(guide.some((r) => r[0] === '基盤が止まったら')).toBe(true);

    // 収支一覧: one row per journal, as many as the book has, each with its date, number and amount.
    const list = byTitle.get('収支一覧')!;
    expect(list.length - 1).toBe(store.allJournals().filter((j) => j.voided === 0).length);
    for (const r of list.slice(1)) {
      expect(r[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r[1]).toMatch(/^J-\d{6}$/);
      expect([r[6], r[7], r[8]].filter((v) => typeof v === 'number')).toHaveLength(1);
    }

    // 仕訳帳: no row leans on the one above it (date and number on every row); debits equal credits.
    const journal = byTitle.get('仕訳帳')!;
    const debit = journal.slice(1).reduce((s, r) => s + ((r[6] as number | null) ?? 0), 0);
    const credit = journal.slice(1).reduce((s, r) => s + ((r[11] as number | null) ?? 0), 0);
    expect(debit).toBe(credit);
    expect(journal.slice(1).every((r) => r[1] && r[2])).toBe(true);

    // 残高試算表 of 2026: the closing balances of the money accounts are what 口座残高 says.
    const trial = byTitle.get('残高試算表')!.filter((r) => r[0] === 2026);
    const balances = byTitle.get('口座残高')!.filter((r) => r[0] === 2026);
    for (const b of balances) {
      const t = trial.find((r) => r[2] === b[1]);
      expect(t?.[7]).toBe(b[5]);
    }
    // No internal ids anywhere in the sheet.
    expect(JSON.stringify(tabs)).not.toMatch(/\b(ac|jn|cl|rc)_[0-9a-f]{16}\b/);
  });

  it('leaves a voided journal out of the sums and lists it on its own', () => {
    const victim = store.allJournals()[0]!;
    store.voidJournal(victim.id, victim.version, '二重に入れた', 'u-admin-a', NOW);
    const tabs = sheetTabs(store, booksOf(store, () => '管理担当'), '基盤_', 2026, NOW);
    const byTitle = new Map(tabs.map((t) => [t.title, t.rows]));
    expect(tabs[0]!.title).toBe('基盤_案内');
    const takenBack = byTitle.get('基盤_取り消した仕訳')!;
    expect(takenBack).toHaveLength(2);
    expect(takenBack[1]![6]).toBe('二重に入れた');
    expect(byTitle.get('基盤_収支一覧')!.some((r) => r[1] === takenBack[1]![0])).toBe(false);
  });
});
