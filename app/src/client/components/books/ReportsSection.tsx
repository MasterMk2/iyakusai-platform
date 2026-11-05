import { useCallback, useMemo, useState } from 'react';
import { yen, type BooksMe, type BooksSummary, type BudgetRow } from '../../../shared/books';
import { api } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { failureOf, YearSelect } from './common';

// 残高と予算 (2026-11-05): the money in each account (期首 + 入金 − 出金), and the budget against what was spent and
// received, by account (予算と実績の対比). The accounting section's editor writes the budget here, per account name
// (弥生's 勘定科目; the sub-accounts add up under it).

interface Budget {
  fiscalYear: number;
  rows: BudgetRow[];
  lines: { accountName: string; amountYen: number }[];
  accountNames: { name: string; kind: 'income' | 'expense'; group: string; active: boolean }[];
}

const signed = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${yen(Math.abs(n))}`);

export function ReportsSection({ me, year, onYear, summary, onChanged }: { me: BooksMe; year: number; onYear: (year: number) => void; summary: BooksSummary | null; onChanged: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<Budget>('GET', `/api/books/budget?fiscalYear=${year}`, undefined, signal);
    },
    [year, refresh],
  );
  const budget = useLoader(load);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const table = (kind: 'income' | 'expense', rows: BudgetRow[]) => {
    const total = (pick: (r: BudgetRow) => number | null) => rows.reduce((s, r) => s + (pick(r) ?? 0), 0);
    const budgeted = rows.some((r) => r.budgetYen !== null);
    return (
      <table className="books-table" data-testid={`budget-${kind}`}>
        <caption>{kind === 'income' ? '収入' : '支出'}</caption>
        <thead>
          <tr>
            <th scope="col">科目</th>
            <th scope="col" className="num">
              予算
            </th>
            <th scope="col" className="num">
              実績
            </th>
            <th scope="col" className="num">
              予算との差
            </th>
            <th scope="col" className="num">
              実績 / 予算
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const over = kind === 'expense' && r.differenceYen !== null && r.differenceYen > 0;
            return (
              <tr key={r.accountName}>
                <th scope="row">{r.accountName}</th>
                <td className="num">{r.budgetYen === null ? '—' : yen(r.budgetYen)}</td>
                <td className="num">{yen(r.actualYen)}</td>
                <td className={`num ${over ? 'books-over' : ''}`}>
                  {signed(r.differenceYen)}
                  {over && <span className="sr-only">（予算超過）</span>}
                </td>
                <td className="num">{r.rate === null ? '—' : `${r.rate}%`}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">合計</th>
            <td className="num">{budgeted ? yen(total((r) => r.budgetYen)) : '—'}</td>
            <td className="num">{yen(total((r) => r.actualYen))}</td>
            <td className="num">{budgeted ? signed(total((r) => r.actualYen) - total((r) => r.budgetYen)) : '—'}</td>
            <td className="num" />
          </tr>
        </tfoot>
      </table>
    );
  };

  const data = budget.data;
  return (
    <div className="pay-view" data-testid="books-reports">
      <div className="pay-head">
        <div className="pane-title">
          <h2>残高と予算</h2>
          {summary && <span className="pane-sub">{`${summary.from}〜${summary.to}（${summary.today} 現在）`}</span>}
        </div>
        <div className="actions">
          <YearSelect
            year={year}
            onChange={(y) => {
              onYear(y);
              setEditing(false);
            }}
          />
          {me.canEdit && data && !editing && (
            <button type="button" className="secondary" onClick={() => { setNotice(null); setEditing(true); }} data-testid="budget-edit">
              予算を直す
            </button>
          )}
        </div>
      </div>
      {notice && (
        <p className="status ok" role="status">
          {notice}
        </p>
      )}
      <section className="books-report" aria-labelledby="balances-head">
        <h3 id="balances-head">口座の残高</h3>
        {!summary ? (
          <p className="hint">読み込んでいます…</p>
        ) : summary.balances.length === 0 ? (
          <p className="hint">口座（現金・預金）の科目がまだありません。「科目と設定」で足すか、弥生の期首残高を取り込んでください。</p>
        ) : (
          <table className="books-table" data-testid="balances">
            <caption className="sr-only">口座ごとの残高</caption>
            <thead>
              <tr>
                <th scope="col">口座</th>
                <th scope="col" className="num">
                  期首残高
                </th>
                <th scope="col" className="num">
                  入金
                </th>
                <th scope="col" className="num">
                  出金
                </th>
                <th scope="col" className="num">
                  残高
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.balances.map((b) => (
                <tr key={b.accountId}>
                  <th scope="row">{b.title}</th>
                  <td className="num">{yen(b.openingYen)}</td>
                  <td className="num">{yen(b.inYen)}</td>
                  <td className="num">{yen(b.outYen)}</td>
                  <td className="num">
                    <strong>{yen(b.balanceYen)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
            {summary.balances.length > 1 && (
              <tfoot>
                <tr>
                  <th scope="row">合計</th>
                  <td className="num">{yen(summary.balances.reduce((s, b) => s + b.openingYen, 0))}</td>
                  <td className="num">{yen(summary.balances.reduce((s, b) => s + b.inYen, 0))}</td>
                  <td className="num">{yen(summary.balances.reduce((s, b) => s + b.outYen, 0))}</td>
                  <td className="num">
                    <strong>{yen(summary.balances.reduce((s, b) => s + b.balanceYen, 0))}</strong>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
        {summary && summary.owedYen > 0 && <p className="hint">このほかに、承認して返金していない立替が {yen(summary.owedYen)} あります（「立替精算」の画面）。</p>}
      </section>
      <section className="books-report" aria-labelledby="budget-head">
        <h3 id="budget-head">予算と実績</h3>
        <LoadStatus loader={budget} what="予算" />
        {data && editing && (
          <BudgetEditor
            budget={data}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              setNotice(`${year}年度の予算を保存しました。`);
              setRefresh((n) => n + 1);
              onChanged();
            }}
          />
        )}
        {data && !editing && (
          <>
            {data.lines.length === 0 && <p className="hint">{year}年度の予算はまだありません。{me.canEdit ? '「予算を直す」から入れられます。' : ''}実績だけを出しています。</p>}
            {data.rows.length === 0 ? (
              <p className="hint">収入・支出の仕訳も予算もまだありません。</p>
            ) : (
              <>
                {table('income', data.rows.filter((r) => r.kind === 'income'))}
                {table('expense', data.rows.filter((r) => r.kind === 'expense'))}
                <p className="hint">予算との差は「実績 − 予算」です（支出の＋は予算を超えた額）。取り消した仕訳は数えていません。実績は {year}年度の日付の仕訳の合計です（期首残高は入りません）。</p>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function BudgetEditor({ budget, onCancel, onSaved }: { budget: Budget; onCancel: () => void; onSaved: () => void }) {
  const initial = useMemo(() => new Map(budget.lines.map((l) => [l.accountName, String(l.amountYen)])), [budget]);
  const [values, setValues] = useState<Map<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = budget.accountNames.filter((a) => a.active || initial.has(a.name));
  const save = async () => {
    if (busy) return;
    const lines: { accountName: string; amountYen: number }[] = [];
    for (const a of names) {
      const text = (values.get(a.name) ?? '').normalize('NFKC').replace(/[,円\s]/g, '');
      if (text === '') continue;
      if (!/^\d{1,9}$/.test(text)) {
        setError(`「${a.name}」の予算は数字で入れてください（空にすると予算なし）。`);
        return;
      }
      lines.push({ accountName: a.name, amountYen: Number(text) });
    }
    setBusy(true);
    setError(null);
    try {
      await api('PUT', '/api/books/budget', { fiscalYear: budget.fiscalYear, lines });
      onSaved();
    } catch (err) {
      setError(failureOf(err).message);
    } finally {
      setBusy(false);
    }
  };
  const group = (kind: 'income' | 'expense') => (
    <fieldset className="books-budget-group">
      <legend>{kind === 'income' ? '収入' : '支出'}</legend>
      {names
        .filter((a) => a.kind === kind)
        .map((a) => (
          <label key={a.name} className="books-budget-line">
            <span>{a.name}</span>
            <input type="text" inputMode="numeric" autoComplete="off" value={values.get(a.name) ?? ''} placeholder="予算なし" onChange={(e) => setValues(new Map(values).set(a.name, e.target.value))} />
            <span aria-hidden="true">円</span>
          </label>
        ))}
    </fieldset>
  );
  return (
    <form
      className="pay-form books-budget"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-testid="budget-form"
    >
      <p className="hint">{budget.fiscalYear}年度の予算を科目ごとに入れます。空の科目は予算なしになります。</p>
      {group('income')}
      {group('expense')}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy} data-testid="budget-save">
          {busy ? '保存しています…' : '予算を保存する'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}
