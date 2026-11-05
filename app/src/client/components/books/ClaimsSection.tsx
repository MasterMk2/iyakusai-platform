import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { BOOKS_LIMITS, yen, type AccountView, type BooksHistoryView, type BooksMe, type ClaimsOverview, type ClaimView } from '../../../shared/books';
import { api, apiForm, fmtDate } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { ClaimBadge, Facts, failureOf, History, newClientToken, parseYen, Receipts, todayInJapan, YearSelect } from './common';

// 立替精算 (2026-11-05). A member files what they paid for the committee, with the receipt's photo, and follows it:
// 確認待ち → 返金待ち → 返金済み (or 差し戻し with the reason, fixed and sent again). The accounting section checks each
// claim (the account, then 承認: the spending goes into the books), and pays back several together (返金済みにする).

type Overview = ClaimsOverview & { accounts: AccountView[]; departments: string[]; preapprovalAboveYen: number; moneyAccounts: AccountView[] | null };
type Tab = 'mine' | 'submitted' | 'approved' | 'closed';
type Pane = { kind: 'none' } | { kind: 'claim'; id: string } | { kind: 'new' } | { kind: 'edit'; claim: ClaimView };

const TAB_LABELS: Record<Tab, string> = { submitted: '確認待ち', approved: '返金待ち', closed: '返金済み・差し戻し', mine: '自分の申請' };

