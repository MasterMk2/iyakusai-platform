import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import type { MailboxSummary } from '../../shared/api';
import type { AssistantSummary } from '../../shared/assistant';
import type { InboxResponse, LineAccountSummary } from '../../shared/line';
import type { TaskContextResponse } from '../../shared/tasks';
import type { TaskSummaryResponse } from '../../shared/task-summary';
import { api, ApiFailure, fmtDate, fmtListDate } from '../api';
import { useLoader } from '../useLoader';
import { BotSummaryCard } from './bot/BotSummaryCard';
import { isBotDisabled } from './bot/BotView';
import { LoadStatus } from './LoadStatus';
import { TaskSummaryCard } from './tasks/TaskSummaryCard';
import type { InboxFilter } from './ThreadList';

/** Answer of GET /api/rental/summary (src/server/rental/store.ts). */
interface RentalSummary {
  total: number;
  counts: { ready: number; loaned: number; review: number };
  planned: number;
  loanedByGroup: { borrower: string; loaned: number; since: string }[];
  review: { code: string; name: string }[];
}

/** The Bot answer, or that its card is not shown (feature off, or no Bot identity). */
export type BotLoaded = { hidden: true } | { hidden: false; summary: AssistantSummary };

const UNHANDLED_ROWS = 5;

/**
 * Home: what needs action now, across modules (../docs/ui-guidelines.md §3). A line of counts that
 * call for work comes first, each one a way in; below it the items themselves where a list is cheap
 * (unhandled mail is one request to this app), and counts per department for tasks (one summary
 * request to the Task service, never one per department). Modules the account cannot use are left out.
 */
