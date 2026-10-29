import type { TaskView } from './tasks.js';
import { addDays, todayInTimeZone } from '../task-service/shared/dates.js';

export const TASK_DEADLINE_LABELS = {
  overdue: '期限超過', today: '今日まで', tomorrow: '明日まで',
  upcoming: '2〜7日後', later: '8日後以降', none: '期限なし',
} as const;
export type TaskDeadlineBucket = keyof typeof TASK_DEADLINE_LABELS;
export interface TaskSummaryResponse {
  today: string;
  generatedAt: string;
  total: number;
  deadlines: Record<TaskDeadlineBucket, number>;
  departments: { workspaceId: string; name: string; parentId: string | null; remaining: number; overdue: number; today: number }[];
  byDate: { deadline: string; remaining: number }[];
}

/** In-process/demo backend only. The production Bot API aggregates in one authorized read. */
export function summarizeTaskGroups(groups: { workspaceId: string; name: string; tasks: Pick<TaskView, 'id' | 'deadline' | 'status'>[] }[], now: string): TaskSummaryResponse {
  const today = todayInTimeZone(new Date(now));
  const tomorrow = addDays(today, 1), weekEnd = addDays(today, 7);
  const unique = new Map(groups.flatMap(g => g.tasks).filter(t => t.status !== 'done').map(t => [t.id, t]));
  const deadlines: TaskSummaryResponse['deadlines'] = { overdue: 0, today: 0, tomorrow: 0, upcoming: 0, later: 0, none: 0 };
  const dates = new Map<string, number>();
  for (const t of unique.values()) {
    const d = t.deadline;
    const bucket = d === null ? 'none' : d < today ? 'overdue' : d === today ? 'today' : d === tomorrow ? 'tomorrow' : d <= weekEnd ? 'upcoming' : 'later';
    deadlines[bucket]++;
    if (d !== null) dates.set(d, (dates.get(d) ?? 0) + 1);
  }
  return {
    today, generatedAt: now, total: unique.size, deadlines,
    departments: groups.map(g => {
      const tasks = [...new Map(g.tasks.filter(t => t.status !== 'done').map(t => [t.id, t])).values()];
      return { workspaceId: g.workspaceId, name: g.name, parentId: null, remaining: tasks.length,
        overdue: tasks.filter(t => t.deadline !== null && t.deadline < today).length,
        today: tasks.filter(t => t.deadline === today).length };
    }),
    byDate: [...dates].sort(([a], [b]) => a.localeCompare(b)).map(([deadline, remaining]) => ({ deadline, remaining })),
  };
}
