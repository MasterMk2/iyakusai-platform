import { describe, expect, it } from 'vitest';
import { summarizeTaskGroups } from '../../src/shared/task-summary.js';
import type { TaskView } from '../../src/shared/tasks.js';

const row = (id: string, deadline: string | null, status: TaskView['status'] = 'todo') => ({ id, deadline, status } as TaskView);
const group = (tasks: TaskView[], workspaceId = 'dept-kikaku') => ({ workspaceId, name: '企画課', tasks });
describe('remaining task counts', () => {
  it('uses the Japanese date across midnight and excludes completed tasks in every bucket', () => {
    const tasks = [row('1', '2026-10-13'), row('2', '2026-10-14'), row('3', '2026-10-15', 'in_progress'), row('4', '2026-10-16', 'blocked'), row('5', '2026-10-21'), row('6', '2026-10-22'), row('7', null), row('8', '2026-10-13', 'done')];
    const s = summarizeTaskGroups([group(tasks)], '2026-10-13T15:00:00Z');
    expect(s.today).toBe('2026-10-14');
    expect(s.total).toBe(7);
    expect(s.deadlines).toEqual({ overdue: 1, today: 1, tomorrow: 1, upcoming: 2, later: 1, none: 1 });
    expect(s.departments[0]).toMatchObject({ remaining: 7, overdue: 1, today: 1 });
    expect(s.byDate.map(d => d.deadline)).toEqual(['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-21', '2026-10-22']);
  });
  it('counts a multi-department task once globally and once in each department', () => {
    const t = row('1', null);
    const s = summarizeTaskGroups([group([t, t]), group([t], 'dept-kaijo')], '2026-10-14T01:00:00Z');
    expect(s.total).toBe(1);
    expect(s.deadlines.none).toBe(1);
    expect(s.departments.map(d => d.remaining)).toEqual([1, 1]);
  });
  it('shows true zero counts with no tasks', () => {
    const s = summarizeTaskGroups([group([])], '2026-10-14T00:00:00Z');
    expect(s.total).toBe(0);
    expect(Object.values(s.deadlines)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(s.byDate).toEqual([]);
  });
});

describe('the viewer’s own open tasks (自分の持ち)', () => {
  const me = 'user-me';
  const held = (id: string, deadline: string | null, assigneeId: string | null, helperIds: string[] = [], status: TaskView['status'] = 'todo') =>
    ({ id, deadline, status, assigneeId, helperIds } as TaskView);
  it('counts open tasks as lead or helper, once each even when a task is in two departments, and leaves completed ones out', () => {
    const tasks = [held('1', '2026-10-13', me), held('2', '2026-10-14', 'user-x', [me], 'in_progress'), held('3', null, me, [], 'done'), held('4', null, 'user-x')];
    const s = summarizeTaskGroups([group(tasks), group(tasks, 'dept-kaijo')], '2026-10-13T15:00:00Z', me);
    expect(s.mine).toEqual({ remaining: 2, lead: 1, helper: 1, overdue: 1, today: 1 });
    expect(s.total).toBe(3);
  });
  it('leaves mine out when no viewer is given, so an older Bot host answer reads the same', () => {
    const s = summarizeTaskGroups([group([held('1', null, me)])], '2026-10-14T00:00:00Z');
    expect('mine' in s).toBe(false);
  });
});
