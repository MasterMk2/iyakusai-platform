import { describe, expect, it } from 'vitest';
import { peopleListState, personLoads, personTasks, sortPeople, unassignedTasks } from '../../src/client/components/tasks/people.js';
import { openingView } from '../../src/client/components/tasks/tree.js';
import type { TaskMember, TaskView } from '../../src/shared/tasks.js';

// The people view (2026-11-03): counts per person from the loaded list and the roster. Synthetic names only.

const TODAY = '2026-10-14';
const member = (userId: string, displayName: string, role: TaskMember['role'] = 'editor', active = true): TaskMember => ({ userId, displayName, role, active });
const task = (id: string, extra: Partial<TaskView> = {}): TaskView => ({ id, status: 'todo', deadline: null, assigneeId: null, helperIds: [], helpers: [], assignee: null, ...extra }) as TaskView;
const asAssignee = (id: string, userId: string, displayName: string, extra: Partial<TaskView> = {}) =>
  task(id, { assigneeId: userId, assignee: { id: userId, displayName, active: true }, ...extra });

const ROSTER = [
  member('user-a', '委員 A'),
  member('user-b', '委員 B'),
  member('user-c', '委員 C', 'admin'),
  member('user-v', '閲覧役 V', 'viewer'),
  member('user-gone', '旧委員 G', 'editor', false),
];

describe('the people view counts', () => {
  it('lists every active member, with zero counts for someone holding nothing', () => {
    const people = personLoads([], ROSTER, TODAY);
    expect(people.map((p) => p.id).sort()).toEqual(['user-a', 'user-b', 'user-c', 'user-v']);
    expect(people.every((p) => p.load === 0 && p.lead === 0)).toBe(true);
  });

  it('counts main and helper assignments, status, overdue and the next seven days, without completed tasks', () => {
    const tasks = [
      asAssignee('t1', 'user-a', '委員 A', { deadline: '2026-10-13', status: 'in_progress' }), // overdue
      asAssignee('t2', 'user-a', '委員 A', { deadline: '2026-10-20', status: 'blocked' }), // within 7 days
      asAssignee('t3', 'user-a', '委員 A', { status: 'done', deadline: '2026-10-13' }), // completed: not counted
      asAssignee('t4', 'user-b', '委員 B', { helperIds: ['user-a'], helpers: [{ id: 'user-a', displayName: '委員 A', active: true }], deadline: '2026-10-14' }),
    ];
    const a = personLoads(tasks, ROSTER, TODAY).find((p) => p.id === 'user-a')!;
    expect(a).toMatchObject({ lead: 2, helper: 1, load: 3, inProgress: 1, blocked: 1, overdue: 1, week: 2 });
    const b = personLoads(tasks, ROSTER, TODAY).find((p) => p.id === 'user-b')!;
    expect(b).toMatchObject({ lead: 1, helper: 0, load: 1, week: 1 });
  });

  it('does not count a day past seven days or a task with no deadline in the week', () => {
    const tasks = [asAssignee('t1', 'user-b', '委員 B', { deadline: '2026-10-22' }), asAssignee('t2', 'user-b', '委員 B')];
    expect(personLoads(tasks, ROSTER, TODAY).find((p) => p.id === 'user-b')).toMatchObject({ week: 0, lead: 2 });
  });

  it('counts a task due today, and one due exactly seven days later, in the week and never as overdue', () => {
    const tasks = [asAssignee('t1', 'user-b', '委員 B', { deadline: TODAY }), asAssignee('t2', 'user-b', '委員 B', { deadline: '2026-10-21' })];
    expect(personLoads(tasks, ROSTER, TODAY).find((p) => p.id === 'user-b')).toMatchObject({ week: 2, overdue: 0, lead: 2 });
  });

  it('keeps a former member who still holds an open task, marked inactive, and never calls them free', () => {
    const tasks = [asAssignee('t1', 'user-gone', '旧委員 G', { assignee: { id: 'user-gone', displayName: '旧委員 G', active: false } })];
    const gone = personLoads(tasks, ROSTER, TODAY).find((p) => p.id === 'user-gone')!;
    expect(gone).toMatchObject({ active: false, lead: 1, free: false });
    expect(personLoads([], ROSTER, TODAY).some((p) => p.id === 'user-gone')).toBe(false);
  });

  it('marks someone free only as an active editor or officer within the guide, judged over the whole committee', () => {
    // user-a holds one open main task in the whole committee (the guide); user-b holds three elsewhere.
    const whole = [asAssignee('t1', 'user-a', '委員 A'), asAssignee('t2', 'user-b', '委員 B'), asAssignee('t3', 'user-b', '委員 B'), asAssignee('t4', 'user-b', '委員 B')];
    const scoped = whole.filter((t) => t.id !== 't1');
    const people = personLoads(scoped, ROSTER, TODAY, whole);
    expect(people.find((p) => p.id === 'user-a')!.free).toBe(true);
    expect(people.find((p) => p.id === 'user-b')!.free).toBe(false);
    expect(people.find((p) => p.id === 'user-c')!.free).toBe(true);
    // A viewer is never suggested as free, whatever they hold.
    expect(people.find((p) => p.id === 'user-v')!.free).toBe(false);
  });

  it('shows a task-only person with a name from the task when the roster does not list them', () => {
    const tasks = [asAssignee('t1', 'user-x', '外部の人')];
    expect(personLoads(tasks, [], TODAY)).toEqual([expect.objectContaining({ id: 'user-x', name: '外部の人', active: true, free: false })]);
  });
});

