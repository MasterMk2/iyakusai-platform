import { INVOICE_STATE_LABELS, yen, type ConfirmResponse, type InvoiceView } from '../../../shared/payments';
import { toFailure } from '../../api';

// Small pieces the accounting screens share: the answer of a refused request, the invoice's badges, a request token.

export interface Failure {
  message: string;
  /** The input the server named (shown next to that field), or null. */
  field: string | null;
  /** Someone changed it first (409): the screen reloads and keeps what was chosen. */
  conflict: boolean;
  status: number;
  details: Record<string, unknown> | null;
}

export function failureOf(err: unknown): Failure {
  const f = toFailure(err);
  const body = f.body as { error?: unknown; details?: unknown } | null;
  const details = body?.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : null;
  return { message: f.message, field: typeof details?.field === 'string' ? details.field : null, conflict: f.status === 409, status: f.status, details };
}

/** A token for one click of 作る: the same click sent again (a slow network) makes no second invoice. */
export function newClientToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The state of an invoice in words and colour (the colour never stands alone). */
export function InvoiceBadges({ invoice }: { invoice: InvoiceView }) {
  return (
    <>
      <span className={`pay-badge ${invoice.state}`}>{INVOICE_STATE_LABELS[invoice.state]}</span>
      {invoice.overdue && <span className="pay-badge overdue">期限切れ</span>}
      {invoice.state === 'paid' && invoice.differenceYen > 0 && <span className="pay-badge over">過払い {yen(invoice.differenceYen)}</span>}
      {invoice.state === 'paid' && invoice.differenceYen < 0 && <span className="pay-badge short">不足 {yen(-invoice.differenceYen)}</span>}
    </>
  );
}

/** What a change of an invoice (made, changed, withdrawn, restored) did to the organization's stage. */
export const ORG_AFTER_CHANGE: Record<ConfirmResponse['org'], string> = {
  advanced: '請求がすべて入金済みになったため、団体の状態を「入金済み」にしました。',
  reverted: '入金済みでない請求があるため、団体の状態を「入金済み」から元に戻しました。',
  unchanged: '',
  failed: '団体の状態を合わせられませんでした。団体の画面で状態を確かめてください。',
};

/** What is left to be paid on an invoice (never below zero). */
export const remainingOf = (invoice: InvoiceView) => Math.max(0, invoice.amountYen - invoice.paidYen);
