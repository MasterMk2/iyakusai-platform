import { useCallback, useMemo, useState } from 'react';
import { BOOKS_LIMITS, yen, type AccountView, type BooksSettings, type DepositToBook } from '../../../shared/books';
import { api } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { failureOf } from './common';

// 入金から記帳 (2026-11-05): the deposits the payments screen confirmed against an invoice, not in the books yet. Each
// goes in as 収入 (the bank account ← the income of the organization's kind, as the settings say), several together;
// one already entered in 弥生 is marked so instead (it then stays out of the books here).

interface Deposits {
  paymentsAvailable: boolean;
  toBook: DepositToBook[];
  booked: (DepositToBook & { journalNumber: string })[];
  markedElsewhere: (DepositToBook & { note: string })[];
  takenBack: (DepositToBook & { journalNumber: string })[];
  settings: BooksSettings;
  moneyAccounts: AccountView[];
  incomeAccounts: AccountView[];
}

export function DepositsPane({ canEdit, onBooked, onOpenJournal }: { canEdit: boolean; onBooked: (notice: string) => void; onOpenJournal: (id: string) => void }) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<Deposits>('GET', '/api/books/deposits', undefined, signal);
    },
    [refresh],
  );
  const loader = useLoader(load);
  const data = loader.data;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [money, setMoney] = useState<Record<string, string>>({});
  const [income, setIncome] = useState<Record<string, string>>({});
  const [marking, setMarking] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moneyOf = (d: DepositToBook) => money[d.depositId] ?? data?.settings.depositMoneyAccountId ?? '';
  const incomeOf = (d: DepositToBook) => income[d.depositId] ?? d.suggestedAccountId ?? '';
  const chosen = useMemo(() => (data?.toBook ?? []).filter((d) => picked.has(d.depositId)), [data, picked]);
  const ready = chosen.length > 0 && chosen.every((d) => moneyOf(d) && incomeOf(d));

  if (!data) return <LoadStatus loader={loader} what="記帳する入金" />;

  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const text = await fn();
      setPicked(new Set());
      setMarking(null);
      setNote('');
      setRefresh((n) => n + 1);
      onBooked(text);
    } catch (err) {
      setError(failureOf(err).message);
      if (failureOf(err).conflict) setRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  const book = () =>
    run(async () => {
      const res = await api<{ booked: number }>('POST', '/api/books/deposits/book', { items: chosen.map((d) => ({ depositId: d.depositId, moneyAccountId: moneyOf(d), accountId: incomeOf(d) })) });
      return `${res.booked} 件の入金を帳簿に入れました（${yen(chosen.reduce((s, d) => s + d.amountYen, 0))}）。`;
    });

  if (!data.paymentsAvailable) return <p className="status error">入金確認の保存ファイルを開けないため、ここには何も出せません。</p>;

  return (
    <div className="books-pane" data-testid="deposits-pane">
      <h2>入金から記帳</h2>
      <p className="hint">「入金確認」で請求に充てて確定した入金のうち、まだ帳簿に入っていないものです。弥生で入れた入金は「弥生で記帳済み」にすると、二重になりません。</p>
      {data.takenBack.length > 0 && (
        <div className="status warning" role="note">
          入金確認で確定を取り消した入金が、帳簿に残っています。
          {data.takenBack.map((d) => (
            <button key={d.depositId} type="button" className="secondary" onClick={() => onOpenJournal(d.journalId!)}>
              {d.journalNumber} を開く
            </button>
          ))}
        </div>
      )}
      {data.toBook.length === 0 ? (
        <div className="list-empty">
          <p>帳簿に入れる入金はありません。</p>
        </div>
      ) : (
        <ul className="pay-picks">
          {data.toBook.map((d) => (
            <li key={d.depositId} className="pay-pick books-deposit">
              <label>
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={picked.has(d.depositId)}
                  onChange={(e) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(d.depositId);
                      else next.delete(d.depositId);
                      return next;
                    })
                  }
                  aria-label={`${d.bookedOn} ${d.orgName} ${yen(d.amountYen)}`}
                />
                <span className="pay-pick-main">
                  <span className="pay-row-top">
                    <span className="row-main">{d.orgName}</span>
                    <span className="pay-amount">{yen(d.amountYen)}</span>
                  </span>
                  <span className="row-meta">
                    <span>{d.bookedOn}</span>
                    <span>{d.orgKindLabel}</span>
                    <span>請求 {d.invoiceNumber}</span>
                    <span>{d.description}</span>
                  </span>
                </span>
              </label>
              {canEdit && (
                <div className="books-deposit-fields">
                  <label className="books-inline-field">
                    口座
                    <select value={moneyOf(d)} onChange={(e) => setMoney({ ...money, [d.depositId]: e.target.value })}>
                      <option value="">選んでください</option>
                      {data.moneyAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="books-inline-field">
                    科目
                    <select value={incomeOf(d)} onChange={(e) => setIncome({ ...income, [d.depositId]: e.target.value })}>
                      <option value="">選んでください</option>
                      {data.incomeAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  {marking === d.depositId ? (
                    <div className="pay-row-extra">
                      <label>
                        メモ（どこに記帳したか）
                        <input type="text" value={note} maxLength={BOOKS_LIMITS.note} placeholder="弥生で記帳済み" onChange={(e) => setNote(e.target.value)} autoFocus />
                      </label>
                      <div className="actions">
                        <button type="button" disabled={busy} onClick={() => void run(async () => { await api('POST', '/api/books/deposits/mark', { depositId: d.depositId, note }); return `${d.orgName} の入金を「別に記帳済み」にしました。`; })}>
                          記帳済みにする
                        </button>
                        <button type="button" className="secondary" disabled={busy} onClick={() => setMarking(null)}>
                          やめる
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="link-button pay-link" onClick={() => setMarking(d.depositId)}>
                      弥生で記帳済み…
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      {canEdit && data.toBook.length > 0 && (
        <div className="pay-sum">
          <p>
            選んだ入金 {chosen.length} 件・合計 <strong className="pay-amount">{yen(chosen.reduce((s, d) => s + d.amountYen, 0))}</strong>
          </p>
          {chosen.length > 0 && !ready && <p className="hint">選んだ入金の口座と科目を選んでください（科目の決まりは「科目と設定」で決められます）。</p>}
          <div className="actions">
            <button type="button" disabled={busy || !ready} onClick={() => void book()} data-testid="deposits-book">
              {chosen.length === 0 ? '記帳する入金を選んでください' : `${chosen.length} 件を記帳する`}
            </button>
          </div>
        </div>
      )}
      {data.markedElsewhere.length > 0 && (
        <details className="books-more">
          <summary>別に記帳済みにした入金（{data.markedElsewhere.length} 件）</summary>
          <ul className="pay-plan">
            {data.markedElsewhere.map((d) => (
              <li key={d.depositId}>
                <span className="pay-plan-head">
                  <span>
                    {d.bookedOn} · {d.orgName} · {yen(d.amountYen)} · {d.note}
                  </span>
                  {canEdit && (
                    <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => { await api('POST', '/api/books/deposits/unmark', { depositId: d.depositId }); return `${d.orgName} の入金を「記帳する入金」に戻しました。`; })}>
                      印を外す
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {data.booked.length > 0 && (
        <details className="books-more">
          <summary>帳簿に入れた入金（{data.booked.length} 件）</summary>
          <ul className="pay-plan">
            {data.booked.map((d) => (
              <li key={d.depositId}>
                <span className="pay-plan-head">
                  <span>
                    {d.bookedOn} · {d.orgName} · {yen(d.amountYen)}
                  </span>
                  <button type="button" className="link-button pay-link" onClick={() => onOpenJournal(d.journalId!)}>
                    {d.journalNumber}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