describe('sorting and the lists', () => {
  it('sorts by load in both directions and by name, with the name breaking ties', () => {
    const tasks = [asAssignee('t1', 'user-b', '委員 B'), asAssignee('t2', 'user-b', '委員 B')];
    const people = personLoads(tasks, ROSTER, TODAY);
    expect(sortPeople(people, 'load-desc').map((p) => p.id)[0]).toBe('user-b');
    expect(sortPeople(people, 'load-asc').map((p) => p.id)[3]).toBe('user-b');
    const names = sortPeople(people, 'name').map((p) => p.name);
    expect(names.indexOf('委員 A')).toBeLessThan(names.indexOf('委員 B'));
    expect(names.indexOf('委員 B')).toBeLessThan(names.indexOf('委員 C'));
  });

  it('lists unassigned open tasks earliest deadline first, with no deadline last', () => {
    const tasks = [task('t1', { deadline: null }), task('t2', { deadline: '2026-10-20' }), task('t3', { deadline: '2026-10-15' }), task('t4', { deadline: '2026-10-01', status: 'done' }), asAssignee('t5', 'user-a', '委員 A', { deadline: '2026-10-01' })];
    expect(unassignedTasks(tasks).map((t) => t.id)).toEqual(['t3', 't2', 't1']);
  });

  it('splits one person into main and helping tasks, each earliest deadline first, leaving out completed ones', () => {
    const tasks = [
      asAssignee('t1', 'user-a', '委員 A', { deadline: '2026-10-30' }),
      asAssignee('t2', 'user-a', '委員 A', { deadline: '2026-10-16' }),
      asAssignee('t3', 'user-b', '委員 B', { deadline: '2026-10-18', helperIds: ['user-a'] }),
      asAssignee('t4', 'user-a', '委員 A', { status: 'done' }),
    ];
    const mine = personTasks(tasks, 'user-a');
    expect(mine.lead.map((t) => t.id)).toEqual(['t2', 't1']);
    expect(mine.helper.map((t) => t.id)).toEqual(['t3']);
  });
});

describe('the screen around the people list', () => {
  it('lists no person while the roster has not arrived, so no "no members" note is said for it', () => {
    expect(peopleListState(false, 0)).toBe('unknown');
    expect(peopleListState(false, 3)).toBe('unknown');
    expect(peopleListState(true, 0)).toBe('empty');
    expect(peopleListState(true, 2)).toBe('rows');
  });

  it('opens the list, not the people view kept in this browser, from a link that sets a filter', () => {
    expect(openingView('people', true)).toBe('list');
    expect(openingView('people', false)).toBe('people');
    expect(openingView('tree', false)).toBe('tree');
  });
});
