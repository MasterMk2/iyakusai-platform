import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { yen, type DepositView, type InvoiceView, type PaymentsMe, type PaymentsOverview } from '../../../shared/payments';
import { api, fmtDate } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { failureOf, InvoiceBadges, ORG_AFTER_CHANGE, remainingOf } from './common';
import { DepositPane } from './DepositPane';
import { InvoiceForm } from './InvoiceForm';
import { InvoicePane } from './InvoicePane';
import { StatementImport } from './StatementImport';
import './payments.css';

// 会計 (入金確認, 2026-11-03), opened from 連絡先 → 団体 by the people with the accounting permission, and since 2026-11-05
// also from the 会計 tab (入金確認, without the way back to the organizations).
// The four lists the accounting checks — 未入金 (overdue first), 入金済み, 照合できていない入金, 過不足 — with their
// counts, the opened invoice or deposit next to them (in their place on a phone), and the two screens that add
// something: 請求を作る and 明細を取り込む (only with 請求と入金の確定). Opening and reading never changes anything.

type Tab = 'unpaid' | 'paid' | 'unmatched' | 'discrepancies';
type Pane = { kind: 'none' } | { kind: 'invoice'; id: string } | { kind: 'deposit'; id: string } | { kind: 'new' } | { kind: 'import' };

const TABS: { key: Tab; label: string }[] = [
  { key: 'unpaid', label: '未入金' },
  { key: 'paid', label: '入金済み' },
  { key: 'unmatched', label: '照合できていない入金' },
  { key: 'discrepancies', label: '過不足' },
];

const THIS_YEAR = new Date().getFullYear();

