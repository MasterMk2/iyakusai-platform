import { useCallback, useEffect, useRef, useState } from 'react';
import { BOOKS_LIMITS, yen, type AccountView, type BooksHistoryView, type BooksMe, type BooksSettings, type BooksSummary, type JournalList, type JournalView } from '../../../shared/books';
import { api, fmtDate } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { changeYen, Facts, failureOf, History, Receipts, signedYen, YearSelect } from './common';
import { DepositsPane } from './DepositsPane';
import { EntryForm } from './EntryForm';

// 帳簿 (2026-11-05): every entry of the year, newest first, as members read them (口座, 科目, 入金・出金), with a
// search and an account to narrow them. With an account chosen the list is that account's own book (出納帳): each
// entry's change of it and the balance after, to check against the cash box or the passbook. 記帳する opens the form
// next to the list; an entry opens with its lines, its receipts and its history. 入金から記帳 books the deposits the
// payments screen confirmed.

type Pane = { kind: 'none' } | { kind: 'journal'; id: string } | { kind: 'new' } | { kind: 'edit'; journal: JournalView } | { kind: 'deposits' };

export function LedgerSection({ me, year, onYear, summary, onChanged }: { me: BooksMe; year: number; onYear: (year: number) => void; summary: BooksSummary | null; onChanged: () => void }) {
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [accountId, setAccountId] = useState('');
  const [voided, setVoided] = useState(false);
  const [pane, setPane] = useState<Pane>({ kind: 'none' });
  const [notice, setNotice] = useState<{ text: string; again?: boolean } | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      const p = new URLSearchParams({ fiscalYear: String(year) });
      if (q) p.set('q', q);
      if (accountId) p.set('accountId', accountId);
      if (voided) p.set('voided', '1');
      return api<JournalList>('GET', `/api/books/journals?${p.toString()}`, undefined, signal);
    },
    [year, q, accountId, voided, refresh],
  );
  const list = useLoader(load);
  const loadSettings = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<{ settings: BooksSettings; accounts: AccountView[] }>('GET', '/api/books/settings', undefined, signal);
    },
    [refresh],
  );
  const accounts = useLoader(loadSettings).data?.accounts ?? [];
  const reload = () => {
    setRefresh((n) => n + 1);
    onChanged();
  };
  const open = (next: Pane) => {
    setNotice(null);
    setPane(next);
  };
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = detailRef.current;
    if (pane.kind === 'none' || !el || !window.matchMedia?.('(max-width: 900px)').matches) return;
    // On a phone the opened entry is under the head and the filters: brought up unless its top is already in view.
    const top = el.getBoundingClientRect().top;
    if (top < 64 || top > window.innerHeight * 0.4) el.scrollIntoView?.({ block: 'start' });
  }, [pane]);
  const data = list.data;
  const book = data?.account ?? null;
  const filtered = q !== '' || accountId !== '' || voided;
  const moneyAccounts = accounts.filter((a) => a.money);
  const otherAccounts = accounts.filter((a) => !a.money);

  const row = (j: JournalView) => {
    const change = book?.byJournal[j.id];
    return (
      <li key={j.id}>
        <button type="button" className="row-open" aria-current={pane.kind === 'journal' && pane.id === j.id ? 'true' : undefined} onClick={() => open({ kind: 'journal', id: j.id })}>
          <span className="pay-row-top">
            <span className="row-main">{j.memo || j.counterparty || j.accountTitle || j.number}</span>
            {change ? (
              <span className={`pay-amount ${change.changeYen > 0 ? 'books-in' : 'books-out'}`}>{changeYen(change.changeYen)}</span>
            ) : (
              <span className={`pay-amount books-${j.direction}`}>{signedYen(j.direction, j.amountYen)}</span>
            )}
          </span>
          <span className="row-meta">
            <span>{j.date}</span>
            <span>{j.moneyAccountTitle ? `${j.moneyAccountTitle} ${j.direction === 'in' ? '←' : j.direction === 'out' ? '→' : '⇄'} ${j.accountTitle ?? ''}` : (j.accountTitle ?? '複合仕訳')}</span>
            {j.counterparty && j.memo && <span>{j.counterparty}</span>}
            <span>{j.number}</span>
            {j.source !== 'manual' && <span className="pay-badge">{j.sourceLabel}</span>}
            {j.voided && <span className="pay-badge short">取り消し</span>}
            {j.yayoiChangedAfterExport && !j.voided && <span className="pay-badge over">弥生で直す</span>}
            {j.receipts.length > 0 && <span>領収書 {j.receipts.length}</span>}
            {change && <span className="books-balance">残高 {yen(change.balanceYen)}</span>}
          </span>
        </button>
      </li>
    );
  };

  const detail = () => {
    const back = (
      <button type="button" className="back-link" onClick={() => setPane({ kind: 'none' })}>
        ← 一覧に戻る
      </button>
    );
    if (pane.kind === 'none') {
      return (
        <div className="detail-placeholder">
          <h2>仕訳を選択</h2>
          <p>一覧から選ぶと、借方・貸方と領収書、変更の記録を見られます。</p>
        </div>
      );
    }
    if (pane.kind === 'new' || pane.kind === 'edit') {
      return (
        <>
          {back}
          <EntryForm
            key={pane.kind === 'edit' ? pane.journal.id : `new-${refresh}`}
            accounts={accounts}
            editing={pane.kind === 'edit' ? pane.journal : null}
            onSaved={(journal) => {
              reload();
              setPane({ kind: 'journal', id: journal.id });
              setNotice({ text: `${journal.number} を${pane.kind === 'edit' ? '直しました' : '記帳しました'}（${yen(journal.amountYen)}）。`, again: pane.kind === 'new' });
            }}
            onCancel={() => setPane(pane.kind === 'edit' ? { kind: 'journal', id: pane.journal.id } : { kind: 'none' })}
          />
        </>
      );
    }
    if (pane.kind === 'deposits') {
      return (
        <>
          {back}
          <DepositsPane
            canEdit={me.canEdit}
            onBooked={(text) => {
              reload();
              setNotice({ text });
            }}
            onOpenJournal={(id) => open({ kind: 'journal', id })}
          />
        </>
      );
    }
    return (
      <>
        {back}
        <JournalPane key={`${pane.id}:${refresh}`} id={pane.id} canEdit={me.canEdit} onChanged={(text) => { reload(); if (text) setNotice({ text }); }} onEdit={(journal) => open({ kind: 'edit', journal })} />
      </>
    );
  };

  return (
    <div className="pay-view" data-testid="books-ledger">
      <div className="pay-head">
        <div className="pane-title">
          <h2>帳簿</h2>
          <span className="pane-sub">{summary ? `${summary.from}〜${summary.to}` : 'お金の出入り'}</span>
        </div>
        <div className="actions">
          <YearSelect
            year={year}
            onChange={(y) => {
              onYear(y);
              setPane({ kind: 'none' });
            }}
          />
          {me.canEdit && (
            <>
              <button type="button" onClick={() => open({ kind: 'new' })} data-testid="ledger-new">
                記帳する
              </button>
              <button type="button" className="secondary" onClick={() => open({ kind: 'deposits' })} data-testid="ledger-deposits">
                入金から記帳{summary && summary.depositsToBook > 0 ? `（${summary.depositsToBook}）` : ''}
              </button>
            </>
          )}
        </div>
      </div>
      {!me.canEdit && <p className="hint">見る権限だけがあります。記帳するのは「会計の確定」の権限がある人です。</p>}
      {summary && (
        <p className="books-totals" aria-label={`${summary.fiscalYear}年度の合計`}>
          <span>
            収入 <strong className="pay-amount">{yen(summary.incomeYen)}</strong>
          </span>
          <span>
            支出 <strong className="pay-amount">{yen(summary.expenseYen)}</strong>
          </span>
          <span>
            口座の残高 <strong className="pay-amount">{yen(summary.balances.reduce((s, b) => s + b.balanceYen, 0))}</strong>
          </span>
          {summary.owedYen > 0 && (
            <span>
              返金待ちの立替 <strong className="pay-amount">{yen(summary.owedYen)}</strong>
            </span>
          )}
        </p>
      )}
      {notice && (
        <p className="status ok" role="status">
          {notice.text}
          {notice.again && (
            <button type="button" className="secondary" onClick={() => open({ kind: 'new' })}>
              続けて記帳する
            </button>
          )}
        </p>
      )}
      <div className="list-tools books-tools">
        <label htmlFor="ledger-search" className="sr-only">
          帳簿を探す
        </label>
        <input id="ledger-search" className="list-search" type="search" value={typed} placeholder="摘要・取引先・科目・金額・番号" maxLength={100} onChange={(e) => setTyped(e.target.value)} data-testid="ledger-search" />
        <label className="books-inline-field">
          口座・科目
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} data-testid="ledger-account">
            <option value="">すべて</option>
            {moneyAccounts.length > 0 && (
              <optgroup label="口座（出納帳と残高）">
                {moneyAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="科目">
              {otherAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={voided} onChange={(e) => setVoided(e.target.checked)} />
          取り消した仕訳も出す
        </label>
      </div>
      <div style={{ position: 'relative' }}>
        <LoadStatus loader={list} what="帳簿" />
      </div>
      {data && (
        <div className={`pay-body ${pane.kind !== 'none' ? 'has-detail' : ''}`}>
          <div className="pay-list">
            {book && (
              <p className="books-account-sum" data-testid="ledger-book">
                <strong>{book.title}</strong>
                <span>
                  期首 <span className="pay-amount">{yen(book.openingYen)}</span>
                </span>
                <span>
                  残高 <strong className="pay-amount">{yen(book.closingYen)}</strong>
                </span>
                {book.money && <span className="hint">手元の現金や通帳の残高と見比べてください</span>}
              </p>
            )}
            <p className="hint">{data.total} 件</p>
            {data.journals.length > 0 ? (
              <ul className="rows-list pay-rows" aria-label="仕訳">
                {data.journals.map(row)}
              </ul>
            ) : filtered ? (
              <div className="list-empty">
                <p>条件に合う仕訳はありません。</p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setTyped('');
                    setQ('');
                    setAccountId('');
                    setVoided(false);
                  }}
                >
                  条件を外す
                </button>
              </div>
            ) : (
              <div className="list-empty">
                <p>{year}年度の仕訳はまだありません。</p>
                {me.canEdit && <p className="hint">「記帳する」から入れるか、「弥生」の画面で弥生の仕訳と期首残高を取り込めます。</p>}
              </div>
            )}
          </div>
          <div className="pay-detail" aria-label="仕訳の詳細" ref={detailRef}>
            {detail()}
          </div>
        </div>
      )}
    </div>
  );
}

