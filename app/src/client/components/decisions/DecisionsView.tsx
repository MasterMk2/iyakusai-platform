import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { LoadStatus } from '../LoadStatus';
import { useLoader } from '../../useLoader';
import { departmentsOf } from '../tasks/common';
import type { TaskContextResponse } from '../../../shared/tasks';
import { DECISION_STATUSES, DECISION_STATUS_LABELS, DECISION_VENUE_LABELS, type DecisionInput, type DecisionListItem, type DecisionStatus } from '../../../shared/decisions';
import { DecisionDetail } from './DecisionDetail';
import { DecisionForm, type DepartmentOption } from './DecisionForm';
import { decisionApi, useDecisionMeta } from './decisionsApi';
import { decisionHref, decisionNewHref, departmentLabel, returnHref, todayInJapan, type DecisionPrefill } from './decisionLinks';

// The register's screen: the list (filtered by search, department, state and the day it was decided) beside the
// decision opened or the form. Filters are sent to the server, so a long list is never loaded whole. On a phone
// the list and the decision take turns, as the other two-pane screens do.

const PAGE_SIZE = 20;
/** The venue a new decision starts with (most decisions are made at the weekly meeting). */
const DEFAULT_VENUE = 'regular';

interface Filters {
  q: string;
  department: string;
  status: '' | DecisionStatus;
  from: string;
  to: string;
  page: number;
}

const NO_FILTERS: Filters = { q: '', department: '', status: '', from: '', to: '', page: 1 };

export function initialInput(prefill: DecisionPrefill | null): DecisionInput {
  return {
    title: prefill?.title ?? '',
    body: '',
    departments: [],
    decidedOn: prefill?.decidedOn || todayInJapan(),
    venue: DEFAULT_VENUE,
    venueOther: '',
    sources: prefill?.source ? [prefill.source] : [],
    taskIds: [],
  };
}

interface Props {
  decisionId: string | null;
  creating: boolean;
  prefill: DecisionPrefill | null;
}

export function DecisionsView({ decisionId, creating, prefill }: Props) {
  const meta = useDecisionMeta();
  const context = useLoader(useCallback((signal: AbortSignal) => api<TaskContextResponse>('GET', '/api/tasks/context', undefined, signal), []));
  // Every save, change, revoke and restore counts up; the list reads the register again when the count moves.
  const [listRevision, setListRevision] = useState(0);
  const listChanged = useCallback(() => setListRevision((n) => n + 1), []);

  // The department keys are the Task service's; the names come from it, and a key only the decisions use is shown as itself.
  const departments = useMemo<DepartmentOption[]>(() => {
    const named = departmentsOf(context.data).map((d) => ({ key: d.key, label: d.label }));
    const extra = (meta?.departments ?? []).filter((k) => !named.some((d) => d.key === k)).map((key) => ({ key, label: key }));
    return [...named, ...extra];
  }, [context.data, meta]);

  if (meta === null) {
    return (
      <main className="main decisions-page" aria-labelledby="decisions-title">
        <h2 id="decisions-title">決定事項</h2>
        <p className="status loading" role="status">
          読み込み中…
        </p>
      </main>
    );
  }
  if (!meta.enabled) {
    return (
      <main className="main decisions-page" aria-labelledby="decisions-title">
        <h2 id="decisions-title">決定事項</h2>
        <p className="status error" role="alert">
          決定事項は、このサーバーでは使えないか、委員だけが使えます。
        </p>
      </main>
    );
  }

  const showingDetail = creating || decisionId !== null;
  return (
    <div className={`layout decisions-layout ${showingDetail ? 'has-detail' : ''}`}>
      <DecisionList departments={departments} selectedId={decisionId} canRegister={meta.canRegister} refresh={listRevision} />
      <section className="decisions-detail" aria-label="選んだ決定事項">
        {creating ? (
          <DecisionForm
            key={JSON.stringify(prefill)}
            mode="new"
            initial={initialInput(prefill)}
            departments={departments}
            onCancel={() => {
              window.location.hash = returnHref(window.location.hash);
            }}
            onSaved={(detail) => {
              listChanged();
              window.location.hash = decisionHref(detail.decision.id);
            }}
          />
        ) : decisionId ? (
          <DecisionDetail key={decisionId} id={decisionId} departments={departments} onChanged={listChanged} />
        ) : (
          <div className="detail-placeholder">
            <h2>決定を選択</h2>
            <p>一覧から選ぶと、決めた内容と変更の流れがここに出ます。</p>
          </div>
        )}
      </section>
    </div>
  );
}

