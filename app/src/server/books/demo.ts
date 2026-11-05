import { DEFAULT_ACCOUNTS, fiscalYearOf, tokyoDate, type EntryInput } from '../../shared/books.js';
import type { User } from '../domain/types.js';
import type { BooksStore } from './store.js';
import { entryJournal } from './views.js';

// Synthetic books for the demo (SMM_AUTH_MODE=demo, 2026-11-05): 弥生's usual accounts, the settings, an opening
// balance, a budget, four entries and one claim waiting for a check. Only into an empty book; made-up names only.

export function seedDemoLedger(store: BooksStore, users: User[], now: string): void {
  if (store.accounts().length > 0) return;
  const actor = users.find((u) => u.canManageAccess)?.id ?? users[0]?.id ?? 'system';
  const today = tokyoDate(now);
  const year = fiscalYearOf(today, store.fiscalStartMonth());
  const day = (md: string) => {
    const d = `${year}-${md}`;
    return d > today ? today : d;
  };
  const ids = new Map<string, string>();
  store.tx(() => {
    for (const a of DEFAULT_ACCOUNTS) {
      ids.set(a.name, store.insertAccount({ name: a.name, sub: '', kind: a.kind, group: a.group, money: a.money === true, label: '', taxClass: '対象外', active: true }, actor, now).id);
    }
    store.setSetting('claimAccountId', ids.get('立替金'));
    store.setSetting('depositMoneyAccountId', ids.get('普通預金'));
    store.setSetting('depositAccountByKind', { sponsor: ids.get('協賛金'), exhibitor: ids.get('出展料'), donor: ids.get('寄付金収入') });
    store.bumpRevision();
  });
  const id = (name: string) => ids.get(name)!;
  store.setOpenings(year, [
    { accountId: id('普通預金'), amountYen: 800_000 },
    { accountId: id('現金'), amountYen: 20_000 },
    { accountId: id('繰越利益'), amountYen: -820_000 },
  ], actor, now);
  store.setBudget(year, [
    { accountName: '協賛金', amountYen: 1_000_000 },
    { accountName: '出展料', amountYen: 50_000 },
    { accountName: '広告宣伝費', amountYen: 200_000 },
    { accountName: '消耗品費', amountYen: 100_000 },
    { accountName: '賃借料', amountYen: 300_000 },
  ], actor, now);
  const entry = (e: Partial<EntryInput> & Pick<EntryInput, 'form' | 'date' | 'amountYen'>): EntryInput => ({
    moneyAccountId: null,
    accountId: null,
    toMoneyAccountId: null,
    debitAccountId: null,
    creditAccountId: null,
    counterparty: '',
    memo: '',
    department: '',
    ...e,
  });
  const entries: EntryInput[] = [
    entry({ form: 'expense', date: day('06-10'), amountYen: 55_000, moneyAccountId: id('普通預金'), accountId: id('広告宣伝費'), counterparty: '合成印刷株式会社', memo: 'ポスター印刷', department: '広報課' }),
    entry({ form: 'income', date: day('07-01'), amountYen: 30_000, moneyAccountId: id('普通預金'), accountId: id('学内寄付金'), counterparty: '合成後援会', memo: '寄付' }),
    entry({ form: 'transfer', date: day('07-15'), amountYen: 50_000, moneyAccountId: id('普通預金'), toMoneyAccountId: id('現金'), memo: '小口現金の補充' }),
    entry({ form: 'expense', date: day('08-03'), amountYen: 3_300, moneyAccountId: id('現金'), accountId: id('消耗品費'), counterparty: '合成ホームセンター', memo: '養生テープ', department: '当日運営課' }),
  ];
  entries.forEach((e, i) => {
    store.createJournal(entryJournal(e, (accountId) => (accountId ? store.account(accountId) : null), fiscalYearOf(e.date, store.fiscalStartMonth())), `demo-journal-${String(i + 1).padStart(9, '0')}`, actor, now);
  });
  const claimant = users.find((u) => u.id === 'u-viewer-b') ?? users[0];
  if (claimant) {
    store.createClaim(
      { spentOn: day('08-20'), amountYen: 1_980, payee: '合成文具店', purpose: '受付用のペンとクリップ', department: '', accountId: id('事務用品費'), preapproval: '' },
      year,
      { id: claimant.id, name: claimant.displayName },
      'demo-claim-0000000001',
      now,
    );
  }
}
