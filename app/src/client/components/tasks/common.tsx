import { useCallback } from 'react';
import { departmentKey, TASK_LIMITS, TASK_STATUS_LABELS, type Department, type TaskContextResponse, type TaskMember, type TaskStatus, type TaskView } from '../../../shared/tasks';
import { todayInTimeZone } from '../../../task-service/shared/dates';
import { api, ApiFailure } from '../../api';
import { useLoader } from '../../useLoader';

/** New operation ID for one user action; retries of the same action reuse it. */
export const newOperationId = () => crypto.randomUUID();

/** The record without one key (for the maps of what is being saved). */
export function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

export function useMembers(workspaceId: string | null, refresh = 0) {
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return workspaceId ? api<TaskMember[]>('GET', `/api/tasks/workspaces/${encodeURIComponent(workspaceId)}/members`, undefined, signal) : Promise.resolve([] as TaskMember[]);
    },
    [workspaceId, refresh],
  );
  return useLoader(load);
}

export function StatusChip({ status }: { status: TaskStatus }) {
  return <span className={`chip task-status-${status}`}>{TASK_STATUS_LABELS[status]}</span>;
}

/**
 * Departments a task can be tagged with (only when the Task service files tasks by department). `parent`
 * is the part a section belongs to (null for a part); it is left out when the Task API does not say
 * (before 2026-10-25), so a caller can tell "no part" from "not known".
 */
export function departmentsOf(context: TaskContextResponse | null | undefined): Department[] {
  if (!context?.tagging) return [];
  return context.memberships.flatMap((m) => {
    const key = departmentKey(m.workspace.id);
    if (!key) return [];
    const parentId = m.workspace.parentId;
    return [{ key, label: m.workspace.name, ...(parentId === undefined ? {} : { parent: parentId === null ? null : departmentKey(parentId) }) }];
  });
}

/** Comma-separated keys from the change history ("kikaku,koho") as department names. */
export function departmentNames(keys: string | null, departments: Department[]): string | null {
  if (keys === null || keys === '') return keys;
  return keys
    .split(',')
    .map((k) => departments.find((d) => d.key === k)?.label ?? k)
    .join('・');
}

export function TagChips({ labels }: { labels: string[] | undefined }) {
  if (!labels?.length) return null;
  return (
    <span className="task-tags" aria-label="部局">
      {labels.map((label) => (
        <span key={label} className="chip task-tag">
          {label}
        </span>
      ))}
    </span>
  );
}

