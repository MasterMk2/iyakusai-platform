import { ACCOUNT_KIND_LABELS, ACCOUNT_KINDS, accountTitle, CLAIM_STATE_LABELS, fiscalRange, JOURNAL_SOURCE_LABELS, normalSide, yen, type AccountKind } from '../../shared/books.js';
import type { Cell, SheetTab } from './sheets.js';
import { claimNumber, journalNumber, type BooksStore, type JournalRow } from './store.js';
import { accountTotals, budgetRows, moneyBalances, plainOf, type Books } from './views.js';

// The master spreadsheet's tabs (2026-11-05). The sheet is what is left to read if the app is gone, so each tab stands
// on its own: plain Japanese headers, one row per thing, every row complete (no blank "same as above" cells), amounts
// in yen as numbers, days as dates, no internal ids (the journals' and claims' numbers are the keys), every fiscal
// year. Taken back journals are left out of the tabs people add up and listed in a tab of their own.
// With 仕訳帳, 期首残高 and 科目 the whole book can be set up again by hand or in 弥生.

const KIND_ORDER = new Map<AccountKind, number>(ACCOUNT_KINDS.map((k, i) => [k, i]));
const DIRECTION = { in: '収入', out: '支出', move: '口座の移動', none: '振替' } as const;

/** An ISO time as Japan's clock, YYYY-MM-DD HH:mm. */
const japanTime = (iso: string) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16);

const byDate = (x: JournalRow, y: JournalRow) => x.date.localeCompare(y.date) || x.seq - y.seq;

