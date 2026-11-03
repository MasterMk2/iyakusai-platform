import { useEffect } from 'react';
import { CALENDAR_UNAVAILABLE, dateLabel, type UpcomingItem, type UpcomingResponse } from '../../../shared/calendar';
import { api } from '../../api';
import { useLoader } from '../../useLoader';

// The home screen's near deadlines: the events whose reminder days have begun, and the person's own tasks due within
// the week. One request for the whole card; a failure says so and offers a retry (it is never shown as 0 items).
// A server that could not open the calendar file answers 503 (calendar_unavailable), and an older one has no route:
// the card is then left out, since the rest of the home screen is what the person came for. `onItems` hands the items to
// the home screen's attention line once they are known (null: none to count, after a failure or with the card left out).

const loadUpcoming = (signal: AbortSignal) => api<UpcomingResponse>('GET', '/api/calendar/upcoming', undefined, signal);

export function UpcomingCard({ onItems }: { onItems?: (items: UpcomingItem[] | null) => void } = {}) {
  const upcoming = useLoader(loadUpcoming);
  const data = upcoming.data;
  const failure = upcoming.error;
  useEffect(() => {
    if (data) onItems?.(data.items);
    else if (failure) onItems?.(null);
  }, [data, failure, onItems]);
  if (failure && (failure.status === 404 || failure.body?.error === CALENDAR_UNAVAILABLE)) return null;
  return (
    <section className="panel upcoming-card" aria-labelledby="upcoming-title" id="home-upcoming" tabIndex={-1} data-testid="home-upcoming">
      <div className="upcoming-head">
        <h2 id="upcoming-title">近づいている予定と期限</h2>
        <span className="hint">予定は前もって知らせる日から、タスクは 7 日以内の期限</span>
      </div>
      {upcoming.loading && !data && <p className="hint">確認しています…</p>}
      {upcoming.error && (
        <p className="status error" role="alert">
          予定と期限を取得できませんでした。
          <button type="button" className="quiet" onClick={upcoming.retry}>
            再読み込み
          </button>
        </p>
      )}
      {data && data.items.length === 0 && <p className="status ok">近づいている予定と期限はありません。</p>}
      {data && data.items.length > 0 && (
        <ul className="upcoming-list">
          {data.items.map((i) => (
            <li key={`${i.kind}-${i.id}-${i.date}`}>
              <a className={`upcoming-item ${i.daysLeft <= 1 ? 'tone-warn' : ''}`} href={i.kind === 'task' ? `#/tasks?task=${encodeURIComponent(i.id)}` : `#/tasks?cal=${i.date}`}>
                <span className="upcoming-when">{i.daysLeft === 0 ? '今日' : `あと ${i.daysLeft} 日`}</span>
                <span className="upcoming-title">{i.title}</span>
                <span className="upcoming-label">{i.label}</span>
                <span className="upcoming-date">{dateLabel(i.date)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {data?.tasks === 'unbound' && <p className="hint">このアカウントはタスクと結び付いていないため、タスクの期限は出ていません。</p>}
      {data?.tasks === 'unavailable' && (
        <p className="hint">
          タスクの期限を取得できませんでした（予定は出しています）。
          <button type="button" className="quiet" onClick={upcoming.retry}>
            再読み込み
          </button>
        </p>
      )}
    </section>
  );
}
