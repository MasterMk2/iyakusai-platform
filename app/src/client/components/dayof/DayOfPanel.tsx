import { useEffect, useRef, useState } from 'react';
import { dateLabel, jstDate } from '../../../shared/calendar';
import { DAYOF_PRIORITY_LABELS, findDayOfPost, sortDayOfPosts, type DayOfBoardResponse, type DayOfPostView } from '../../../shared/dayof';
import { DECISION_STATUS_LABELS } from '../../../shared/decisions';
import type { TaskContextResponse } from '../../../shared/tasks';
import { toFailure } from '../../api';
import { decisionHref } from '../decisions/decisionLinks';
import { departmentsOf } from '../tasks/common';
import { DecisionQuickForm, type DepartmentChoice } from './DecisionQuickForm';
import { dayofApi, useDayOfBoard, type DayOfBoardState } from './dayofApi';
import { PostForm } from './PostForm';
import './dayof.css';

// 当日 on the home screen (2026-11-03): only on the festival days an access administrator set (Japan time), at the
// top of the home screen. Outside the period, or for a person or server without the board, nothing is drawn. The
// headquarters' notices come first (至急 pinned), then today's decisions, today's events and the counts of lent items.
// The rules of who decides what stand at the top, as plain text. It reads itself again every 30 seconds while it is on
// screen; a new 至急 notice is announced at the top of the panel until the person says they saw it.
//
// So the home screen does not jump when the first read answers, the tab remembers (sessionStorage, no content) that
// today is a festival day and how tall the panel was; the next time the home screen opens that day, a frame of that
// height stands in its place while it loads.

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
/**
 * The time, with the date in front for a notice of an earlier day (an open notice stays on the board for the rest of
 * the period; the period is at most 14 days, so the month and the day are enough).
 */
const stampOf = (iso: string, today: string) => {
  const day = jstDate(new Date(iso));
  return day === today ? timeOf(iso) : `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} ${timeOf(iso)}`;
};

/** The first line of a decision's text, short (the register may hold a long one). */
const firstLine = (text: string) => {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  const chars = [...line];
  return chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : line;
};

const HINT_KEY = 'iyakusai-dayof-panel';
type PanelHint = { today: string; height: number };