function JournalPane({ id, canEdit, onChanged, onEdit }: { id: string; canEdit: boolean; onChanged: (notice: string | null) => void; onEdit: (journal: JournalView) => void }) {
  const load = useCallback((signal: AbortSignal) => api<{ journal: JournalView; history: BooksHistoryView[] }>('GET', `/api/books/journals/${encodeURIComponent(id)}`, undefined, signal), [id]);
  const loader = useLoader(load);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = loader.data;
  if (!data) return <LoadStatus loader={loader} what="仕訳" />;
  const j = data.journal;
  const act = async (path: string, body: unknown, done: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/books/journals/${encodeURIComponent(j.id)}/${path}`, body);
      setAsking(false);
      setNote('');
      onChanged(done);
    } catch (err) {
      const f = failureOf(err);
      setError(f.message);
      if (f.conflict) loader.retry();
    } finally {
      setBusy(false);
    }
  };
  const debits = j.lines.filter((l) => l.side === 'debit');
  const credits = j.lines.filter((l) => l.side === 'credit');
  const yayoi = j.source === 'yayoi' ? `弥生から取り込み${j.yayoiNo ? `（伝票 ${j.yayoiNo}）` : ''}` : j.yayoiExportedAt ? `${fmtDate(j.yayoiExportedAt)} に書き出し${j.yayoiNo ? `（弥生の伝票 ${j.yayoiNo}）` : ''}` : 'まだ書き出していない';
  const voidable = j.source !== 'claim';

  return (
    <div className="books-pane" data-testid="journal-pane">
      <div className="pane-title">
        <h2>{j.memo || j.accountTitle || j.number}</h2>
        {j.voided && <span className="pay-badge short">取り消し</span>}
      </div>
      {j.voided && j.voidNote && <p className="status warning">取り消しの理由: {j.voidNote}</p>}
      {j.yayoiChangedAfterExport && (
        <div className="status warning" role="note">
          弥生へ書き出したあとに{j.voided ? '取り消しました' : '変えました'}。弥生の同じ仕訳も手で{j.voided ? '消して' : '直して'}ください。
          {canEdit && (
            <button type="button" className="secondary" disabled={busy} onClick={() => void act('yayoi-fixed', {}, `${j.number} を弥生で直したことにしました。`)}>
              弥生で直した
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      {/* 直す・取り消す at the head: the facts, the lines and the receipts run longer than a screen. */}
      {canEdit && (
        <section className="pay-section books-pane-actions" aria-label="仕訳の操作">
          {j.source === 'claim' && <p className="hint">立替精算から入った仕訳です。直すときは立替精算の画面で承認や返金を取り消してください。</p>}
          {!j.voided && j.entry === null && j.source !== 'claim' && <p className="hint">この仕訳はここでは直せません（複合仕訳・弥生や入金確認から来た仕訳）。取り消して記帳し直すか、弥生で直して取り込み直してください。</p>}
          {j.voided ? (
            (j.source === 'manual' || j.source === 'yayoi') && (
              <div className="actions">
                <button type="button" className="secondary" disabled={busy} onClick={() => void act('restore', { expectedVersion: j.version }, `${j.number} の取り消しを戻しました。`)}>
                  取り消しを戻す
                </button>
              </div>
            )
          ) : asking ? (
            <div className="pay-row-extra">
              <label>
                取り消しの理由
                <input type="text" value={note} maxLength={BOOKS_LIMITS.note} onChange={(e) => setNote(e.target.value)} autoFocus />
              </label>
              <div className="actions">
                <button type="button" className="danger" disabled={busy} onClick={() => void act('void', { expectedVersion: j.version, note }, `${j.number} を取り消しました（合計には入りません）。`)}>
                  取り消す
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => setAsking(false)}>
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <div className="actions">
              {j.entry && j.source === 'manual' && (
                <button type="button" onClick={() => onEdit(j)} data-testid="journal-edit">
                  直す
                </button>
              )}
              {voidable && (
                <button type="button" className="secondary" onClick={() => setAsking(true)}>
                  取り消す…
                </button>
              )}
            </div>
          )}
        </section>
      )}
      <Facts
        items={[
          ['番号', j.number],
          ['日付', j.date],
          ['金額', <span className="pay-amount">{yen(j.amountYen)}</span>],
          ['口座', j.moneyAccountTitle],
          ['科目', j.accountTitle],
          ['取引先', j.counterparty],
          ['部局', j.department],
          ['記帳元', j.sourceLabel],
          ['弥生', yayoi],
          ['最後に変えた人', `${j.updatedByName}（${fmtDate(j.updatedAt)}）`],
        ]}
      />
      <table className="books-lines">
        <caption className="sr-only">借方と貸方</caption>
        <thead>
          <tr>
            <th scope="col">借方</th>
            <th scope="col" className="num">
              金額
            </th>
            <th scope="col">貸方</th>
            <th scope="col" className="num">
              金額
            </th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: Math.max(debits.length, credits.length) }, (_, i) => (
            <tr key={i}>
              <td>{debits[i]?.accountTitle ?? ''}</td>
              <td className="num">{debits[i] ? yen(debits[i].amountYen) : ''}</td>
              <td>{credits[i]?.accountTitle ?? ''}</td>
              <td className="num">{credits[i] ? yen(credits[i].amountYen) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Receipts receipts={j.receipts} uploadUrl={`/api/books/journals/${encodeURIComponent(j.id)}/receipts`} canChange={canEdit && !j.voided} onChanged={() => { loader.retry(); onChanged(null); }} />
      <History items={data.history} />
    </div>
  );
}