export function HomeView({
  rental,
  tasks,
  mailboxes,
  lineAccounts,
  inbox,
  inboxLocked = false,
  inboxUnhandledTotal = null,
  refresh,
  onRefresh,
  onOpenTasks,
  onOpenInbox,
  onOpenMailbox,
  onOpenThread,
  onOpenBot,
  onOpenContacts,
}: {
  userName?: string;
  rental: boolean;
  tasks: TaskContextResponse | null;
  mailboxes: MailboxSummary[];
  lineAccounts: LineAccountSummary[];
  inbox: boolean;
  /** The committee mailbox needs the password again on this device. */
  inboxLocked?: boolean;
  /** The committee mailbox counts a message in two mailboxes once; the per-mailbox rows would count it twice. */
  inboxUnhandledTotal?: number | null;
  refresh: number;
  onRefresh: () => void;
  onOpenTasks: () => void;
  onOpenInbox: (filter?: InboxFilter) => void;
  onOpenMailbox?: (mailboxId: string) => void;
  onOpenThread?: (threadId: string) => void;
  onOpenBot: (section?: 'candidates' | 'remind') => void;
  /** Committee contacts (a search, or the whole list when empty); absent where there are none. */
  onOpenContacts?: (query: string) => void;
}) {
  const taskBound = !!tasks?.enabled && tasks.bound;
  const loadTasks = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return taskBound ? api<TaskSummaryResponse>('GET', '/api/tasks/summary', undefined, signal) : Promise.resolve(null);
    },
    [taskBound, refresh],
  );
  const taskSummary = useLoader(loadTasks);
  const loadBot = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<AssistantSummary>('GET', '/api/assistant/summary', undefined, signal).then(
        (summary): BotLoaded => ({ hidden: false, summary }),
        (err: unknown): BotLoaded => {
          if (err instanceof ApiFailure && (isBotDisabled(err) || err.status === 403)) return { hidden: true };
          throw err;
        },
      );
    },
    [refresh],
  );
  const bot = useLoader(loadBot);
  const loadRental = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return rental ? api<RentalSummary>('GET', '/api/rental/summary', undefined, signal) : Promise.resolve(null);
    },
    [rental, refresh],
  );
  const rentalSummary = useLoader(loadRental);
  const mailOpen = inbox && !inboxLocked;
  const loadUnhandled = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return mailOpen ? api<InboxResponse>('GET', `/api/inbox?status=unhandled&page=1&pageSize=${UNHANDLED_ROWS}`, undefined, signal) : Promise.resolve(null);
    },
    [mailOpen, refresh],
  );
  const unhandled = useLoader(loadUnhandled);

  const t = taskSummary.data;
  const b = bot.data && !bot.data.hidden ? bot.data.summary : null;
  const r = rentalSummary.data;
  const mailTotal = inboxUnhandledTotal ?? unhandled.data?.total ?? null;
  const scrollTo = (id: string) => () => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  };

  // The attention line: only counts above zero, each with the place it opens.
  const items: { key: string; label: string; n: number; tone: 'error' | 'warning' | 'info'; onOpen: () => void; testId: string }[] = [];
  if (t) {
    if (t.deadlines.overdue > 0) items.push({ key: 'overdue', label: 'タスクの期限超過', n: t.deadlines.overdue, tone: 'error', onOpen: scrollTo('home-tasks'), testId: 'attention-task-overdue' });
    if (t.deadlines.today > 0) items.push({ key: 'today', label: '今日が期限のタスク', n: t.deadlines.today, tone: 'warning', onOpen: scrollTo('home-tasks'), testId: 'attention-task-today' });
  }
  if (mailOpen && mailTotal !== null && mailTotal > 0) items.push({ key: 'mail', label: '未対応のメール', n: mailTotal, tone: 'error', onOpen: () => onOpenInbox('unhandled'), testId: 'attention-mail' });
  if (b) {
    if (b.pendingCandidates > 0) items.push({ key: 'cand', label: '承認待ちのタスク候補', n: b.pendingCandidates, tone: 'warning', onOpen: () => onOpenBot('candidates'), testId: 'attention-candidates' });
    if (b.reminders.overdue > 0) items.push({ key: 'remind', label: '期限超過のリマインド', n: b.reminders.overdue, tone: 'error', onOpen: () => onOpenBot('remind'), testId: 'attention-reminders' });
  }
  if (r) {
    if (r.loanedByGroup.length > 0) items.push({ key: 'loan', label: '返却待ちの団体', n: r.loanedByGroup.length, tone: 'info', onOpen: scrollTo('home-rental'), testId: 'attention-loans' });
    if (r.counts.review > 0) items.push({ key: 'review', label: '要確認の物品', n: r.counts.review, tone: 'warning', onOpen: scrollTo('home-rental'), testId: 'attention-review' });
  }
  const settled = !taskSummary.loading && !bot.loading && !rentalSummary.loading && !unhandled.loading;
  const failed = !!(taskSummary.error || bot.error || rentalSummary.error || unhandled.error);

  return (
    <main className="main home" aria-labelledby="home-title">
      <div className="page-head">
        <div className="page-title">
          <h1 id="home-title">ホーム</h1>
          <span className="hint">いま対応が必要なもの</span>
        </div>
        <button type="button" className="secondary" onClick={onRefresh}>
          最新の状態にする
        </button>
      </div>
      <section className="attention" aria-label="対応が必要な件数" data-testid="home-attention">
        {items.length > 0 ? (
          <ul>
            {items.map((i) => (
              <li key={i.key}>
                <button type="button" className={`attention-item tone-${i.tone}`} onClick={i.onOpen} data-testid={i.testId}>
                  <strong>{i.n}</strong>
                  <span>{i.label}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : settled && !failed ? (
          <p className="status ok">いま期限を過ぎたタスクや未対応のメールはありません。</p>
        ) : !settled ? (
          <p className="hint">件数を確認しています…</p>
        ) : null}
        {settled && failed && <p className="hint">一部の件数を取得できませんでした。下の各欄で理由と再試行を確認してください。</p>}
      </section>
      <div className="home-columns">
        <div className="home-main">
          {inbox && (
            <InboxCard
              mailboxes={mailboxes}
              lineAccounts={lineAccounts}
              locked={inboxLocked}
              unhandledTotal={mailTotal}
              unhandled={unhandled}
              onOpenInbox={onOpenInbox}
              onOpenMailbox={onOpenMailbox}
              onOpenThread={onOpenThread}
            />
          )}
          {tasks?.enabled && <TaskSummaryCard context={tasks} loader={taskSummary} onOpenTasks={onOpenTasks} />}
        </div>
        <div className="home-side">
          {rental && <RentalCard loader={rentalSummary} />}
          <BotSummaryCard loader={bot} onOpenBot={onOpenBot} />
          {onOpenContacts && <ContactsCard onOpen={onOpenContacts} />}
        </div>
      </div>
    </main>
  );
}

type Loader<T> = ReturnType<typeof useLoader<T>>;

/**
 * A search that opens the contacts tab with it (a quick way to a phone number on the festival days).
 * Not a count of things to do; it is kept at the bottom of the side column.
 */
function ContactsCard({ onOpen }: { onOpen: (query: string) => void }) {
  const [query, setQuery] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onOpen(query.trim());
  };
  return (
    <Card
      id="home-contacts"
      title="連絡先"
      testId="home-contacts"
      action={
        <button type="button" className="secondary" onClick={() => onOpen('')}>
          一覧を開く
        </button>
      }
    >
      <form className="search-row" role="search" onSubmit={submit}>
        <label htmlFor="home-contact-search" className="sr-only">
          連絡先を探す
        </label>
        <input id="home-contact-search" type="search" value={query} placeholder="名前・会社・電話・メール" onChange={(e) => setQuery(e.target.value)} maxLength={200} data-testid="home-contact-search" />
        <button type="submit">探す</button>
      </form>
      <p className="hint">相手先・出展団体・委員会の窓口・委員の電話とメール</p>
    </Card>
  );
}

function Card({ id, title, action, children, testId, className = '' }: { id: string; title: string; action?: ReactNode; children: ReactNode; testId: string; className?: string }) {
  return (
    <section className={`panel ${className}`} aria-labelledby={`${id}-title`} id={id} tabIndex={-1} data-testid={testId}>
      <div className="panel-head">
        <h2 id={`${id}-title`}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function RentalCard({ loader }: { loader: Loader<RentalSummary | null> }) {
  const s = loader.data;
  return (
    <Card
      id="home-rental"
      title="物品貸出"
      testId="home-rental"
      action={
        <a className="button primary" href="/rental">
          貸出・返却を始める
        </a>
      }
    >
      <LoadStatus loader={loader} what="物品の状況" compact />
      {s && (
        <>
          <dl className="stats">
            <div className="stat">
              <dt>貸出中</dt>
              <dd>
                {s.counts.loaned}
                <small>件・{s.loanedByGroup.length}団体</small>
              </dd>
            </div>
            <div className={`stat ${s.counts.review > 0 ? 'stat-warning' : ''}`}>
              <dt>要確認</dt>
              <dd>
                {s.counts.review}
                <small>件</small>
              </dd>
            </div>
            <div className="stat">
              <dt>貸出できる</dt>
              <dd>
                {s.counts.ready}
                <small>／{s.total}件</small>
              </dd>
            </div>
          </dl>
          {s.planned > 0 && <p className="hint">貸出できる物品のうち {s.planned} 件は、貸出先の団体が決まっています（来たら読み取るだけで入ります）。</p>}
          {s.counts.review > 0 && (
            <>
              <h3>要確認の物品（整備・破損で返却）</h3>
              <ul className="rows">
                {s.review.map((item) => (
                  <li key={item.code}>
                    <span className="row-main">{item.name}</span>
                    <span className="row-sub">{item.code}</span>
                  </li>
                ))}
              </ul>
              {s.counts.review > s.review.length && <p className="hint">ほか {s.counts.review - s.review.length} 件</p>}
            </>
          )}
          <h3>返却待ちの団体</h3>
          {s.loanedByGroup.length === 0 ? (
            <p className="empty">貸出中の物品はありません。</p>
          ) : (
            <ul className="rows">
              {s.loanedByGroup.slice(0, 8).map((g) => (
                <li key={g.borrower}>
                  <span className="row-main">{g.borrower}</span>
                  <span className="row-sub">
                    {g.loaned} 件{g.since && `・${fmtDate(g.since)} から`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {s.loanedByGroup.length > 8 && <p className="hint">ほか {s.loanedByGroup.length - 8} 団体（物品貸出の「情報」で全団体を確認できます）</p>}
        </>
      )}
    </Card>
  );
}

function InboxCard({
  mailboxes,
  lineAccounts,
  locked,
  unhandledTotal,
  unhandled,
  onOpenInbox,
  onOpenMailbox,
  onOpenThread,
}: {
  mailboxes: MailboxSummary[];
  lineAccounts: LineAccountSummary[];
  locked: boolean;
  unhandledTotal: number | null;
  unhandled: Loader<InboxResponse | null>;
  onOpenInbox: (filter?: InboxFilter) => void;
  onOpenMailbox?: (mailboxId: string) => void;
  onOpenThread?: (threadId: string) => void;
}) {
  // Only mailboxes with something to do, most first; a mailbox with none is left out.
  const boxes = [...mailboxes.map((m) => ({ id: m.id, name: m.name, kind: 'メール', unhandled: m.unhandledCount, mail: true })), ...lineAccounts.map((a) => ({ id: a.id, name: a.name, kind: 'LINE', unhandled: a.unhandledCount, mail: false }))]
    .filter((x) => x.unhandled > 0)
    .sort((a, b) => b.unhandled - a.unhandled);
  const total = unhandledTotal ?? boxes.reduce((n, x) => n + x.unhandled, 0);
  const items = unhandled.data?.items ?? [];
  return (
    <Card
      id="home-inbox"
      title={`未対応のメール${locked ? '' : `（${total} 件）`}`}
      testId="home-inbox"
      action={
        <button type="button" className="secondary" onClick={() => onOpenInbox(total > 0 ? 'unhandled' : undefined)}>
          {total > 0 ? '未対応のメールを見る' : 'メールを開く'}
        </button>
      }
    >
      {locked ? (
        <p className="hint" data-testid="home-inbox-locked">
          メールを開くにはパスワードの再入力が必要です（しばらくメールを使っていなかったため）。「メール」を開くと入力できます。
        </p>
      ) : (
        <>
          <LoadStatus loader={unhandled} what="未対応のメール" compact />
          {unhandled.data && items.length === 0 && <p className="empty">未対応のメールはありません。</p>}
          {items.length > 0 && (
            <ul className="rows home-mail-rows">
              {items.map((item) =>
                item.source === 'email' ? (
                  <li key={item.threadId}>
                    <button type="button" className="row-button" onClick={() => onOpenThread?.(item.threadId)}>
                      <span className="row-line">
                        <span className="row-main">{item.subject || '（件名なし）'}</span>
                        <span className="row-sub">{fmtListDate(item.latestReceivedAt)}</span>
                      </span>
                      <span className="row-sub">
                        {item.senders[0] ?? ''}・{(item.mailboxes ?? [item.mailbox]).map((m) => m.name).join('・')}
                        {item.assignees.length > 0 ? `・担当 ${item.assignees.join('、')}` : '・担当なし'}
                      </span>
                    </button>
                  </li>
                ) : (
                  <li key={item.conversationId}>
                    <span className="row-main">{item.title}</span>
                    <span className="row-sub">LINE・{item.account.name}</span>
                  </li>
                ),
              )}
            </ul>
          )}
          {unhandled.data && unhandled.data.total > items.length && <p className="hint">ほか {unhandled.data.total - items.length} 件（新しい順に {items.length} 件を表示）</p>}
          {boxes.length > 0 && (
            <>
              <h3>受信箱別の未対応</h3>
              <ul className="box-counts">
                {boxes.map((x) => (
                  <li key={`${x.kind}:${x.id}`}>
                    {x.mail && onOpenMailbox ? (
                      <button type="button" className="link-button" onClick={() => onOpenMailbox(x.id)}>
                        {x.name}
                      </button>
                    ) : (
                      <span>
                        {x.kind === 'LINE' ? 'LINE: ' : ''}
                        {x.name}
                      </span>
                    )}
                    <span className="count-badge">{x.unhandled}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}
