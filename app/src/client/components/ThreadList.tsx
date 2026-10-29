import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { HANDLING_STATUSES, LIMITS, PAGE_SIZE_CHOICES, STATUS_LABELS, type HandlingStatus, type LabelFacet } from '../../shared/api';
import type { InboxItem, InboxResponse } from '../../shared/line';
import { REAUTH_REQUIRED } from '../../shared/mailbox';
import { api, fmtListDate } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';
import { ThreadStatusButtons } from './ThreadStatusButtons';

interface Filters {
  q: string;
  source: string;
  status: string;
  label: string;
  assignee: string;
}

/** Shortcut a link may open the list with (home counts). */
export type InboxFilter = 'unhandled' | 'mine';

const EMPTY: Filters = { q: '', source: '', status: '', label: '', assignee: '' };
// The chosen page size is remembered on this device only; storage may be blocked (private windows).
const PAGE_SIZE_KEY = 'iyakusai-mail-page-size';
// Without a remembered choice the list shows 20 rows: with one-line rows that fills a PC screen.
const DEFAULT_PAGE_SIZE = 20;

function savedPageSize(): number {
  try {
    const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
    if ((PAGE_SIZE_CHOICES as readonly number[]).includes(saved)) return saved;
  } catch {
    // fall through to the default
  }
  return DEFAULT_PAGE_SIZE;
}

function initialFilters(filter: InboxFilter | null | undefined): Filters {
  if (filter === 'unhandled') return { ...EMPTY, status: 'unhandled' };
  if (filter === 'mine') return { ...EMPTY, assignee: 'me' };
  return EMPTY;
}

const TARGET_LABEL = { user: '1:1', group: 'グループ', room: 'トークルーム', legacy_chat: '旧履歴' } as const;

export type Selection = { kind: 'thread' | 'conversation'; id: string };

/**
 * The marks under a row. The status is written out only where the row has no status buttons, or where
 * its messages differ (no button is pressed then); otherwise the pressed button already says it.
 */
function Chips({ statuses, labels, assignees, showStatus }: { statuses: HandlingStatus[]; labels: string[]; assignees: string[]; showStatus: boolean }) {
  if (!showStatus && labels.length === 0 && assignees.length === 0) return null;
  return (
    <span className="chips">
      {showStatus &&
        statuses.map((s) => (
          <span key={s} className={`chip status-${s}`}>
            {STATUS_LABELS[s]}
          </span>
        ))}
      {assignees.map((a) => (
        <span key={a} className="chip assignee">
          担当: {a}
        </span>
      ))}
      {labels.map((l) => (
        <span key={l} className="chip label">
          {l}
        </span>
      ))}
    </span>
  );
}

