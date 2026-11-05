import { useCallback, useEffect, useState } from 'react';
import type { BooksMe, BooksSummary } from '../../../shared/books';
import type { PaymentsMe } from '../../../shared/payments';
import { api } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { AccountingView } from '../payments/AccountingView';
import { ClaimsSection } from './ClaimsSection';
import { LedgerSection } from './LedgerSection';
import { ReportsSection } from './ReportsSection';
import { BooksSettingsSection } from './SettingsSection';
import { YayoiSection } from './YayoiSection';
import '../payments/payments.css';
import './books.css';

// 会計 (2026-11-05). Every member: their reimbursement claims (立替精算). The accounting section (会計を見る / 会計の確定):
// the books (帳簿), the balances and the budget, the payments screen (入金確認), 弥生 and the settings. A member
// without the accounting permission sees the claims only, without the switch. The counts on the switch are the things
// waiting for the accounting section (claims to check, deposits to book, entries not yet sent to 弥生).

export type BooksSection = 'claims' | 'ledger' | 'reports' | 'payments' | 'yayoi' | 'settings';
const SECTIONS: BooksSection[] = ['claims', 'ledger', 'reports', 'payments', 'yayoi', 'settings'];

export function parseBooksSection(value: string | undefined): BooksSection | null {
  return SECTIONS.includes(value as BooksSection) ? (value as BooksSection) : null;
}

const LABELS: Record<BooksSection, string> = {
  claims: '立替精算',
  ledger: '帳簿',
  reports: '残高と予算',
  payments: '入金確認',
  yayoi: '弥生',
  settings: '科目と設定',
};

export function BooksView({ section, onSection }: { section: BooksSection | null; onSection: (section: BooksSection) => void }) {
  const loadMe = useCallback((signal: AbortSignal) => api<BooksMe>('GET', '/api/books/me', undefined, signal), []);
  const me = useLoader(loadMe);
  const [payments, setPayments] = useState<PaymentsMe | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const changed = useCallback(() => setRefresh((n) => n + 1), []);
  const canView = me.data?.canView === true;

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    api<PaymentsMe>('GET', '/api/payments/me', undefined, controller.signal).then(setPayments, () => setPayments(null));
    return () => controller.abort();
  }, [canView]);

  const shownYear = year ?? me.data?.fiscalYear ?? new Date().getFullYear();
  const loadSummary = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return canView ? api<BooksSummary>('GET', `/api/books/summary?fiscalYear=${shownYear}`, undefined, signal) : Promise.resolve(null);
    },
    [canView, shownYear, refresh],
  );
  const summary = useLoader(loadSummary).data;

  if (!me.data) {
    return (
      <main className="main books-view">
        <h2>会計</h2>
        <LoadStatus loader={me} what="会計" />
      </main>
    );
  }
  const who = me.data;
  const available = SECTIONS.filter((s) => (s === 'claims' ? true : s === 'yayoi' ? who.canEdit : s === 'payments' ? who.canView && payments?.canView === true : who.canView));
  const current: BooksSection = section && available.includes(section) ? section : who.canView ? 'ledger' : 'claims';
  const counts: Partial<Record<BooksSection, number>> = summary
    ? { claims: summary.claimsWaiting, ledger: summary.depositsToBook, yayoi: summary.yayoi.unexported + summary.yayoi.changedAfterExport }
    : {};

  return (
    <main className="main books-view" data-testid="books">
      {available.length > 1 && (
        <nav className="books-sections filter-chips" aria-label="会計の画面">
          {available.map((s) => (
            <button key={s} type="button" className="filter-chip" aria-pressed={current === s} onClick={() => onSection(s)} data-testid={`books-section-${s}`}>
              {LABELS[s]}
              {counts[s] ? <span className="option-count"> {counts[s]}</span> : null}
            </button>
          ))}
        </nav>
      )}
      {current === 'claims' && <ClaimsSection me={who} year={shownYear} onYear={setYear} onChanged={changed} />}
      {current === 'ledger' && <LedgerSection me={who} year={shownYear} onYear={setYear} summary={summary} onChanged={changed} />}
      {current === 'reports' && <ReportsSection me={who} year={shownYear} onYear={setYear} summary={summary} onChanged={changed} />}
      {current === 'payments' && payments && <AccountingView me={payments} />}
      {current === 'yayoi' && <YayoiSection year={shownYear} onYear={setYear} onChanged={changed} />}
      {current === 'settings' && <BooksSettingsSection me={who} year={shownYear} onYear={setYear} summary={summary} onChanged={changed} />}
    </main>
  );
}
