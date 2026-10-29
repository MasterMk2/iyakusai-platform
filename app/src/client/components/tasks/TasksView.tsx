import { useCallback, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import {
  DEPARTMENT_WORKSPACE_PREFIX,
  departmentKey,
  isAssignedTo,
  REQUIREMENT_FIELDS,
  REQUIREMENT_LABELS,
  TASK_LIMITS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  taskNumber,
  type Department,
  type Requirements,
  type TaskContextResponse,
  type TaskMutationResponse,
  type TaskStatus,
  type TaskView,
} from '../../../shared/tasks';
import { addDays } from '../../../task-service/shared/dates';
import { api, ApiFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { AssigneeSelect, assigneeText, deadlineInfo, DepartmentPicker, departmentsOf, failureText, HelperPicker, newOperationId, sinceText, StatusChip, tasksToday, useMembers, without } from './common';
import { coveredKeys, coversTask, DepartmentFilter, parseSelection, selectionLabel, selectionParam, storedSelection, storeSelection, topLevelKeys } from './DepartmentFilter';
import { TaskBowtie } from './TaskBowtie';
import { TaskDetailPanel } from './TaskDetailPanel';
import { childrenByParent, groupRows, openCount, parentChoices, type RowGroup } from './nesting';
import { openChildrenText, TaskStatusButtons } from './TaskStatusButtons';
import { departmentTree, storedFolded, storedView, storeFolded, storeView, treeKeys, type ListView, type TreeNode } from './tree';

/** Shortcut a link may open the list with (home counts): the matching filter is set. */
export type TaskFocus = 'overdue' | 'today' | 'mine';

export interface TaskRoute {
  workspaceId: string | null;
  taskId: string | null;
  creating: boolean;
  remaining?: boolean;
  focus?: TaskFocus | null;
}

const EMPTY_REQS: Requirements = { purpose: '', deliverable: '', completionCriteria: '', openQuestions: '' };
// The status filter (2026-10-24): several statuses can be shown at once, e.g. everything but done.
const OPEN_STATUSES: TaskStatus[] = TASK_STATUSES.filter((s) => s !== 'done');

/**
 * Every filter works on the list already fetched: every department in one request (2026-10-25), or one
 * department from a Task API without the sections' parts. Changing the departments, a filter, the search
 * or the order sends nothing to the Task service.
 */
type AssigneeFilter = '' | 'me' | 'none' | string;
type DeadlineFilter = '' | 'overdue' | 'today' | 'week' | 'none';
type SortKey = 'deadline' | 'updated' | 'created';

const DEADLINE_CHIPS: { key: Exclude<DeadlineFilter, ''>; label: string }[] = [
  { key: 'overdue', label: '期限超過' },
  { key: 'today', label: '今日まで' },
  { key: 'week', label: '7日以内' },
  { key: 'none', label: '期限なし' },
];
const SORT_LABELS: Record<SortKey, string> = { deadline: '期限が近い順', updated: '更新が新しい順', created: '登録順' };

function matchesDeadline(t: TaskView, f: DeadlineFilter, today: string): boolean {
  if (f === '') return true;
  if (f === 'none') return t.deadline === null;
  if (t.deadline === null || t.status === 'done') return false;
  if (f === 'overdue') return t.deadline < today;
  if (f === 'today') return t.deadline === today;
  return t.deadline >= today && t.deadline <= addDays(today, 7);
}

/** A person's tasks include those they help with (副担当, 2026-10-28); "unassigned" is no main assignee. */
function matchesAssignee(t: TaskView, f: AssigneeFilter, me: string | null): boolean {
  if (f === '') return true;
  if (f === 'none') return t.assigneeId === null;
  if (f === 'me') return me !== null && isAssignedTo(t, me);
  return isAssignedTo(t, f);
}

/** Open tasks first, by deadline (none last); done tasks at the end, newest change first. */
function byDeadline(a: TaskView, b: TaskView): number {
  const done = Number(a.status === 'done') - Number(b.status === 'done');
  if (done !== 0) return done;
  if (a.status === 'done') return b.updatedAt.localeCompare(a.updatedAt);
  if (a.deadline !== b.deadline) return a.deadline === null ? 1 : b.deadline === null ? -1 : a.deadline.localeCompare(b.deadline);
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function TasksView({ route, onNavigate, refresh }: { route: TaskRoute; onNavigate: (r: TaskRoute) => void; refresh: number }) {
  const [localRefresh, setLocalRefresh] = useState(0);
  const loadContext = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<TaskContextResponse>('GET', '/api/tasks/context', undefined, signal);
    },
    [refresh],
  );
  const context = useLoader(loadContext);
  const memberships = context.data?.memberships ?? [];
  // This person's ID in the Task service (what assigneeId holds; with the Discord login it is not the app's
  // login ID). An older server does not send it, and then "自分の担当" is not offered.
  const userId = context.data?.self ?? null;
  // Department tags: the workspaces are departments and a task may carry several.
  const departments = useMemo(() => departmentsOf(context.data), [context.data]);
  // Several departments at once needs to know each section's part (/me, 2026-10-25); a Task API from
  // before that keeps the one-department list.
  const multi = departments.length > 0 && departments.every((d) => d.parent !== undefined);
  const firstWorkspace = memberships[0]?.workspace.id ?? null;
  // The chosen departments: from the link (ws=dept-a,dept-b), else the last choice in this browser, else all.
  const selection = useMemo(
    () => (multi ? (parseSelection(route.workspaceId, departments) ?? storedSelection(departments) ?? topLevelKeys(departments)) : []),
    [multi, route.workspaceId, departments],
  );
  const workspaceId = multi ? null : (route.workspaceId?.split(',')[0] ?? firstWorkspace);
  // What a link to a task or the create form keeps, so that going back shows the same departments.
  const wsParam = multi ? route.workspaceId : workspaceId;
  // The role is committee-wide with department tags, so the first department's says it.
  const role = memberships.find((m) => m.workspace.id === (multi ? firstWorkspace : workspaceId))?.role ?? null;
  const canEditRole = (ws: string) => {
    const r = memberships.find((m) => m.workspace.id === ws)?.role;
    return r === 'editor' || r === 'admin';
  };

  const [statuses, setStatuses] = useState<TaskStatus[]>(() => (route.remaining || route.focus ? [...OPEN_STATUSES] : [...TASK_STATUSES]));
  const [assignee, setAssignee] = useState<AssigneeFilter>(() => (route.focus === 'mine' ? 'me' : ''));
  const [deadline, setDeadline] = useState<DeadlineFilter>(() => (route.focus === 'overdue' ? 'overdue' : route.focus === 'today' ? 'today' : ''));
  const [sort, setSort] = useState<SortKey>('deadline');
  // Phones fold the filters under one button (the list comes first there); wider screens always show them.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState('');
  const toggleStatus = (status: TaskStatus, on: boolean) =>
    // Keep the statuses' own order.
    setStatuses((prev) => TASK_STATUSES.filter((s) => (s === status ? on : prev.includes(s))));
  // Which list is loaded: every department ("*", read once whatever is chosen) or one department.
  const listKey = multi ? '*' : workspaceId;
  const loadTasks = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      void localRefresh;
      if (!listKey || !context.data?.bound) return Promise.resolve({ listKey, tasks: [] as TaskView[] });
      const path = listKey === '*' ? '/api/tasks/all' : `/api/tasks/workspaces/${encodeURIComponent(listKey)}/tasks`;
      return api<TaskView[]>('GET', path, undefined, signal).then((tasks) => ({ listKey, tasks }));
    },
    [listKey, refresh, localRefresh, context.data?.bound],
  );
  const tasks = useLoader(loadTasks);
  // Members are the whole committee with department tags, so one department's list serves every choice.
  const members = useMembers(context.data?.bound ? (multi ? firstWorkspace : workspaceId) : null, refresh);

  // Status buttons on the list rows (2026-10-24). A saved task replaces its row until the list comes
  // back with that version or newer, so a change costs no extra list request (only a conflict refetches).
  const [saved, setSaved] = useState<Record<string, TaskView>>({});
  // Rows being saved (with the status being set, shown pressed at once) and rows whose save failed: only
  // that row waits, and its failure shows on it (2026-10-26: every row's buttons stopped while one saved, and
  // the failure was at the top of a long list).
  const [saving, setSaving] = useState<Record<string, TaskStatus | 'reopen'>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string; undo?: { task: TaskView; previous: TaskStatus } } | null>(null);
  // One operation ID per pending change of each task; a retry after a failure reuses it.
  const pendingOps = useRef<Record<string, { key: string; id: string }>>({});
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [confirmDone, setConfirmDone] = useState<string | null>(null);
  // Parent tasks (2026-10-25): projects whose children are folded away, and the parent a new task is
  // created under ("＋ 子タスクを追加"; not kept in the link, so a reload opens a plain form).
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [createParent, setCreateParent] = useState<string | null>(null);
  // The list by department (2026-10-28), offered with several departments at once. The view and the
  // folded departments are kept in this browser.
  const [view, setView] = useState<ListView>(storedView);
  const [foldedDepartments, setFoldedDepartments] = useState<ReadonlySet<string>>(storedFolded);
  // The role is committee-wide (the same for every department); only officers ("admin") may reopen.
  const admin = role === 'admin';
  const editable = role === 'editor' || role === 'admin';

  async function write(task: TaskView, kind: 'status' | 'reopen', status?: TaskStatus): Promise<TaskView> {
    const key = JSON.stringify({ id: task.id, v: task.version, kind, status });
    const previous = pendingOps.current[task.id];
    const operationId = previous?.key === key ? previous.id : newOperationId();
    pendingOps.current[task.id] = { key, id: operationId };
    const path = `/api/tasks/${encodeURIComponent(task.id)}`;
    const res = kind === 'reopen'
      ? await api<TaskMutationResponse>('POST', `${path}/reopen`, { expectedVersion: task.version, operationId })
      : await api<TaskMutationResponse>('PATCH', path, { expectedVersion: task.version, operationId, changes: { status } });
    delete pendingOps.current[task.id];
    setSaved((prev) => ({ ...prev, [res.task.id]: res.task }));
    if (route.taskId === res.task.id) setDetailRefresh((n) => n + 1);
    return res.task;
  }
  function failed(task: TaskView, err: unknown, prefix: string) {
    setRowErrors((e) => ({ ...e, [task.id]: prefix + failureText(err) }));
    // Someone else changed the task: fetch the list once so the row shows the newer state.
    if (err instanceof ApiFailure && err.status === 409) setLocalRefresh((n) => n + 1);
  }
  async function run(task: TaskView, doing: TaskStatus | 'reopen', action: () => Promise<void>) {
    if (saving[task.id]) return;
    setSaving((s) => ({ ...s, [task.id]: doing }));
    setRowErrors((e) => without(e, task.id));
    setNotice(null);
    try {
      await action();
    } finally {
      setSaving((s) => without(s, task.id));
    }
  }
  const changeStatus = (task: TaskView, status: TaskStatus, confirmed = false, openChildren = 0) => {
    if (saving[task.id] || status === task.status) return;
    // An ordinary member cannot undo a completion (reopening is for officers), so the row asks first.
    if (status === 'done' && !admin && !confirmed) {
      setNotice(null);
      setConfirmDone(task.id);
      return;
    }
    setConfirmDone(null);
    void run(task, status, async () => {
      try {
        const updated = await write(task, 'status', status);
        // Completing a project leaves its open children as they are; say so (an officer was not asked first).
        const children = status === 'done' && openChildren > 0 ? openChildrenText(openChildren) : '';
        setNotice({ kind: 'ok', text: `「${task.title}」を${TASK_STATUS_LABELS[status]}にしました。${children}`, ...(status === 'done' && admin ? { undo: { task: updated, previous: task.status } } : {}) });
      } catch (err) {
        failed(task, err, '変更できませんでした: ');
      }
    });
  };
  const reopen = (task: TaskView) =>
    void run(task, 'reopen', async () => {
      try {
        await write(task, 'reopen');
        setNotice({ kind: 'ok', text: `「${task.title}」を再開しました（未着手）。` });
      } catch (err) {
        failed(task, err, '再開できませんでした: ');
      }
    });
  // Reopening always goes back to to-do, so a task that was in progress or on hold is moved back after it.
  const undo = (u: { task: TaskView; previous: TaskStatus }) =>
    void run(u.task, u.previous, async () => {
      let reopened: TaskView;
      try {
        reopened = await write(u.task, 'reopen');
      } catch (err) {
        failed(u.task, err, '元に戻せませんでした: ');
        return;
      }
      if (u.previous === 'todo') {
        setNotice({ kind: 'ok', text: `「${u.task.title}」を未着手に戻しました。` });
        return;
      }
      try {
        await write(reopened, 'status', u.previous);
        setNotice({ kind: 'ok', text: `「${u.task.title}」を${TASK_STATUS_LABELS[u.previous]}に戻しました。` });
      } catch (err) {
        failed(u.task, err, `再開して未着手にしましたが、${TASK_STATUS_LABELS[u.previous]}には戻せませんでした: `);
      }
    });

  if (!context.data) {
    return (
      <main className="main tasks-main">
        <LoadStatus loader={context} what="タスクの利用状況" />
      </main>
    );
  }
  if (!context.data.enabled) {
    return (
      <main className="main tasks-main">
        <p className="status info" data-testid="tasks-disabled">
          このサーバーではタスク機能（委員会タスク管理）が設定されていません。受信箱は通常どおり使えます。
        </p>
      </main>
    );
  }
  if (!context.data.bound) {
    return (
      <main className="main tasks-main">
        <p className="status info" data-testid="tasks-unbound">
          このアカウントにはタスク機能の権限がありません（委員会タスクの利用者として登録されていません）。
        </p>
      </main>
    );
  }

  const today = tasksToday();
  const searchText = search.normalize('NFKC').trim().toLocaleLowerCase('ja');
  // After switching departments (one-department list), the previous rows are not shown while the new list loads.
  const loaded = tasks.data && tasks.data.listKey === listKey ? tasks.data.tasks : null;
  const current = (loaded ?? []).map((t) => {
    const s = saved[t.id];
    return s && s.version > t.version ? s : t;
  });
  const byId = new Map(current.map((t) => [t.id, t]));
  // Parent tasks: offered when the Task service reports them (parentId on its tasks).
  const nesting = current.some((t) => t.parentId !== undefined);
  const children = childrenByParent(current);
  // The chosen departments (a part with its sections). With every department chosen, nothing is left out.
  // A child comes with its project: it is in when its parent's departments are.
  const covered = coveredKeys(selection, departments);
  const everything = covered.size === departments.length;
  const covers = (keys: Set<string>, t: TaskView) => {
    const parent = t.parentId ? byId.get(t.parentId) : undefined;
    return coversTask(keys, t) || (!!parent && coversTask(keys, parent));
  };
  const inSelection = (t: TaskView) => !multi || everything || covers(covered, t);
  const searchedAll = !searchText
    ? current
    : current.filter((t) => [t.title, t.assignee?.displayName ?? '', ...(t.tagLabels ?? [])].join(' ').normalize('NFKC').toLocaleLowerCase('ja').includes(searchText));
  const searched = searchedAll.filter(inSelection);
  const people = members.data ?? [];
  const otherPerson = assignee !== '' && assignee !== 'me' && assignee !== 'none' ? assignee : '';
  // Each group's counts leave that group's own choice out, so a count says what choosing it would show.
  const forDepartments = multi ? searchedAll.filter((t) => statuses.includes(t.status) && matchesAssignee(t, assignee, userId) && matchesDeadline(t, deadline, today)) : [];
  const departmentCount = (key: string) => (loaded ? forDepartments.filter((t) => covers(coveredKeys([key], departments), t)).length : null);
  const forStatus = searched.filter((t) => matchesAssignee(t, assignee, userId) && matchesDeadline(t, deadline, today));
  const forChips = searched.filter((t) => statuses.includes(t.status));
  const list = forStatus.filter((t) => statuses.includes(t.status));
  if (sort === 'deadline') list.sort(byDeadline);
  else if (sort === 'updated') list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Each child right under its parent; a parent outside the filters is shown (dimmed) for its children.
  const groups = groupRows(list, byId);
  const listed = new Set(list.map((t) => t.id));
  // By department: the chosen departments with the same rows (a task under each of its departments).
  // The connections view draws the same rows between their departments and projects.
  const treeMode = multi && view === 'tree';
  const bowtieMode = multi && view === 'bowtie';
  const tree = treeMode ? departmentTree(list, byId, departments, covered) : [];
  const allFolded = tree.filter((n) => n.tasks.length > 0).every((n) => foldedDepartments.has(n.key));
  const filtered = searchText !== '' || statuses.length !== TASK_STATUSES.length || assignee !== '' || deadline !== '';
  const activeFilters = Number(statuses.length !== TASK_STATUSES.length) + Number(assignee !== '') + Number(deadline !== '');
  const clearAll = () => {
    setSearch('');
    setStatuses([...TASK_STATUSES]);
    setAssignee('');
    setDeadline('');
  };
  const departmentName = multi ? selectionLabel(selection, departments) : (memberships.find((m) => m.workspace.id === workspaceId)?.workspace.name ?? '');
  // A row's department names leave out the one department being viewed (it would be on every row).
  const ownKey = multi ? (selection.length === 1 ? selection[0]! : null) : workspaceId ? departmentKey(workspaceId) : null;
  const noneChosen = multi && selection.length === 0;
  const canCreate = (role === 'editor' || role === 'admin') && (multi || workspaceId !== null);
  // A new task starts with the departments being viewed (none when several cover them all: the creator
  // picks); a new child task with its project's.
  const parentOfNew = createParent ? (byId.get(createParent) ?? null) : null;
  const createTags = parentOfNew?.tags?.length
    ? parentOfNew.tags
    : multi
      ? selection.length === 1 || (!everything && selection.length <= TASK_LIMITS.tagsMax) ? selection : []
      : ownKey && departments.some((d) => d.key === ownKey) ? [ownKey] : [];
  const startCreate = (parentId: string | null) => {
    setCreateParent(parentId);
    onNavigate({ workspaceId: wsParam, taskId: null, creating: true });
  };
  const toggleFold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const chooseDepartments = (keys: string[]) => {
    storeSelection(keys);
    onNavigate({ workspaceId: selectionParam(keys), taskId: route.taskId, creating: false });
  };
  const showAllDepartments = () => chooseDepartments(topLevelKeys(departments));
  const chooseView = (next: ListView) => {
    setView(next);
    storeView(next);
  };
  const foldDepartments = (next: ReadonlySet<string>) => {
    setFoldedDepartments(next);
    storeFolded(next);
  };
  const toggleDepartment = (key: string) => {
    const next = new Set(foldedDepartments);
    if (!next.delete(key)) next.add(key);
    foldDepartments(next);
  };
  const tagNames = (t: TaskView) => (t.tags ?? []).map((k, i) => ({ k, label: t.tagLabels?.[i] ?? k }));
  // One list row. A child is indented under its project; a project shown only for its children is dimmed
  // and has no status buttons. `skip` is the departments the row is shown under (not repeated on it).
  const row = (
    t: TaskView,
    { child = false, context = false, skip, note }: { child?: boolean; context?: boolean; skip?: ReadonlySet<string>; note?: string } = {},
  ) => {
    const selected = route.taskId === t.id;
    const due = deadlineInfo(t, today);
    const others = tagNames(t).filter((d) => (skip ? !skip.has(d.k) : d.k !== ownKey));
    const withButtons = !context && editable && (t.status !== 'done' || admin);
    const kids = children.get(t.id) ?? [];
    const open = openCount(kids);
    return (
      <li key={t.id} className={`row task-row ${selected ? 'selected' : ''} ${withButtons ? 'has-buttons' : ''} ${child ? 'task-child' : ''} ${context ? 'task-context' : ''}`}>
        <button
          type="button"
          className="row-open task-list-item"
          data-task-id={t.id}
          aria-current={selected ? 'true' : undefined}
          onClick={() => onNavigate({ workspaceId: wsParam, taskId: t.id, creating: false })}
        >
          <span className="row-line">
            {/* The pressed status button says the status; a row without buttons shows it as a mark. */}
            {withButtons ? <span className="sr-only">{TASK_STATUS_LABELS[t.status]}</span> : <StatusChip status={t.status} />}
            <span className="subject" title={t.title}>
              {t.title}
            </span>
            <span className={`due due-${due.tone}`}>
              <strong>{due.label}</strong>
              {due.date && <small>{due.date}</small>}
            </span>
          </span>
          <span className="row-meta">
            {context && <span className="task-context-note">{note ?? '条件外'}（子タスクのため表示）</span>}
            {kids.length > 0 && (
              <span className="task-child-progress">
                子タスク {kids.length - open}/{kids.length} 完了
              </span>
            )}
            <span className={t.assignee ? undefined : 'meta-warn'}>担当: {assigneeText(t)}</span>
            {others.length > 0 && <span>{others.map((d) => d.label).join('・')}</span>}
            {t.missingRequirements.length > 0 && <span>記入不足 {t.missingRequirements.length}</span>}
            <span>更新 {sinceText(t.updatedAt)}</span>
          </span>
        </button>
        {withButtons && (
          <TaskStatusButtons
            task={t}
            canReopen={admin}
            saving={!!saving[t.id]}
            disabled={!!saving[t.id]}
            pending={saving[t.id] && saving[t.id] !== 'reopen' ? (saving[t.id] as TaskStatus) : null}
            confirmingDone={confirmDone === t.id}
            openChildren={open}
            onChoose={(s) => changeStatus(t, s, false, open)}
            onConfirmDone={() => changeStatus(t, 'done', true, open)}
            onCancelDone={() => setConfirmDone(null)}
            onReopen={() => reopen(t)}
          />
        )}
        {rowErrors[t.id] && (
          <p className="status error task-row-error" role="alert">
            {rowErrors[t.id]}
          </p>
        )}
      </li>
    );
  };
  // A project's row, the bar that folds its children and the children shown (in the list and under a
  // department alike). The bar counts the children not shown: under another department, or left out by
  // the filters.
  const groupItems = (g: RowGroup, { foldKey = g.head.id, skip }: { foldKey?: string; skip?: ReadonlySet<string> } = {}) => {
    const shown = !folded.has(foldKey);
    const here = new Set(g.children.map((c) => c.id));
    const kids = children.get(g.head.id) ?? [];
    const elsewhere = kids.filter((c) => listed.has(c.id) && !here.has(c.id)).length;
    const left = kids.length - here.size - elsewhere;
    const hidden = [elsewhere > 0 ? `${elsewhere} 件は別の部局` : '', left > 0 ? `${left} 件は条件外` : ''].filter(Boolean).join('、');
    const bar = `子タスク ${g.children.length} 件${shown ? '' : 'を表示'}`;
    // A project shown only for its children is either left out by the filters or under other departments.
    const note = !g.headMatches && listed.has(g.head.id) ? `${tagNames(g.head).map((d) => d.label).join('・') || '部局なし'}のタスク` : undefined;
    return [
      row(g.head, { context: !g.headMatches, skip, note }),
      ...(g.children.length > 0
        ? [
            <li key={`${g.head.id}:children`} className="task-children-bar">
              <button
                type="button"
                className="quiet task-children-toggle"
                aria-expanded={shown}
                // Names the project too: every bar says "子タスク N 件".
                aria-label={`「${g.head.title}」の${bar}${hidden ? `（ほか ${hidden}）` : ''}`}
                onClick={() => toggleFold(foldKey)}
              >
                <span aria-hidden="true">{shown ? '▾' : '▸'}</span>
                {bar}
                {hidden && <span className="task-children-hidden">（ほか {hidden}）</span>}
              </button>
            </li>,
            ...(shown ? g.children.map((c) => row(c, { child: true, skip })) : []),
          ]
        : []),
    ];
  };
  // One department of the list by department: its heading folds its tasks and sections away.
  const departmentNode = (node: TreeNode, depth: number): ReactElement => {
    const open = !foldedDepartments.has(node.key);
    const overdue = node.tasks.filter((t) => matchesDeadline(t, 'overdue', today)).length;
    const skip = new Set(node.part ? [node.key, node.part] : [node.key]);
    const Heading = depth === 0 ? 'h2' : 'h3';
    // The spaces keep the parts apart in the heading's name ("総務部 12 件 期限超過 3"); the layout ignores them.
    const facts = (
      <>
        <span className="task-tree-name">{node.label}</span>{' '}
        <span className="task-tree-count">{node.tasks.length} 件</span>
        {overdue > 0 && (
          <>
            {' '}
            <span className="task-tree-overdue">期限超過 {overdue}</span>
          </>
        )}
      </>
    );
    return (
      <li key={node.key} className={`task-tree-node depth-${depth}`} data-department={node.key}>
        <Heading className="task-tree-head">
          {node.tasks.length === 0 ? (
            <span className="task-tree-toggle is-empty">
              <span className="task-tree-caret" aria-hidden="true" />
              {facts}
            </span>
          ) : (
            <button type="button" className="task-tree-toggle" aria-expanded={open} onClick={() => toggleDepartment(node.key)}>
              <span className="task-tree-caret" aria-hidden="true">
                {open ? '▾' : '▸'}
              </span>
              {facts}
            </button>
          )}
        </Heading>
        {open && node.tasks.length > 0 && (
          <>
            {node.groups.length > 0 && (
              <ul className="rows-list task-tree-rows">{node.groups.flatMap((g) => groupItems(g, { foldKey: `${node.key}:${g.head.id}`, skip }))}</ul>
            )}
            {node.sections.length > 0 && <ul className="task-tree task-tree-sections">{node.sections.map((s) => departmentNode(s, depth + 1))}</ul>}
          </>
        )}
      </li>
    );
  };

  return (
    <>
      <section className="list-pane task-list-pane" aria-label="タスク一覧">
        <header className="pane-head">
          <div className="pane-title">
            <h1>タスク</h1>
            {multi ? (
              <DepartmentFilter departments={departments} value={selection} count={departmentCount} onChange={chooseDepartments} />
            ) : (
              <label className="task-workspace-field">
                <span className="sr-only">{departments.length > 0 ? '部局' : '委員会'}</span>
                <select
                  value={workspaceId ?? ''}
                  onChange={(e) => onNavigate({ workspaceId: e.target.value, taskId: null, creating: false })}
                  data-testid="task-workspace"
                  aria-label={departments.length > 0 ? '部局' : '委員会'}
                >
                  {memberships.map((m) => (
                    <option key={m.workspace.id} value={m.workspace.id}>
                      {m.workspace.name}
                      {m.role === 'viewer' ? '（閲覧のみ）' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {canCreate && (
            <button type="button" className="task-create-button" onClick={() => startCreate(null)}>
              ＋ 新しいタスク
            </button>
          )}
        </header>
        <div className="list-tools">
          <input
            type="search"
            className="list-search"
            aria-label="タスクを検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="タイトル・担当者・部局で検索"
          />
          <button type="button" className="secondary filters-toggle" aria-expanded={filtersOpen} aria-controls="task-filters" onClick={() => setFiltersOpen((o) => !o)}>
            絞り込み{activeFilters > 0 ? `（${activeFilters} つ適用中）` : ''}
          </button>
          <div id="task-filters" className={`filters-body ${filtersOpen ? 'open' : ''}`}>
          <fieldset className="task-status-filter" data-testid="task-status-filter">
            <legend>表示する状態</legend>
            {TASK_STATUSES.map((s) => (
              <label key={s} className="status-option">
                <input type="checkbox" checked={statuses.includes(s)} onChange={(e) => toggleStatus(s, e.target.checked)} data-status={s} />
                <span>{TASK_STATUS_LABELS[s]}</span>
                {/* The count is a visual aid; the box keeps the status alone as its name, and the result count is read below. */}
                <span className="option-count" aria-hidden="true">{loaded ? forStatus.filter((t) => t.status === s).length : ''}</span>
              </label>
            ))}
          </fieldset>
          <div className="filter-chips" role="group" aria-label="担当と期限で絞り込む">
            {userId && (
              <FilterChip label="自分の担当" count={loaded ? forChips.filter((t) => matchesDeadline(t, deadline, today) && userId !== null && isAssignedTo(t, userId)).length : null} pressed={assignee === 'me'} onToggle={(on) => setAssignee(on ? 'me' : '')} />
            )}
            <FilterChip label="未割当" count={loaded ? forChips.filter((t) => matchesDeadline(t, deadline, today) && t.assigneeId === null).length : null} pressed={assignee === 'none'} onToggle={(on) => setAssignee(on ? 'none' : '')} />
            <select className={`chip-select ${otherPerson ? 'selected' : ''}`} aria-label="担当者で絞り込み" value={otherPerson} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">担当者を選ぶ</option>
              {people.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <span className="chip-divider" aria-hidden="true" />
            {DEADLINE_CHIPS.map((c) => (
              <FilterChip
                key={c.key}
                label={c.label}
                tone={c.key === 'overdue' ? 'overdue' : c.key === 'today' ? 'today' : undefined}
                count={loaded ? forChips.filter((t) => matchesAssignee(t, assignee, userId) && matchesDeadline(t, c.key, today)).length : null}
                pressed={deadline === c.key}
                onToggle={(on) => setDeadline(on ? c.key : '')}
              />
            ))}
          </div>
          </div>
        </div>
        <div className="list-bar task-list-summary">
          <p className="count">{loaded ? `${list.length} 件${filtered ? 'を表示' : ''}` : 'タスク一覧'}</p>
          {filtered && (
            <button type="button" className="quiet" onClick={clearAll}>
              絞り込みを解除
            </button>
          )}
          {multi && (
            <div className="view-switch" role="group" aria-label="表示の形">
              <button type="button" aria-pressed={!treeMode && !bowtieMode} onClick={() => chooseView('list')}>
                一覧
              </button>
              <button type="button" aria-pressed={treeMode} onClick={() => chooseView('tree')}>
                部局ごと
              </button>
              <button type="button" aria-pressed={bowtieMode} onClick={() => chooseView('bowtie')}>
                関係図
              </button>
            </div>
          )}
          {treeMode && list.length > 0 && (
            <button
              type="button"
              className="quiet"
              onClick={() => foldDepartments(allFolded ? new Set() : new Set([...foldedDepartments, ...treeKeys(tree)]))}
            >
              {allFolded ? 'すべて開く' : 'すべてたたむ'}
            </button>
          )}
          <label className="sort-field">
            並べ順
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {notice && (
          <div className={`status ${notice.kind} task-list-notice`} role={notice.kind === 'ok' ? 'status' : 'alert'}>
            <span>{notice.text}</span>
            {notice.undo && (
              <button type="button" className="quiet" disabled={!!saving[notice.undo.task.id]} onClick={() => undo(notice.undo!)}>
                元に戻す
              </button>
            )}
          </div>
        )}
        <LoadStatus loader={{ ...tasks, data: loaded }} what="タスク一覧" />
        {loaded && list.length === 0 && (
          <div className="empty list-empty">
            {noneChosen ? (
              <>
                <p>表示する部局が選ばれていません。</p>
                <button type="button" className="secondary" onClick={showAllDepartments}>
                  すべての部局を表示
                </button>
              </>
            ) : statuses.length === 0 ? (
              <p>表示する状態が選ばれていません。見たい状態にチェックを入れてください。</p>
            ) : filtered ? (
              <>
                <p>条件に合うタスクはありません。検索や絞り込みを変えてください。</p>
                <button type="button" className="secondary" onClick={clearAll}>
                  絞り込みを解除
                </button>
              </>
            ) : (
              <p>
                {multi && selection.length > 1 ? '選んだ部局' : 'この部署'}のタスクはまだありません。{canCreate ? '「＋ 新しいタスク」から登録できます。' : ''}
              </p>
            )}
          </div>
        )}
        {treeMode ? (
          list.length > 0 && (
            <ul className="task-tree" data-testid="task-tree">
              {tree.map((n) => departmentNode(n, 0))}
            </ul>
          )
        ) : bowtieMode ? (
          list.length > 0 && (
            <TaskBowtie
              rows={list}
              byId={byId}
              departments={departments}
              shown={covered}
              children={children}
              today={today}
              selectedId={route.taskId}
              onOpen={(id) => onNavigate({ workspaceId: wsParam, taskId: id, creating: false })}
            />
          )
        ) : (
          <ul className="rows-list task-list" data-testid="task-list">
            {groups.flatMap((g) => groupItems(g))}
          </ul>
        )}
      </section>
      <section className="detail-pane task-detail-pane" aria-label="タスク詳細">
        {(route.taskId || route.creating) && (
          <button type="button" className="back-link" onClick={() => onNavigate({ workspaceId: wsParam, taskId: null, creating: false })}>
            ← 一覧に戻る
          </button>
        )}
        {route.creating && canCreate ? (
          <CreateTaskForm
            key={`${multi ? 'departments' : (workspaceId ?? '')}:${parentOfNew?.id ?? ''}`}
            workspaceId={workspaceId}
            initialTags={createTags}
            parentChoices={nesting ? parentChoices(current, null) : null}
            helping={current.some((t) => t.helperIds !== undefined)}
            initialParent={parentOfNew?.id ?? null}
            departmentName={multi ? '' : departmentName}
            departments={departments}
            members={people}
            onCancel={() => onNavigate({ workspaceId: wsParam, taskId: null, creating: false })}
            onCreated={(task) => {
              setLocalRefresh((n) => n + 1);
              // The list keeps the chosen departments; the one-department list opens the task's own.
              onNavigate({ workspaceId: multi ? wsParam : task.workspaceId, taskId: task.id, creating: false });
            }}
          />
        ) : route.taskId ? (
          <TaskDetailPanel
            key={route.taskId}
            taskId={route.taskId}
            departments={departments}
            canEditRole={canEditRole}
            canReopen={admin}
            refreshKey={detailRefresh}
            onChanged={(task, listChanged) => {
              // A saved task replaces its row at once; the list is fetched again only after a reload or a change
              // of departments or parent (the task may leave this department's list or move under a project).
              if (task) setSaved((prev) => ({ ...prev, [task.id]: task }));
              if (!task || listChanged) setLocalRefresh((n) => n + 1);
            }}
            family={
              nesting
                ? {
                    tasks: current,
                    onOpen: (id) => onNavigate({ workspaceId: wsParam, taskId: id, creating: false }),
                    onAddChild: (parent) => startCreate(parent.id),
                  }
                : null
            }
          />
        ) : (
          <DepartmentOverview
            name={departmentName}
            tasks={noneChosen ? null : loaded && loaded.filter(inSelection)}
            today={today}
            userId={userId}
            onFilter={(f) => {
              setSearch('');
              setStatuses([...OPEN_STATUSES]);
              setAssignee(f.assignee ?? '');
              setDeadline(f.deadline ?? '');
            }}
            onOpen={(id) => onNavigate({ workspaceId: wsParam, taskId: id, creating: false })}
          />
        )}
      </section>
    </>
  );
}

function FilterChip({ label, count, pressed, tone, onToggle }: { label: string; count: number | null; pressed: boolean; tone?: 'overdue' | 'today'; onToggle: (on: boolean) => void }) {
  return (
    <button type="button" className={`filter-chip ${tone && count ? `tone-${tone}` : ''}`} aria-pressed={pressed} onClick={() => onToggle(!pressed)}>
      {label}
      {count !== null && <span className="option-count">{count}</span>}
    </button>
  );
}

/**
 * What the empty detail pane shows: the department at a glance, in counts that call for action, each
 * a shortcut to that filter, and the tasks changed most recently.
 */
function DepartmentOverview({
  name,
  tasks,
  today,
  userId,
  onFilter,
  onOpen,
}: {
  name: string;
  tasks: TaskView[] | null;
  today: string;
  userId: string | null;
  onFilter: (f: { assignee?: AssigneeFilter; deadline?: DeadlineFilter }) => void;
  onOpen: (taskId: string) => void;
}) {
  if (!tasks) return null;
  const open = tasks.filter((t) => t.status !== 'done');
  const count = (f: DeadlineFilter) => open.filter((t) => matchesDeadline(t, f, today)).length;
  const byPerson = new Map<string, { name: string; n: number; overdue: number }>();
  // A helper's tasks count for them too, so a count matches the list its button filters to.
  const helping = tasks.some((t) => t.helperIds !== undefined);
  for (const t of open) {
    const people = [{ id: t.assigneeId ?? 'none', name: t.assignee?.displayName ?? '未割当' }, ...(t.helpers ?? []).map((h) => ({ id: h.id, name: h.displayName }))];
    for (const person of people) {
      const row = byPerson.get(person.id) ?? { name: person.name, n: 0, overdue: 0 };
      row.n++;
      if (matchesDeadline(t, 'overdue', today)) row.overdue++;
      byPerson.set(person.id, row);
    }
  }
  const people = [...byPerson].sort((a, b) => b[1].n - a[1].n);
  const recent = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const stat = (label: string, n: number, f: { assignee?: AssigneeFilter; deadline?: DeadlineFilter }, tone = '') => (
    <button type="button" className={`overview-stat ${n > 0 ? tone : ''}`} onClick={() => onFilter(f)}>
      <span>{label}</span>
      <strong>{n}</strong>
    </button>
  );
  return (
    <div className="department-overview" data-testid="department-overview">
      <header className="detail-head">
        <h2>{name}の概要</h2>
        <p className="hint">一覧からタスクを選ぶと、ここに詳細が出ます。数字を押すと、その条件で一覧を絞り込みます。</p>
      </header>
      {tasks.length === 0 ? (
        <p className="empty">この部局のタスクはまだありません。</p>
      ) : (
        <>
          <div className="overview-stats">
            {stat('未完了', open.length, {})}
            {stat('期限超過', count('overdue'), { deadline: 'overdue' }, 'tone-overdue')}
            {stat('今日まで', count('today'), { deadline: 'today' }, 'tone-today')}
            {stat('7日以内', count('week'), { deadline: 'week' })}
            {stat('未割当', open.filter((t) => t.assigneeId === null).length, { assignee: 'none' }, 'tone-today')}
          </div>
          <section aria-labelledby="overview-people">
            <h3 id="overview-people">担当者別の未完了</h3>
            {helping && <p className="hint">副担当のタスクも数えています。</p>}
            {people.length === 0 ? (
              <p className="empty">未完了のタスクはありません。</p>
            ) : (
              <table className="overview-table">
                <thead>
                  <tr>
                    <th scope="col">担当者</th>
                    <th scope="col">未完了</th>
                    <th scope="col">うち超過</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map(([id, p]) => (
                    <tr key={id}>
                      <th scope="row">
                        <button type="button" className="link-button" onClick={() => onFilter({ assignee: id === 'none' ? 'none' : id === userId ? 'me' : id })}>
                          {p.name}
                          {id === userId ? '（自分）' : ''}
                        </button>
                      </th>
                      <td>{p.n}</td>
                      <td className={p.overdue > 0 ? 'count-overdue' : ''}>{p.overdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section aria-labelledby="overview-recent">
            <h3 id="overview-recent">最近変更されたタスク</h3>
            <ul className="overview-recent">
              {recent.map((t) => (
                <li key={t.id}>
                  <button type="button" className="link-button" onClick={() => onOpen(t.id)}>
                    {t.title}
                  </button>
                  <span className="hint">
                    {TASK_STATUS_LABELS[t.status]}・{sinceText(t.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function CreateTaskForm({
  workspaceId,
  initialTags,
  parentChoices: choices,
  helping = false,
  initialParent,
  departmentName,
  departments,
  members,
  onCancel,
  onCreated,
}: {
  /** The Task service has helpers (副担当; known from the tasks it lists). */
  helping?: boolean;
  /** Where to file the task; null with several departments shown: then under its first department. */
  workspaceId: string | null;
  initialTags: string[];
  /** Projects a new task can go under (null: the Task service has no parent tasks). */
  parentChoices: TaskView[] | null;
  initialParent: string | null;
  departmentName: string;
  departments: Department[];
  members: { userId: string; displayName: string; role: 'viewer' | 'editor' | 'admin'; active: boolean }[];
  onCancel: () => void;
  onCreated: (task: TaskView) => void;
}) {
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [helpers, setHelpers] = useState<string[]>([]);
  // A helper chosen as the assignee leaves the helpers; no assignee, no helpers.
  const chooseAssignee = (value: string | null) => {
    setAssignee(value);
    setHelpers((h) => (value === null ? [] : h.filter((v) => v !== value)));
  };
  const [deadline, setDeadline] = useState('');
  const [reqs, setReqs] = useState<Requirements>(EMPTY_REQS);
  // Starts with the departments being viewed; they can be changed.
  const [tags, setTags] = useState<string[]>(initialTags);
  const [parent, setParent] = useState<string | null>(initialParent);
  const [operationId] = useState(newOperationId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tagging = departments.length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim() === '') {
      setError('タイトルを入力してください。');
      return;
    }
    if (tagging && tags.length === 0) {
      setError('部局を 1 つ以上選んでください。');
      return;
    }
    const target = workspaceId ?? DEPARTMENT_WORKSPACE_PREFIX + (tags[0] ?? '');
    setBusy(true);
    setError(null);
    try {
      const res = await api<TaskMutationResponse>('POST', `/api/tasks/workspaces/${encodeURIComponent(target)}/tasks`, {
        operationId,
        title,
        assigneeId: assignee,
        deadline: deadline || null,
        requirements: reqs,
        ...(tagging ? { tags } : {}),
        // Only when chosen, so a task without a parent is sent exactly as before.
        ...(parent ? { parentId: parent } : {}),
        ...(helpers.length ? { helperIds: helpers } : {}),
      });
      onCreated(res.task);
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="task-create" onSubmit={(e) => void submit(e)} aria-label="新しいタスク">
      <header className="detail-head">
        <h2 className="thread-title">新しいタスク</h2>
        <p className="hint">{departmentName ? `${departmentName}に登録します。` : ''}タイトルだけでも登録できます。担当者や内容は、あとから変えられます。</p>
      </header>
      <div className="form-grid">
        <label className="field-wide">
          タイトル（必須・{TASK_LIMITS.titleMax} 文字以内）
          <input value={title} maxLength={TASK_LIMITS.titleMax} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label htmlFor="create-assignee">
          {helping ? '主担当' : '担当者'}
          <AssigneeSelect id="create-assignee" members={members} value={assignee} disabled={busy} onChange={chooseAssignee} />
        </label>
        {helping && (
          <div>
            <label htmlFor="create-helpers">副担当（任意・{TASK_LIMITS.helpersMax} 人まで）</label>
            <HelperPicker id="create-helpers" members={members} assignee={assignee} value={helpers} disabled={busy} onChange={setHelpers} />
          </div>
        )}
        <label>
          期限（任意）
          <input type="date" value={deadline} disabled={busy} onChange={(e) => setDeadline(e.target.value)} />
        </label>
        {choices && (
          <label className="field-wide">
            {/* Named by its label only; the hint is read as its description. */}
            <span id="create-parent-label">親タスク（任意）</span>
            <select
              value={parent ?? ''}
              disabled={busy}
              aria-labelledby="create-parent-label"
              aria-describedby="create-parent-hint"
              onChange={(e) => setParent(e.target.value || null)}
            >
              <option value="">なし（このタスクを親か単独のタスクにする）</option>
              {choices.map((t) => (
                <option key={t.id} value={t.id}>
                  {taskNumber(t.id)} {t.title}
                </option>
              ))}
            </select>
            <span id="create-parent-hint" className="hint">
              大きな仕事（プロジェクト）の一部なら、その仕事を選ぶと下に入ります。親子は 1 段までです。
            </span>
          </label>
        )}
        {tagging && (
          <div className="field-wide">
            <DepartmentPicker departments={departments} value={tags} onChange={setTags} disabled={busy} />
          </div>
        )}
      </div>
      <section className="form-section" aria-label="新しいタスクの内容">
        <h3>タスクの内容（任意）</h3>
        <p className="hint">引き継ぐ人が読んで分かるように、分かるところから書いてください。</p>
        <div className="form-grid">
          {REQUIREMENT_FIELDS.map((f) => (
            <label key={f}>
              {REQUIREMENT_LABELS[f]}（任意）
              <textarea rows={3} maxLength={TASK_LIMITS.textMax} value={reqs[f]} disabled={busy} onChange={(e) => setReqs({ ...reqs, [f]: e.target.value })} />
            </label>
          ))}
        </div>
      </section>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="actions form-actions">
        <button type="submit" disabled={busy}>
          {busy ? '作成中…' : error ? '再試行' : '作成する'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          キャンセル
        </button>
      </div>
    </form>
  );
}
