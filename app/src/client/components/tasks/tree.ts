// With extensions, so that the unit tests (Node's module resolution) can import this file too.
import type { Department, TaskView } from '../../../shared/tasks.js';
import { groupRows, type RowGroup } from './nesting.js';

// The list by department (2026-10-28): parts (部) with their own tasks, then their sections (課), each
// with its tasks and the projects' children under them. It is built from the rows already filtered and
// sorted, so it sends nothing to the Task service.

/** The node of the tasks without a known department (only when every department is shown). */
export const NO_DEPARTMENT = '';

export interface TreeNode {
  /** Department key, or NO_DEPARTMENT. */
  key: string;
  label: string;
  /** The part this section is shown under (its own tasks' rows leave both names out). */
  part: string | null;
  /** This department's own rows, grouped under their projects, in the list's order. */
  groups: RowGroup[];
  /** The shown sections of a part. */
  sections: TreeNode[];
  /** The matching tasks here and in the sections, each once (a dimmed project is not one of them). */
  tasks: TaskView[];
}

/** Where a task sits: its departments, without a part when one of that part's sections is there too. */
export function placesOf(task: TaskView, departments: Department[]): string[] {
  const tags = task.tags ?? [];
  const partOf = new Map(departments.map((d) => [d.key, d.parent ?? null]));
  return tags.filter((k) => !tags.some((s) => partOf.get(s) === k));
}

/**
 * The shown departments a row is placed under: its own; for a child whose own departments are not shown,
 * its project's (it came in with its project, as in the list); else NO_DEPARTMENT.
 */
export function shownPlaces(task: TaskView, byId: Map<string, TaskView>, departments: Department[], shown: Set<string>): string[] {
  const keys = placesOf(task, departments).filter((k) => shown.has(k));
  if (keys.length > 0) return keys;
  const parent = task.parentId ? byId.get(task.parentId) : undefined;
  const parents = parent ? placesOf(parent, departments).filter((k) => shown.has(k)) : [];
  return parents.length > 0 ? parents : [NO_DEPARTMENT];
}

/**
 * The tree of the shown departments. A task is under each of the departments shownPlaces gives, so a
 * child sits where its project does when only the project's departments are shown. A section sits under
 * its part when the part is shown, else on its own.
 */
export function departmentTree(rows: TaskView[], byId: Map<string, TaskView>, departments: Department[], shown: Set<string>): TreeNode[] {
  const placed = new Map<string, TaskView[]>();
  for (const task of rows) {
    for (const key of shownPlaces(task, byId, departments, shown)) placed.set(key, [...(placed.get(key) ?? []), task]);
  }
  const node = (d: { key: string; label: string }, part: string | null): TreeNode => {
    const own = placed.get(d.key) ?? [];
    const sections = part === null ? departments.filter((s) => s.parent === d.key && shown.has(s.key)).map((s) => node(s, d.key)) : [];
    const tasks = [...own];
    const seen = new Set(own.map((t) => t.id));
    for (const t of sections.flatMap((s) => s.tasks)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      tasks.push(t);
    }
    return { key: d.key, label: d.label, part, groups: groupRows(own, byId), sections, tasks };
  };
  const tops = departments.filter((d) => shown.has(d.key) && !(d.parent && shown.has(d.parent))).map((d) => node(d, null));
  const loose = placed.get(NO_DEPARTMENT);
  return loose ? [...tops, node({ key: NO_DEPARTMENT, label: '部局なし' }, null)] : tops;
}

/** Every node's key, sections included (to fold or open them all). */
export const treeKeys = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => [n.key, ...treeKeys(n.sections)]);

// How the list is shown and which departments are folded, kept only in this browser; reading or writing
// may fail (private windows, blocked storage), and the list then opens as a plain list with all open.
const VIEW_KEY = 'iyakusai.tasks.view';
const FOLDED_KEY = 'iyakusai.tasks.treeFolded';

export type ListView = 'list' | 'tree' | 'bowtie';

export function storedView(): ListView {
  try {
    const view = localStorage.getItem(VIEW_KEY);
    return view === 'tree' || view === 'bowtie' ? view : 'list';
  } catch {
    return 'list';
  }
}

export function storedFolded(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not kept; it lasts until the page is reloaded.
  }
}

export const storeView = (view: ListView): void => store(VIEW_KEY, view);
export const storeFolded = (folded: ReadonlySet<string>): void => store(FOLDED_KEY, JSON.stringify([...folded]));
