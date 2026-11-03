import { useEffect, useState } from 'react';
import { ORG_KIND_LABELS, ORG_KINDS, type OrgKind, type OrgListResponse, type OrgMailBatchSummary, type OrgMeta } from '../../../shared/organizations';
import { api, toFailure } from '../../api';
import { OrganizationDetail } from './OrganizationDetail';
import { OrganizationImport } from './OrganizationImport';
import { OrganizationMail } from './OrganizationMail';
import './organizations.css';

// Organizations (団体の台帳, 2026-11-03), inside the 連絡先 tab as its second section (団体). A list with the
// filters on top (year, kind, person in charge, department, status chips, search), the opened organization on the
// right (one column on a phone), and two screens of their own: the CSV import and the batch mail to the checked
// organizations (at most the batch limit; the selection is cleared when the year changes or the mail is sent).
// Every committee member reads and edits; the batch mail needs a send grant on the From mailbox (the screen shows
// it only when the server says the person can send).

const PAGE_SIZE = 50;

type View = { kind: 'browse' } | { kind: 'new' } | { kind: 'import' } | { kind: 'mail'; resumeId?: string };

/**
 * The organization open on the screen is kept in the address (#/contacts?section=organizations&org=og_…), so coming
 * back with the browser's Back (from a related mail, or from the contact) opens it again. The filters are not kept.
 */
