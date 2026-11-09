import { z } from 'zod';
import { departmentsOfLabel } from '../../shared/mailbox.js';
import { TASK_DRAFT_LIMITS, type TaskDraft } from '../../shared/assistant.js';
import { departmentKey, isAssignedTo, TASK_LIMITS, type TaskContextResponse, type TaskMember, type TaskView } from '../../shared/tasks.js';
import type { User } from '../domain/types.js';

// Task drafting (taskdraft, 2026-11-09, contract §9). The browser sends only the outline; this server adds who the
// Bot may propose (the roster: active members who can edit, with their departments and how many open tasks they
// hold) and the open tasks, both read from the Task service as the person who asked. The Bot answers with Task
// users from that roster only; the draft is checked again here before a browser sees it.

/** One person the Bot may propose, as the Bot host's input takes it (contract §9-2). */
export interface RosterEntry {
  id: string;
  name: string;
  /** Department keys of the person's Discord roles (所属). */
  departments: string[];
  lead: number;
  helper: number;
  overdue: number;
  /** Department keys of tasks the person has held (any status). */
  history: string[];
}

export interface OpenTaskEntry {
  title: string;
  tags: string[];
  assigneeId: string | null;
  deadline: string | null;
}

const isOpen = (t: TaskView) => t.status !== 'done';
const cap = (n: number) => Math.min(n, 9999);

/** Department label (the workspace name, "企画課") to key ("kikaku"), from the Task service's own departments. */
export function departmentKeysByLabel(memberships: TaskContextResponse['memberships']): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of memberships) {
    const key = departmentKey(m.workspace.id);
    if (key) map.set(m.workspace.name, key);
  }
  return map;
}

/**
 * The roster: active editors and officers (a viewer cannot take a task on). Departments come from the app's people
 * (Discord roles), matched through the identity bridge; someone the app does not know has none.
 */
export function buildRoster(input: {
  members: TaskMember[];
  tasks: TaskView[];
  people: User[];
  taskUserFor: (principalId: string) => string | null;
  labels: Map<string, string>;
  today: string;
}): RosterEntry[] {
  const departmentsOf = new Map<string, string[]>();
  for (const person of input.people) {
    if (person.disabled) continue;
    const taskUser = input.taskUserFor(person.id);
    if (!taskUser) continue;
    const keys = departmentsOfLabel(person.roleLabel)
      .map((label) => input.labels.get(label))
      .filter((k): k is string => k !== undefined);
    departmentsOf.set(taskUser, [...new Set(keys)].slice(0, 10));
  }
  return input.members
    .filter((m) => m.active && m.role !== 'viewer')
    .map((m) => {
      const held = input.tasks.filter((t) => isAssignedTo(t, m.userId));
      const open = held.filter(isOpen);
      const history = [...new Set(held.flatMap((t) => t.tags ?? []))].slice(0, 10);
      return {
        id: m.userId,
        name: m.displayName.slice(0, 40) || '（名前なし）',
        departments: departmentsOf.get(m.userId) ?? [],
        lead: cap(open.filter((t) => t.assigneeId === m.userId).length),
        helper: cap(open.filter((t) => t.assigneeId !== m.userId).length),
        overdue: cap(open.filter((t) => t.deadline !== null && t.deadline < input.today).length),
        history,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    .slice(0, TASK_DRAFT_LIMITS.rosterMax);
}

/** Open tasks for the Bot to avoid repeating: those of the hinted departments first, then the nearest deadline. */
export function openTasksFor(tasks: TaskView[], hint: string[], roster: Set<string>): OpenTaskEntry[] {
  const near = (t: TaskView) => (hint.length > 0 && (t.tags ?? []).some((k) => hint.includes(k)) ? 0 : 1);
  return tasks
    .filter(isOpen)
    .sort((a, b) => near(a) - near(b) || (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || a.id.localeCompare(b.id))
    .slice(0, TASK_DRAFT_LIMITS.openTasksMax)
    .map((t) => ({
      title: t.title.slice(0, TASK_LIMITS.titleMax),
      tags: (t.tags ?? []).slice(0, TASK_LIMITS.tagsMax),
      // Someone outside the roster is sent as "assigned" without a name the Bot could propose.
      assigneeId: t.assigneeId !== null && roster.has(t.assigneeId) ? t.assigneeId : null,
      deadline: t.deadline,
    }));
}

// ---- the draft as the browser may see it

const id = z.string().regex(/^[a-z0-9-]{1,64}$/);
const key = z.string().regex(/^[a-z]{2,16}$/);
const line = (max: number) => z.string().max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const person = z.object({ id, name: line(80), facts: line(200) });
const item = z.object({
  title: line(TASK_LIMITS.titleMax).min(1),
  tags: z.array(key).min(1).max(TASK_LIMITS.tagsMax),
  deadline: date,
  purpose: line(TASK_LIMITS.textMax),
  deliverable: line(TASK_LIMITS.textMax),
  completionCriteria: line(TASK_LIMITS.textMax),
  openQuestions: line(TASK_LIMITS.textMax),
  assigneeId: id.nullable(),
  assigneeName: line(80).nullable(),
  assigneeBy: z.enum(['ai', 'rule']).nullable(),
  assigneeFacts: line(200),
  reason: line(400),
  helperIds: z.array(id).max(TASK_LIMITS.helpersMax),
  helperNames: z.array(line(80)).max(TASK_LIMITS.helpersMax),
  alternatives: z.array(person).max(5),
});
const draftSchema = z.object({
  parent: item.nullable(),
  items: z.array(item).min(1).max(TASK_DRAFT_LIMITS.itemsMax),
  notes: line(1200),
  questions: z.array(line(400)).max(10),
  parentTask: z.object({ id, title: line(TASK_LIMITS.titleMax) }).nullable(),
  sources: z.array(z.object({ label: line(300), excerpt: line(400) })).max(10),
  model: line(80).optional(),
});

/** The Bot's draft, checked and stripped to the known fields; null when it does not have the expected shape. */
export function browserDraft(value: unknown): TaskDraft | null {
  const parsed = draftSchema.safeParse(value);
  return parsed.success ? (parsed.data as TaskDraft) : null;
}