export function sheetTabs(store: BooksStore, b: Books, prefix: string, fiscalYear: number, writtenAt: string): SheetTab[] {
  const tab = (name: string) => `${prefix}${name}`;
  const startMonth = store.fiscalStartMonth();
  const all = store.allJournals();
  const live = all.filter((j) => j.voided === 0).sort(byDate);
  const voided = all.filter((j) => j.voided === 1).sort(byDate);
  const lines = store.linesOf(all.map((j) => j.id));
  const receipts = store.receiptsOf('journal', all.map((j) => j.id));
  const years = [...new Set([fiscalYear, ...store.years()])].sort((x, y) => y - x);
  const title = (id: string) => {
    const a = b.accounts.get(id);
    return a ? accountTitle(a) : '（不明な科目）';
  };
  const yayoiState = (j: JournalRow) =>
    j.source === 'yayoi' ? '弥生から取り込み' : j.yayoi_batch ? (j.yayoi_dirty === 1 ? '書き出したあとに変更あり' : '弥生へ書き出し済み') : 'まだ書き出していない';

  // 収支一覧: one row per journal, as members read it.
  const list: Cell[][] = [['日付', '番号', '年度', '区分', '口座', '科目', '入金（円）', '出金（円）', '振替・移動（円）', '取引先', '摘要', '部局', '記帳元', '弥生', '領収書（枚）']];
  for (const j of live) {
    const ls = lines.get(j.id) ?? [];
    const amount = ls.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount_yen, 0);
    const plain = plainOf(b, ls);
    const compound = ls.length !== 2;
    const other = compound ? ls.map((l) => `${l.side === 'debit' ? '借方' : '貸方'} ${title(l.account_id)} ${yen(l.amount_yen)}`).join(' ／ ') : (plain.other ?? '');
    list.push([
      j.date,
      journalNumber(j.seq),
      j.fiscal_year,
      compound ? '複合仕訳' : DIRECTION[plain.direction],
      plain.money ?? '',
      other,
      plain.direction === 'in' ? amount : null,
      plain.direction === 'out' ? amount : null,
      plain.direction === 'move' || plain.direction === 'none' ? amount : null,
      j.counterparty,
      j.memo,
      j.department,
      JOURNAL_SOURCE_LABELS[j.source],
      yayoiState(j),
      receipts.get(j.id)?.length ?? 0,
    ]);
  }

  // 仕訳帳: the double entry, debit and credit side by side as in 弥生, every row complete.
  const journal: Cell[][] = [['年度', '日付', '番号', '借方科目', '借方補助科目', '借方税区分', '借方金額（円）', '借方取引先', '貸方科目', '貸方補助科目', '貸方税区分', '貸方金額（円）', '貸方取引先', '摘要', '部局', '記帳元', '弥生の伝票番号']];
  let debitSum = 0;
  let creditSum = 0;
  for (const j of live) {
    const ls = lines.get(j.id) ?? [];
    const debits = ls.filter((l) => l.side === 'debit');
    const credits = ls.filter((l) => l.side === 'credit');
    for (let i = 0; i < Math.max(debits.length, credits.length); i += 1) {
      const d = debits[i];
      const c = credits[i];
      const da = d ? b.accounts.get(d.account_id) : undefined;
      const ca = c ? b.accounts.get(c.account_id) : undefined;
      debitSum += d?.amount_yen ?? 0;
      creditSum += c?.amount_yen ?? 0;
      journal.push([
        j.fiscal_year,
        j.date,
        journalNumber(j.seq),
        da?.name ?? '',
        da?.sub ?? '',
        d?.tax_class ?? '',
        d?.amount_yen ?? null,
        d?.partner ?? '',
        ca?.name ?? '',
        ca?.sub ?? '',
        c?.tax_class ?? '',
        c?.amount_yen ?? null,
        c?.partner ?? '',
        j.memo,
        j.department,
        JOURNAL_SOURCE_LABELS[j.source],
        j.yayoi_no,
      ]);
    }
  }

  // The reports, every year (newest first).
  const trial: Cell[][] = [['年度', '区分', '科目', '補助科目', '期首残高（円）', '借方（円）', '貸方（円）', '期末残高（円）']];
  const balances: Cell[][] = [['年度', '口座', '期首（円）', '入金（円）', '出金（円）', '残高（円）']];
  const budget: Cell[][] = [['年度', '区分', '科目', '予算（円）', '実績（円）', '差 実績−予算（円）', '達成率（%）']];
  const openings: Cell[][] = [['年度', '期首日', '科目', '補助科目', '貸借', '金額（円）']];
  let current = { money: 0, income: 0, expense: 0 };
  for (const year of years) {
    const totals = accountTotals(store, year);
    const accounts = [...totals.keys()]
      .map((id) => b.accounts.get(id))
      .filter((a): a is NonNullable<typeof a> => a !== undefined)
      .sort((x, y) => KIND_ORDER.get(x.kind)! - KIND_ORDER.get(y.kind)! || x.grp.localeCompare(y.grp, 'ja') || x.name.localeCompare(y.name, 'ja') || x.sub.localeCompare(y.sub, 'ja'));
    for (const a of accounts) {
      const t = totals.get(a.id)!;
      if (t.opening === 0 && t.debit === 0 && t.credit === 0) continue;
      // Shown on the side the account grows on (a positive 期末残高 is the usual case for every kind).
      const sign = normalSide(a.kind) === 'debit' ? 1 : -1;
      trial.push([year, ACCOUNT_KIND_LABELS[a.kind], a.name, a.sub, sign * t.opening, t.debit, t.credit, sign * (t.opening + t.debit - t.credit)]);
    }
    const money = moneyBalances(b, totals).filter((m) => m.openingYen !== 0 || m.inYen !== 0 || m.outYen !== 0);
    for (const m of money) balances.push([year, m.title, m.openingYen, m.inYen, m.outYen, m.balanceYen]);
    const rows = budgetRows(b, totals, store.budget(year));
    for (const r of rows) budget.push([year, r.kind === 'income' ? '収入' : '支出', r.accountName, r.budgetYen, r.actualYen, r.differenceYen, r.rate]);
    const { from } = fiscalRange(year, startMonth);
    for (const o of store.openings(year)) {
      const a = b.accounts.get(o.account_id);
      openings.push([year, from, a?.name ?? '（不明な科目）', a?.sub ?? '', o.amount_yen >= 0 ? '借方' : '貸方', Math.abs(o.amount_yen)]);
    }
    if (year === fiscalYear) {
      current = {
        money: money.reduce((s, m) => s + m.balanceYen, 0),
        income: rows.filter((r) => r.kind === 'income').reduce((s, r) => s + r.actualYen, 0),
        expense: rows.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.actualYen, 0),
      };
    }
  }

  const claimRows = store.allClaims();
  const claimReceipts = store.receiptsOf('claim', claimRows.map((c) => c.id));
  const claims: Cell[][] = [['番号', '年度', '申請日', '申請者', '部局', '支払日', '支払先', '品名・用途', '金額（円）', '科目', '状態', '事前の承認', '承認日', '返金日', '返金した口座', 'メモ（差し戻しの理由など）', '領収書（枚）']];
  for (const c of [...claimRows].sort((x, y) => y.fiscal_year - x.fiscal_year || y.seq - x.seq)) {
    const account = c.account_id ? b.accounts.get(c.account_id) : undefined;
    const from = c.paid_from ? b.accounts.get(c.paid_from) : undefined;
    claims.push([
      claimNumber(c.fiscal_year, c.seq),
      c.fiscal_year,
      japanTime(c.created_at).slice(0, 10),
      c.claimant_name,
      c.department,
      c.spent_on,
      c.payee,
      c.purpose,
      c.amount_yen,
      account ? accountTitle(account) : '',
      CLAIM_STATE_LABELS[c.state],
      c.preapproval,
      c.approved_at ? japanTime(c.approved_at).slice(0, 10) : '',
      c.paid_on ?? '',
      from ? accountTitle(from) : '',
      c.note,
      claimReceipts.get(c.id)?.length ?? 0,
    ]);
  }
  const owedYen = claimRows.filter((c) => c.state === 'approved').reduce((s, c) => s + c.amount_yen, 0);

  const accountsTab: Cell[][] = [['区分', '科目', '補助科目', '見出し', '口座（現金・預金）', '税区分', '使うか']];
  for (const a of [...b.accounts.values()].sort((x, y) => KIND_ORDER.get(x.kind)! - KIND_ORDER.get(y.kind)! || x.grp.localeCompare(y.grp, 'ja') || x.name.localeCompare(y.name, 'ja') || x.sub.localeCompare(y.sub, 'ja'))) {
    accountsTab.push([ACCOUNT_KIND_LABELS[a.kind], a.name, a.sub, a.grp, a.money === 1 ? '口座' : '', a.tax_class, a.active === 1 ? '使う' : '使わない']);
  }

  const takenBack: Cell[][] = [['番号', '年度', '日付', '金額（円）', '摘要', '取引先', '取り消しの理由', '取り消した日時']];
  for (const j of voided) {
    const amount = (lines.get(j.id) ?? []).filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount_yen, 0);
    takenBack.push([journalNumber(j.seq), j.fiscal_year, j.date, amount, j.memo, j.counterparty, j.void_note, japanTime(j.updated_at)]);
  }

  const { from, to } = fiscalRange(fiscalYear, startMonth);
  const guide: Cell[][] = [
    ['医薬祭実行委員会 会計のマスターシート', ''],
    ['', ''],
    ['これは何か', '医薬祭の基盤システム（会計）が付けている帳簿の写しです。基盤で記帳するたびに、しばらくして自動で書き直されます。'],
    ['直したいとき', 'このシートは直接は編集できません（保護しています）。直すときは基盤の「会計」タブから直してください。'],
    ['最終更新', `${japanTime(writtenAt)}（日本時間）`],
    ['', ''],
    [`${fiscalYear}年度のいま`, `${from}〜${to}`],
    ['口座の残高の合計', yen(current.money)],
    ['収入の合計', yen(current.income)],
    ['支出の合計', yen(current.expense)],
    ['返金待ちの立替', yen(owedYen)],
    ['帳簿の確かめ', `仕訳帳の借方金額の合計 ${yen(debitSum)}、貸方金額の合計 ${yen(creditSum)}（${debitSum === creditSum ? '一致しています' : '一致していません。会計課に知らせてください'}）`],
    ['', ''],
    ['タブの中身', ''],
    [tab('収支一覧'), 'お金の出入りを 1 件 1 行で。まずはここを見てください。'],
    [tab('口座残高'), '口座（現金・預金）ごとの期首・入金・出金・残高。年度ごと。'],
    [tab('予算と実績'), '科目ごとの予算と、実際に使った額・入った額。年度ごと。'],
    [tab('立替精算'), '委員が立て替えた分の申請と、返金の状況。'],
    [tab('仕訳帳'), '借方・貸方の仕訳（弥生と同じ考え方）。どの行も、その行だけで読めるようにしています。'],
    [tab('残高試算表'), '科目ごとの期首・借方・貸方・期末。年度ごと。期末残高は、その科目が増える側をプラスで書いています。'],
    [tab('期首残高'), '年度の初めの残高（弥生の期首残高と同じ）。'],
    [tab('科目'), '使っている勘定科目と補助科目、税区分。'],
    [tab('取り消した仕訳'), '取り消した仕訳。ほかのタブの合計には入っていません。'],
    ['', ''],
    ['見方', '金額の単位は円、日付は 年-月-日 です。どのタブも 1 行目の見出しで絞り込み・並べ替えができます（表示だけで、元の表は変わりません）。'],
    ['領収書', '領収書の画像は基盤の中に保存しています。このシートには枚数だけ載せています。'],
    ['基盤が止まったら', 'このシートはそのまま読めます。帳簿を手で続けるときは「ファイル → コピーを作成」で保護のないコピーを作り、コピーの仕訳帳に行を足してください。仕訳帳・期首残高・科目があれば、弥生にも同じ帳簿を作れます。'],
  ];

  return [
    { title: tab('案内'), rows: guide, header: false, widths: { 0: 220, 1: 760 } },
    { title: tab('収支一覧'), rows: list, dates: [0], yen: [6, 7, 8] },
    { title: tab('口座残高'), rows: balances, yen: [2, 3, 4, 5] },
    { title: tab('予算と実績'), rows: budget, yen: [3, 4, 5] },
    { title: tab('立替精算'), rows: claims, dates: [2, 5, 12, 13], yen: [8] },
    { title: tab('仕訳帳'), rows: journal, dates: [1], yen: [6, 11] },
    { title: tab('残高試算表'), rows: trial, yen: [4, 5, 6, 7] },
    { title: tab('期首残高'), rows: openings, dates: [1], yen: [5] },
    { title: tab('科目'), rows: accountsTab },
    { title: tab('取り消した仕訳'), rows: takenBack, dates: [2], yen: [3] },
  ];
}
