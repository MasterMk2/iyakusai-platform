import { useEffect, useRef, useState } from 'react';
import { CANDIDATE_MIN_SCORE, yen, type ConfirmResponse, type DepositDetailResponse, type InvoiceCandidate } from '../../../shared/payments';
import { api, fmtDate } from '../../api';
import { failureOf, InvoiceBadges, remainingOf } from './common';

// One deposit from the statement: the open invoices it may pay (best first) with 確定 on each, or the invoice it was
// put on. A deposit a transfer fee was taken off can close its invoice at once, with a reason (不足を認めて確定). A
// deposit that pays no invoice (interest, a member's own transfer) can be set aside with a reason, and back.
// The answer of a 確定 shows under the row that was pressed while the row is there, else at the top (scrolled to).

type Message = { text: string; tone: 'ok' | 'warning' | 'error'; near: string | 'top'; openInvoice?: string };

export function DepositPane({ id, canConfirm, onChanged, onOpenInvoice }: { id: string; canConfirm: boolean; onChanged: () => void; onOpenInvoice: (id: string) => void }) {
  const [detail, setDetail] = useState<DepositDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [excluding, setExcluding] = useState(false);
  const [note, setNote] = useState('');
  const [showAll, setShowAll] = useState(false);
  // The invoice whose shortfall is being accepted (the reason is asked under its row).
  const [shortFor, setShortFor] = useState<string | null>(null);
  const [shortNote, setShortNote] = useState('');
  const topMessage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<DepositDetailResponse>('GET', `/api/payments/deposits/${encodeURIComponent(id)}`, undefined, controller.signal)
      .then((d) => {
        setDetail(d);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setLoadError(failureOf(err).message);
      });
    return () => controller.abort();
  }, [id, reloadKey]);

  useEffect(() => {
    topMessage.current?.scrollIntoView?.({ block: 'nearest' });
  }, [message, detail]);

  if (loadError && !detail) {
    return (
      <div className="status error" role="alert">
        入金を読めませんでした（{loadError}）。
        <button type="button" className="secondary" onClick={() => setReloadKey((n) => n + 1)}>
          読み直す
        </button>
      </div>
    );
  }
  if (!detail) {
    return (
      <p className="status loading" role="status">
        読み込み中…
      </p>
    );
  }
  const d = detail.deposit;
  const good = detail.candidates.filter((c) => c.score >= CANDIDATE_MIN_SCORE);
  const rest = detail.candidates.filter((c) => c.score < CANDIDATE_MIN_SCORE);
  const shown = showAll || good.length === 0 ? detail.candidates : good;
  const atRow = message !== null && message.near !== 'top' && shown.some((c) => c.invoice.id === message.near) && !d.invoiceId;

  const run = async (near: Message['near'], fn: () => Promise<Omit<Message, 'near'>>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await fn();
      setMessage({ ...next, near });
      setReloadKey((n) => n + 1);
      onChanged();
    } catch (err) {
      const f = failureOf(err);
      setMessage({ text: f.conflict ? `${f.message}（最新の内容を読み込みました）` : f.message, tone: 'error', near });
      if (f.conflict) setReloadKey((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const confirmOn = (c: InvoiceCandidate, acceptShortNote: string | null) =>
    run(c.invoice.id, async () => {
      const res = await api<ConfirmResponse>('POST', `/api/payments/invoices/${encodeURIComponent(c.invoice.id)}/confirm`, {
        expectedVersion: c.invoice.version,
        depositIds: [d.id],
        ...(acceptShortNote ? { acceptShort: { note: acceptShortNote } } : {}),
      });
      setShortFor(null);
      setShortNote('');
      const paid = res.invoice.invoice.state === 'paid';
      const org = res.org === 'advanced' ? '団体の状態を「入金済み」にしました。' : res.org === 'failed' ? '団体の状態は変えられませんでした。団体の画面で確かめてください。' : '';
      const state = paid
        ? '入金済みになりました'
        : `残り ${yen(remainingOf(res.invoice.invoice))}。足りないまま入金が終わったときは、請求の画面で不足を認めて入金済みにできます`;
      return { text: `請求 ${c.invoice.number} に充てて確定しました（${state}）。${org}`, tone: res.org === 'failed' ? 'warning' : 'ok', ...(paid ? {} : { openInvoice: c.invoice.id }) };
    });

  const setExcluded = (on: boolean) =>
    run('top', async () => {
      await api<DepositDetailResponse>('POST', `/api/payments/deposits/${encodeURIComponent(d.id)}/exclude`, { excluded: on, note: on ? note.trim() : '' });
      setExcluding(false);
      setNote('');
      return { text: on ? '照合の対象外にしました（「照合の対象に戻す」で戻せます）。' : '照合の対象に戻しました。', tone: 'ok' };
    });

  const messageContent = (m: Message) => (
    <>
      <span>{m.text}</span>
      {m.openInvoice && (
        <button type="button" className="secondary" onClick={() => onOpenInvoice(m.openInvoice!)}>
          請求を開く
        </button>
      )}
    </>
  );

  const invoiceRow = (c: InvoiceCandidate) => {
    const shortfall = c.invoice.amountYen - c.invoice.paidYen - d.amountYen;
    return (
      <li key={c.invoice.id} className="pay-pick-row">
        <span className="pay-pick-main">
          <span className="pay-row-top">
            <button type="button" className="link-button pay-link" onClick={() => onOpenInvoice(c.invoice.id)}>
              {c.invoice.orgName}
            </button>
            <span className="pay-amount">{yen(c.invoice.amountYen)}</span>
          </span>
          <span className="row-meta">
            <span>請求 {c.invoice.number}</span>
            <InvoiceBadges invoice={c.invoice} />
            {c.invoice.state === 'partial' && <span>残り {yen(remainingOf(c.invoice))}</span>}
          </span>
          {c.reasons.length > 0 && (
            <span className="pay-reasons">
              {c.reasons.map((r) => (
                <span key={r}>{r}</span>
              ))}
            </span>
          )}
        </span>
        {canConfirm && (
          <span className="pay-row-actions">
            <button type="button" disabled={busy} onClick={() => void confirmOn(c, null)}>
              この請求で確定
            </button>
            {c.amountFit === 'fee' && shortFor !== c.invoice.id && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setShortFor(c.invoice.id);
                  setShortNote('');
                }}
              >
                不足を認めて確定…
              </button>
            )}
          </span>
        )}
        {canConfirm && shortFor === c.invoice.id && (
          <div className="pay-row-extra status info" role="group" aria-label={`請求 ${c.invoice.number} の不足を認めて確定`}>
            <label>
              不足 {yen(shortfall)} を認める理由（振込手数料を引かれた、など）
              <input type="text" value={shortNote} maxLength={200} onChange={(e) => setShortNote(e.target.value)} />
            </label>
            <span className="actions">
              <button type="button" disabled={busy || !shortNote.trim()} onClick={() => void confirmOn(c, shortNote.trim())}>
                {busy ? '確定しています…' : `不足 ${yen(shortfall)} を認めて入金済みにする`}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setShortFor(null)}>
                やめる
              </button>
            </span>
            {!shortNote.trim() && <span className="hint">理由を書くと確定できます。</span>}
          </div>
        )}
        {atRow && message.near === c.invoice.id && (
          <div className={`pay-row-extra status ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
            {messageContent(message)}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="pay-deposit" data-testid="accounting-deposit">
      <div className="pane-head">
        <div className="pane-title">
          <h2 className="pay-desc">{d.description}</h2>
          <span className="pane-sub">入金 {d.bookedOn}</span>
        </div>
      </div>
      {message && !atRow && (
        <div ref={topMessage} className={`status ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
          {messageContent(message)}
        </div>
      )}
      <dl className="pay-facts">
        <dt>入金額</dt>
        <dd className="pay-amount">{yen(d.amountYen)}</dd>
        <dt>日付</dt>
        <dd>{d.bookedOn}</dd>
        <dt>残高</dt>
        <dd className="pay-amount">{d.balanceYen === null ? '—' : yen(d.balanceYen)}</dd>
        <dt>取り込み</dt>
        <dd>
          {fmtDate(d.importedAt)}（明細の {d.line} 行目）
        </dd>
        {d.excluded && (
          <>
            <dt>照合の対象外</dt>
            <dd>{d.excludedNote || '理由なし'}</dd>
          </>
        )}
      </dl>

      {d.invoiceId ? (
        <section className="pay-section">
          <h3>充てた請求</h3>
          <p>
            <button type="button" className="link-button pay-link" onClick={() => onOpenInvoice(d.invoiceId!)}>
              {d.invoiceLabel ?? '請求を開く'}
            </button>
          </p>
          <p className="hint">確定を外すときは、請求の画面の「確定を外す」を使います。</p>
        </section>
      ) : d.excluded ? (
        canConfirm && (
          <div className="actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => void setExcluded(false)}>
              照合の対象に戻す
            </button>
          </div>
        )
      ) : (
        <>
          <section className="pay-section" aria-labelledby="pay-invoices-title">
            <h3 id="pay-invoices-title">この入金に合う請求</h3>
            {good.length === 0 && <p className="hint">金額や振込名義が近い未入金の請求はありません。{rest.length === 0 ? '請求を作ってから、ここに戻ってきてください。' : ''}</p>}
            {good.length > 0 && (
              <ul className="pay-picks" aria-label="この入金に合う請求">
                {good.map(invoiceRow)}
              </ul>
            )}
            {rest.length > 0 &&
              (showAll || good.length === 0 ? (
                <>
                  <p className="hint">そのほかの未入金の請求（{rest.length} 件）</p>
                  <ul className="pay-picks" aria-label="そのほかの未入金の請求">
                    {rest.map(invoiceRow)}
                  </ul>
                </>
              ) : (
                <button type="button" className="secondary" onClick={() => setShowAll(true)}>
                  ほかの未入金の請求も表示する（{rest.length} 件）
                </button>
              ))}
          </section>
          {canConfirm && (
            <div className="pay-danger-zone">
              {excluding ? (
                <div className="status info" role="group" aria-label="照合の対象外にする">
                  <label style={{ display: 'grid', gap: 4, width: '100%' }}>
                    理由（利息、委員の立替の戻り、など）
                    <input type="text" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
                  </label>
                  <button type="button" disabled={busy} onClick={() => void setExcluded(true)}>
                    対象外にする
                  </button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => setExcluding(false)}>
                    やめる
                  </button>
                </div>
              ) : (
                <div className="actions">
                  <button type="button" className="secondary" disabled={busy} onClick={() => setExcluding(true)}>
                    請求の入金ではない（照合の対象外にする）…
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <details className="history pay-section">
        <summary>この入金の記録（{detail.history.length} 件）</summary>
        <ul>
          {detail.history.map((h) => (
            <li key={h.id}>
              <span>
                {fmtDate(h.at)} · {h.actorName}
              </span>
              <span className="history-meta">{h.text}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
