import { addDays, jstDate } from '../../../shared/calendar';
import { AVAILABILITY_STATE_LABELS, describeDay, showsBusy } from '../../../shared/availability';
import { fmtDate } from '../../api';
import { useAvailability, useRemembered } from './useAvailability';
import './availability.css';

// Under an assignee field (2026-11-20): the chosen person's busy days from today to the task's deadline (two weeks
// when there is none), from their own Google calendar, when they let the signed-in person see it. Nothing shows for
// "未割当", or on a server without the feature. A person who does not share, or whose calendar could not be read, is
// said so in words: it never reads as free.

const DEFAULT_DAYS = 14;

const shortDay = (date: string) => {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  const w = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(Number(date.slice(0, 4)), m - 1, d)).getUTCDay()];
  return `${m}/${d}（${w}）`;
};

export function AvailabilityHint({ taskUserId, deadline }: { taskUserId: string | null; deadline?: string | null }) {
  const today = jstDate(new Date());
  const due = deadline && /^\d{4}-\d{2}-\d{2}/.test(deadline) ? deadline.slice(0, 10) : null;
  // To the deadline when it is ahead (at least the next three days), else two weeks.
  const to = due && due >= today ? (due < addDays(today, 2) ? addDays(today, 2) : due > addDays(today, 59) ? addDays(today, 59) : due) : addDays(today, DEFAULT_DAYS - 1);
  const [shown, setShown] = useRemembered('iyakusai.availability.assignee', true);
  const loader = useAvailability(today, to, taskUserId !== null);
  const data = loader.data;
  if (!taskUserId || !data?.enabled) return null;

  const person = data.people.find((p) => p.taskUserId === taskUserId) ?? null;
  const name = person?.displayName ?? 'この人';
  const end = to > data.coveredTo ? data.coveredTo : to;

  if (!shown) {
    return (
      <p className="avail-hint is-hidden">
        <button type="button" className="quiet" onClick={() => setShown(true)}>
          空き具合を表示
        </button>
      </p>
    );
  }
  return (
    <div className="avail-hint" aria-live="polite" data-testid="availability-hint">
      <div className="avail-hint-head">
        <span>
          {person ? `${name}さんの予定あり` : '空き具合'}（{shortDay(today)}〜{shortDay(end)}）
        </span>
        <button type="button" className="quiet" onClick={() => setShown(false)}>
          隠す
        </button>
      </div>
      {loader.error && !data && <p className="hint">空き具合を読み込めませんでした。</p>}
      {!person && <p className="hint">この人の空き具合は見られません（共有していないか、あなたに見せる設定になっていません）。</p>}
      {person && !showsBusy(person.state) && <p className="status warning">{AVAILABILITY_STATE_LABELS[person.state]}。予定がないという意味ではありません。</p>}
      {person && showsBusy(person.state) && (
        <>
          {person.days.length === 0 ? (
            <p className="hint">この期間に予定はありません。</p>
          ) : (
            <ul className="avail-days">
              {person.days.map((d) => (
                <li key={d.date}>
                  <span className="avail-day">{shortDay(d.date)}</span> {describeDay(d)}
                </li>
              ))}
            </ul>
          )}
          <p className="hint">
            {person.days.length > 0 && 'ほかの日は予定なし。'}
            {person.state === 'stale' ? `${AVAILABILITY_STATE_LABELS.stale}（${fmtDate(person.fetchedAt ?? '')} 時点）。` : person.fetchedAt ? `${fmtDate(person.fetchedAt)} に Google から読んだ情報です。` : ''}
            {to > data.coveredTo && ` ${shortDay(data.coveredTo)} より先は分かりません。`}
          </p>
        </>
      )}
    </div>
  );
}
