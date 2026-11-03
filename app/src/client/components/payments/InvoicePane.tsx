import { useEffect, useRef, useState } from 'react';
import { CANDIDATE_MIN_SCORE, yen, type ConfirmResponse, type DepositCandidate, type InvoiceDetailResponse } from '../../../shared/payments';
import { api, fmtDate } from '../../api';
import { failureOf, InvoiceBadges, ORG_AFTER_CHANGE, remainingOf } from './common';
import { InvoiceForm } from './InvoiceForm';

// One invoice: what was asked and what came in, the deposits that may be its payment (best first, chosen with a tap
// on the whole row), and 確定 at the foot of the list (it stays in view while choosing). A shortfall is closed only
// when someone accepts it with a reason (also when no deposit is left to choose); a confirmation is taken off with
// 確定を外す (recorded). The version sent with each write stops a second click from an older screen: the latest is
// loaded, and the screen says which of the chosen deposits could no longer be kept.
// The answer of 確定 shows next to the button (the foot of the list stays in view on a phone); the others show at the
// top of the invoice, which is scrolled into view.

type Message = { text: string; tone: 'ok' | 'warning' | 'error'; near: 'sum' | 'top' };

const ORG_RESULT: Record<ConfirmResponse['org'], string> = {
  advanced: '団体の状態を「入金済み」にしました。',
  reverted: '団体の状態を元に戻しました。',
  unchanged: '',
  failed: '団体の状態は変えられませんでした。団体の画面で状態を確かめてください。',
};