function DecisionList({ departments, selectedId, canRegister, refresh }: { departments: DepartmentOption[]; selectedId: string | null; canRegister: boolean; refresh: number }) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [search, setSearch] = useState('');

  // The search waits until the typing stops, so each word is not a request.
  useEffect(() => {
    const timer = setTimeout(() => {
      const q = search.trim();
      setFilters((f) => (f.q === q ? f : { ...f, q, page: 1 }));
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ page: String(filters.page), pageSize: String(PAGE_SIZE) });
    if (filters.q) p.set('q', filters.q);
    if (filters.department) p.set('department', filters.department);
    if (filters.status) p.set('status', filters.status);
    if (filters.from) p.set('from', filters.from);
    if (filters.to) p.set('to', filters.to);
    return p;
  }, [filters]);

  const fetcher = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return decisionApi.list(query, signal);
    },
    [query, refresh],
  );
  const loader = useLoader(fetcher);
  const page = loader.data;
  const filtered = filters.q !== '' || filters.department !== '' || filters.status !== '' || filters.from !== '' || filters.to !== '';
  const pages = page ? Math.max(1, Math.ceil(page.total / PAGE_SIZE)) : 1;
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch, page: 'page' in patch ? (patch.page as number) : 1 }));
  const label = (item: DecisionListItem) => DECISION_VENUE_LABELS[item.venue];

  return (
    <section className="panel decisions-list" aria-labelledby="decisions-title">
      <div className="panel-head">
        <h2 id="decisions-title">決定事項</h2>
        {canRegister && (
          <a className="button" href={decisionNewHref()} data-testid="decision-new">
            決定を登録
          </a>
        )}
      </div>
      <p className="hint">議論の場とは別に、決まったことをここに残します。変更は古い決定を残し、新しい決定で置き換えます。</p>

      <form className="decision-filters" role="search" aria-label="決定事項を探す" onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label htmlFor="decision-search">探す（内容・詳しい内容・出典・タスク）</label>
          <input id="decision-search" type="search" value={search} maxLength={200} onChange={(e) => setSearch(e.target.value)} data-testid="decision-search" />
        </div>
        <details className="decision-more" open={filtered}>
          <summary>絞り込み（部局・状態・決めた日）{filtered ? '・条件あり' : ''}</summary>
          <div className="field-row">
            <div className="field">
              <label htmlFor="decision-department">部局</label>
              <select id="decision-department" value={filters.department} onChange={(e) => set({ department: e.target.value })}>
                <option value="">すべて</option>
                {departments.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="decision-status">状態</label>
              <select id="decision-status" value={filters.status} onChange={(e) => set({ status: e.target.value as '' | DecisionStatus })}>
                <option value="">すべて</option>
                {DECISION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {DECISION_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="decision-from">決めた日（から）</label>
              <input id="decision-from" type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="decision-to">決めた日（まで）</label>
              <input id="decision-to" type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
            </div>
          </div>
        </details>
        {filtered && (
          <button type="button" className="secondary" onClick={() => { setSearch(''); setFilters(NO_FILTERS); }}>
            条件を戻す
          </button>
        )}
      </form>

      <LoadStatus loader={loader} what="決定事項" />
      {page && page.total === 0 && (
        <div className="empty-state">
          {filtered ? (
            <p>条件に合う決定事項はありません。条件をゆるめてください。</p>
          ) : (
            <>
              <p>まだ決定事項はありません。</p>
              {canRegister && (
                <a className="button" href={decisionNewHref()}>
                  最初の決定を登録する
                </a>
              )}
            </>
          )}
        </div>
      )}
      {page && page.total > 0 && (
        <>
          <p className="hint" data-testid="decision-count">
            {page.total} 件（{page.page} / {pages} ページ）
          </p>
          <ul className="rows decision-list-items" aria-label="決定事項の一覧">
            {page.items.map((item) => (
              <li key={item.id}>
                <a href={decisionHref(item.id)} className="decision-row" aria-current={item.id === selectedId ? 'true' : undefined} data-testid="decision-row">
                  <span className="decision-row-title">{item.title}</span>
                  <span className="facts-line">
                    <span className={`decision-status decision-status-${item.status}`}>{DECISION_STATUS_LABELS[item.status]}</span>
                    <span>{item.decidedOn}</span>
                    <span>{label(item)}</span>
                    <span>{item.departments.map((k) => departmentLabel(k, departments)).join('・')}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <nav className="pager" aria-label="ページ">
            <button type="button" className="secondary" disabled={filters.page <= 1} onClick={() => set({ page: filters.page - 1 })}>
              前のページ
            </button>
            <button type="button" className="secondary" disabled={filters.page >= pages} onClick={() => set({ page: filters.page + 1 })}>
              次のページ
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
