import { describe, expect, it } from 'vitest';
import { departmentTree, NO_DEPARTMENT, placesOf, treeKeys, type TreeNode } from '../../src/client/components/tasks/tree.js';
import type { Department, TaskView } from '../../src/shared/tasks.js';

// The list by department (2026-10-28): where each task goes in the tree of the shown departments.

const DEPARTMENTS: Department[] = [
  { key: 'yakuin', label: '役員会', parent: null },
  { key: 'soumu', label: '総務部', parent: null },
  { key: 'kaikei', label: '会計課', parent: 'soumu' },
  { key: 'system', label: 'システム課', parent: 'soumu' },
  { key: 'gaimu', label: '外務部', parent: null },
  { key: 'koho', label: '広報課', parent: 'gaimu' },
  { key: 'shogai', label: '渉外課', parent: 'gaimu' },
];
const ALL = new Set(DEPARTMENTS.map((d) => d.key));

const task = (id: string, tags: string[], parentId: string | null = null) => ({ id, tags, parentId }) as TaskView;
const byId = (tasks: TaskView[]) => new Map(tasks.map((t) => [t.id, t]));
/** Each node as "key: own rows (a child as >id, a dimmed project as ~id) | count", sections nested. */
const outline = (nodes: TreeNode[]): unknown =>
  nodes.map((n) => ({
    [n.key || '(none)']: [
      n.groups.flatMap((g) => [`${g.headMatches ? '' : '~'}${g.head.id}`, ...g.children.map((c) => `>${c.id}`)]).join(' '),
      n.tasks.length,
      ...(n.sections.length > 0 ? [outline(n.sections)] : []),
    ],
  }));

describe('the list by department', () => {
  it('puts a task under each of its departments, but a part only when none of its sections is there', () => {
    expect(placesOf(task('a', ['soumu', 'kaikei', 'shogai']), DEPARTMENTS)).toEqual(['kaikei', 'shogai']);
    expect(placesOf(task('b', ['soumu', 'koho']), DEPARTMENTS)).toEqual(['soumu', 'koho']);
    expect(placesOf(task('c', []), DEPARTMENTS)).toEqual([]);
  });

  it('nests the sections under their parts, counts each task once, and keeps the list order', () => {
    const rows = [task('t1', ['kaikei', 'shogai']), task('t2', ['soumu']), task('t3', ['kaikei']), task('t4', ['yakuin'])];
    expect(outline(departmentTree(rows, byId(rows), DEPARTMENTS, ALL))).toEqual([
      { yakuin: ['t4', 1] },
      { soumu: ['t2', 3, [{ kaikei: ['t1 t3', 2] }, { system: ['', 0] }]] },
      { gaimu: ['', 1, [{ koho: ['', 0] }, { shogai: ['t1', 1] }]] },
    ]);
  });

  it('puts children under their project in each department, dimming a project that is elsewhere', () => {
    const rows = [task('p', ['shogai', 'kaikei']), task('c1', ['shogai'], 'p'), task('c2', ['kaikei'], 'p'), task('c3', ['koho'], 'p')];
    const tree = departmentTree(rows, byId(rows), DEPARTMENTS, ALL);
    expect(outline(tree)).toEqual([
      { yakuin: ['', 0] },
      { soumu: ['', 2, [{ kaikei: ['p >c2', 2] }, { system: ['', 0] }]] },
      { gaimu: ['', 3, [{ koho: ['~p >c3', 1] }, { shogai: ['p >c1', 2] }]] },
    ]);
  });

  it('shows a child whose departments are not chosen where its project is (it came in with the project)', () => {
    const rows = [task('p', ['shogai']), task('c', ['kaikei'], 'p')];
    const shown = new Set(['gaimu', 'koho', 'shogai']);
    expect(outline(departmentTree(rows, byId(rows), DEPARTMENTS, shown))).toEqual([{ gaimu: ['', 2, [{ koho: ['', 0] }, { shogai: ['p >c', 2] }]] }]);
  });

  it('shows a chosen section on its own when its part is not chosen', () => {
    const rows = [task('t', ['koho'])];
    expect(outline(departmentTree(rows, byId(rows), DEPARTMENTS, new Set(['koho', 'yakuin'])))).toEqual([{ yakuin: ['', 0] }, { koho: ['t', 1] }]);
  });

  it('gathers the tasks without a known department last', () => {
    const rows = [task('t', []), task('u', ['other'])];
    const tree = departmentTree(rows, byId(rows), DEPARTMENTS, ALL);
    expect(tree.at(-1)).toMatchObject({ key: NO_DEPARTMENT, label: '部局なし' });
    expect(tree.at(-1)!.tasks.map((t) => t.id)).toEqual(['t', 'u']);
    expect(treeKeys(tree)).toEqual(['yakuin', 'soumu', 'kaikei', 'system', 'gaimu', 'koho', 'shogai', NO_DEPARTMENT]);
  });
});