function readHint(): PanelHint | null {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(HINT_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    const { today, height } = raw as Record<string, unknown>;
    if (typeof today !== 'string' || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return null;
    return today === jstDate(new Date()) ? { today, height: Math.min(Math.round(height), 4000) } : null;
  } catch {
    return null;
  }
}

function writeHint(hint: PanelHint | null): void {
  try {
    if (hint) sessionStorage.setItem(HINT_KEY, JSON.stringify(hint));
    else sessionStorage.removeItem(HINT_KEY);
  } catch {
    // Storage blocked: the panel only appears without a frame held for it.
  }
}

export function DayOfPanel({ refresh, tasks }: { refresh: number; tasks: TaskContextResponse | null }) {
  const board = useDayOfBoard(refresh);
  const [hint] = useState(readHint);
  const off = board.hidden || board.data?.active === false;
  useEffect(() => {
    if (off) writeHint(null);
  }, [off]);
  if (board.hidden) return null;
  if (!board.data) {
    // The first read: a frame where the panel stood when this tab knows today is a festival day, nothing otherwise
    // (most days are not festival days); a failure says so.
    if (!board.error) {
      if (!hint) return null;
      return (
        <section className="panel dayof dayof-pending" aria-label="当日" aria-busy="true" data-testid="dayof-pending" style={{ minHeight: hint.height }}>
          <p className="hint">当日の欄を読み込んでいます…</p>
        </section>
      );
    }
    return (
      <section className="panel dayof" aria-label="当日" data-testid="dayof-panel">
        <p className="status error" role="alert">
          当日の欄を読み込めませんでした: {board.error.message}
          <button type="button" onClick={board.reload}>
            再試行
          </button>
        </p>
      </section>
    );
  }
  if (!board.data.active) return null;
  return <ActivePanel board={board} data={board.data} tasks={tasks} />;
}

type Notice = { text: string; undo?: () => Promise<void> } | null;

function ActivePanel({ board, data, tasks }: { board: DayOfBoardState; data: DayOfBoardResponse; tasks: TaskContextResponse | null }) {
  const [writing, setWriting] = useState(false);
  // The notice being corrected, as it was when 直す was pressed (the form saves against that version).
  const [editing, setEditing] = useState<DayOfPostView | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The decision just recorded, with a way to its page in the register (kept until another is recorded).
  const [decided, setDecided] = useState<string | null>(null);

  const open = data.posts.filter((p) => p.status === 'open');
  const resolved = data.posts.filter((p) => p.status === 'resolved');
  const urgentOpen = open.filter((p) => p.priority === 'urgent');
  const newUrgent = board.newUrgent.filter((id) => urgentOpen.some((p) => p.id === id));
  // A notice resolved or withdrawn by someone else while it is being corrected keeps its place in the list (from the
  // copy taken when the correction began), so the form and what was typed in it stay on screen.
  const editingLatest = editing ? findDayOfPost(data, editing.id) : null;
  const listed = editing && !open.some((p) => p.id === editing.id) ? sortDayOfPosts([...open, { ...editing, status: 'open' as const }]) : open;

  // The height of the panel at rest, for the frame that holds its place the next time the home screen opens today.
  const panelRef = useRef<HTMLElement>(null);
  const atRest = !writing && !editing && !deciding && !notice && !failure && !decided && newUrgent.length === 0;
  useEffect(() => {
    const height = panelRef.current?.offsetHeight ?? 0;
    if (atRest && height > 0) writeHint({ today: data.today, height });
  });

  const taskDepartments = departmentsOf(tasks).map((d) => ({ key: d.key, label: d.label }));
  const decisionChoices: DepartmentChoice[] = [...taskDepartments, ...data.decisionDepartments.filter((k) => !taskDepartments.some((d) => d.key === k)).map((key) => ({ key, label: key }))];
  const labelOf = (key: string) => decisionChoices.find((d) => d.key === key)?.label ?? key;

  async function change(post: DayOfPostView, kind: 'resolve' | 'reopen' | 'withdraw' | 'restore') {
    setBusy(post.id);
    setFailure(null);
    try {
      const saved = await dayofApi.change(post.id, kind, post.version);
      board.noteOwn(saved.post);
      const short = post.body.length > 20 ? `${post.body.slice(0, 20)}…` : post.body;
      const undoKind = kind === 'resolve' ? 'reopen' : kind === 'withdraw' ? 'restore' : null;
      const words = { resolve: '済にしました', reopen: '未解決に戻しました', withdraw: '取り下げました', restore: '戻しました' }[kind];
      setNotice({
        text: `「${short}」を${words}。`,
        ...(undoKind
          ? {
              undo: async () => {
                const back = await dayofApi.change(saved.post.id, undoKind, saved.post.version);
                board.noteOwn(back.post);
                setNotice({ text: `「${short}」を元に戻しました。` });
              },
            }
          : {}),
      });
    } catch (err) {
      setFailure(toFailure(err).message);
      board.reload();
    } finally {
      setBusy(null);
    }
  }

  async function undo() {
    if (!notice?.undo) return;
    try {
      await notice.undo();
    } catch (err) {
      setFailure(toFailure(err).message);
      board.reload();
    }
  }

  const scrollToUrgent = () => {
    const el = document.getElementById('dayof-board');
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  };

  const dayText = data.day ? (data.day.total > 1 ? `${data.day.index}日目／${data.day.total}日間` : '') : '';

  return (
    <section className="panel dayof" aria-labelledby="dayof-title" data-testid="dayof-panel" ref={panelRef}>
      <div className="panel-head dayof-head">
        <h2 id="dayof-title">
          当日 <span className="dayof-date">{dateLabel(data.today).replace(/^\d+年/, '')}</span>
          {dayText && <span className="dayof-day">{dayText}</span>}
        </h2>
        <span className="hint dayof-updated" aria-live="off">
          {board.readAt ? `${timeOf(new Date(board.readAt).toISOString())} 更新・30 秒ごとに自動で更新` : ''}
        </span>
      </div>
      {board.error && (
        <p className="status error" role="alert">
          新しい内容を読み込めませんでした（{board.readAt ? timeOf(new Date(board.readAt).toISOString()) : '前回'} の内容を表示しています）。
          <button type="button" onClick={board.reload}>
            再試行
          </button>
        </p>
      )}
      {newUrgent.length > 0 && (
        <div className="dayof-alert" role="alert" data-testid="dayof-new-urgent">
          <strong>新しい至急の連絡が {newUrgent.length} 件あります</strong>
          <span className="dayof-alert-actions">
            <button type="button" onClick={scrollToUrgent}>
              見る
            </button>
            <button type="button" className="secondary" onClick={board.acknowledge}>
              確認した
            </button>
          </span>
        </div>
      )}
      {data.rules && (
        <details className="dayof-rules" open data-testid="dayof-rules">
          <summary>決め方（誰が何を決めるか）</summary>
          <p>{data.rules}</p>
        </details>
      )}

      <section className="dayof-section" id="dayof-board" tabIndex={-1} aria-labelledby="dayof-board-title">
        <div className="dayof-section-head">
          <h3 id="dayof-board-title">本部からの連絡{open.length > 0 ? `（${open.length} 件）` : ''}</h3>
          {data.canPost && !writing && (
            <button type="button" onClick={() => setWriting(true)} data-testid="dayof-write">
              連絡を書く
            </button>
          )}
        </div>
        {writing && (
          <PostForm
            departments={data.departmentChoices}
            onCancel={() => setWriting(false)}
            onSaved={(post, message) => {
              setWriting(false);
              board.noteOwn(post);
              setNotice({ text: message });
            }}
          />
        )}
        {notice && (
          <p className="status ok" role="status">
            {notice.text}
            {notice.undo && (
              <button type="button" className="secondary small" onClick={() => void undo()}>
                元に戻す
              </button>
            )}
          </p>
        )}
        {failure && (
          <p className="status error" role="alert">
            {failure}
          </p>
        )}
        {listed.length === 0 ? (
          <p className="empty">いま流れている連絡はありません。</p>
        ) : (
          <ul className="dayof-posts" data-testid="dayof-posts">
            {listed.map((post) =>
              editing?.id === post.id ? (
                <li key={post.id} className="dayof-post">
                  <PostForm
                    departments={data.departmentChoices}
                    editing={editing}
                    latest={editingLatest}
                    onStale={board.reload}
                    onCancel={() => setEditing(null)}
                    onSaved={(saved, message) => {
                      setEditing(null);
                      board.noteOwn(saved);
                      setNotice({ text: message });
                    }}
                  />
                </li>
              ) : (
                <PostRow key={post.id} post={post} today={data.today} fresh={newUrgent.includes(post.id)} canPost={data.canPost} busy={busy === post.id} onChange={change} onEdit={() => setEditing(post)} />
              ),
            )}
          </ul>
        )}
        {resolved.length > 0 && (
          <details className="dayof-closed">
            <summary>今日済んだ連絡（{resolved.length} 件）</summary>
            <ul className="dayof-posts">
              {resolved.map((post) => (
                <PostRow key={post.id} post={post} today={data.today} fresh={false} canPost={data.canPost} busy={busy === post.id} onChange={change} onEdit={() => undefined} />
              ))}
            </ul>
          </details>
        )}
        {data.canPost && data.withdrawn.length > 0 && (
          <details className="dayof-closed">
            <summary>今日取り下げた連絡（{data.withdrawn.length} 件）</summary>
            <ul className="dayof-posts">
              {data.withdrawn.map((post) => (
                <PostRow key={post.id} post={post} today={data.today} fresh={false} canPost={data.canPost} busy={busy === post.id} onChange={change} onEdit={() => undefined} />
              ))}
            </ul>
          </details>
        )}
      </section>

      {data.decisions && (
        <section className="dayof-section" aria-labelledby="dayof-decisions-title" data-testid="dayof-decisions">
          <div className="dayof-section-head">
            <h3 id="dayof-decisions-title">今日決めたこと</h3>
            {data.canDecide && !deciding && (
              <button type="button" className="secondary" onClick={() => setDeciding(true)} data-testid="dayof-decide">
                決めたことを記録
              </button>
            )}
          </div>
          {deciding && (
            <DecisionQuickForm
              departments={decisionChoices}
              onCancel={() => setDeciding(false)}
              onSaved={(id) => {
                setDeciding(false);
                setNotice(null);
                board.reload();
                setDecided(id);
              }}
            />
          )}
          {decided && (
            <p className="status ok" role="status">
              決定事項の台帳に記録しました。
              <a href={decisionHref(decided)}>台帳で開く</a>
            </p>
          )}
          {data.decisions.length === 0 ? (
            <p className="empty">今日の決定はまだありません。</p>
          ) : (
            <ul className="rows dayof-decisions">
              {data.decisions.map((d) => (
                <li key={d.id}>
                  <span className="row-line">
                    <a href={decisionHref(d.id)} className="row-main">
                      {d.title}
                    </a>
                    {d.status !== 'active' && <span className={`decision-status decision-status-${d.status}`}>{DECISION_STATUS_LABELS[d.status]}</span>}
                  </span>
                  {d.changeNote && <span className="dayof-change">変更：{d.changeNote}</span>}
                  {d.body && <span className="dayof-decision-body">{firstLine(d.body)}</span>}
                  <span className="row-sub">
                    {timeOf(d.createdAt)}・{d.venueLabel}
                    {d.departments.length > 0 && `・${d.departments.map(labelOf).join('・')}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {data.events && (
        <section className="dayof-section" aria-labelledby="dayof-events-title" data-testid="dayof-events">
          <div className="dayof-section-head">
            <h3 id="dayof-events-title">今日の予定</h3>
            <a className="button secondary small" href={`#/tasks?cal=${data.today}`}>
              カレンダーで見る
            </a>
          </div>
          {data.events.length === 0 ? (
            <p className="empty">今日の予定はありません。</p>
          ) : (
            <ul className="rows dayof-events">
              {data.events.map((e) => (
                <li key={e.id}>
                  <span className="row-line">
                    <span className="dayof-time">{e.time ?? '終日'}</span>
                    <span className="row-main">{e.title}</span>
                  </span>
                  <span className="row-sub">
                    {e.kindLabel}
                    {e.departments.length > 0 ? `・${e.departments.join('・')}` : '・委員会全体'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {data.supplies && (
        <section className="dayof-section" aria-labelledby="dayof-supplies-title" data-testid="dayof-supplies">
          <h3 id="dayof-supplies-title">物品の状況</h3>
          <p className="dayof-supplies">
            貸出中 <strong>{data.supplies.cardsOut}</strong> 件（カードの物品）・<strong>{data.supplies.unitsOut}</strong> 個（数の物品）／回収が済んでいない団体{' '}
            <strong className={data.supplies.groupsOpen > 0 ? 'dayof-count-info' : ''}>{data.supplies.groupsOpen}</strong> 団体
          </p>
          <p className="dayof-links">
            <a href="/rental">物品貸出を開く</a>
            <a href="/rental/supplies">団体の回収表を開く</a>
          </p>
        </section>
      )}
    </section>
  );
}

function PostRow({
  post,
  today,
  fresh,
  canPost,
  busy,
  onChange,
  onEdit,
}: {
  post: DayOfPostView;
  today: string;
  fresh: boolean;
  canPost: boolean;
  busy: boolean;
  onChange: (post: DayOfPostView, kind: 'resolve' | 'reopen' | 'withdraw' | 'restore') => void;
  onEdit: () => void;
}) {
  const meta = [stampOf(post.createdAt, today), post.authorName, post.place, ...post.departments].filter(Boolean).join('・');
  return (
    <li className={`dayof-post dayof-post-${post.priority} dayof-post-${post.status} ${fresh ? 'dayof-fresh' : ''}`} data-testid="dayof-post">
      <div className="dayof-post-line">
        {post.status === 'open' && post.priority !== 'normal' && <span className={`dayof-tag dayof-tag-${post.priority}`}>{DAYOF_PRIORITY_LABELS[post.priority]}</span>}
        {post.status === 'resolved' && <span className="dayof-tag dayof-tag-resolved">済</span>}
        {fresh && <span className="dayof-tag dayof-tag-new">新着</span>}
        <span className="row-sub">
          {meta}
          {post.edited && '・直しあり'}
          {post.staffVisible && '・臨時スタッフにも表示'}
        </span>
      </div>
      <p className="dayof-body">{post.body}</p>
      {post.status === 'resolved' && post.resolvedAt && (
        <span className="row-sub">
          {stampOf(post.resolvedAt, today)} に{post.resolvedByName ?? ''}が済にしました
        </span>
      )}
      {canPost && (
        <div className="dayof-post-actions">
          {post.status === 'open' && (
            <button type="button" className="secondary small" disabled={busy} onClick={() => onChange(post, 'resolve')}>
              済にする
            </button>
          )}
          {post.status === 'resolved' && (
            <button type="button" className="secondary small" disabled={busy} onClick={() => onChange(post, 'reopen')}>
              未解決に戻す
            </button>
          )}
          {post.status === 'open' && post.canEdit && (
            <button type="button" className="quiet" disabled={busy} onClick={onEdit}>
              直す
            </button>
          )}
          {post.status !== 'withdrawn' && post.canEdit && (
            <button type="button" className="quiet" disabled={busy} onClick={() => onChange(post, 'withdraw')}>
              取り下げる
            </button>
          )}
          {post.status === 'withdrawn' && post.canEdit && (
            <button type="button" className="secondary small" disabled={busy} onClick={() => onChange(post, 'restore')}>
              戻す
            </button>
          )}
        </div>
      )}
    </li>
  );
}
