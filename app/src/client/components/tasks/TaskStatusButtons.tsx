import { useEffect, useRef } from 'react';
import { TASK_STATUSES, TASK_STATUS_LABELS, type TaskStatus, type TaskView } from '../../../shared/tasks';

/**
 * Status buttons under a task list row (2026-10-24), like the mail list's: one click saves.
 * A done task cannot be moved by an ordinary edit; only officers reopen it, back to to-do,
 * so a done row offers just "再開する" and only to them. Members confirm a completion in the row.
 */
export function TaskStatusButtons({
  task,
  canReopen,
  saving,
  disabled,
  pending = null,
  confirmingDone,
  onChoose,
  onConfirmDone,
  onCancelDone,
  onReopen,
  openChildren = 0,
}: {
  task: TaskView;
  canReopen: boolean;
  saving: boolean;
  disabled: boolean;
  /** The status being saved: its button shows pressed at once (and goes back if the save fails). */
  pending?: TaskStatus | null;
  confirmingDone: boolean;
  /** Child tasks not done yet (2026-10-25): the completion question says they stay open. */
  openChildren?: number;
  onChoose: (status: TaskStatus) => void;
  onConfirmDone: () => void;
  onCancelDone: () => void;
  onReopen: () => void;
}) {
  if (task.status === 'done' && !canReopen) return null;
  return (
    <div className="status-buttons task-status-buttons" role="group" aria-label={`「${task.title}」の状態`} aria-busy={saving}>
      {task.status === 'done' ? (
        <button type="button" className="status-button task-reopen" disabled={disabled} onClick={onReopen}>
          再開する（未着手に戻す）
        </button>
      ) : (
        TASK_STATUSES.map((s) => (
          <button key={s} type="button" className={`status-button status-${s}`} aria-pressed={(pending ?? task.status) === s} disabled={disabled} onClick={() => onChoose(s)}>
            {TASK_STATUS_LABELS[s]}
          </button>
        ))
      )}
      {confirmingDone && task.status !== 'done' && <DoneConfirm disabled={disabled} openChildren={openChildren} onConfirm={onConfirmDone} onCancel={onCancelDone} />}
      {saving && (
        <span className="hint" role="status">
          保存中…
        </span>
      )}
    </div>
  );
}

/** What completing a task with open child tasks means (they are not completed with it). */
export const openChildrenText = (n: number) => `未完了の子タスクが ${n} 件あります（子タスクは完了になりません）。`;

function DoneConfirm({ disabled, openChildren, onConfirm, onCancel }: { disabled: boolean; openChildren: number; onConfirm: () => void; onCancel: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null);
  // Keyboard users land on the question they just opened.
  useEffect(() => confirm.current?.focus(), []);
  return (
    <div className="task-done-confirm">
      {openChildren > 0 && <p className="meta-warn">{openChildrenText(openChildren)}</p>}
      <p>完了にすると、戻せるのは役員（委員長・副委員長・役員会）だけです。完了にしますか？</p>
      <div className="actions">
        <button type="button" ref={confirm} disabled={disabled} onClick={onConfirm}>
          完了にする
        </button>
        <button type="button" className="secondary" disabled={disabled} onClick={onCancel}>
          やめる
        </button>
      </div>
    </div>
  );
}
