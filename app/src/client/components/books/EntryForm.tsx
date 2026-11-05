import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ACCOUNT_KIND_LABELS, ACCOUNT_KINDS, BOOKS_LIMITS, type AccountKind, type AccountView, type EntryForm as Form, type EntryInput, type JournalView } from '../../../shared/books';
import { api } from '../../api';
import { failureOf, newClientToken, parseYen, todayInJapan } from './common';

// 記帳 (2026-11-05): the plain forms the accounting section enters without double entry — 支出 (an account paid
// something), 収入 (money came into an account), 口座の移動 (cash to the bank and back) — and 振替 (both sides chosen,
// for what is neither). The server makes the journal's two lines; the list then reads them back the same way.

const FORMS: { key: Form; label: string; hint: string }[] = [
  { key: 'expense', label: '支出', hint: '口座からお金を払った' },
  { key: 'income', label: '収入', hint: '口座にお金が入った' },
  { key: 'transfer', label: '口座の移動', hint: '口座から口座へ移した（預け入れ・引き出し）' },
  { key: 'journal', label: '振替', hint: 'お金が動かない仕訳（借方と貸方を選ぶ）' },
];

/** The accounts of a select, the likely kind first, each kind under its heading. */
function AccountOptions({ accounts, first }: { accounts: AccountView[]; first: AccountKind | null }) {
  const kinds: AccountKind[] = first ? [first, ...ACCOUNT_KINDS.filter((k) => k !== first)] : [...ACCOUNT_KINDS];
  return (
    <>
      {kinds.map((kind) => {
        const items = accounts.filter((a) => a.kind === kind);
        if (items.length === 0) return null;
        return (
          <optgroup key={kind} label={ACCOUNT_KIND_LABELS[kind]}>
            {items.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

export function EntryForm({ accounts, editing, onSaved, onCancel }: { accounts: AccountView[]; editing: JournalView | null; onSaved: (journal: JournalView) => void; onCancel: () => void }) {
  const start: EntryInput | null = editing?.entry ?? null;
  const [form, setForm] = useState<Form>(start?.form ?? 'expense');
  const [date, setDate] = useState(start?.date ?? todayInJapan());
  const [amount, setAmount] = useState(start ? String(start.amountYen) : '');
  const [moneyId, setMoneyId] = useState(start?.moneyAccountId ?? '');
  const [accountId, setAccountId] = useState(start?.accountId ?? '');
  const [toId, setToId] = useState(start?.toMoneyAccountId ?? '');
  const [debitId, setDebitId] = useState(start?.debitAccountId ?? '');
  const [creditId, setCreditId] = useState(start?.creditAccountId ?? '');
  const [counterparty, setCounterparty] = useState(start?.counterparty ?? '');
  const [memo, setMemo] = useState(start?.memo ?? '');
  const [department, setDepartment] = useState(start?.department ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field: string | null } | null>(null);
  const [token, setToken] = useState(newClientToken);
  const active = useMemo(() => accounts.filter((a) => a.active || [moneyId, accountId, toId, debitId, creditId].includes(a.id)), [accounts, moneyId, accountId, toId, debitId, creditId]);
  const money = active.filter((a) => a.money);
  const others = active.filter((a) => !a.money);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const amountYen = parseYen(amount);
    if (amountYen === null) {
      setError({ message: '金額を数字で入れてください（例: 3300）。', field: 'amountYen' });
      return;
    }
    const entry: EntryInput = {
      form,
      date,
      amountYen,
      moneyAccountId: form === 'journal' ? null : moneyId || null,
      accountId: form === 'income' || form === 'expense' ? accountId || null : null,
      toMoneyAccountId: form === 'transfer' ? toId || null : null,
      debitAccountId: form === 'journal' ? debitId || null : null,
      creditAccountId: form === 'journal' ? creditId || null : null,
      counterparty,
      memo,
      department,
    };
    setBusy(true);
    setError(null);
    try {
      const res = editing
        ? await api<{ journal: JournalView }>('PUT', `/api/books/journals/${encodeURIComponent(editing.id)}`, { expectedVersion: editing.version, entry })
        : await api<{ journal: JournalView }>('POST', '/api/books/journals', { clientToken: token, entry });
      setToken(newClientToken());
      onSaved(res.journal);
    } catch (err) {
      const f = failureOf(err);
      setError({ message: f.conflict ? `${f.message}（入力した内容は残っています）` : f.message, field: f.field });
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
  const select = (label: string, value: string, set: (v: string) => void, field: string, options: ReactNode, testId?: string) => (
    <>
      <label>
        {label}
        <select value={value} onChange={(e) => set(e.target.value)} aria-invalid={error?.field === field} data-testid={testId}>
          <option value="">選んでください</option>
          {options}
        </select>
      </label>
      {fieldError(field)}
    </>
  );
  const moneyOptions = money.map((a) => (
    <option key={a.id} value={a.id}>
      {a.title}
    </option>
  ));

  return (
    <form className="pay-form" onSubmit={(e) => void submit(e)} noValidate data-testid="entry-form">
      <h2>{editing ? `${editing.number} を直す` : '記帳する'}</h2>
      {editing?.yayoiExportedAt && <p className="status warning">この仕訳は弥生へ書き出し済みです。直したら、弥生の同じ仕訳も手で直してください（「弥生」の画面に出ます）。</p>}
      <fieldset className="books-forms">
        <legend>種類</legend>
        {FORMS.map((f) => (
          <label key={f.key} className="books-form-choice">
            <input type="radio" name="entry-form" value={f.key} checked={form === f.key} onChange={() => setForm(f.key)} />
            <span>
              <strong>{f.label}</strong>
              <span className="hint">{f.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        日付
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={error?.field === 'date'} />
      </label>
      {fieldError('date')}
      <label>
        金額（円）
        <input type="text" inputMode="numeric" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={error?.field === 'amountYen'} data-testid="entry-amount" />
      </label>
      {fieldError('amountYen')}
      {form === 'expense' && (
        <>
          {select('払った口座', moneyId, setMoneyId, 'moneyAccountId', moneyOptions, 'entry-money')}
          {select('科目', accountId, setAccountId, 'accountId', <AccountOptions accounts={others} first="expense" />, 'entry-account')}
        </>
      )}
      {form === 'income' && (
        <>
          {select('入った口座', moneyId, setMoneyId, 'moneyAccountId', moneyOptions, 'entry-money')}
          {select('科目', accountId, setAccountId, 'accountId', <AccountOptions accounts={others} first="income" />, 'entry-account')}
        </>
      )}
      {form === 'transfer' && (
        <>
          {select('移す元の口座', moneyId, setMoneyId, 'moneyAccountId', moneyOptions)}
          {select('移す先の口座', toId, setToId, 'toMoneyAccountId', moneyOptions)}
        </>
      )}
      {form === 'journal' && (
        <>
          {select('借方の科目', debitId, setDebitId, 'debitAccountId', <AccountOptions accounts={active} first={null} />)}
          {select('貸方の科目', creditId, setCreditId, 'creditAccountId', <AccountOptions accounts={active} first={null} />)}
        </>
      )}
      <label>
        取引先
        <input type="text" value={counterparty} maxLength={BOOKS_LIMITS.counterparty} onChange={(e) => setCounterparty(e.target.value)} />
      </label>
      {fieldError('counterparty')}
      <label>
        摘要
        <input type="text" value={memo} maxLength={BOOKS_LIMITS.memo} onChange={(e) => setMemo(e.target.value)} data-testid="entry-memo" />
        <span className="hint">何のお金か（弥生の摘要になります）</span>
      </label>
      {fieldError('memo')}
      <label>
        部局
        <input type="text" value={department} maxLength={BOOKS_LIMITS.department} onChange={(e) => setDepartment(e.target.value)} />
      </label>
      {error && error.field === null && (
        <p className="status error" role="alert">
          {error.message}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy} data-testid="entry-submit">
          {busy ? '保存しています…' : editing ? '直す' : '記帳する'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}
