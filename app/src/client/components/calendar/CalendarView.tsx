import { useCallback, useMemo, useRef, useState } from 'react';
import {
  addDays,
  CALENDAR_KIND_LABELS,
  dateLabel,
  isDateOnly,
  jstDate,
  weekStart,
  type CalendarEventView,
  type CalendarListResponse,
  type CalendarYearlyResponse,
} from '../../../shared/calendar';
import { isAssignedTo, TASK_STATUS_LABELS, type TaskView } from '../../../shared/tasks';
import { needsDateCheck } from '../../../shared/rollover';
import { api } from '../../api';
import { useLoader } from '../../useLoader';
import { EventForm } from './EventForm';
import { SubscribePanel } from './SubscribePanel';
import './calendar.css';

// The calendar inside the tasks tab (one of its views, so no tab is added). A month table on a PC, a week of days
// as a vertical list on a phone (CSS picks one). Events come from the calendar API; the task deadlines are the
// tasks the tasks tab already loaded, so the screen makes no extra request for them.

const WEEK_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
const CHIPS_PER_DAY = 3;

type Editing = { kind: 'new'; date: string; yearly: boolean } | { kind: 'edit'; event: CalendarEventView } | null;

interface Item {
  key: string;
  /** The text a chip or a row shows, with its kind written out (never by colour alone). */
  label: string;
  title: string;
  time: string | null;
  done: boolean;
  onOpen: () => void;
}