export function ClaimsSection({ me, year, onYear, onChanged }: { me: BooksMe; year: number; onYear: (year: number) => void; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>(me.canView ? 'submitted' : 'mine');
  const [pane, setPane] = useState<Pane>({ kind: 'none' });
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<Overview>('GET', `/api/books/claims?fiscalYear=${year}`, undefined, signal);
    },
    [year, refresh],
  );
  const overview = useLoader(load);
  const data = overview.data;
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
    // On a phone the opened claim is under the head and the tabs: brought up unless its top is already in view.
    const top = el.getBoundingClientRect().top;
    if (top < 64 || top > window.innerHeight * 0.4) el.scrollIntoView?.({ block: 'start' });
  }, [pane]);

  const tabs: Tab[] = me.canView ? ['submitted', 'approved', 'closed', 'mine'] : ['mine'];
  const listOf = (t: Tab): ClaimView[] => (!data ? [] : t === 'mine' ? data.mine : (data[t] ?? []));

  const row = (c: ClaimView) => (
    <li key={c.id}>
      <button type="button" className="row-open" aria-current={pane.kind === 'claim' && pane.id === c.id ? 'true' : undefined} onClick={() => open({ kind: 'claim', id: c.id })}>
        <span className="pay-row-top">
          <span className="row-main">{c.purpose}</span>
          <span className="pay-amount">{yen(c.amountYen)}</span>
        </span>
        <span className="row-meta">
          <ClaimBadge claim={c} />
          {tab !== 'mine' && <span>{c.claimantName}</span>}
          <span>{c.spentOn}</span>
          <span>{c.payee}</span>
          <span>{c.number}</span>
          <span>{c.receipts.length > 0 ? `領収書 ${c.receipts.length} 枚` : '領収書なし'}</span>
        </span>
      </button>
    </li>
  );

  const list = () => {
    if (!data) return null;
    if (tab === 'approved' && data.moneyAccounts) return <PayBack data={data} onOpen={(id) => open({ kind: 'claim', id })} current={pane.kind === 'claim' ? pane.id : null} onPaid={(text) => { reload(); setPane({ kind: 'none' }); setNotice(text); }} />;
    const items = listOf(tab);
    if (items.length > 0) return <ul className="rows-list pay-rows" aria-label={TAB_LABELS[tab]}>{items.map(row)}</ul>;
    if (tab === 'mine') {
      return (
        <div className="list-empty">
          <p>{year}年度の申請はまだありません。</p>
          <p className="hint">委員会のために立て替えて払ったものは、上の「立替精算を申請する」から申請すると返金されます。レシートか領収書の写真を付けてください。</p>
        </div>
      );
    }
    return (
      <div className="list-empty">
        <p>{tab === 'submitted' ? '確認待ちの申請はありません。' : `${year}年度の返金済み・差し戻しの申請はありません。`}</p>
      </div>
    );
  };

  const detail = () => {
    if (!data) return null;
    const back = (
      <button type="button" className="back-link" onClick={() => setPane({ kind: 'none' })}>
        ← 一覧に戻る
      </button>
    );
    if (pane.kind === 'none') {
      return (
        <div className="detail-placeholder">
          <h2>申請を選択</h2>
          <p>{me.canView ? '一覧から選ぶと、ここで中身と領収書を確かめて承認できます。' : '一覧から選ぶと、ここで状況と領収書を見られます。'}</p>
        </div>
      );
    }
    if (pane.kind === 'new' || pane.kind === 'edit') {
      return (
        <>
          {back}
          <ClaimForm
            key={pane.kind === 'edit' ? pane.claim.id : 'new'}
            editing={pane.kind === 'edit' ? pane.claim : null}
            accounts={data.accounts}
            departments={data.departments}
            preapprovalAboveYen={data.preapprovalAboveYen}
            onSaved={(claim, uploadError) => {
              reload();
              setTab('mine');
              setPane({ kind: 'claim', id: claim.id });
              setNotice(
                uploadError
                  ? `${claim.number} を${pane.kind === 'edit' ? '直して出し直しました' : '申請しました'}。ただし領収書を付けられませんでした（${uploadError}）。下の「写真・PDF を付ける」からもう一度付けてください。`
                  : `${claim.number} を${pane.kind === 'edit' ? '直して出し直しました' : '申請しました'}。会計課が確認すると「返金待ち」になります。`,
              );
            }}
            onCancel={() => setPane(pane.kind === 'edit' ? { kind: 'claim', id: pane.claim.id } : { kind: 'none' })}
          />
        </>
      );
    }
    return (
      <>
        {back}
        <ClaimPane
          key={`${pane.id}:${refresh}`}
          id={pane.id}
          me={me}
          accounts={data.accounts}
          onChanged={(text) => {
            reload();
            if (text) setNotice(text);
          }}
          onEdit={(claim) => open({ kind: 'edit', claim })}
        />
      </>
    );
  };

  return (
    <div className="pay-view" data-testid="books-claims">
      <div className="pay-head">
        <div className="pane-title">
          <h2>立替精算</h2>
          <span className="pane-sub">委員が立て替えたお金の返金</span>
        </div>
        <div className="actions">
          <YearSelect
            year={year}
            onChange={(y) => {
              onYear(y);
              setPane({ kind: 'none' });
            }}
          />
          <button type="button" onClick={() => open({ kind: 'new' })} data-testid="claim-new">
            立替精算を申請する
          </button>
        </div>
      </div>
      {notice && (
        <p className="status ok" role="status">
          {notice}
        </p>
      )}
      {tabs.length > 1 && (
        <div className="pay-tabs filter-chips" role="group" aria-label="申請の切り替え">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              className="filter-chip"
              aria-pressed={tab === t}
              onClick={() => {
                setTab(t);
                if (pane.kind === 'claim') setPane({ kind: 'none' });
              }}
            >
              {TAB_LABELS[t]} <span className="option-count">{data ? listOf(t).length : '…'}</span>
            </button>
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <LoadStatus loader={overview} what="立替精算" />
      </div>
      {data && (
        <div className={`pay-body ${pane.kind !== 'none' ? 'has-detail' : ''}`}>
          <div className="pay-list">{list()}</div>
          <div className="pay-detail" aria-label="申請の詳細" ref={detailRef}>
            {detail()}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- the form (a new claim, or one sent back to fix)

function ClaimForm({
  editing,
  accounts,
  departments,
  preapprovalAboveYen,
  onSaved,
  onCancel,
}: {
  editing: ClaimView | null;
  accounts: AccountView[];
  departments: string[];
  preapprovalAboveYen: number;
  onSaved: (claim: ClaimView, uploadError: string | null) => void;
  onCancel: () => void;
}) {
  const [spentOn, setSpentOn] = useState(editing?.spentOn ?? todayInJapan());
  const [amount, setAmount] = useState(editing ? String(editing.amountYen) : '');
  const [payee, setPayee] = useState(editing?.payee ?? '');
  const [purpose, setPurpose] = useState(editing?.purpose ?? '');
  const [department, setDepartment] = useState(editing?.department ?? (departments.length === 1 ? departments[0]! : ''));
  const [accountId, setAccountId] = useState(editing?.accountId ?? '');
  const [preapproval, setPreapproval] = useState(editing?.preapproval ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field: string | null } | null>(null);
  const [token] = useState(newClientToken);
  const amountYen = parseYen(amount);
  const needsPreapproval = amountYen !== null && amountYen > preapprovalAboveYen;
  // Accounts in 弥生 are grouped (事務費用 › 消耗品費…): the list shows the name and the 補助科目.
  const choices = useMemo(() => accounts.filter((a) => a.active).sort((a, b) => a.title.localeCompare(b.title, 'ja')), [accounts]);
  const departmentChoices = useMemo(() => [...new Set([...departments, ...(editing?.department ? [editing.department] : [])])], [departments, editing]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (amountYen === null) {
      setError({ message: '金額を数字で入れてください（例: 1980）。', field: 'amountYen' });
      return;
    }
    setBusy(true);
    setError(null);
    const claim = { spentOn, amountYen, payee, purpose, department, accountId: accountId || null, preapproval: needsPreapproval ? preapproval : '' };
    let saved: ClaimView;
    try {
      saved = editing
        ? (await api<{ claim: ClaimView }>('PUT', `/api/books/claims/${encodeURIComponent(editing.id)}`, { expectedVersion: editing.version, claim })).claim
        : (await api<{ claim: ClaimView }>('POST', '/api/books/claims', { clientToken: token, claim })).claim;
    } catch (err) {
      const f = failureOf(err);
      setError({ message: f.conflict ? `${f.message}（入力した内容は残っています）` : f.message, field: f.field });
      setBusy(false);
      return;
    }
    let uploadError: string | null = null;
    for (const file of files) {
      try {
        const form = new FormData();
        form.append('file', file, file.name);
        await apiForm(`/api/books/claims/${encodeURIComponent(saved.id)}/receipts`, form);
      } catch (err) {
        uploadError = failureOf(err).message;
        break;
      }
    }
    setBusy(false);
    onSaved(saved, uploadError);
  };

  const fieldError = (field: string) =>
    error?.field === field ? (
      <p className="field-error" role="alert">
        {error.message}
      </p>
    ) : null;

  return (
    <form className="pay-form" onSubmit={(e) => void submit(e)} noValidate data-testid="claim-form">
      <h2>{editing ? `${editing.number} を直して出し直す` : '立替精算を申請する'}</h2>
      {editing?.state === 'rejected' && editing.note && (
        <p className="status warning" role="note">
          差し戻しの理由: {editing.note}
        </p>
      )}
      <label>
        払った日
        <input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} required aria-invalid={error?.field === 'spentOn'} />
      </label>
      {fieldError('spentOn')}
      <label>
        金額（円）
        <input type="text" inputMode="numeric" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} required aria-invalid={error?.field === 'amountYen'} data-testid="claim-amount" />
      </label>
      {fieldError('amountYen')}
      <label>
        払った先（店・サービス）
        <input type="text" value={payee} maxLength={BOOKS_LIMITS.counterparty} onChange={(e) => setPayee(e.target.value)} required aria-invalid={error?.field === 'payee'} data-testid="claim-payee" />
      </label>
      {fieldError('payee')}
      <label>
        何を、何のために
        <input type="text" value={purpose} maxLength={BOOKS_LIMITS.purpose} onChange={(e) => setPurpose(e.target.value)} required aria-invalid={error?.field === 'purpose'} data-testid="claim-purpose" />
        <span className="hint">例: 受付で使うペンとクリップ</span>
      </label>
      {fieldError('purpose')}
      <label>
        部局
        <select value={department} onChange={(e) => setDepartment(e.target.value)}>
          <option value="">（選ばない）</option>
          {departmentChoices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label>
        科目（分かれば）
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">分からない（会計課が決めます）</option>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </select>
      </label>
      {needsPreapproval && (
        <>
          <label>
            事前の承認（{yen(preapprovalAboveYen)}を超える買い物）
            <input type="text" value={preapproval} maxLength={BOOKS_LIMITS.note} onChange={(e) => setPreapproval(e.target.value)} aria-invalid={error?.field === 'preapproval'} />
            <span className="hint">誰がいつ認めたか（例: 部長 10/1、役員会 10/3）。無ければ空のままで構いません。</span>
          </label>
          {fieldError('preapproval')}
        </>
      )}
      <label>
        領収書（写真か PDF）
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          multiple
          onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, BOOKS_LIMITS.receipts))}
          data-testid="claim-files"
        />
        <span className="hint">{editing ? '付いている領収書はそのまま残ります。足すものだけ選んでください。' : `${BOOKS_LIMITS.receipts} 枚まで。あとから付けることもできます。`}</span>
      </label>
      {error && error.field === null && (
        <p className="status error" role="alert">
          {error.message}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy} data-testid="claim-submit">
          {busy ? '送っています…' : editing ? '直して出し直す' : '申請する'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

// ---- one claim

function ClaimPane({ id, me, accounts, onChanged, onEdit }: { id: string; me: BooksMe; accounts: AccountView[]; onChanged: (notice: string | null) => void; onEdit: (claim: ClaimView) => void }) {
  const load = useCallback((signal: AbortSignal) => api<{ claim: ClaimView; history: BooksHistoryView[] }>('GET', `/api/books/claims/${encodeURIComponent(id)}`, undefined, signal), [id]);
  const loader = useLoader(load);
  const [asking, setAsking] = useState<'reject' | 'withdraw' | 'unapprove' | 'unpay' | null>(null);
  const [note, setNote] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = loader.data;
  if (!data) return <LoadStatus loader={loader} what="申請" />;
  const c = data.claim;
  const chosenAccount = accountId ?? c.accountId ?? '';
  const ownOpen = c.mine && (c.state === 'submitted' || c.state === 'rejected');

  const act = async (path: string, body: unknown, done: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/books/claims/${encodeURIComponent(c.id)}/${path}`, body);
      setAsking(null);
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

  const reasonForm = (label: string, button: string, path: string, done: string, required: boolean) => (
    <div className="pay-row-extra">
      <label>
        {label}
        <input type="text" value={note} maxLength={BOOKS_LIMITS.note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </label>
      <div className="actions">
        <button type="button" className="danger" disabled={busy || (required && note.trim() === '')} onClick={() => void act(path, { expectedVersion: c.version, note }, done)}>
          {button}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setAsking(null)}>
          やめる
        </button>
      </div>
    </div>
  );

  return (
    <div className="books-pane" data-testid="claim-pane">
      <div className="pane-title">
        <h2>{c.purpose}</h2>
        <ClaimBadge claim={c} />
      </div>
      {c.state === 'rejected' && c.note && (
        <p className="status warning" role="note">
          差し戻しの理由: {c.note}
          {c.mine && '（直して出し直してください）'}
        </p>
      )}
      <Facts
        items={[
          ['番号', c.number],
          ['金額', <span className="pay-amount">{yen(c.amountYen)}</span>],
          ['払った日', c.spentOn],
          ['払った先', c.payee],
          ['申請した人', c.claimantName],
          ['部局', c.department],
          ['科目', c.accountTitle ?? '（会計課が決めます）'],
          ['事前の承認', c.preapproval],
          ['申請した日', fmtDate(c.submittedAt)],
          ['承認', c.approvedAt ? `${fmtDate(c.approvedAt)}・${c.approvedByName ?? ''}` : ''],
          ['返金', c.paidOn ? `${c.paidOn}・${c.paidFromTitle ?? ''}` : ''],
        ]}
      />
      <Receipts receipts={c.receipts} uploadUrl={`/api/books/claims/${encodeURIComponent(c.id)}/receipts`} canChange={ownOpen || me.canEdit} onChanged={() => { loader.retry(); onChanged(null); }} />

      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}

      {me.canEdit && c.state === 'submitted' && (
        <section className="pay-section" aria-label="確認">
          <h3>確認する</h3>
          {c.receipts.length === 0 && <p className="status warning">領収書が付いていません。付けてもらうなら差し戻してください。</p>}
          <label className="books-inline-field">
            科目
            <select value={chosenAccount} onChange={(e) => setAccountId(e.target.value)} data-testid="claim-approve-account">
              <option value="">選んでください</option>
              {accounts
                .filter((a) => a.active)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
            </select>
          </label>
          {asking === 'reject' ? (
            reasonForm('差し戻しの理由（申請した人に見えます）', '差し戻す', 'reject', `${c.number} を差し戻しました。`, true)
          ) : (
            <div className="actions">
              <button type="button" disabled={busy || !chosenAccount} onClick={() => void act('approve', { expectedVersion: c.version, accountId: chosenAccount }, `${c.number} を承認して帳簿に入れました。「返金待ち」から返金できます。`)} data-testid="claim-approve">
                承認して帳簿に入れる
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setAsking('reject')}>
                差し戻す…
              </button>
            </div>
          )}
        </section>
      )}

      {me.canEdit && c.state === 'approved' && (
        <section className="pay-section" aria-label="承認の取り消し">
          <p className="hint">返金は「返金待ち」で、ほかの申請とまとめて返金済みにできます。</p>
          {asking === 'unapprove' ? (
            reasonForm('取り消しの理由', '承認を取り消す', 'unapprove', `${c.number} の承認を取り消しました（帳簿の仕訳も取り消しました）。`, false)
          ) : (
            <div className="actions">
              <button type="button" className="secondary" onClick={() => setAsking('unapprove')}>
                承認を取り消す…
              </button>
            </div>
          )}
        </section>
      )}

      {me.canEdit && c.state === 'paid' && (
        <section className="pay-section" aria-label="返金の取り消し">
          {asking === 'unpay' ? (
            reasonForm('取り消しの理由', '返金を取り消す', 'unpay', `${c.number} の返金を取り消しました（返金待ちに戻しました）。`, false)
          ) : (
            <div className="actions">
              <button type="button" className="secondary" onClick={() => setAsking('unpay')}>
                返金を取り消す…
              </button>
            </div>
          )}
        </section>
      )}

      {ownOpen && (
        <section className="pay-section" aria-label="自分の申請">
          {asking === 'withdraw' ? (
            <div className="pay-row-extra">
              <p>この申請を取り下げます。取り下げた申請は戻せません（もう一度申請はできます）。</p>
              <div className="actions">
                <button type="button" className="danger" disabled={busy} onClick={() => void act('withdraw', { expectedVersion: c.version }, `${c.number} を取り下げました。`)}>
                  取り下げる
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => setAsking(null)}>
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <div className="actions">
              <button type="button" onClick={() => onEdit(c)}>
                {c.state === 'rejected' ? '直して出し直す' : '直す'}
              </button>
              <button type="button" className="secondary" onClick={() => setAsking('withdraw')}>
                取り下げる…
              </button>
            </div>
          )}
        </section>
      )}
      <History items={data.history} />
    </div>
  );
}

// ---- paying back (返金待ち): pick the claims, the day and the account, and mark them paid together

function PayBack({ data, onOpen, current, onPaid }: { data: Overview; onOpen: (id: string) => void; current: string | null; onPaid: (notice: string) => void }) {
  const approved = useMemo(() => data.approved ?? [], [data.approved]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [paidOn, setPaidOn] = useState(todayInJapan());
  const money = data.moneyAccounts ?? [];
  const [moneyId, setMoneyId] = useState(money[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = approved.filter((c) => picked.has(c.id));
  const total = chosen.reduce((s, c) => s + c.amountYen, 0);
  const byClaimant = useMemo(() => {
    const groups = new Map<string, ClaimView[]>();
    for (const c of approved) groups.set(c.claimantId, [...(groups.get(c.claimantId) ?? []), c]);
    return [...groups.values()].sort((a, b) => a[0]!.claimantName.localeCompare(b[0]!.claimantName, 'ja'));
  }, [approved]);

  if (approved.length === 0) {
    return (
      <div className="list-empty">
        <p>返金待ちの申請はありません。</p>
        <p className="hint">「確認待ち」で承認した申請がここに並びます。</p>
      </div>
    );
  }
  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const pay = async () => {
    if (busy || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ totalYen: number; claims: ClaimView[] }>('POST', '/api/books/claims/pay', { paidOn, moneyAccountId: moneyId, claims: chosen.map((c) => ({ id: c.id, expectedVersion: c.version })) });
      setPicked(new Set());
      onPaid(`${res.claims.length} 件（${yen(res.totalYen)}）を返金済みにして、帳簿に入れました。`);
    } catch (err) {
      setError(failureOf(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {byClaimant.map((group) => {
        const ids = group.map((c) => c.id);
        const all = ids.every((id) => picked.has(id));
        return (
          <section key={group[0]!.claimantId} className="books-owed" aria-label={`${group[0]!.claimantName}さんへの返金`}>
            <label className="books-owed-head">
              <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} />
              <span className="row-main">{group[0]!.claimantName}</span>
              <span className="pay-amount">{yen(group.reduce((s, c) => s + c.amountYen, 0))}</span>
              <span className="hint">{group.length} 件</span>
            </label>
            <ul className="pay-picks">
              {group.map((c) => (
                <li key={c.id} className="pay-pick books-pick">
                  <label>
                    <input type="checkbox" checked={picked.has(c.id)} onChange={(e) => toggle([c.id], e.target.checked)} aria-label={`${c.number} ${c.purpose}`} />
                    <span className="pay-pick-main">
                      <span className="pay-row-top">
                        <span>{c.purpose}</span>
                        <span className="pay-amount">{yen(c.amountYen)}</span>
                      </span>
                      <span className="row-meta">
                        <span>{c.spentOn}</span>
                        <span>{c.number}</span>
                      </span>
                    </span>
                  </label>
                  <button type="button" className="link-button pay-link" aria-current={current === c.id ? 'true' : undefined} onClick={() => onOpen(c.id)}>
                    開く
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <div className="pay-sum" aria-label="返金">
        <p>
          選んだ申請 {chosen.length} 件・合計 <strong className="pay-amount">{yen(total)}</strong>
        </p>
        <div className="books-sum-fields">
          <label>
            返金した日
            <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
          </label>
          <label>
            返金した口座
            <select value={moneyId} onChange={(e) => setMoneyId(e.target.value)}>
              {money.length === 0 && <option value="">口座の科目がありません</option>}
              {money.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p className="status error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" disabled={busy || chosen.length === 0 || !moneyId} onClick={() => void pay()} data-testid="claims-pay">
            {chosen.length === 0 ? '返金した申請を選んでください' : `${chosen.length} 件を返金済みにする`}
          </button>
        </div>
      </div>
    </>
  );
}
