import { useEffect, useState } from 'react';
import { yen, type OrgPaymentStatus as Status } from '../../../shared/payments';
import { api } from '../../api';
import { InvoiceBadges, remainingOf } from './common';
import './payments.css';

// The payment of one organization, in its detail (団体). Every member sees only 入金済み or not; the people with the
// accounting permission also see the invoices and the deposits put on them. Nothing shows where the server has no
// accounting (or the answer cannot be read), so the organization's screen stays as it was.

const STATE_TEXT: Record<Status['state'], string> = { none: '請求はまだありません', unpaid: '未入金', paid: '入金済み' };

export function OrgPaymentStatus({ orgId, version }: { orgId: string; version: number }) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<Status>('GET', `/api/payments/organizations/${encodeURIComponent(orgId)}`, undefined, controller.signal)
      .then((s) => setStatus(s && (s.state === 'none' || s.state === 'unpaid' || s.state === 'paid') ? s : null))
      .catch(() => {
        // No accounting on this server (or not readable now): the section is left out.
        if (!controller.signal.aborted) setStatus(null);
      });
    return () => controller.abort();
  }, [orgId, version]);

  // An organization without an invoice says nothing to the members outside the accounting.
  if (!status || (status.state === 'none' && !status.canView)) return null;
  const invoices = status.detail?.invoices ?? [];
  return (
    <section className="pay-org" aria-labelledby="pay-org-title" data-testid="org-payment">
      <h3 id="pay-org-title">入金</h3>
      <p>
        <span className={`pay-badge ${status.state === 'paid' ? 'paid' : ''}`}>{STATE_TEXT[status.state]}</span>
      </p>
      {invoices.length > 0 && (
        <ul>
          {invoices.map((i) => {
            const deposits = status.detail?.allocations[i.id] ?? [];
            return (
              <li key={i.id}>
                <span className="row-meta">
                  <span>請求 {i.number}</span>
                  <span className="pay-amount">{yen(i.amountYen)}</span>
                  <InvoiceBadges invoice={i} />
                  {i.state === 'partial' && <span>残り {yen(remainingOf(i))}</span>}
                  {i.dueOn && i.state !== 'paid' && i.state !== 'void' && <span>期限 {i.dueOn}</span>}
                </span>
                {deposits.map((a) => (
                  <span key={a.transactionId} className="hint">
                    {a.bookedOn} {yen(a.amountYen)}（確定 {a.confirmedByName}）
                  </span>
                ))}
              </li>
            );
          })}
        </ul>
      )}
      {status.canView && (
        <p className="hint">{status.canConfirm ? '請求の作成と入金の確定は「会計」（団体の一覧の上）から行います。' : '請求と入金の明細は「会計」（団体の一覧の上）で見られます。'}</p>
      )}
    </section>
  );
}