/** Checkboxes for the departments of a task; at least one, at most TASK_LIMITS.tagsMax. */
export function DepartmentPicker({
  departments,
  value,
  onChange,
  disabled,
}: {
  departments: Department[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const toggle = (key: string, on: boolean) => {
    const next = on ? [...value, key] : value.filter((k) => k !== key);
    // Keep the departments' own order, so the first one is stable.
    onChange(departments.map((d) => d.key).filter((k) => next.includes(k)));
  };
  return (
    <fieldset className="department-picker" disabled={disabled}>
      <legend>部局（1〜{TASK_LIMITS.tagsMax} つ）</legend>
      <p className="hint department-hint">課を選ぶと、課と部の両方の一覧に出ます。</p>
      {departments.map((d) => (
        <label key={d.key} className="department-option">
          <input
            type="checkbox"
            checked={value.includes(d.key)}
            disabled={disabled || (!value.includes(d.key) && value.length >= TASK_LIMITS.tagsMax)}
            onChange={(e) => toggle(d.key, e.target.checked)}
            data-department={d.key}
          />
          {d.label}
        </label>
      ))}
    </fieldset>
  );
}

export function deadlineText(task: Pick<TaskView, 'deadline' | 'overdue'>): string {
  if (!task.deadline) return '期限なし';
  return task.overdue ? `${task.deadline}（期限超過）` : task.deadline;
}

/** Today in Japan (deadlines are dates in Asia/Tokyo, like the Task service). */
export const tasksToday = () => todayInTimeZone(new Date());

const DAY_MS = 86_400_000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** "10/22（木）" from "2026-10-22". */
export function shortDate(dateOnly: string): string {
  const [y, m, d] = dateOnly.split('-').map(Number);
  return `${m}/${d}（${WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]}）`;
}

export type DeadlineTone = 'overdue' | 'today' | 'soon' | 'later' | 'none' | 'done';

/**
 * How far the deadline is, in the words a list is scanned for: "3日超過", "今日まで", "明日まで",
 * "あと4日", with the date beside it. A done task shows only the date (its deadline no longer warns).
 */
export function deadlineInfo(task: Pick<TaskView, 'deadline' | 'status'>, today: string): { label: string; date: string; tone: DeadlineTone } {
  if (!task.deadline) return { label: '期限なし', date: '', tone: 'none' };
  const date = shortDate(task.deadline);
  if (task.status === 'done') return { label: date, date: '', tone: 'done' };
  const days = Math.round((Date.parse(`${task.deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  if (days < 0) return { label: `${-days}日超過`, date, tone: 'overdue' };
  if (days === 0) return { label: '今日まで', date, tone: 'today' };
  if (days === 1) return { label: '明日まで', date, tone: 'soon' };
  return { label: `あと${days}日`, date, tone: days <= 7 ? 'soon' : 'later' };
}

/** "3時間前", "2日前" or the date, for "last changed" marks. */
export function sinceText(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}時間前`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}日前`;
  return shortDate(todayInTimeZone(new Date(iso)));
}

/** Message for a failed task request, with the conflict case spelled out. */
export function failureText(err: unknown): string {
  if (err instanceof ApiFailure) {
    if (err.status === 409 && err.body?.error === 'version_conflict') return `${err.message} 最新の内容を読み込んでから、もう一度操作してください。`;
    // The Task API names only the code; say which rule it was.
    if (err.body?.error === 'invalid_parent') {
      return 'その親タスクにはできません。親子は 1 段までです（子タスクの下には入れられず、子タスクのあるタスクはほかの下に入れられません）。';
    }
    if (err.body?.error === 'invalid_assignees') {
      return 'その担当にはできません。副担当は主担当のいるタスクにだけ付けられ、主担当の人は副担当にできません（副担当がいるうちは主担当を未割当にできません）。';
    }
    if (err.status === 503) return err.message;
    const details = (err.body?.details as { message: string }[] | undefined)?.map((d) => d.message).join('、');
    return details ? `${err.message}（${details}）` : err.message;
  }
  return 'サーバーに接続できませんでした。通信状態を確認して再試行してください。';
}

/** "合成 花子（副 見本 さくら、試験 一郎 ほか 1 人）": the assignee with the first two helpers. */
export function assigneeText(task: Pick<TaskView, 'assignee' | 'helpers'>): string {
  const main = task.assignee?.displayName ?? '未割当';
  const helpers = task.helpers ?? [];
  if (helpers.length === 0) return main;
  const shown = helpers.slice(0, 2).map((h) => h.displayName).join('、');
  return `${main}（副 ${shown}${helpers.length > 2 ? ` ほか ${helpers.length - 2} 人` : ''}）`;
}

/**
 * Helpers (副担当, 2026-10-28): the chosen members as names with a remove button, and a list to add one more
 * (active members other than the assignee). Only with an assignee; at most TASK_LIMITS.helpersMax.
 */
export function HelperPicker({
  members,
  assignee,
  value,
  onChange,
  id,
  disabled,
  known = [],
}: {
  members: TaskMember[];
  assignee: string | null;
  value: string[];
  onChange: (value: string[]) => void;
  id: string;
  disabled?: boolean;
  /** Names the task already shows, for a helper no longer among the members. */
  known?: { id: string; displayName: string }[];
}) {
  const name = (userId: string) => members.find((m) => m.userId === userId)?.displayName ?? known.find((k) => k.id === userId)?.displayName ?? userId;
  const inactive = (userId: string) => !members.some((m) => m.userId === userId && m.active);
  const choices = members.filter((m) => m.active && m.userId !== assignee && !value.includes(m.userId));
  const full = value.length >= TASK_LIMITS.helpersMax;
  return (
    <div className="helper-picker">
      {value.length > 0 && (
        <ul className="helper-list" aria-label="副担当">
          {value.map((userId) => (
            <li key={userId} className="chip helper-chip">
              {name(userId)}
              {inactive(userId) && '（無効な所属）'}
              <button type="button" className="helper-remove" disabled={disabled} aria-label={`${name(userId)}を副担当から外す`} onClick={() => onChange(value.filter((v) => v !== userId))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <select id={id} value="" disabled={disabled || assignee === null} aria-describedby={assignee === null ? `${id}-hint` : undefined} onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">＋ 副担当を追加</option>
          {choices.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.displayName}
            </option>
          ))}
        </select>
      )}
      {assignee === null ? (
        <p id={`${id}-hint`} className="hint">
          副担当は、主担当を決めると付けられます。
        </p>
      ) : (
        full && <p className="hint">副担当は {TASK_LIMITS.helpersMax} 人までです。</p>
      )}
    </div>
  );
}

/** Assignee choices: only active members of the selected committee, plus unassigned. */
export function AssigneeSelect({
  members,
  value,
  onChange,
  id,
  disabled,
}: {
  members: TaskMember[];
  value: string | null;
  onChange: (value: string | null) => void;
  id?: string;
  disabled?: boolean;
}) {
  const active = members.filter((m) => m.active);
  const current = value && !active.some((m) => m.userId === value) ? members.find((m) => m.userId === value) : undefined;
  return (
    <select id={id} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
      <option value="">未割当</option>
      {current && (
        <option value={current.userId} disabled>
          {current.displayName}（無効な所属）
        </option>
      )}
      {active.map((m) => (
        <option key={m.userId} value={m.userId}>
          {m.displayName}
        </option>
      ))}
    </select>
  );
}
