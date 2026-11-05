import { Fragment, useCallback, useMemo, useState, type FormEvent } from 'react';
import { ACCOUNT_KIND_LABELS, ACCOUNT_KINDS, BOOKS_LIMITS, DEFAULT_TAX_CLASS, normalSide, yen, type AccountInput, type AccountKind, type AccountView, type BooksMe, type BooksSettings, type BooksSummary, type OpeningRow, type SheetsStatus } from '../../../shared/books';
import { api, fmtDate } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { failureOf, YearSelect } from './common';

// 科目と設定 (2026-11-05): the spreadsheet the books are copied to (its state, and a write now), the settings that
// decide how claims and deposits are booked, the accounts (弥生's 勘定科目 and 補助科目, by the same names), and the
// opening balances of the year. Viewers read them; the editor changes them.

interface SettingsData {
  settings: BooksSettings;
  accounts: AccountView[];
  orgKinds: { key: string; label: string }[];
}

type Pane = 'none' | 'settings' | 'new-account' | { account: AccountView } | 'openings';

export function BooksSettingsSection({ me, year, onYear, summary, onChanged }: { me: BooksMe; year: number; onYear: (year: number) => void; summary: BooksSummary | null; onChanged: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<SettingsData>('GET', '/api/books/settings', undefined, signal);
    },
    [refresh],
  );
  const loader = useLoader(load);
  const [pane, setPane] = useState<Pane>('none');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = (text: string | null) => {
    setRefresh((n) => n + 1);
    setPane('none');
    setNotice(text);
    onChanged();
  };
  const open = (next: Pane) => {
    setNotice(null);
    setError(null);
    setPane(next);
  };
  const data = loader.data;

  const addDefaults = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ added: number }>('POST', '/api/books/accounts/defaults', {});
      reload(res.added > 0 ? `弥生の一般的な科目を ${res.added} 個足しました。` : '足す科目はありませんでした（すべてあります）。');
    } catch (err) {
      setError(failureOf(err).message);
    } finally {
      setBusy(false);
    }
  };

  const titleOf = (id: string | null) => (id ? (data?.accounts.find((a) => a.id === id)?.title ?? '（見つからない科目）') : '未設定');

  return (
    <div className="pay-view" data-testid="books-settings">
      <div className="pay-head">
        <div className="pane-title">
          <h2>科目と設定</h2>
        </div>
      </div>
      {notice && (
        <p className="status ok" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <SheetsPanel canEdit={me.canEdit} initial={summary?.sheets ?? null} />
      <LoadStatus loader={loader} what="設定" />
      {data && (
        <>
          <section className="books-report" aria-labelledby="settings-head">
            <div className="books-report-head">
              <h3 id="settings-head">記帳の決まり</h3>
              {me.canEdit && pane !== 'settings' && (
                <button type="button" className="secondary" onClick={() => open('settings')} data-testid="settings-edit">
                  直す
                </button>
              )}
            </div>
            {pane === 'settings' ? (
              <SettingsForm data={data} onCancel={() => setPane('none')} onSaved={() => reload('設定を保存しました。')} />
            ) : (
              <dl className="pay-facts">
                <dt>年度の始まり</dt>
                <dd>{data.settings.fiscalStartMonth}月</dd>
                <dt>立替金の科目</dt>
                <dd>
                  {titleOf(data.settings.claimAccountId)}
                  {!data.settings.claimAccountId && <span className="books-over">（決めるまで立替精算を承認できません）</span>}
                </dd>
                <dt>入金確認の入金先</dt>
                <dd>{titleOf(data.settings.depositMoneyAccountId)}</dd>
                {data.orgKinds.map((k) => (
                  <div key={k.key} className="books-fact-pair">
                    <dt>{k.label}からの入金</dt>
                    <dd>{titleOf(data.settings.depositAccountByKind[k.key] ?? null)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section className="books-report" aria-labelledby="openings-head">
            <div className="books-report-head">
              <h3 id="openings-head">期首残高</h3>
              <div className="actions">
                <YearSelect year={year} onChange={onYear} />
                {me.canEdit && pane !== 'openings' && (
                  <button type="button" className="secondary" onClick={() => open('openings')} data-testid="openings-edit">
                    直す
                  </button>
                )}
              </div>
            </div>
            <Openings key={`${year}:${refresh}`} year={year} accounts={data.accounts} editing={pane === 'openings'} onCancel={() => setPane('none')} onSaved={() => reload(`${year}年度の期首残高を保存しました。`)} />
          </section>
          <section className="books-report" aria-labelledby="accounts-head">
            <div className="books-report-head">
              <h3 id="accounts-head">科目（{data.accounts.length}）</h3>
              {me.canEdit && (
                <div className="actions">
                  <button type="button" className="secondary" onClick={() => open('new-account')} data-testid="account-new">
                    科目を足す
                  </button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void addDefaults()}>
                    弥生の一般的な科目をまとめて足す
                  </button>
                </div>
              )}
            </div>
            <p className="hint">名前は弥生会計の勘定科目・補助科目と一字一句同じにしてください（弥生へ書き出すときに、この名前で合わせます）。</p>
            {pane === 'new-account' && <AccountForm editing={null} onCancel={() => setPane('none')} onSaved={(title) => reload(`科目「${title}」を足しました。`)} />}
            {data.accounts.length === 0 ? (
              <div className="list-empty">
                <p>科目がまだありません。</p>
                {me.canEdit && <p className="hint">「弥生の一般的な科目をまとめて足す」か、「弥生」の画面で弥生の期首残高・仕訳を取り込むと、弥生の科目がそのまま入ります。</p>}
              </div>
            ) : (
              ACCOUNT_KINDS.map((kind) => {
                const items = data.accounts.filter((a) => a.kind === kind);
                if (items.length === 0) return null;
                return (
                  <table key={kind} className="books-table books-accounts">
                    <caption>{ACCOUNT_KIND_LABELS[kind]}</caption>
                    <thead>
                      <tr>
                        <th scope="col">科目</th>
                        <th scope="col">区分</th>
                        <th scope="col">税区分</th>
                        <th scope="col">
                          <span className="sr-only">操作</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((a) => {
                        const editing = typeof pane === 'object' && pane.account.id === a.id;
                        return (
                          <Fragment key={a.id}>
                            <tr className={a.active ? '' : 'books-inactive'}>
                              <th scope="row">
                                {a.title}
                                {a.label && <span className="hint">（弥生: {a.name}{a.sub ? ` / ${a.sub}` : ''}）</span>}
                                {a.money && <span className="pay-badge">口座</span>}
                                {!a.active && <span className="pay-badge">使っていない</span>}
                              </th>
                              <td>{a.group}</td>
                              <td>{a.taxClass}</td>
                              <td>
                                {me.canEdit && !editing && (
                                  <button type="button" className="link-button pay-link" onClick={() => open({ account: a })} aria-label={`${a.title}を直す`}>
                                    直す
                                  </button>
                                )}
                              </td>
                            </tr>
                            {/* The form opens under its own row: the list is long, a form at its top would be out of sight. */}
                            {editing && (
                              <tr className="books-edit-row">
                                <td colSpan={4}>
                                  <AccountForm key={a.id} editing={a} onCancel={() => setPane('none')} onSaved={(title) => reload(`科目「${title}」を直しました。`)} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                );
              })
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SheetsPanel({ canEdit, initial }: { canEdit: boolean; initial: SheetsStatus | null }) {
  const [status, setStatus] = useState<SheetsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = status ?? initial;
  const syncNow = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<SheetsStatus>('POST', '/api/books/sheets/sync', {}));
    } catch (err) {
      setError(failureOf(err).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="books-report" aria-labelledby="sheets-head" data-testid="sheets-panel">
      <div className="books-report-head">
        <h3 id="sheets-head">スプレッドシート</h3>
        <div className="actions">
          {s?.url && (
            <a className="button secondary" href={s.url} target="_blank" rel="noopener noreferrer">
              開く
            </a>
          )}
          {canEdit && s?.configured && (
            <button type="button" className="secondary" disabled={busy} onClick={() => void syncNow()} data-testid="sheets-sync">
              {busy ? '書き込んでいます…' : '今すぐ書き込む'}
            </button>
          )}
        </div>
      </div>
      {!s ? (
        <p className="hint">読み込んでいます…</p>
      ) : !s.configured ? (
        <p className="hint">まだつないでいません。システム課がスプレッドシートの設定を置くと、帳簿の写しを書き込み始めます。</p>
      ) : (
        <>
          <dl className="pay-facts">
            <dt>最後に書き込めた時刻</dt>
            <dd>{s.lastOkAt ? fmtDate(s.lastOkAt) : 'まだ書き込んでいない'}</dd>
            <dt>状態</dt>
            <dd>{s.lastError ? <span className="books-over">書き込めませんでした: {s.lastError}</span> : s.pending ? '変更を待って書き込みます（数分以内）' : '最新です'}</dd>
          </dl>
          <p className="hint">帳簿を変えるたびに、少し待ってからまとめて書き込みます。表は基盤だけが書き換えられるよう保護しています。直すときはこの画面からにしてください。基盤が止まっても、表の「案内」のタブに読み方があります。</p>
        </>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function SettingsForm({ data, onCancel, onSaved }: { data: SettingsData; onCancel: () => void; onSaved: () => void }) {
  const s = data.settings;
  const [month, setMonth] = useState(s.fiscalStartMonth);
  const [claim, setClaim] = useState(s.claimAccountId ?? '');
  const [money, setMoney] = useState(s.depositMoneyAccountId ?? '');
  const [byKind, setByKind] = useState<Record<string, string>>(Object.fromEntries(data.orgKinds.map((k) => [k.key, s.depositAccountByKind[k.key] ?? ''])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = data.accounts.filter((a) => a.active);
  const options = (items: AccountView[]) =>
    items.map((a) => (
      <option key={a.id} value={a.id}>
        {a.title}
      </option>
    ));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('PUT', '/api/books/settings', {
        expectedVersion: s.version,
        settings: { fiscalStartMonth: month, claimAccountId: claim || null, depositMoneyAccountId: money || null, depositAccountByKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v || null])) },
      });
      onSaved();
    } catch (err) {
      setError(failureOf(err).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="pay-form" onSubmit={(e) => void submit(e)} data-testid="settings-form">
      <label>
        年度の始まりの月
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>
              {m}月
            </option>
          ))}
        </select>
        <span className="hint">弥生会計の会計期間と同じにします（医薬祭は 1 月始まり）。</span>
      </label>
      <label>
        立替金の科目
        <select value={claim} onChange={(e) => setClaim(e.target.value)} data-testid="settings-claim">
          <option value="">選んでください</option>
          {options(active.filter((a) => !a.money && (a.kind === 'asset' || a.kind === 'liability')))}
        </select>
        <span className="hint">立替精算を承認してから返金するまでの科目です（弥生で使っている科目。例: 立替金、未払金）。</span>
      </label>
      <label>
        入金確認の入金先
        <select value={money} onChange={(e) => setMoney(e.target.value)}>
          <option value="">選んでください</option>
          {options(active.filter((a) => a.money))}
        </select>
      </label>
      <fieldset className="books-forms">
        <legend>団体の種類ごとの収入の科目</legend>
        {data.orgKinds.map((k) => (
          <label key={k.key}>
            {k.label}
            <select value={byKind[k.key] ?? ''} onChange={(e) => setByKind({ ...byKind, [k.key]: e.target.value })}>
              <option value="">決めない（記帳のときに選ぶ）</option>
              {options(active.filter((a) => a.kind === 'income'))}
            </select>
          </label>
        ))}
      </fieldset>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? '保存しています…' : '保存する'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

function AccountForm({ editing, onCancel, onSaved }: { editing: AccountView | null; onCancel: () => void; onSaved: (title: string) => void }) {
  const [input, setInput] = useState<AccountInput>(
    editing
      ? { name: editing.name, sub: editing.sub, kind: editing.kind, group: editing.group, money: editing.money, label: editing.label, taxClass: editing.taxClass, active: editing.active }
      : { name: '', sub: '', kind: 'expense', group: '', money: false, label: '', taxClass: DEFAULT_TAX_CLASS, active: true },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field: string | null } | null>(null);
  const set = <K extends keyof AccountInput>(key: K, value: AccountInput[K]) => setInput({ ...input, [key]: value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) await api('PUT', `/api/books/accounts/${encodeURIComponent(editing.id)}`, { expectedVersion: editing.version, account: input });
      else await api('POST', '/api/books/accounts', { account: input });
      onSaved(input.label || `${input.name}${input.sub ? ` / ${input.sub}` : ''}`);
    } catch (err) {
      const f = failureOf(err);
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
  const locked = editing?.used === true;
  return (
    <form className="pay-form books-account-form" onSubmit={(e) => void submit(e)} noValidate data-testid="account-form">
      <h4>{editing ? `${editing.title} を直す` : '科目を足す'}</h4>
      {locked && <p className="hint">仕訳で使っている科目です。名前と種類は変えられません（使わなくなったら「使っていない」にします）。</p>}
      <label>
        科目名（弥生の勘定科目）
        <input type="text" value={input.name} maxLength={BOOKS_LIMITS.accountName} disabled={locked} onChange={(e) => set('name', e.target.value)} aria-invalid={error?.field === 'name'} data-testid="account-name" />
      </label>
      {fieldError('name')}
      <label>
        補助科目（なければ空）
        <input type="text" value={input.sub} maxLength={BOOKS_LIMITS.accountName} disabled={locked} onChange={(e) => set('sub', e.target.value)} aria-invalid={error?.field === 'sub'} />
      </label>
      {fieldError('sub')}
      <label>
        種類
        <select value={input.kind} disabled={locked} onChange={(e) => setInput({ ...input, kind: e.target.value as AccountKind, money: e.target.value === 'asset' ? input.money : false })} data-testid="account-kind">
          {ACCOUNT_KINDS.map((k) => (
            <option key={k} value={k}>
              {ACCOUNT_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {fieldError('kind')}
      <label className="checkbox">
        <input type="checkbox" checked={input.money} disabled={input.kind !== 'asset'} onChange={(e) => set('money', e.target.checked)} />
        口座（現金・預金）として使う
      </label>
      {fieldError('money')}
      <label>
        区分（決算書の見出し・空なら種類の名前）
        <input type="text" value={input.group} maxLength={BOOKS_LIMITS.accountLabel} onChange={(e) => set('group', e.target.value)} />
      </label>
      <label>
        画面での名前（空なら科目名）
        <input type="text" value={input.label} maxLength={BOOKS_LIMITS.accountLabel} onChange={(e) => set('label', e.target.value)} />
      </label>
      {fieldError('label')}
      <label>
        税区分（弥生の税区分）
        <input type="text" value={input.taxClass} maxLength={BOOKS_LIMITS.taxClass} onChange={(e) => set('taxClass', e.target.value)} />
      </label>
      {fieldError('taxClass')}
      <label className="checkbox">
        <input type="checkbox" checked={!input.active} onChange={(e) => set('active', !e.target.checked)} />
        使っていない（記帳の選択肢に出さない）
      </label>
      {error && error.field === null && (
        <p className="status error" role="alert">
          {error.message}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy} data-testid="account-save">
          {busy ? '保存しています…' : editing ? '直す' : '足す'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

/** The opening balances, each on its usual side (資産は借方、負債・純資産は貸方) so the amounts read as balances. */
function Openings({ year, accounts, editing, onCancel, onSaved }: { year: number; accounts: AccountView[]; editing: boolean; onCancel: () => void; onSaved: () => void }) {
  const load = useCallback((signal: AbortSignal) => api<{ fiscalYear: number; rows: OpeningRow[] }>('GET', `/api/books/openings?fiscalYear=${year}`, undefined, signal), [year]);
  const loader = useLoader(load);
  const sheet = useMemo(() => accounts.filter((a) => a.kind === 'asset' || a.kind === 'liability' || a.kind === 'equity'), [accounts]);
  const shown = (kind: AccountKind, debitPositive: number) => (normalSide(kind) === 'debit' ? debitPositive : -debitPositive);
  const [values, setValues] = useState<Map<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = loader.data?.rows;
  if (!rows) return <LoadStatus loader={loader} what="期首残高" />;

  if (!editing) {
    if (rows.length === 0) return <p className="hint">{year}年度の期首残高はまだありません。「弥生」の画面で弥生の期首残高を取り込むか、「直す」から入れてください。</p>;
    return (
      <table className="books-table" data-testid="openings">
        <caption className="sr-only">{year}年度の期首残高</caption>
        <thead>
          <tr>
            <th scope="col">科目</th>
            <th scope="col">種類</th>
            <th scope="col" className="num">
              期首残高
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.accountId}>
              <th scope="row">{r.title}</th>
              <td>{ACCOUNT_KIND_LABELS[r.kind]}</td>
              <td className="num">{yen(shown(r.kind, r.amountYen))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  const current = values ?? new Map(rows.map((r) => [r.accountId, String(shown(r.kind, r.amountYen))]));
  const parsed = sheet.map((a) => {
    const text = (current.get(a.id) ?? '').normalize('NFKC').replace(/[,円\s]/g, '').replace(/^−/, '-');
    const ok = text === '' || /^-?\d{1,9}$/.test(text);
    const n = ok && text !== '' ? Number(text) : 0;
    return { a, ok, debitPositive: normalSide(a.kind) === 'debit' ? n : -n };
  });
  const bad = parsed.find((p) => !p.ok);
  const total = parsed.reduce((s, p) => s + p.debitPositive, 0);
  const save = async () => {
    if (busy || bad || total !== 0) return;
    setBusy(true);
    setError(null);
    try {
      await api('PUT', '/api/books/openings', { fiscalYear: year, rows: parsed.filter((p) => p.debitPositive !== 0).map((p) => ({ accountId: p.a.id, amountYen: p.debitPositive })) });
      onSaved();
    } catch (err) {
      setError(failureOf(err).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="pay-form books-budget"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-testid="openings-form"
    >
      <p className="hint">{year}年度の始めの残高です。資産は借方、負債・純資産は貸方の残高を入れます（逆の側は − を付けます）。借方と貸方の合計が同じになるよう、差は繰越利益などで合わせます。</p>
      {(['asset', 'liability', 'equity'] as const).map((kind) => (
        <fieldset key={kind} className="books-budget-group">
          <legend>{ACCOUNT_KIND_LABELS[kind]}</legend>
          {sheet
            .filter((a) => a.kind === kind)
            .map((a) => (
              <label key={a.id} className="books-budget-line">
                <span>{a.title}</span>
                <input type="text" inputMode="numeric" autoComplete="off" value={current.get(a.id) ?? ''} placeholder="0" onChange={(e) => setValues(new Map(current).set(a.id, e.target.value))} />
                <span aria-hidden="true">円</span>
              </label>
            ))}
        </fieldset>
      ))}
      <p className={total === 0 ? 'hint' : 'status warning'} role="status">
        {bad ? `「${bad.a.title}」は数字で入れてください。` : total === 0 ? '借方と貸方の合計が合っています。' : `借方と貸方の合計が ${yen(Math.abs(total))} 合いません（${total > 0 ? '借方' : '貸方'}が多い）。`}
      </p>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy || bad !== undefined || total !== 0} data-testid="openings-save">
          {busy ? '保存しています…' : '期首残高を保存する'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}