function orgFromHash(): string | null {
  try {
    const value = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('org');
    return value && /^og_[0-9a-f]{16}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function keepOrgInHash(id: string | null): void {
  try {
    const [path = '', query = ''] = window.location.hash.split('?');
    if (!path.startsWith('#/contacts')) return;
    const params = new URLSearchParams(query);
    if (id) params.set('org', id);
    else params.delete('org');
    const text = params.toString();
    window.history.replaceState(null, '', `${path}${text ? `?${text}` : ''}`);
  } catch {
    // The address only helps coming back; without it the list opens with nothing chosen.
  }
}

/** The year shown by default: the festival's year (the list's year can be changed). */
const THIS_YEAR = new Date().getFullYear();

function errorText(err: unknown): string {
  return toFailure(err).message;
}

/** The class of a deadline: past (red), within a week (yellow), else none. Dates are compared as YYYY-MM-DD text. */
function dueClass(due: string | null): string {
  if (!due) return '';
  const today = new Date().toLocaleDateString('sv-SE');
  if (due < today) return 'overdue';
  const week = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  return due <= week ? 'soon' : '';
}

export function OrganizationsPanel() {
  const [meta, setMeta] = useState<OrgMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [year, setYear] = useState(THIS_YEAR);
  const [kind, setKind] = useState<OrgKind | ''>('');
  const [owner, setOwner] = useState('');
  const [department, setDepartment] = useState('');
  const [status, setStatus] = useState('');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<OrgListResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(orgFromHash);
  const [checked, setChecked] = useState<Map<string, string>>(new Map());
  const [selectNotice, setSelectNotice] = useState<string | null>(null);
  const [openBatches, setOpenBatches] = useState<OrgMailBatchSummary[]>([]);
  const [view, setView] = useState<View>({ kind: 'browse' });

  useEffect(() => keepOrgInHash(selectedId), [selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    api<OrgMeta>('GET', '/api/organizations/meta', undefined, controller.signal)
      .then((m) => setMeta(m))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setMetaError(errorText(err));
      });
    return () => controller.abort();
  }, []);

  // The search follows the typing a moment after it stops.
  useEffect(() => {
    const next = typed.trim();
    if (next === q) return;
    const timer = window.setTimeout(() => {
      setQ(next);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [typed, q]);

  useEffect(() => {
    const controller = new AbortController();
    const p = new URLSearchParams({ fiscalYear: String(year), page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) p.set('q', q);
    if (kind) p.set('kind', kind);
    if (owner) p.set('owner', owner);
    if (status) p.set('status', status);
    if (department) p.set('department', department);
    api<OrgListResponse>('GET', `/api/organizations?${p.toString()}`, undefined, controller.signal)
      .then((r) => {
        setList(r);
        setListError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setListError(errorText(err));
      });
    return () => controller.abort();
  }, [year, kind, owner, department, status, q, page, reloadKey]);

  // The batches started and not finished (the screen offers to continue them).
  const mailOn = !!meta && meta.mail.enabled && meta.mail.from.length > 0;
  useEffect(() => {
    if (!mailOn) return;
    const controller = new AbortController();
    api<{ items: OrgMailBatchSummary[] }>('GET', '/api/organizations/mail/batches', undefined, controller.signal)
      .then((r) => setOpenBatches(r.items))
      .catch(() => {
        // The list of unfinished batches is a convenience: without it the screen works as before.
      });
    return () => controller.abort();
  }, [mailOn, reloadKey]);

  const stages = kind ? meta?.stages[kind] ?? null : null;
  const totalPages = list ? Math.max(1, Math.ceil(list.total / PAGE_SIZE)) : 1;
  const reload = () => setReloadKey((n) => n + 1);
  const batchLimit = meta?.limits.batch ?? 30;

  const pick = (id: string, name: string, on: boolean) => {
    if (on && !checked.has(id) && checked.size >= batchLimit) {
      setSelectNotice(`一斉送信は ${batchLimit} 団体までです。ほかの団体を選ぶには、選んだ団体の選択を外してください。`);
      return;
    }
    setSelectNotice(null);
    setChecked((prev) => {
      const next = new Map(prev);
      if (on) next.set(id, name);
      else next.delete(id);
      return next;
    });
  };

  const allOnPage = list ? list.items.length > 0 && list.items.every((i) => checked.has(i.id)) : false;
  const togglePage = (on: boolean) => {
    if (!list) return;
    if (!on) {
      setChecked((prev) => {
        const next = new Map(prev);
        for (const i of list.items) next.delete(i.id);
        return next;
      });
      setSelectNotice(null);
      return;
    }
    const next = new Map(checked);
    let skipped = 0;
    for (const i of list.items) {
      if (next.has(i.id)) continue;
      if (next.size >= batchLimit) {
        skipped += 1;
        continue;
      }
      next.set(i.id, i.name);
    }
    setChecked(next);
    setSelectNotice(skipped > 0 ? `一斉送信は ${batchLimit} 団体までのため、${skipped} 件は選べませんでした。` : null);
  };

  if (view.kind === 'import' && meta) {
    return (
      <section className="orgs-panel" aria-label="団体の取り込み">
        <div className="orgs-full">
          <button type="button" className="back-link" onClick={() => setView({ kind: 'browse' })}>
            ← 団体の一覧に戻る
          </button>
          <OrganizationImport
            meta={meta}
            onDone={() => {
              reload();
              setView({ kind: 'browse' });
            }}
          />
        </div>
      </section>
    );
  }

  if (view.kind === 'mail' && meta && mailOn) {
    return (
      <section className="orgs-panel" aria-label="団体への一斉送信">
        <div className="orgs-full">
          <button type="button" className="back-link" onClick={() => setView({ kind: 'browse' })}>
            ← 団体の一覧に戻る
          </button>
          <OrganizationMail
            meta={meta}
            ids={[...checked.keys()]}
            names={Object.fromEntries(checked.entries())}
            resumeBatchId={view.resumeId}
            onSent={(sent) => {
              // The selection is for the mail just sent: it is cleared, and the list shows the new state.
              if (sent > 0) setChecked(new Map());
              reload();
            }}
            onClose={() => setView({ kind: 'browse' })}
          />
        </div>
      </section>
    );
  }

  const detailOpen = view.kind === 'new' || selectedId !== null;

  return (
    <section className="orgs-panel" aria-label="団体の一覧">
      <div className={`orgs-body ${detailOpen ? 'has-detail' : ''}`}>
        <div className="orgs-list-pane orgs-list">
          <div className="pane-head">
            <div className="pane-title">
              <h2>団体</h2>
              <span className="pane-sub">協賛・寄付・出展団体・業者・大学の部署</span>
            </div>
            <div className="actions">
              <button type="button" onClick={() => setView({ kind: 'new' })}>
                団体を追加
              </button>
              <button type="button" className="secondary" onClick={() => setView({ kind: 'import' })}>
                CSVから取り込む
              </button>
            </div>
          </div>

          {metaError && <p className="status error" role="alert">団体の設定を読めませんでした（{metaError}）。読み直してください。</p>}

          {openBatches.length > 0 && (
            <div className="status warning orgs-open-batches" role="region" aria-label="送りかけの一斉送信">
              <p>送りかけの一斉送信が {openBatches.length} 件あります（残りの宛先は、まだ送っていません）。</p>
              <ul className="orgs-mail-list">
                {openBatches.map((o) => (
                  <li key={o.id} className="orgs-open-item">
                    <span>
                      {o.subject}（残り {o.counts.pending + o.counts.failed} 件）
                    </span>
                    <button type="button" className="secondary" onClick={() => setView({ kind: 'mail', resumeId: o.id })}>
                      続きを見る
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="list-tools">
            <input
              className="list-search"
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="団体名・部局・内容・メモで探す"
              aria-label="団体を探す"
              maxLength={100}
              data-testid="org-search"
            />
            <div className="orgs-filters">
              <label>
                年度
                <select
                  value={year}
                  onChange={(e) => {
                    setYear(Number(e.target.value));
                    setPage(1);
                    // A selection made for another year is not sent by accident: it is cleared.
                    setChecked(new Map());
                    setSelectNotice(null);
                  }}
                >
                  {[THIS_YEAR, THIS_YEAR - 1, THIS_YEAR + 1].map((y) => (
                    <option key={y} value={y}>
                      {y}年度
                    </option>
                  ))}
                </select>
              </label>
              <label>
                種別
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as OrgKind | '');
                    setStatus('');
                    setPage(1);
                  }}
                >
                  <option value="">すべて</option>
                  {ORG_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {ORG_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                委員会側の担当
                <select
                  value={owner}
                  onChange={(e) => {
                    setOwner(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">すべて</option>
                  {meta?.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                部局
                <select
                  value={department}
                  onChange={(e) => {
                    setDepartment(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">すべて</option>
                  {department && !list?.departments.includes(department) && <option value={department}>{department}</option>}
                  {(list?.departments ?? []).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {list && Object.keys(list.statusCounts).length > 0 && (
              <div className="filter-chips orgs-counts" role="group" aria-label="状態で絞る">
                <button type="button" className="filter-chip" aria-pressed={status === ''} onClick={() => { setStatus(''); setPage(1); }}>
                  すべて <span className="option-count">{Object.values(list.statusCounts).reduce((a, b) => a + b, 0)}</span>
                </button>
                {(stages ? [...stages, ...Object.keys(list.statusCounts).filter((s) => !stages.includes(s))] : Object.keys(list.statusCounts)).map((s) => (
                  <button key={s} type="button" className="filter-chip" aria-pressed={status === s} onClick={() => { setStatus(status === s ? '' : s); setPage(1); }}>
                    {s} <span className="option-count">{list.statusCounts[s] ?? 0}</span>
                  </button>
                ))}
              </div>
            )}
            {mailOn && (
              <label className="orgs-check">
                <input type="checkbox" checked={allOnPage} disabled={!list || list.items.length === 0} onChange={(e) => togglePage(e.target.checked)} />
                表示中の {list?.items.length ?? 0} 件を選ぶ（一斉送信は {batchLimit} 団体まで）
              </label>
            )}
            {selectNotice && (
              <p className="status warning" role="status">
                {selectNotice}
              </p>
            )}
          </div>

          {listError ? (
            <div className="status error" role="alert">
              団体の一覧を読めませんでした（{listError}）。
              <button type="button" className="secondary" onClick={reload}>
                読み直す
              </button>
            </div>
          ) : !list ? (
            <div className="status loading" role="status">
              読み込み中…
            </div>
          ) : list.items.length === 0 ? (
            <div className="list-empty">
              {q || kind || owner || status || department ? (
                <>
                  <p>条件に合う団体がありません。</p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setTyped('');
                      setQ('');
                      setKind('');
                      setOwner('');
                      setDepartment('');
                      setStatus('');
                      setPage(1);
                    }}
                  >
                    絞り込みを解除する
                  </button>
                </>
              ) : (
                <p>{year}年度の団体はまだありません。「団体を追加」か、協賛マスターの CSV から取り込めます。</p>
              )}
            </div>
          ) : (
            <>
              <p className="hint" aria-live="polite">
                {year}年度 · {list.total} 件中 {(page - 1) * PAGE_SIZE + 1}〜{Math.min(list.total, page * PAGE_SIZE)} 件
              </p>
              <ul className="rows-list contact-rows orgs-rows" aria-label="団体の一覧">
                {list.items.map((item) => (
                  <li key={item.id} className="orgs-row">
                    {mailOn && (
                      <label className="orgs-row-pick">
                        <input
                          type="checkbox"
                          aria-label={`${item.name} を一斉送信に選ぶ`}
                          checked={checked.has(item.id)}
                          onChange={(e) => pick(item.id, item.name, e.target.checked)}
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      className="row-open"
                      aria-current={selectedId === item.id ? 'true' : undefined}
                      onClick={() => {
                        setView({ kind: 'browse' });
                        setSelectedId(item.id);
                      }}
                    >
                      <span className="row-main">{item.name}</span>
                      <span className="row-meta">
                        <span className="orgs-kind">{ORG_KIND_LABELS[item.kind]}</span>
                        <span className={`orgs-status ${dueClass(item.nextDue)}`}>{item.status}</span>
                        {item.amountYen !== null && <span>{item.amountYen.toLocaleString('ja-JP')}円</span>}
                        {item.nextDue && <span>期限 {item.nextDue}</span>}
                        {item.ownerName && <span>担当 {item.ownerName}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {list.total > PAGE_SIZE && (
                <div className="pager">
                  <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    前へ
                  </button>
                  <span>
                    {page} / {totalPages}
                  </span>
                  <button type="button" className="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                    次へ
                  </button>
                </div>
              )}
            </>
          )}

          {mailOn && checked.size > 0 && (
            <div className="orgs-selected-bar" role="region" aria-label="一斉送信の選択">
              <div className="orgs-selected-names">
                <strong>
                  {checked.size} / {batchLimit} 団体を選んでいます
                </strong>
                <span className="hint">{[...checked.values()].join('、')}</span>
              </div>
              <span className="actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setChecked(new Map());
                    setSelectNotice(null);
                  }}
                >
                  選択を外す
                </button>
                <button type="button" onClick={() => setView({ kind: 'mail' })} data-testid="org-bulk-start">
                  選んだ団体に一斉送信
                </button>
              </span>
            </div>
          )}
        </div>

        <div className="orgs-detail-pane orgs-detail" aria-label="団体の詳細">
          {view.kind === 'new' ? (
            <div className="orgs-full">
              <button type="button" className="back-link" onClick={() => setView({ kind: 'browse' })}>
                ← 一覧に戻る
              </button>
              {meta ? (
                <OrganizationDetail
                  meta={meta}
                  id={null}
                  onChanged={(id) => {
                    reload();
                    setView({ kind: 'browse' });
                    setSelectedId(id);
                  }}
                  onClose={() => setView({ kind: 'browse' })}
                />
              ) : (
                <p className="status loading">読み込み中…</p>
              )}
            </div>
          ) : selectedId && meta ? (
            <div className="orgs-full">
              <button type="button" className="back-link" onClick={() => setSelectedId(null)}>
                ← 一覧に戻る
              </button>
              <OrganizationDetail
                key={selectedId}
                meta={meta}
                id={selectedId}
                onChanged={() => reload()}
                onClose={() => setSelectedId(null)}
                onDeleted={() => {
                  setSelectedId(null);
                  reload();
                }}
              />
            </div>
          ) : (
            <div className="detail-placeholder">
              <h2>団体を選択</h2>
              <p>一覧から選ぶと、状態・金額・次の対応・関係するメールがここに出ます。</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