function Item({ item, selectedId, filtered, showSource, showMailbox, onSelect }: { item: InboxItem; selectedId: string | null; filtered: boolean; showSource: boolean; showMailbox: boolean; onSelect: (s: Selection) => void }) {
  const unhandled = item.statuses.includes('unhandled');
  if (item.source === 'email') {
    const selected = selectedId === item.threadId;
    return (
      <button
        type="button"
        className={`row-open thread ${selected ? 'selected' : ''} ${unhandled ? 'is-unhandled' : ''}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect({ kind: 'thread', id: item.threadId })}
        data-thread-id={item.threadId}
      >
        <span className="row-line">
          <span className="subject" title={item.subject}>
            {item.subject || '（件名なし）'}
          </span>
          <span className="date">{fmtListDate(item.latestReceivedAt)}</span>
        </span>
        <span className="row-meta">
          {showSource && <span className="source-badge source-email">メール</span>}
          <span className="senders" title={item.senders.join('、')}>
            {item.senders[0] ?? ''}
            {item.senders.length > 1 ? ` ほか${item.senders.length - 1}` : ''}
          </span>
          {item.receiptCount > 1 && <span className="receipt-count">{item.receiptCount} 通{filtered && item.matchCount !== item.receiptCount ? `（一致 ${item.matchCount}）` : ''}</span>}
          {showMailbox && <span className="mailbox-names">{(item.mailboxes ?? [item.mailbox]).map((m) => m.name).join('・')}</span>}
        </span>
        <span className="snippet">{item.snippet}</span>
      </button>
    );
  }
  const selected = selectedId === item.conversationId;
  return (
    <button
      type="button"
      className={`row-open thread ${selected ? 'selected' : ''} ${unhandled ? 'is-unhandled' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect({ kind: 'conversation', id: item.conversationId })}
      data-conversation-id={item.conversationId}
    >
      <span className="row-line">
        <span className="subject" title={item.title}>
          {item.title}
        </span>
        <span className="date">{fmtListDate(item.latestAt)}</span>
      </span>
      <span className="row-meta">
        <span className="source-badge source-line">LINE</span>
        {showMailbox && <span className="mailbox-names">{item.account.name}</span>}
        <span>{TARGET_LABEL[item.targetType]}</span>
        <span>{item.messageCount} 件{filtered && item.matchCount !== item.messageCount ? `（一致 ${item.matchCount}）` : ''}</span>
      </span>
      <span className="snippet">{item.snippet}</span>
    </button>
  );
}

export function ThreadList(props: {
  mailboxId: string | null;
  lineAccountId: string | null;
  mailboxName: string | null;
  /** Address of the selected mailbox, shown under its name. */
  mailboxAddress?: string | null;
  /** Title of the all-mailboxes view (the committee mailbox shows every mailbox to everyone). */
  allTitle?: string;
  /** Filter to open with (from a home count). */
  initialFilter?: InboxFilter | null;
  /** The person changed or cleared the filters (the opening filter no longer describes the list). */
  onFiltersChanged?: () => void;
  /** Choice of mailbox shown above the list where the mailbox column is folded away (narrow windows). */
  switcher?: ReactNode;
  /** The mail screens need the password again (committee mailbox idle limit). */
  onReauthRequired?: () => void;
  selectedId: string | null;
  refresh: number;
  onSelect: (selection: Selection) => void;
  /** A status was set from the list (reloads the list, the open thread and the counts). */
  onChanged?: () => void;
}) {
  const { mailboxId, lineAccountId, refresh } = props;
  const [draft, setDraft] = useState<Filters>(() => initialFilters(props.initialFilter));
  const [applied, setApplied] = useState<Filters>(() => initialFilters(props.initialFilter));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(savedPageSize);
  const [formError, setFormError] = useState<string | null>(null);

  const scope = useCallback(() => {
    const params = new URLSearchParams();
    if (mailboxId) params.set('mailboxId', mailboxId);
    if (lineAccountId) params.set('lineAccountId', lineAccountId);
    return params;
  }, [mailboxId, lineAccountId]);

  const loadThreads = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      const params = scope();
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      for (const [key, value] of Object.entries(applied)) if (value) params.set(key, value);
      return api<InboxResponse>('GET', `/api/inbox?${params.toString()}`, undefined, signal);
    },
    [scope, applied, page, pageSize, refresh],
  );
  const threads = useLoader(loadThreads);
  const reauth = threads.error?.body?.error === REAUTH_REQUIRED;
  const { onReauthRequired } = props;
  useEffect(() => {
    if (reauth) onReauthRequired?.();
  }, [reauth, onReauthRequired]);

  const loadLabels = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      const params = scope().toString();
      return api<LabelFacet[]>('GET', `/api/inbox/labels${params ? `?${params}` : ''}`, undefined, signal);
    },
    [scope, refresh],
  );
  const labels = useLoader(loadLabels);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (draft.q.length > LIMITS.queryMaxLength) {
      setFormError(`検索語は ${LIMITS.queryMaxLength} 文字以内で入力してください。`);
      return;
    }
    setFormError(null);
    setPage(1);
    setApplied({ ...draft, q: draft.q.trim() });
    props.onFiltersChanged?.();
  }

  // A choice in a list box filters at once (the keyword waits for Enter or 検索, as it is typed).
  function choose(key: Exclude<keyof Filters, 'q'>, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setPage(1);
    setApplied((a) => ({ ...a, [key]: value }));
    props.onFiltersChanged?.();
  }

  // Keeps the first row on screen in view: rows 41–60 at 20 per page become page 1 (rows 1–50) at 50.
  function changePageSize(next: number) {
    setPage(Math.floor(((page - 1) * pageSize) / next) + 1);
    setPageSize(next);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(next));
    } catch {
      // not remembered; this view still uses it
    }
  }

  function clear() {
    setDraft(EMPTY);
    setApplied(EMPTY);
    setPage(1);
    setFormError(null);
    props.onFiltersChanged?.();
  }

  const data = threads.data;
  const filtered = Object.values(applied).some(Boolean);
  const title = mailboxId || lineAccountId ? (props.mailboxName ?? (lineAccountId ? 'LINE アカウント' : '受信箱')) : (props.allTitle ?? 'すべての許可された受信箱');
  const showSource = data?.lineEnabled === true && !mailboxId && !lineAccountId;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="thread-list">
      <header className="pane-head">
        <div className="pane-title">
          <h2>{title}</h2>
          {props.mailboxAddress && <span className="pane-sub">{props.mailboxAddress}</span>}
        </div>
        {props.switcher}
      </header>
      <form className="list-tools filters" onSubmit={submit} role="search" aria-label="メール検索">
        <div className="search-row">
          <input
            type="search"
            className="list-search"
            aria-label="検索語"
            placeholder="件名・差出人・本文で検索"
            value={draft.q}
            onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          />
          <button type="submit" className="secondary">
            検索
          </button>
        </div>
        <div className="filter-row">
          {showSource && (
            <label>
              種類
              <select aria-label="種類" value={draft.source} onChange={(e) => choose('source', e.target.value)}>
                <option value="">すべて</option>
                <option value="email">メールだけ</option>
                <option value="line">LINE だけ</option>
              </select>
            </label>
          )}
          <label>
            対応状況
            <select aria-label="対応状況" value={draft.status} onChange={(e) => choose('status', e.target.value)}>
              <option value="">すべて</option>
              {HANDLING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            担当
            <select aria-label="担当" value={draft.assignee} onChange={(e) => choose('assignee', e.target.value)}>
              <option value="">すべて</option>
              <option value="me">自分が担当</option>
              <option value="none">担当なし</option>
            </select>
          </label>
          <label>
            ラベル
            <select aria-label="ラベル" value={draft.label} onChange={(e) => choose('label', e.target.value)}>
              <option value="">すべて</option>
              {(labels.data ?? []).map((l) => (
                <option key={l.label} value={l.label}>
                  {l.label}（{l.count}）
                </option>
              ))}
            </select>
          </label>
        </div>
      </form>
      {formError && <p className="status error" role="alert">{formError}</p>}
      <LoadStatus loader={threads} what="スレッド一覧" />
      {data && (
        <>
          <div className="list-bar">
            <p className="count" data-testid="thread-count">
              {data.total === 0 ? '0 件' : `全 ${data.total} 件中 ${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)} 件`}
            </p>
            {filtered && (
              <button type="button" className="quiet" onClick={clear}>
                条件をクリア
              </button>
            )}
            <label className="page-size">
              表示件数
              <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
                {PAGE_SIZE_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n} 件
                  </option>
                ))}
              </select>
            </label>
          </div>
          {data.counts.line > 0 && (
            <p className="hint" data-testid="source-counts">
              内訳: メール {data.counts.email} 件 ／ LINE {data.counts.line} 件
            </p>
          )}
          {data.total === 0 && (
            <div className="empty list-empty">
              {filtered ? (
                <>
                  <p>条件に一致するスレッドはありません。</p>
                  <button type="button" className="secondary" onClick={clear}>
                    条件をクリア
                  </button>
                </>
              ) : (
                <p>この範囲に表示できるメールはありません。</p>
              )}
            </div>
          )}
          <ul className="rows-list threads">
            {data.items.map((t) => {
              const withButtons = t.source === 'email' && t.canSetStatus === true;
              const id = t.source === 'email' ? t.threadId : t.conversationId;
              return (
                <li key={id} className={`row thread-row ${props.selectedId === id ? 'selected' : ''} ${withButtons ? 'has-buttons' : ''}`}>
                  <Item item={t} selectedId={props.selectedId} filtered={filtered} showSource={showSource} showMailbox={!mailboxId && !lineAccountId} onSelect={props.onSelect} />
                  {/* Labels and assignee on the left, the row's own status buttons on the right. */}
                  <div className="row-foot">
                    <Chips statuses={t.statuses} labels={t.labels} assignees={t.assignees} showStatus={!withButtons || t.statuses.length > 1} />
                    {t.source === 'email' && withButtons && <ThreadStatusButtons threadId={t.threadId} subject={t.subject} statuses={t.statuses} onChanged={props.onChanged ?? threads.retry} />}
                  </div>
                </li>
              );
            })}
          </ul>
          {data.total > data.pageSize && (
            <div className="pager">
              <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                前へ
              </button>
              <span>
                {page} / {pages} ページ
              </span>
              <button type="button" className="secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>
                次へ
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
