import type { useLoader } from '../../useLoader';
import type { BotLoaded } from '../HomeView';
import { LoadStatus } from '../LoadStatus';

/**
 * Home card of the Bot: task candidates waiting for approval and my reminders that are overdue or due
 * today (one request, made by the home screen). Hidden when the feature is off or the person has no Bot
 * identity. A failure shows its error with retry; it is never shown as a zero (../docs/ui-guidelines.md §3).
 */
export function BotSummaryCard({ loader, onOpenBot }: { loader: ReturnType<typeof useLoader<BotLoaded>>; onOpenBot: (section?: 'candidates' | 'remind') => void }) {
  if (loader.data?.hidden) return null;
  const summary = loader.data && !loader.data.hidden ? loader.data.summary : null;
  return (
    <section className="panel home-bot" aria-labelledby="home-bot-title" data-testid="home-bot">
      <div className="panel-head">
        <h2 id="home-bot-title">Bot</h2>
        <button type="button" className="secondary" onClick={() => onOpenBot()}>
          Bot を開く
        </button>
      </div>
      <LoadStatus loader={loader} what="Bot の状況" compact />
      {summary && (
        <ul className="rows bot-counts">
          <li className={summary.pendingCandidates > 0 ? 'tone-today' : ''}>
            <button type="button" className="row-button" onClick={() => onOpenBot('candidates')}>
              <span className="row-line">
                <span className="row-main">承認待ちのタスク候補</span>
                <strong data-testid="bot-pending">
                  {summary.pendingCandidates}
                  <small>件</small>
                </strong>
              </span>
            </button>
          </li>
          <li className={summary.reminders.overdue > 0 ? 'tone-overdue' : ''}>
            <button type="button" className="row-button" onClick={() => onOpenBot('remind')}>
              <span className="row-line">
                <span className="row-main">期限超過のリマインド</span>
                <strong data-testid="bot-overdue">
                  {summary.reminders.overdue}
                  <small>件</small>
                </strong>
              </span>
            </button>
          </li>
          <li className={summary.reminders.today > 0 ? 'tone-today' : ''}>
            <button type="button" className="row-button" onClick={() => onOpenBot('remind')}>
              <span className="row-line">
                <span className="row-main">今日までのリマインド</span>
                <strong data-testid="bot-today">
                  {summary.reminders.today}
                  <small>件</small>
                </strong>
              </span>
            </button>
          </li>
        </ul>
      )}
    </section>
  );
}
