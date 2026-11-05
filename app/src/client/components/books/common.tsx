import { useRef, useState, type ReactNode } from 'react';
import { BOOKS_LIMITS, yen, type BooksHistoryView, type ClaimView, type ReceiptView } from '../../../shared/books';
import { api, apiForm, fmtDate } from '../../api';
import { failureOf } from '../payments/common';

// Small pieces the 会計 screens share: amounts, badges, the receipts of a claim or a journal, the history, a year.

export { failureOf, newClientToken, type Failure } from '../payments/common';

/** An amount with its sign, for the list of entries (入金 +, 出金 −, a move or 振替 without one). */
export function signedYen(direction: 'in' | 'out' | 'move' | 'none', amountYen: number): string {
  return direction === 'in' ? `＋${yen(amountYen)}` : direction === 'out' ? `−${yen(amountYen)}` : yen(amountYen);
}

/** A change of one account's balance (出納帳): ＋ up, − down. */
export function changeYen(amountYen: number): string {
  return amountYen > 0 ? `＋${yen(amountYen)}` : amountYen < 0 ? `−${yen(-amountYen)}` : yen(0);
}

const CLAIM_TONE: Record<ClaimView['state'], string> = { submitted: 'partial', approved: 'partial', paid: 'paid', rejected: 'short', withdrawn: '' };

export function ClaimBadge({ claim }: { claim: ClaimView }) {
  return <span className={`pay-badge ${CLAIM_TONE[claim.state]}`}>{claim.stateLabel}</span>;
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="pay-facts">
      {items
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function History({ items }: { items: BooksHistoryView[] }) {
  if (items.length === 0) return null;
  return (
    <details className="books-history">
      <summary>変更の記録（{items.length} 件）</summary>
      <ul className="pay-plan">
        {items.map((h) => (
          <li key={h.id}>
            <span>
              {fmtDate(h.at)} · {h.actorName}
            </span>
            <span>{h.text}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * The receipts of a claim or a journal: each opens in a new tab; who may change them adds a photo or a PDF (on a phone
 * the picker offers the camera) and takes one off. Nothing is deleted: a receipt taken off stays in the history.
 */
export function Receipts({ receipts, uploadUrl, canChange, onChanged }: { receipts: ReceiptView[]; uploadUrl: string; canChange: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const full = receipts.length >= BOOKS_LIMITS.receipts;

  const add = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of [...files].slice(0, BOOKS_LIMITS.receipts - receipts.length)) {
        const form = new FormData();
        form.append('file', file, file.name);
        await apiForm(uploadUrl, form);
      }
      onChanged();
    } catch (err) {
      setError(failureOf(err).message);
      onChanged();
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/books/receipts/${encodeURIComponent(id)}/remove`, {});
      setRemoving(null);
      onChanged();
    } catch (err) {
      setError(failureOf(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pay-section" aria-label="領収書">
      <h3>領収書</h3>
      {receipts.length === 0 ? (
        <p className="hint">{canChange ? 'まだ付いていません。レシートや領収書の写真か PDF を付けてください。' : '付いていません。'}</p>
      ) : (
        <ul className="books-receipts">
          {receipts.map((r) => (
            <li key={r.id}>
              <a href={`/api/books/receipts/${encodeURIComponent(r.id)}`} target="_blank" rel="noopener noreferrer">
                {r.name}
              </a>
              <span className="hint">{kb(r.bytes)}</span>
              {canChange &&
                (removing === r.id ? (
                  <span className="actions">
                    <button type="button" className="danger" disabled={busy} onClick={() => void remove(r.id)}>
                      外す
                    </button>
                    <button type="button" className="secondary" disabled={busy} onClick={() => setRemoving(null)}>
                      やめる
                    </button>
                  </span>
                ) : (
                  <button type="button" className="secondary" disabled={busy} onClick={() => setRemoving(r.id)}>
                    外す…
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {canChange && (
        <div className="books-upload">
          <label className={`button secondary ${busy || full ? 'disabled' : ''}`}>
            {busy ? '送っています…' : '写真・PDF を付ける'}
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple disabled={busy || full} onChange={(e) => void add(e.target.files)} className="sr-only" />
          </label>
          <span className="hint">{full ? `${BOOKS_LIMITS.receipts} 枚まで付いています。` : `JPEG・PNG・WebP・PDF、1 枚 ${BOOKS_LIMITS.receiptBytes / 1024 / 1024} MB まで・${BOOKS_LIMITS.receipts} 枚まで`}</span>
        </div>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** The year picker of the 会計 screens: the year shown, one before and one after. */
export function YearSelect({ year, onChange }: { year: number; onChange: (year: number) => void }) {
  return (
    <label className="pay-year">
      年度
      <select value={year} onChange={(e) => onChange(Number(e.target.value))}>
        {[year - 2, year - 1, year, year + 1].map((y) => (
          <option key={y} value={y}>
            {y}年度
          </option>
        ))}
      </select>
    </label>
  );
}

/** Today in Japan as YYYY-MM-DD (the default day of a form). */
export const todayInJapan = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

/** A yen amount typed by a person: digits, with or without commas and a full-width form; null when it is not one. */
export function parseYen(text: string): number | null {
  const t = text.normalize('NFKC').replace(/[,円\s]/g, '');
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 ? n : null;
}