export function InvoicePane({ id, canConfirm, onChanged, onOpenDeposit }: { id: string; canConfirm: boolean; onChanged: () => void; onOpenDeposit: (id: string) => void }) {
  const [detail, setDetail] = useState<InvoiceDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [acceptShort, setAcceptShort] = useState(false);
  const [shortNote, setShortNote] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidNote, setVoidNote] = useState('');
  const topMessage = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<InvoiceDetailResponse>('GET', `/api/payments/invoices/${encodeURIComponent(id)}`, undefined, controller.signal)
      .then((d) => {
        setDetail(d);
        setLoadError(null);
        // A deposit chosen before a reload stays chosen only while it can still be chosen.
        setPicked((prev) => new Set([...prev].filter((p) => d.candidates.some((c) => c.deposit.id === p))));
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setLoadError(failureOf(err).message);
      });
    return () => controller.abort();
  }, [id, reloadKey]);

  // A message at the top of the invoice may be above the screen (a phone, after scrolling the list of deposits).
  useEffect(() => {
    topMessage.current?.scrollIntoView?.({ block: 'nearest' });
  }, [message]);

  if (loadError && !detail) {
    return (
      <div className="status error" role="alert">
        請求を読めませんでした（{loadError}）。
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

  const inv = detail.invoice;
  if (editing) {
    return (
      <InvoiceForm
        mode={{ kind: 'edit', invoice: inv, issuedOnHints: detail.issuedOnHints }}
        onSaved={(saved) => {
          setDetail(saved);
          setEditing(false);
          setMessage({ text: `請求を保存しました。${ORG_AFTER_CHANGE[saved.org ?? 'unchanged']}`, tone: saved.org === 'failed' ? 'warning' : 'ok', near: 'top' });
          onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const open = inv.state === 'open' || inv.state === 'partial';
  const good = detail.candidates.filter((c) => c.score >= CANDIDATE_MIN_SCORE);
  const rest = detail.candidates.filter((c) => c.score < CANDIDATE_MIN_SCORE);
  const pickedSum = detail.candidates.filter((c) => picked.has(c.deposit.id)).reduce((sum, c) => sum + c.deposit.amountYen, 0);
  const after = inv.paidYen + pickedSum;
  const diff = after - inv.amountYen;
  const canAcceptShort = diff < 0 && after > 0;
  const shortOn = acceptShort && canAcceptShort;
  const ready = open && (picked.size > 0 || shortOn) && (!shortOn || shortNote.trim().length > 0);
  // 確定 is offered while there is a deposit to choose, and for a part payment also without one (to accept the rest).
  const sumShown = open && canConfirm && (detail.candidates.length > 0 || inv.state === 'partial');
  const messageAtSum = message !== null && message.near === 'sum' && sumShown;

  /** After a conflict: the latest invoice, and the chosen deposits that can still be chosen (said when some could not). */
  const reloadAfterConflict = async (): Promise<string> => {
    try {
      const latest = await api<InvoiceDetailResponse>('GET', `/api/payments/invoices/${encodeURIComponent(inv.id)}`);
      const usable = new Set(latest.candidates.map((c) => c.deposit.id));
      const kept = [...picked].filter((p) => usable.has(p));
      const dropped = picked.size - kept.length;
      setDetail(latest);
      setPicked(new Set(kept));
      if (dropped > 0) return `最新の内容を読み込みました。選んでいた入金のうち ${dropped} 件は、ほかの請求に充てられたか照合の対象外になったため外しました`;
      return picked.size > 0 ? '最新の内容を読み込みました。選んだ入金はそのままです' : '最新の内容を読み込みました';
    } catch {
      setReloadKey((n) => n + 1);
      return '読み直しています';
    }
  };

  /** Writes and shows the answer; a conflict loads the latest version. */
  const write = async (near: Message['near'], run: () => Promise<{ detail: InvoiceDetailResponse; message: Omit<Message, 'near'> }>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await run();
      setDetail(next.detail);
      setMessage({ ...next.message, near });
      onChanged();
    } catch (err) {
      const f = failureOf(err);
      const reloaded = f.conflict ? `（${await reloadAfterConflict()}）` : '';
      setMessage({ text: `${f.message}${reloaded}`, tone: 'error', near });
    } finally {
      setBusy(false);
    }
  };

  const confirm = () =>
    write('sum', async () => {
      const res = await api<ConfirmResponse>('POST', `/api/payments/invoices/${encodeURIComponent(inv.id)}/confirm`, {
        expectedVersion: inv.version,
        depositIds: [...picked],
        ...(shortOn ? { acceptShort: { note: shortNote.trim() } } : {}),
      });
      setPicked(new Set());
      setAcceptShort(false);
      setShortNote('');
      const paid = res.invoice.invoice.state === 'paid';
      const text = `${paid ? '入金済みにしました。' : `入金を確定しました（残り ${yen(remainingOf(res.invoice.invoice))}）。`}${ORG_RESULT[res.org]}`;
      return { detail: res.invoice, message: { text, tone: res.org === 'failed' ? 'warning' : 'ok' } };
    });

  const unconfirm = (depositIds: string[]) =>
    write('top', async () => {
      const res = await api<ConfirmResponse>('POST', `/api/payments/invoices/${encodeURIComponent(inv.id)}/unconfirm`, { expectedVersion: inv.version, depositIds });
      const text = `${depositIds.length > 0 ? '入金の確定を外しました。' : '不足の承認を取り消しました。'}${ORG_RESULT[res.org]}`;
      return { detail: res.invoice, message: { text, tone: res.org === 'failed' ? 'warning' : 'ok' } };
    });

  const setVoid = (on: boolean) =>
    write('top', async () => {
      const detail = on
        ? await api<InvoiceDetailResponse>('POST', `/api/payments/invoices/${encodeURIComponent(inv.id)}/void`, { expectedVersion: inv.version, note: voidNote.trim() })
        : await api<InvoiceDetailResponse>('POST', `/api/payments/invoices/${encodeURIComponent(inv.id)}/restore`, { expectedVersion: inv.version });
      setVoiding(false);
      setVoidNote('');
      const text = `${on ? '請求を取り消しました（記録は残ります。「取り消しを戻す」で戻せます）。' : '請求の取り消しを戻しました。'}${ORG_AFTER_CHANGE[detail.org ?? 'unchanged']}`;
      return { detail, message: { text, tone: detail.org === 'failed' ? 'warning' : 'ok' } };
    });

  const toggle = (depositId: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(depositId);
      else next.delete(depositId);
      return next;
    });

  const statusLine = (m: Message) => (
    <p className={`status ${m.tone}`} role={m.tone === 'error' ? 'alert' : 'status'}>
      {m.text}
    </p>
  );

  const pickRow = (c: DepositCandidate) => (
    <li key={c.deposit.id} className="pay-pick">
      <label>
        <input type="checkbox" checked={picked.has(c.deposit.id)} disabled={busy} onChange={(e) => toggle(c.deposit.id, e.target.checked)} aria-label={`${c.deposit.bookedOn} ${yen(c.deposit.amountYen)} ${c.deposit.description} を選ぶ`} />
        <span className="pay-pick-main">
          <span className="pay-row-top">
            <span className="pay-desc">{c.deposit.description}</span>
            <span className="pay-amount">{yen(c.deposit.amountYen)}</span>
          </span>
          <span className="row-meta">
            <span>{c.deposit.bookedOn}</span>
          </span>
          {c.reasons.length > 0 && (
            <span className="pay-reasons">
              {c.reasons.map((r) => (
                <span key={r}>{r}</span>
              ))}
            </span>
          )}
        </span>
      </label>
    </li>
  );

  return (
    <div className="pay-invoice" data-testid="accounting-invoice">
      <div className="pane-head">
        <div className="pane-title">
          <h2>{inv.orgName}</h2>
          <span className="pane-sub">請求 {inv.number}</span>
        </div>
        <span className="row-meta">
          <InvoiceBadges invoice={inv} />
        </span>
      </div>
      {message && !messageAtSum && (
        <p ref={topMessage} className={`status ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      {!inv.orgExists && <p className="status warning">この請求の団体は台帳から削除されています（請求の記録は残っています）。</p>}

      <dl className="pay-facts">
        <dt>請求額</dt>
        <dd className="pay-amount">{yen(inv.amountYen)}</dd>
        <dt>入金額</dt>
        <dd className="pay-amount">
          {yen(inv.paidYen)}
          {inv.state === 'partial' && `（残り ${yen(remainingOf(inv))}）`}
          {inv.differenceYen > 0 && `（過払い ${yen(inv.differenceYen)}）`}
        </dd>
        {inv.shortAccepted && (
          <>
            <dt>不足を認めた理由</dt>
            <dd>
              {yen(-inv.differenceYen)}：{inv.shortNote}
            </dd>
          </>
        )}
        <dt>請求日</dt>
        <dd>{inv.issuedOn ?? '—'}</dd>
        <dt>支払の期限</dt>
        <dd>{inv.dueOn ?? '—'}</dd>
        <dt>振込名義</dt>
        <dd>{inv.payerKana || '—'}</dd>
        {inv.memo && (
          <>
            <dt>メモ</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{inv.memo}</dd>
          </>
        )}
        {inv.state === 'void' && (
          <>
            <dt>取り消した理由</dt>
            <dd>{inv.voidNote || '—'}</dd>
          </>
        )}
        <dt>更新</dt>
        <dd>
          {fmtDate(inv.updatedAt)} · {inv.updatedByName}
        </dd>
      </dl>

      {detail.allocations.length > 0 && (
        <section className="pay-section" aria-labelledby="pay-allocations-title">
          <h3 id="pay-allocations-title">この請求に充てた入金</h3>
          <ul className="pay-picks">
            {detail.allocations.map((a) => (
              <li key={a.transactionId} className="pay-pick-row">
                <span className="pay-pick-main">
                  <span className="pay-row-top">
                    <button type="button" className="link-button pay-link pay-desc" onClick={() => onOpenDeposit(a.transactionId)}>
                      {a.description || '（摘要なし）'}
                    </button>
                    <span className="pay-amount">{yen(a.amountYen)}</span>
                  </span>
                  <span className="hint">
                    {a.bookedOn} · 確定 {fmtDate(a.confirmedAt)} {a.confirmedByName}
                  </span>
                </span>
                {canConfirm && (
                  <button type="button" className="secondary" disabled={busy} aria-label={`${a.bookedOn} ${yen(a.amountYen)} の確定を外す`} onClick={() => void unconfirm([a.transactionId])}>
                    確定を外す
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canConfirm && inv.shortAccepted && (
            <div className="actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => void unconfirm([])}>
                不足の承認を取り消す
              </button>
            </div>
          )}
        </section>
      )}

      {open && canConfirm && (
        <section className="pay-section" aria-labelledby="pay-candidates-title">
          <h3 id="pay-candidates-title">この請求の入金を選ぶ</h3>
          {detail.candidates.length === 0 ? (
            <p className="hint">
              照合できていない入金がありません。
              {inv.state === 'partial' ? '残りの入金を待つか、振込手数料などで足りないまま入金が終わったときは、下で不足を認めて入金済みにできます。' : '銀行の明細を取り込むと、ここに候補が出ます。'}
            </p>
          ) : (
            <>
              {detail.candidatesTotal > detail.candidates.length && (
                <p className="hint">
                  照合できていない入金 {detail.candidatesTotal} 件のうち、近い順に {detail.candidates.length} 件を出しています。ここに無い入金は、「照合できていない入金」の一覧から開いて、この請求に充てられます。
                </p>
              )}
              {good.length > 0 ? (
                <ul className="pay-picks" aria-label="入金の候補">
                  {good.map(pickRow)}
                </ul>
              ) : (
                <p className="hint">金額や振込名義が近い入金はありません。ほかの入金から選べます。</p>
              )}
              {rest.length > 0 &&
                (showAll || good.length === 0 ? (
                  <>
                    <p className="hint">そのほかの照合できていない入金（{rest.length} 件）</p>
                    <ul className="pay-picks" aria-label="そのほかの入金">
                      {rest.map(pickRow)}
                    </ul>
                  </>
                ) : (
                  <button type="button" className="secondary" onClick={() => setShowAll(true)}>
                    ほかの入金も表示する（{rest.length} 件）
                  </button>
                ))}
            </>
          )}
          {sumShown && (
            <div className="pay-sum" role="region" aria-label="確定">
              <p>
                {detail.candidates.length > 0 && (
                  <>
                    選んだ入金 <strong className="pay-amount">{yen(pickedSum)}</strong>（{picked.size} 件）→{' '}
                  </>
                )}
                入金の合計 {yen(after)}／請求 {yen(inv.amountYen)}
                {(picked.size > 0 || inv.paidYen > 0) && (diff === 0 ? '：ちょうど' : diff > 0 ? `：過払い ${yen(diff)}` : `：不足 ${yen(-diff)}`)}
              </p>
              {canAcceptShort && (
                <>
                  <label className="checkbox">
                    <input type="checkbox" checked={acceptShort} disabled={busy} onChange={(e) => setAcceptShort(e.target.checked)} />
                    不足 {yen(-diff)} を認めて入金済みにする
                  </label>
                  {acceptShort && (
                    <label>
                      理由（振込手数料を引かれた、など）
                      <input type="text" value={shortNote} maxLength={200} onChange={(e) => setShortNote(e.target.value)} />
                    </label>
                  )}
                </>
              )}
              {messageAtSum && statusLine(message)}
              <div className="actions">
                <button type="button" disabled={!ready || busy} onClick={() => void confirm()} data-testid="accounting-confirm">
                  {busy ? '確定しています…' : shortOn ? '不足を認めて入金済みにする' : '選んだ入金で確定'}
                </button>
              </div>
              {!ready && !busy && (
                <p className="hint">
                  {shortOn && !shortNote.trim()
                    ? '不足を認める理由を書いてください。'
                    : picked.size === 0 && !shortOn
                      ? detail.candidates.length > 0
                        ? '入金を選ぶと確定できます。'
                        : '不足を認めるときは、上の印を付けて理由を書いてください。'
                      : ''}
                </p>
              )}
            </div>
          )}
        </section>
      )}
      {open && !canConfirm && <p className="hint">入金を確定するのは「請求と入金の確定」の権限がある人です。</p>}

      <details className="history pay-section">
        <summary>この請求の記録（{detail.history.length} 件）</summary>
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

      {canConfirm && (
        <div className="pay-danger-zone">
          {inv.state !== 'void' && (
            <div className="actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(true)}>
                請求を編集する
              </button>
            </div>
          )}
          {inv.state === 'void' ? (
            <div className="actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => void setVoid(false)}>
                取り消しを戻す
              </button>
            </div>
          ) : detail.allocations.length > 0 ? (
            <p className="hint">確定した入金がある請求は取り消せません（先に「確定を外す」で入金の確定を外してください）。</p>
          ) : voiding ? (
            <div className="status warning" role="group" aria-label="請求の取り消し">
              <label style={{ display: 'grid', gap: 4, width: '100%' }}>
                取り消す理由（二重に作った、など）
                <input type="text" value={voidNote} maxLength={200} onChange={(e) => setVoidNote(e.target.value)} />
              </label>
              <button type="button" className="danger" disabled={busy} onClick={() => void setVoid(true)}>
                請求を取り消す
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setVoiding(false)}>
                やめる
              </button>
            </div>
          ) : (
            <div className="actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => setVoiding(true)}>
                この請求を取り消す…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
