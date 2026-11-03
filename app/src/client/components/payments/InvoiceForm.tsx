import { useState, type FormEvent } from 'react';
import { PAYMENT_LIMITS, yen, type InvoiceableOrg, type InvoiceDetailResponse, type InvoiceView } from '../../../shared/payments';
import { api } from '../../api';
import { failureOf, newClientToken } from './common';

// 請求を作る (from an organization of the year that has none yet, with its amount and the payer's name filled in) and
// 請求を編集. The day a mail went to the organization is offered for 請求日 as a button; nothing is set by itself.
// Errors are shown next to their field, and what was typed stays.

type Mode = { kind: 'new'; invoiceable: InvoiceableOrg[]; fiscalYear: number } | { kind: 'edit'; invoice: InvoiceView; issuedOnHints: { date: string; subject: string }[] };

/** "300,000円" or "３０００００" as a number; null when it is not a whole number of yen. */
function parseYen(value: string): number | null {
  const v = value.normalize('NFKC').replace(/[,\s円¥]/g, '');
  if (!/^\d{1,9}$/.test(v)) return null;
  return Number(v);
}

export function InvoiceForm({ mode, onSaved, onCancel }: { mode: Mode; onSaved: (saved: InvoiceDetailResponse) => void; onCancel: () => void }) {
  const editing = mode.kind === 'edit' ? mode.invoice : null;
  const [orgId, setOrgId] = useState(editing?.orgId ?? '');
  const [amount, setAmount] = useState(editing ? String(editing.amountYen) : '');
  const [issuedOn, setIssuedOn] = useState(editing?.issuedOn ?? '');
  const [dueOn, setDueOn] = useState(editing?.dueOn ?? '');
  const [payerKana, setPayerKana] = useState(editing?.payerKana ?? '');
  const [number, setNumber] = useState(editing?.number ?? '');
  const [memo, setMemo] = useState(editing?.memo ?? '');
  const [allowAnother, setAllowAnother] = useState(false);
  const [askAnother, setAskAnother] = useState(false);
  const [token] = useState(newClientToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field: string | null } | null>(null);

  const orgs = mode.kind === 'new' ? mode.invoiceable : [];
  const org = orgs.find((o) => o.orgId === orgId) ?? null;
  const hints = mode.kind === 'edit' ? mode.issuedOnHints : (org?.issuedOnHints ?? []);

  const chooseOrg = (id: string) => {
    const before = org;
    const next = orgs.find((o) => o.orgId === id) ?? null;
    setOrgId(id);
    setError(null);
    // The amount and the payer's name follow the organization unless they were typed by hand.
    if (next) {
      if (amount === '' || (before && amount === String(before.amountYen ?? ''))) setAmount(next.amountYen === null ? '' : String(next.amountYen));
      if (payerKana === '' || (before && payerKana === before.payerKana)) setPayerKana(next.payerKana);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!orgId) {
      setError({ message: '請求先の団体を選んでください。', field: 'orgId' });
      return;
    }
    const amountYen = parseYen(amount);
    if (amountYen === null || amountYen < 1) {
      setError({ message: '請求額を円の整数で入れてください（例: 300000）。', field: 'amountYen' });
      return;
    }
    setBusy(true);
    setError(null);
    const invoice = { orgId, number: number.trim(), amountYen, issuedOn: issuedOn || null, dueOn: dueOn || null, payerKana: payerKana.trim(), memo };
    try {
      const saved = editing
        ? await api<InvoiceDetailResponse>('PUT', `/api/payments/invoices/${encodeURIComponent(editing.id)}`, { expectedVersion: editing.version, invoice })
        : await api<InvoiceDetailResponse>('POST', '/api/payments/invoices', { clientToken: token, invoice, ...(allowAnother ? { allowAnother: true } : {}) });
      onSaved(saved);
    } catch (err) {
      const f = failureOf(err);
      // The organization has an invoice already: a second one is made only when asked for.
      if (!editing && f.conflict && f.field === 'orgId') setAskAnother(true);
      setError({ message: f.message, field: f.field });
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (field: string) =>
    error?.field === field ? (
      <p className="field-error" role="alert">
        {error.message}
      </p>
    ) : null;

  if (mode.kind === 'new' && orgs.length === 0) {
    return (
      <div className="pay-form">
        <h2>請求を作る</h2>
        <p className="list-empty">{mode.fiscalYear}年度の団体には、すべて請求があります（または団体がまだありません）。団体を追加すると、ここで請求を作れます。</p>
        <div className="actions">
          <button type="button" className="secondary" onClick={onCancel}>
            閉じる
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="pay-form" onSubmit={(e) => void submit(e)} noValidate data-testid="accounting-invoice-form">
      <h2>{editing ? `請求 ${editing.number} を編集` : '請求を作る'}</h2>
      {error && error.field === null && (
        <p className="status error" role="alert">
          {error.message}
        </p>
      )}

      {editing ? (
        <p>
          請求先: <strong>{editing.orgName}</strong>
        </p>
      ) : (
        <label>
          請求先の団体
          <select value={orgId} onChange={(e) => chooseOrg(e.target.value)} aria-invalid={error?.field === 'orgId'}>
            <option value="">選んでください</option>
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>
                {o.name}（{o.kindLabel}・{o.status}
                {o.amountYen === null ? '' : `・${yen(o.amountYen)}`}）
              </option>
            ))}
          </select>
          {fieldError('orgId')}
        </label>
      )}
      {askAnother && (
        <label className="checkbox">
          <input type="checkbox" checked={allowAnother} onChange={(e) => setAllowAnother(e.target.checked)} />
          追加の請求として作る（分けて請求するときだけ）
        </label>
      )}

      <label>
        請求額（円）
        <input type="text" inputMode="numeric" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={error?.field === 'amountYen'} />
        {fieldError('amountYen')}
      </label>

      <label>
        請求日
        <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} aria-invalid={error?.field === 'issuedOn'} />
        {fieldError('issuedOn')}
      </label>
      {hints.length > 0 && (
        <div className="pay-hints" role="group" aria-label="請求日の候補">
          <span className="hint">この団体にメールを送った日（押すと請求日に入ります）:</span>
          {hints.map((h) => (
            <button key={`${h.date}-${h.subject}`} type="button" className="secondary" aria-pressed={issuedOn === h.date} onClick={() => setIssuedOn(h.date)}>
              {h.date}「{h.subject}」
            </button>
          ))}
        </div>
      )}

      <label>
        支払の期限
        <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} aria-invalid={error?.field === 'dueOn'} />
        {fieldError('dueOn')}
      </label>

      <label>
        振込名義（カナ。通帳に出る名前。候補を探すのに使います）
        <input type="text" value={payerKana} maxLength={PAYMENT_LIMITS.payerKana} onChange={(e) => setPayerKana(e.target.value)} aria-invalid={error?.field === 'payerKana'} />
        {fieldError('payerKana')}
      </label>

      <label>
        請求番号（空のままなら自動で付けます）
        <input type="text" value={number} maxLength={PAYMENT_LIMITS.number} onChange={(e) => setNumber(e.target.value)} aria-invalid={error?.field === 'number'} />
        {fieldError('number')}
      </label>

      <label>
        メモ
        <textarea rows={3} value={memo} maxLength={PAYMENT_LIMITS.memo} onChange={(e) => setMemo(e.target.value)} />
        {fieldError('memo')}
      </label>

      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? '保存しています…' : editing ? '保存' : '請求を作る'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}