interface Props {
  /** The tasks the calendar shows (the departments chosen in the tasks tab already applied). */
  tasks: TaskView[];
  tasksLoading: boolean;
  /** Why task deadlines are not shown, or what narrows them, when there is something to say. */
  taskNote: string | null;
  /** The signed-in person's ID in the Task service (what a task's assignee holds). */
  userId: string | null;
  onOpenTask: (taskId: string) => void;
  /** The day to open on (from a deadline on the home screen), "YYYY-MM-DD"; today when absent or not a date. */
  initialDate?: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const monthOf = (date: string) => date.slice(0, 7);

/** The date `months` months from `date`, on the same day of the month or the last day of a shorter month. */
function shiftMonth(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}-${pad(Math.min(d, last))}`;
}

/** Every day the month table shows: whole weeks from the Sunday on or before the 1st to the Saturday on or after the last. */
function monthDays(anchor: string): string[] {
  const first = `${monthOf(anchor)}-01`;
  const lastDay = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0)).getUTCDate();
  const last = `${monthOf(anchor)}-${pad(lastDay)}`;
  const start = weekStart(first);
  const end = addDays(weekStart(last), 6);
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

/** The days the events request covers: the month table and the week of the anchor (the phone list). */
function visibleRange(anchor: string): { from: string; to: string } {
  const days = monthDays(anchor);
  const week = weekStart(anchor);
  return { from: days[0]! < week ? days[0]! : week, to: days[days.length - 1]! > addDays(week, 6) ? days[days.length - 1]! : addDays(week, 6) };
}

export function CalendarView({ tasks, tasksLoading, taskNote, userId, onOpenTask, initialDate = null }: Props) {
  const today = jstDate(new Date());
  // The day it opens on: the link's day when it is a date (read once, when the calendar opens), else today.
  const opening = initialDate && isDateOnly(initialDate) ? initialDate : null;
  const [anchor, setAnchor] = useState(opening ?? today);
  const [mode, setMode] = useState<'month' | 'yearly'>('month');
  const [dept, setDept] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [hideDone, setHideDone] = useState(false);
  const [selected, setSelected] = useState<string | null>(opening);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const dayPanel = useRef<HTMLElement>(null);

  const range = useMemo(() => visibleRange(anchor), [anchor]);
  const loadEvents = useCallback((signal: AbortSignal) => api<CalendarListResponse>('GET', `/api/calendar/events?from=${range.from}&to=${range.to}`, undefined, signal), [range.from, range.to]);
  const events = useLoader(loadEvents);
  const loadYearly = useCallback((signal: AbortSignal) => api<CalendarYearlyResponse>('GET', `/api/calendar/yearly?year=${year}`, undefined, signal), [year]);
  const yearly = useLoader(loadYearly);

  const myDepartments = events.data?.myDepartments ?? [];
  const eventVisible = (e: CalendarEventView) => {
    if (dept && !(e.departments.length === 0 || e.departments.includes(dept))) return false;
    if (mineOnly && !(e.departments.length === 0 || e.departments.some((d) => myDepartments.includes(d)))) return false;
    return true;
  };
  const taskVisible = (t: TaskView) => {
    if (hideDone && t.status === 'done') return false;
    if (dept && !(t.tagLabels ?? []).includes(dept)) return false;
    if (mineOnly && !(userId !== null && isAssignedTo(t, userId))) return false;
    return true;
  };

  const eventItem = (e: CalendarEventView): Item => ({
    key: `e-${e.id}-${e.date}`,
    label: `${CALENDAR_KIND_LABELS[e.kind]}${e.occurrence ? '（毎年）' : ''}${needsDateCheck(e) ? '・日付を確かめる' : ''}`,
    title: e.title,
    time: e.time,
    done: false,
    // An occurrence on another year's day opens with the day the event holds, so saving it cannot move that day.
    onOpen: () => setEditing({ kind: 'edit', event: e.occurrence ? { ...e, date: e.baseDate } : e }),
  });
  const taskItem = (t: TaskView): Item => ({
    key: `t-${t.id}`,
    label: `タスク・${TASK_STATUS_LABELS[t.status]}`,
    title: t.title,
    time: null,
    done: t.status === 'done',
    onOpen: () => onOpenTask(t.id),
  });
  const itemsOn = (date: string): Item[] => {
    const evs = (events.data?.events ?? []).filter((e) => e.date === date && eventVisible(e)).sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title, 'ja'));
    const tks = tasks.filter((t) => t.deadline?.slice(0, 10) === date && taskVisible(t));
    return [...evs.map(eventItem), ...tks.map(taskItem)];
  };

  const step = (dir: -1 | 1) => {
    // On a phone the list moves a week at a time; on a PC the table moves a month at a time.
    const narrow = window.matchMedia('(max-width: 679px)').matches;
    setAnchor((a) => (narrow ? addDays(a, 7 * dir) : shiftMonth(a, dir)));
  };

  const dayLabel = selected ?? anchor;
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i));
  const days = monthDays(anchor);
  const deptChoices = events.data?.departments ?? [];
  const yearChoices = [year - 1, year, year + 1, year + 2, year + 3];
  const reload = () => {
    events.retry();
    yearly.retry();
  };
  // A day chosen from the "ほか N 件" count: its list opens at the bottom of the table, where the screen shows it.
  const openDay = (d: string) => {
    setSelected(d);
    dayPanel.current?.scrollIntoView({ block: 'start' });
  };
  // The yearly list follows the same department choice as the table (events with no department are for everyone).
  const yearlyItems = (yearly.data?.items ?? []).filter(({ event }) => !dept || event.departments.length === 0 || event.departments.includes(dept));
  const saved = (verb: string) => {
    setEditing(null);
    setNotice(`${verb}しました。`);
    reload();
  };

  const [ay, am] = anchor.split('-');

  return (
    <div className="cal" data-testid="calendar-view">
      <div className="cal-toolbar">
        <h2 className="cal-title">
          {Number(ay)}年{Number(am)}月
          <span className="cal-title-week">
            （{dateLabel(weekDays[0]!).slice(0, -3)}〜{dateLabel(weekDays[6]!).slice(5, -3)}）
          </span>
        </h2>
        <div className="cal-nav" role="group" aria-label="期間の移動">
          <button type="button" className="secondary" onClick={() => step(-1)}>
            前へ
          </button>
          <button type="button" className="secondary" onClick={() => setAnchor(today)}>
            今日
          </button>
          <button type="button" className="secondary" onClick={() => step(1)}>
            次へ
          </button>
        </div>
        <div className="cal-modes" role="group" aria-label="表示の種類">
          <button type="button" aria-pressed={mode === 'month'} onClick={() => setMode('month')}>
            月の表
          </button>
          <button type="button" aria-pressed={mode === 'yearly'} onClick={() => setMode('yearly')}>
            毎年の予定
          </button>
        </div>
        <button type="button" onClick={() => setEditing({ kind: 'new', date: dayLabel, yearly: mode === 'yearly' })}>
          予定を追加
        </button>
      </div>

      <div className="cal-filters" role="group" aria-label="絞り込み">
        <label>
          部局
          <select value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">すべての部局</option>
            {deptChoices.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        {mode === 'month' && (
          <>
            <label className="cal-check">
              <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> 自分に関係するもの
            </label>
            <label className="cal-check">
              <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> 完了したタスクを隠す
            </label>
          </>
        )}
      </div>

      {notice && (
        <p className="status ok" role="status">
          {notice}
        </p>
      )}
      {editing && (
        <EventForm
          key={editing.kind === 'edit' ? `${editing.event.id}-${editing.event.version}` : `new-${editing.date}-${editing.yearly}`}
          initial={editing.kind === 'edit' ? editing.event : null}
          date={editing.kind === 'new' ? editing.date : dayLabel}
          yearly={editing.kind === 'new' ? editing.yearly : false}
          departments={deptChoices}
          onSaved={() => saved('保存')}
          onDeleted={() => saved('削除')}
          onReload={reload}
          onClose={() => setEditing(null)}
        />
      )}

      {mode === 'month' ? (
        <>
          {events.loading && !events.data && <p className="hint">予定を読み込んでいます…</p>}
          {events.error && (
            <p className="status error" role="alert">
              予定を取得できませんでした。{events.error.message}
              <button type="button" className="quiet" onClick={events.retry}>
                再読み込み
              </button>
            </p>
          )}
          {(taskNote || tasksLoading) && <p className="hint">{tasksLoading ? 'タスクの期限を読み込んでいます…' : taskNote}</p>}

          <table className="cal-month" aria-label={`${Number(ay)}年${Number(am)}月の予定`}>
            <thead>
              <tr>
                {WEEK_NAMES.map((w) => (
                  <th key={w} scope="col">
                    {w}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: days.length / 7 }, (_, row) => (
                <tr key={row}>
                  {days.slice(row * 7, row * 7 + 7).map((d) => {
                    const items = itemsOn(d);
                    const cls = ['cal-cell', monthOf(d) !== monthOf(anchor) ? 'is-out' : '', d === today ? 'is-today' : '', d === selected ? 'is-selected' : ''].filter(Boolean).join(' ');
                    return (
                      <td key={d} className={cls} aria-current={d === today ? 'date' : undefined}>
                        <button type="button" className="cal-day" aria-pressed={d === selected} aria-label={`${dateLabel(d)}、${items.length} 件`} onClick={() => setSelected(d)}>
                          {Number(d.slice(8))}
                        </button>
                        <ul className="cal-chips">
                          {items.slice(0, CHIPS_PER_DAY).map((it) => (
                            <li key={it.key}>
                              <button type="button" className={`cal-chip ${it.done ? 'cal-done' : ''}`} onClick={it.onOpen}>
                                <span className="cal-chip-label">{it.label}</span> {it.title}
                              </button>
                            </li>
                          ))}
                          {items.length > CHIPS_PER_DAY && (
                            <li>
                              <button type="button" className="cal-more" onClick={() => openDay(d)}>
                                ほか {items.length - CHIPS_PER_DAY} 件を見る
                              </button>
                            </li>
                          )}
                        </ul>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="cal-week-list" aria-label="この週の予定">
            {weekDays.map((d) => {
              const items = itemsOn(d);
              return (
                <section key={d} className={`cal-week-day ${d === today ? 'is-today' : ''}`} aria-label={dateLabel(d)}>
                  <h3>{dateLabel(d)}</h3>
                  {items.length === 0 ? <p className="hint">予定はありません。</p> : <ItemList items={items} />}
                  <button type="button" className="quiet" onClick={() => setEditing({ kind: 'new', date: d, yearly: false })}>
                    この日に予定を追加
                  </button>
                </section>
              );
            })}
          </div>

          <section ref={dayPanel} className="cal-day-panel panel" aria-label={`${dateLabel(dayLabel)} の予定`}>
            <h3>{dateLabel(dayLabel)}</h3>
            {(() => {
              const items = itemsOn(dayLabel);
              return items.length === 0 ? <p className="hint">この日の予定とタスクの期限はありません。</p> : <ItemList items={items} />;
            })()}
            <button type="button" className="secondary" onClick={() => setEditing({ kind: 'new', date: dayLabel, yearly: false })}>
              この日に予定を追加
            </button>
          </section>

          <SubscribePanel />
        </>
      ) : (
        <section className="cal-yearly panel" aria-labelledby="cal-yearly-title">
          <div className="cal-yearly-head">
            <h3 id="cal-yearly-title">毎年の予定</h3>
            <label>
              年
              <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
                {yearChoices.map((y) => (
                  <option key={y} value={y}>
                    {y}年
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="hint">毎年の予定を、選んだ年の日付で並べています。次の年度へ写すときの元になります。</p>
          {yearly.loading && !yearly.data && <p className="hint">読み込んでいます…</p>}
          {yearly.error && (
            <p className="status error" role="alert">
              毎年の予定を取得できませんでした。
              <button type="button" className="quiet" onClick={yearly.retry}>
                再読み込み
              </button>
            </p>
          )}
          {yearly.data && yearly.data.items.length === 0 && <p className="hint">毎年の予定はまだありません。</p>}
          {yearly.data && yearly.data.items.length > 0 && yearlyItems.length === 0 && <p className="hint">この部局の毎年の予定はありません。</p>}
          {yearlyItems.length > 0 && (
            <ul className="cal-yearly-list">
              {yearlyItems.map(({ event, occurrence }) => (
                <li key={event.id}>
                  <button type="button" className="cal-item" onClick={() => setEditing({ kind: 'edit', event })}>
                    <span className="cal-item-date">{dateLabel(occurrence)}</span>
                    <span className="cal-item-label">{CALENDAR_KIND_LABELS[event.kind]}</span>
                    <span className="cal-item-title">{event.title}</span>
                    {event.departments.length > 0 && <span className="cal-item-sub">{event.departments.join('・')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setEditing({ kind: 'new', date: `${year}-01-01`, yearly: true })}>
            毎年の予定を追加
          </button>
        </section>
      )}
    </div>
  );
}

function ItemList({ items }: { items: Item[] }) {
  return (
    <ul className="cal-items">
      {items.map((it) => (
        <li key={it.key}>
          <button type="button" className={`cal-item ${it.done ? 'cal-done' : ''}`} onClick={it.onOpen}>
            <span className="cal-item-time">{it.time ?? '終日'}</span>
            <span className="cal-item-label">{it.label}</span>
            <span className="cal-item-title">{it.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