export function AccountingView({ me, onBack }: { me: PaymentsMe; onBack?: () => void }) {
  const [year, setYear] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('unpaid');
  const [pane, setPane] = useState<Pane>({ kind: 'none' });
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<PaymentsOverview>('GET', `/api/payments/overview${year === null ? '' : `?fiscalYear=${year}`}`, undefined, signal);
    },
    [year, refresh],
  );
  const overview = useLoader(load);
  const data = overview.data;
  const reload = () => setRefresh((n) => n + 1);
  const shownYear = year ?? data?.fiscalYear ?? THIS_YEAR;
  const open = (next: Pane) => {
    setNotice(null);
    setPane(next);
  };
  // On a phone the opened invoice or deposit takes the list's place: its head may be above the screen (a row far down
  // the list was tapped), so it is brought into view.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = detailRef.current;
    if (pane.kind === 'none' || !el || !window.matchMedia?.('(max-width: 900px)').matches) return;
    if (el.getBoundingClientRect().top < 64) el.scrollIntoView?.({ block: 'start' });
  }, [pane]);

  const removeImport = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await api('POST', `/api/payments/imports/${encodeURIComponent(id)}/remove`, {});
      setRemoving(null);
      setNotice('取り込みを取り消しました（その取り込みの入金を一覧から外しました）。');
      reload();
    } catch (err) {
      setRemoveError(failureOf(err).message);
    } finally {
      setBusy(false);
    }
  };

  const counts: Record<Tab, number> = {
    unpaid: data?.unpaid.length ?? 0,
    paid: data?.paid.length ?? 0,
    unmatched: data?.unmatched.length ?? 0,
    discrepancies: data?.discrepancies.length ?? 0,
  };
  const overdue = data?.unpaid.filter((i) => i.overdue).length ?? 0;
  const detailOpen = pane.kind !== 'none';

  const invoiceRow = (i: InvoiceView) => (
    <li key={i.id}>
      <button type="button" className="row-open" aria-current={pane.kind === 'invoice' && pane.id === i.id ? 'true' : undefined} onClick={() => open({ kind: 'invoice', id: i.id })}>
        <span className="pay-row-top">
          <span className="row-main">{i.orgName}</span>
          <span className="pay-amount">{yen(i.amountYen)}</span>
        </span>
        <span className="row-meta">
          <span>請求 {i.number}</span>
          <InvoiceBadges invoice={i} />
          {i.state === 'partial' && <span>残り {yen(remainingOf(i))}</span>}
          {i.state === 'paid' ? i.lastPaidOn && <span>入金 {i.lastPaidOn}</span> : i.dueOn && <span>期限 {i.dueOn}</span>}
        </span>
      </button>
    </li>
  );

  const depositRow = (d: DepositView) => (
    <li key={d.id}>
      <button type="button" className="row-open" aria-current={pane.kind === 'deposit' && pane.id === d.id ? 'true' : undefined} onClick={() => open({ kind: 'deposit', id: d.id })}>
        <span className="pay-row-top">
          <span className="row-main pay-desc">{d.description}</span>
          <span className="pay-amount">{yen(d.amountYen)}</span>
        </span>
        <span className="row-meta">
          <span>{d.bookedOn}</span>
          {d.excluded && <span className="pay-badge">対象外{d.excludedNote ? `（${d.excludedNote}）` : ''}</span>}
        </span>
      </button>
    </li>
  );

  const empty = (text: string, extra?: ReactNode) => (
    <div className="list-empty">
      <p>{text}</p>
      {extra}
    </div>
  );

  const list = () => {
    if (!data) return null;
    if (tab === 'unpaid') {
      if (data.unpaid.length > 0) return <ul className="rows-list pay-rows" aria-label="未入金の請求">{data.unpaid.map(invoiceRow)}</ul>;
      if (data.paid.length + data.voided.length === 0) {
        return empty(
          `${data.fiscalYear}年度の請求はまだありません。`,
          me.canConfirm ? (
            <button type="button" onClick={() => open({ kind: 'new' })}>
              請求を作る
            </button>
          ) : (
            <p className="hint">請求は「請求と入金の確定」の権限がある人が作ります。</p>
          ),
        );
      }
      return empty('未入金の請求はありません。');
    }
    if (tab === 'paid') return data.paid.length > 0 ? <ul className="rows-list pay-rows" aria-label="入金済みの請求">{data.paid.map(invoiceRow)}</ul> : empty('入金済みの請求はまだありません。');
    if (tab === 'discrepancies') {
      return data.discrepancies.length > 0 ? (
        <ul className="rows-list pay-rows" aria-label="過不足のある請求">{data.discrepancies.map(invoiceRow)}</ul>
      ) : (
        empty('過不足のある請求はありません。', <p className="hint">入金済みのうち、入金額が請求額と違うもの（過払い・不足を認めたもの）がここに出ます。</p>)
      );
    }
    if (data.unmatched.length > 0) {
      return (
        <>
          <p className="hint">入金は年度に関係なく、まだ請求に充てていないものを並べています。</p>
          <ul className="rows-list pay-rows" aria-label="照合できていない入金">{data.unmatched.map(depositRow)}</ul>
        </>
      );
    }
    return empty(
      '照合できていない入金はありません。',
      me.canConfirm && data.imports.length === 0 ? (
        <>
          <p className="hint">銀行の入出金明細（CSV）を取り込むと、入金がここに並びます。</p>
          <button type="button" onClick={() => open({ kind: 'import' })}>
            明細を取り込む
          </button>
        </>
      ) : undefined,
    );
  };

  const detail = () => {
    if (pane.kind === 'none') {
      return (
        <div className="detail-placeholder">
          <h2>請求か入金を選択</h2>
          <p>一覧から選ぶと、ここで入金を照らし合わせて確定できます。</p>
        </div>
      );
    }
    const back = (
      <button type="button" className="back-link" onClick={() => setPane({ kind: 'none' })}>
        ← 一覧に戻る
      </button>
    );
    if (pane.kind === 'invoice') {
      return (
        <>
          {back}
          <InvoicePane key={pane.id} id={pane.id} canConfirm={me.canConfirm} onChanged={reload} onOpenDeposit={(id) => open({ kind: 'deposit', id })} />
        </>
      );
    }
    if (pane.kind === 'deposit') {
      return (
        <>
          {back}
          <DepositPane key={pane.id} id={pane.id} canConfirm={me.canConfirm} onChanged={reload} onOpenInvoice={(id) => open({ kind: 'invoice', id })} />
        </>
      );
    }
    if (pane.kind === 'new') {
      return (
        <>
          {back}
          {data ? (
            <InvoiceForm
              mode={{ kind: 'new', invoiceable: data.invoiceable, fiscalYear: data.fiscalYear }}
              onSaved={(saved) => {
                reload();
                setPane({ kind: 'invoice', id: saved.invoice.id });
                setTab('unpaid');
                setNotice(`請求 ${saved.invoice.number}（${saved.invoice.orgName}）を作りました。${ORG_AFTER_CHANGE[saved.org ?? 'unchanged']}`);
              }}
              onCancel={() => setPane({ kind: 'none' })}
            />
          ) : (
            <p className="status loading" role="status">
              読み込み中…
            </p>
          )}
        </>
      );
    }
    return (
      <>
        {back}
        <StatementImport
          onDone={(added) => {
            reload();
            setPane({ kind: 'none' });
            setTab('unmatched');
            setNotice(added > 0 ? `${added} 件の入金を取り込みました。「照合できていない入金」から請求に充てられます。` : '新しい入金はありませんでした。');
          }}
          onCancel={() => setPane({ kind: 'none' })}
        />
      </>
    );
  };

  return (
    <div className="pay-view" data-testid="accounting">
      {onBack && (
        <button type="button" className="back-link" onClick={onBack}>
          ← 団体の一覧に戻る
        </button>
      )}
      <div className="pay-head">
        <div className="pane-title">
          <h2>会計（入金の確認）</h2>
          <span className="pane-sub">請求と銀行の入金を照らし合わせます</span>
        </div>
        <div className="actions">
          <label className="pay-year">
            年度
            <select
              value={shownYear}
              onChange={(e) => {
                setYear(Number(e.target.value));
                setPane({ kind: 'none' });
              }}
            >
              {[shownYear - 1, shownYear, shownYear + 1].map((y) => (
                <option key={y} value={y}>
                  {y}年度
                </option>
              ))}
            </select>
          </label>
          {me.canConfirm && (
            <>
              <button type="button" onClick={() => open({ kind: 'new' })} data-testid="accounting-new-invoice">
                請求を作る
              </button>
              <button type="button" className="secondary" onClick={() => open({ kind: 'import' })} data-testid="accounting-import">
                明細を取り込む
              </button>
            </>
          )}
        </div>
      </div>
      {!me.canConfirm && <p className="hint">見る権限だけがあります。請求を作る・入金を確定するのは「請求と入金の確定」の権限がある人です。</p>}
      {notice && (
        <p className="status ok" role="status">
          {notice}
        </p>
      )}

      <div className="pay-tabs filter-chips" role="group" aria-label="一覧の切り替え">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`filter-chip ${t.key === 'unpaid' && overdue > 0 ? 'tone-overdue' : ''}`}
            aria-pressed={tab === t.key}
            onClick={() => {
              setTab(t.key);
              if (pane.kind === 'new' || pane.kind === 'import') return;
              setPane({ kind: 'none' });
            }}
          >
            {t.label} <span className="option-count">{data ? counts[t.key] : '…'}</span>
          </button>
        ))}
      </div>

      <div style={{ position: 'relative' }}>
        <LoadStatus loader={overview} what="会計の一覧" />
      </div>

      {data && (
        <div className={`pay-body ${detailOpen ? 'has-detail' : ''}`}>
          <div className="pay-list">
            {tab === 'unpaid' && overdue > 0 && (
              <p className="hint">
                期限を過ぎた請求が {overdue} 件あります（先頭に並べています）。今日は {data.today} です。
              </p>
            )}
            {list()}

            <div className="pay-more">
              {data.excluded.length > 0 && (
                <details>
                  <summary>照合の対象外にした入金（{data.excluded.length} 件）</summary>
                  <ul className="rows-list pay-rows">{data.excluded.map(depositRow)}</ul>
                </details>
              )}
              {data.voided.length > 0 && (
                <details>
                  <summary>取り消した請求（{data.voided.length} 件）</summary>
                  <ul className="rows-list pay-rows">{data.voided.map(invoiceRow)}</ul>
                </details>
              )}
              {data.imports.length > 0 && (
                <details>
                  <summary>明細の取り込みの記録（{data.imports.length} 件）</summary>
                  {removeError && (
                    <p className="status error" role="alert">
                      {removeError}
                    </p>
                  )}
                  <ul className="pay-imports">
                    {data.imports.map((i) => (
                      <li key={i.id}>
                        <span>
                          {fmtDate(i.at)} · {i.actorName} · {i.label} · {i.added} 件{i.removed ? '（取り消し済み）' : i.matched > 0 ? `（${i.matched} 件を確定済み）` : ''}
                        </span>
                        {me.canConfirm &&
                          !i.removed &&
                          i.matched === 0 &&
                          (removing === i.id ? (
                            <span className="actions">
                              <button type="button" className="danger" disabled={busy} onClick={() => void removeImport(i.id)}>
                                {i.added} 件を一覧から外す
                              </button>
                              <button type="button" className="secondary" disabled={busy} onClick={() => setRemoving(null)}>
                                やめる
                              </button>
                            </span>
                          ) : (
                            <button type="button" className="secondary" onClick={() => setRemoving(i.id)}>
                              この取り込みを取り消す
                            </button>
                          ))}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <details>
                <summary>CSV に書き出す</summary>
                <p className="hint">表計算ソフトで開ける形（UTF-8・BOM 付き）です。金額や振込人の名前が入るので、会計の外に送らないでください。</p>
                <div className="actions">
                  <a className="button secondary" href={`/api/payments/export.csv?fiscalYear=${shownYear}&what=invoices`} download>
                    {shownYear}年度の請求と入金
                  </a>
                  <a className="button secondary" href="/api/payments/export.csv?what=deposits" download>
                    取り込んだ入金のすべて
                  </a>
                </div>
              </details>
            </div>
          </div>
          <div className="pay-detail" aria-label="請求と入金の詳細" ref={detailRef}>
            {detail()}
          </div>
        </div>
      )}
    </div>
  );
}
