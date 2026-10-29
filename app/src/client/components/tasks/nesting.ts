import { TASK_STATUSES, type TaskView } from '../../../shared/tasks.js';

// Parent and child tasks (2026-10-25): a project is a task with child tasks under it, one level only.
// The list shows each child right under its parent; everything here works on the list already loaded.

export interface RowGroup {
  /** The top row: a task without a parent, or the parent of matching children. */
  head: TaskView;
  /** False when the parent is shown only because some of its children match the filters. */
  headMatches: boolean;
  /** The matching children, in the list's order. */
  children: TaskView[];
}

/**
 * The matching rows (already sorted) grouped under their parents. A group sits where its first matching
 * member is, so a project comes up as early as its most urgent child. A child whose parent is not loaded
 * stands alone.
 */
export function groupRows(rows: TaskView[], byId: Map<string, TaskView>): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  for (const task of rows) {
    const parent = task.parentId ? byId.get(task.parentId) : undefined;
    if (parent) {
      const group = groups.get(parent.id) ?? { head: parent, headMatches: false, children: [] };
      group.children.push(task);
      groups.set(parent.id, group);
    } else {
      const group = groups.get(task.id);
      if (group) group.headMatches = true;
      else groups.set(task.id, { head: task, headMatches: true, children: [] });
    }
  }
  return [...groups.values()];
}

/** Every task's children, from the whole list (not only the matching rows). */
export function childrenByParent(tasks: TaskView[]): Map<string, TaskView[]> {
  const children = new Map<string, TaskView[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  }
  return children;
}

export const openCount = (tasks: TaskView[]): number => tasks.filter((t) => t.status !== 'done').length;

/** Children for a detail: open ones first, nearest deadline first; done ones last. */
export function childOrder(a: TaskView, b: TaskView): number {
  const status = TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
  if (a.status === 'done' || b.status === 'done') return status;
  if (a.deadline !== b.deadline) return a.deadline === null ? 1 : b.deadline === null ? -1 : a.deadline.localeCompare(b.deadline);
  return status;
}

/** Tasks that can take children: those that are not a child themselves (one level), but this one. */
export function parentChoices(tasks: TaskView[], exceptId: string | null): TaskView[] {
  return tasks.filter((t) => !t.parentId && t.id !== exceptId).sort((a, b) => a.title.localeCompare(b.title, 'ja'));
}
