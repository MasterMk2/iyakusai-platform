import { departmentKey, TASK_STATUS_LABELS, taskNumber, type TaskView } from '../../shared/tasks.js';
import type { RolloverTaskGroup, RolloverTasksResponse } from '../../shared/rollover.js';
import type { User } from '../domain/types.js';
import { TaskServiceError } from '../tasks/client.js';
import type { TaskRuntime } from '../tasks/routes.js';

// Step 3: the open tasks, by department, for the new officers to decide what to carry over. The tasks stay in the
// Task service (the Bot host's task DB): nothing here writes them. The read is the administrator's own (what they may
// see), in one request: the list of every department, or, where the Task service has none (the demo's), one list per
// committee of theirs, up to WORKSPACES_MAX.

const WORKSPACES_MAX = 20;
const NO_DEPARTMENT = '部局なし';

export const TASK_MESSAGES = {
  off: 'このサーバーではタスク機能が設定されていません。',
  unbound: 'あなたのアカウントはタスクの利用者として登録されていないため、タスクを読めません（Discord の /register と委員会のロールを確かめてください）。',
  unavailable: 'タスク API から読み込めませんでした。時間をおいて、もう一度読み込んでください。',
} as const;

async function readOpenTasks(tasks: TaskRuntime, actor: string): Promise<{ tasks: TaskView[]; names: Map<string, string> }> {
  const names = new Map<string, string>();
  try {
    return { tasks: (await tasks.client.listAllTasks(actor)).filter((t) => t.status !== 'done'), names };
  } catch (err) {
    if (!(err instanceof TaskServiceError) || err.status !== 404) throw err;
  }
  const me = await tasks.client.me(actor);
  const all: TaskView[] = [];
  for (const { workspace } of me.memberships.slice(0, WORKSPACES_MAX)) {
    names.set(workspace.id, workspace.name);
    all.push(...(await tasks.client.listTasks(actor, workspace.id, {})).filter((t) => t.status !== 'done'));
  }
  return { tasks: all, names };
}

/**
 * Department names by key, from the Task service's departments (its `dept-<key>` workspaces), as the decisions
 * screen names them; whether a department has open tasks does not matter. Empty when there is no Task service, the
 * administrator is not a task user, or it cannot be read (the keys then stand for themselves).
 */
export async function departmentLabels(tasks: TaskRuntime | null, user: User): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const actor = tasks?.bridge.taskUserFor(user.id) ?? null;
  if (!tasks || !actor) return labels;
  try {
    for (const { workspace } of (await tasks.client.me(actor)).memberships) {
      const key = departmentKey(workspace.id);
      if (key) labels.set(key, workspace.name);
    }
  } catch {
    // The keys stand for themselves.
  }
  return labels;
}

/** The open tasks this administrator can see, by department (a task with two departments is in both). */
export async function openTasksByDepartment(tasks: TaskRuntime | null, user: User): Promise<RolloverTasksResponse> {
  if (!tasks) return { state: 'off', message: TASK_MESSAGES.off, total: 0, groups: [] };
  const actor = tasks.bridge.taskUserFor(user.id);
  if (!actor) return { state: 'unbound', message: TASK_MESSAGES.unbound, total: 0, groups: [] };
  let read: Awaited<ReturnType<typeof readOpenTasks>>;
  try {
    read = await readOpenTasks(tasks, actor);
  } catch {
    return { state: 'unavailable', message: TASK_MESSAGES.unavailable, total: 0, groups: [] };
  }
  const groups = new Map<string, RolloverTaskGroup>();
  const add = (key: string, label: string, task: TaskView) => {
    const group = groups.get(key) ?? { key, label, tasks: [] };
    group.tasks.push({
      id: task.id,
      number: taskNumber(task.id),
      title: task.title,
      status: TASK_STATUS_LABELS[task.status],
      assignee: task.assignee?.displayName ?? '',
      deadline: task.deadline,
      overdue: task.overdue,
    });
    groups.set(key, group);
  };
  for (const task of read.tasks) {
    const tags = task.tags ?? [];
    if (tags.length > 0) tags.forEach((tag, i) => add(tag, task.tagLabels?.[i] ?? tag, task));
    else {
      const key = departmentKey(task.workspaceId) ?? task.workspaceId;
      add(key, read.names.get(task.workspaceId) ?? (key === task.workspaceId ? NO_DEPARTMENT : key), task);
    }
  }
  const ordered = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'ja'));
  for (const g of ordered) g.tasks.sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || a.title.localeCompare(b.title, 'ja'));
  return { state: 'ok', message: null, total: new Set(read.tasks.map((t) => t.id)).size, groups: ordered };
}

/** A cell that a spreadsheet would read as a formula gets a leading apostrophe. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The open tasks as CSV for Excel (UTF-8 with a BOM, CRLF), one row per department and task. */
export function tasksCsv(result: RolloverTasksResponse): string {
  const rows = [['部局', 'タスク番号', '題名', '状態', '担当', '期限', '期限超過', '持ち越す（記入用）']];
  for (const g of result.groups) {
    for (const t of g.tasks) rows.push([g.label, t.number, t.title, t.status, t.assignee, t.deadline?.slice(0, 10) ?? '', t.overdue ? '超過' : '', '']);
  }
  return `\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
