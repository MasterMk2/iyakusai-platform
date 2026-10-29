import type { TaskContextResponse } from '../../../shared/tasks';
import { TASK_DEADLINE_LABELS, type TaskDeadlineBucket, type TaskSummaryResponse } from '../../../shared/task-summary';
import { formatDateOnly } from '../../../task-service/shared/dates';
import { fmtDate } from '../../api';
import type { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';

const tasksHref = (workspaceId: string, extra: string) => `#/tasks?ws=${encodeURIComponent(workspaceId)}&${extra}`;

/**
 * Remaining tasks on the home screen, from the one summary request (counts only: the Task service is
 * never asked once per department). A department opens its list of open tasks; its overdue and
 * due-today counts open that list already filtered.
 */
export function TaskSummaryCard({ context, loader, onOpenTasks }: { context: TaskContextResponse; loader: ReturnType<typeof useLoader<TaskSummaryResponse | null>>; onOpenTasks: () => void }) {
  const s = context.bound ? loader.data : null;
  return (
    <section className="panel home-task-summary" aria-labelledby="home-tasks-title" id="home-tasks" tabIndex={-1} data-testid="home-tasks">
      <div className="panel-head">
        <h2 id="home-tasks-title">タスクの残数</h2>
        <button type="button" className="secondary" onClick={onOpenTasks}>
          タスク一覧を開く
        </button>
      </div>
      {!context.bound ? (
        <p className="hint">このアカウントはタスク機能の利用者として登録されていません。</p>
      ) : (
        <>
          <LoadStatus loader={loader} what="タスクの残数" compact />
          {s && (
            <>
              <div className="task-total">
                <span>未完了</span>
                <strong data-testid="task-remaining-total">
                  {s.total}
                  <small>件</small>
                </strong>
                <span className="hint">{formatDateOnly(s.today)} 時点（未着手・進行中・保留）</span>
              </div>
              {(loader.loading || loader.error || loader.cancelled) && <p className="hint">前回取得した件数を表示しています。取得時刻：{fmtDate(s.generatedAt)}</p>}
              <dl className="deadline-strip" aria-label="期限別">
                {(Object.entries(TASK_DEADLINE_LABELS) as [TaskDeadlineBucket, string][]).map(([key, label]) => (
                  <div key={key} className={s.deadlines[key] > 0 ? (key === 'overdue' ? 'tone-overdue' : key === 'today' ? 'tone-today' : '') : 'is-zero'}>
                    <dt>{label}</dt>
                    <dd data-testid={'task-deadline-' + key}>
                      {s.deadlines[key]}
                      <small>件</small>
                    </dd>
                  </div>
                ))}
              </dl>
              <table className="task-department-counts">
                <caption className="sr-only">{context.tagging ? '部署別の残数' : '委員会別の残数'}</caption>
                <thead>
                  <tr>
                    <th scope="col">{context.tagging ? '部局' : '委員会'}</th>
                    <th scope="col">残数</th>
                    <th scope="col">期限超過</th>
                    <th scope="col">今日まで</th>
                  </tr>
                </thead>
                <tbody>
                  {s.departments.map((d) => (
                    <tr key={d.workspaceId} className={d.parentId ? 'department-child' : 'department-parent'}>
                      <th scope="row">
                        <a href={tasksHref(d.workspaceId, 'remaining=1')}>{d.name}</a>
                      </th>
                      <td data-testid={'remaining-' + d.workspaceId}>{d.remaining}</td>
                      <td className={d.overdue > 0 ? 'count-overdue' : 'is-zero'}>
                        {d.overdue > 0 ? <a href={tasksHref(d.workspaceId, 'focus=overdue')} aria-label={`${d.name}の期限超過 ${d.overdue} 件を開く`}>{d.overdue}</a> : d.overdue}
                      </td>
                      <td className={d.today > 0 ? 'count-today' : 'is-zero'}>
                        {d.today > 0 ? <a href={tasksHref(d.workspaceId, 'focus=today')} aria-label={`${d.name}の今日までの ${d.today} 件を開く`}>{d.today}</a> : d.today}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {context.tagging && <p className="hint">部の残数には所属する課も含みます。複数の部局に付いたタスクは各部局に計上し、未完了の合計では1件として数えます。</p>}
              <details className="task-by-date">
                <summary>日付ごとの残数</summary>
                {s.byDate.length === 0 ? (
                  <p className="empty">期限が設定された未完了タスクはありません。</p>
                ) : (
                  <dl>
                    {s.byDate.map((d) => (
                      <div key={d.deadline} className={d.deadline < s.today ? 'count-overdue' : d.deadline === s.today ? 'count-today' : ''}>
                        <dt>
                          {formatDateOnly(d.deadline)}
                          {d.deadline < s.today ? '・期限超過' : d.deadline === s.today ? '・今日' : ''}
                        </dt>
                        <dd>{d.remaining}件</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <p className="hint">期限なし：{s.deadlines.none}件</p>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
