import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  REQUIREMENT_FIELDS,
  REQUIREMENT_LABELS,
  TASK_FIELD_LABELS,
  TASK_LIMITS,
  TASK_SOURCE_LABELS,
  TASK_STATUS_LABELS,
  taskNumber,
  type Department,
  type TaskDetailResponse,
  type TaskHistoryEntry,
  type TaskMember,
  type TaskMutationResponse,
  type TaskStatus,
  type TaskView,
} from '../../../shared/tasks';
import { api, fmtDate } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { AssigneeSelect, assigneeText, deadlineInfo, DepartmentPicker, departmentNames, failureText, HelperPicker, newOperationId, sinceText, StatusChip, TagChips, tasksToday, useMembers, without } from './common';
import { childOrder, openCount, parentChoices } from './nesting';
import { openChildrenText, TaskStatusButtons } from './TaskStatusButtons';

type Changes = Partial<Record<string, string | string[] | null>>;

/** The loaded list, for a task's parent and children (2026-10-25). */
export interface TaskFamily {
  tasks: TaskView[];
  onOpen: (taskId: string) => void;
  onAddChild: (parent: TaskView) => void;
}

/**
 * Detail of one task from the Task service. The status saves on one press, like the list rows; every
 * other field saves separately with the version the user was looking at, and its save button appears
 * only once that field differs from the saved value. A concurrent change (Web or Discord) is reported,
 * never overwritten.
 */
export function TaskDetailPanel({
  taskId,
  departments = [],
  canEditRole,
  canReopen = false,
  refreshKey = 0,
  onChanged,
  family = null,
}: {
  taskId: string;
  departments?: Department[];
  canEditRole: (workspaceId: string) => boolean;
  /** Officers may reopen a done task (back to to-do). */
  canReopen?: boolean;
  /** Bumped when the list changes this task (its status buttons), so the detail follows. */
  refreshKey?: number;
  /** A save passes the task as saved (and whether its departments or parent changed); a reload passes nothing. */
  onChanged: (task?: TaskView, listChanged?: boolean) => void;
  /** Null when the Task service has no parent tasks. */
  family?: TaskFamily | null;
}) {
  const [refresh, setRefresh] = useState(0);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      void refreshKey;
      return api<TaskDetailResponse>('GET', `/api/tasks/${encodeURIComponent(taskId)}`, undefined, signal);
    },
    [taskId, refresh, refreshKey],
  );
  const detail = useLoader(load);
  const loadHistory = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      void refreshKey;
      void historyRefresh;
      return api<TaskHistoryEntry[]>('GET', `/api/tasks/${encodeURIComponent(taskId)}/history`, undefined, signal);
    },
    [taskId, refresh, refreshKey, historyRefresh],
  );
  const history = useLoader(loadHistory);
  // The task as the last save answered it (2026-10-26: a save waited for a reload of the detail, the history
  // and the list before anything changed). It is shown until a reload brings the same version or a newer one.
  const [answered, setAnswered] = useState<TaskView | null>(null);
  const loaded = detail.data?.task ?? null;
  const task = answered && (!loaded || answered.version > loaded.version) ? answered : loaded;
  const members = useMembers(task?.workspaceId ?? null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'conflict'; text: string } | null>(null);
  // What is being saved ('status' or a field) and what failed; only those wait. Saves go one after another,
  // each with the version the previous one made, so saving a second field never conflicts with the first.
  const [saving, setSaving] = useState<Record<string, true>>({});
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [pendingStatus, setPendingStatus] = useState<TaskStatus | null>(null);
  const [confirmDone, setConfirmDone] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const version = useRef<number | null>(null);
  useEffect(() => {
    if (task) version.current = task.version;
  }, [task]);
  // One operation ID per pending change; a retry after a failure reuses it.
  const pendingOps = useRef<Record<string, { key: string; id: string }>>({});

  const reload = () => {
    setRefresh((n) => n + 1);
    onChanged();
  };

  function write(what: string, label: string, send: (expectedVersion: number, operationId: string) => Promise<TaskMutationResponse>, ok: string, listChanged = false) {
    if (!task) return Promise.resolve();
    setSaving((s) => ({ ...s, [what]: true }));
    setFailed((f) => without(f, what));
    setMessage(null);
    const run = queue.current.then(async () => {
      const expected = version.current ?? task.version;
      const key = JSON.stringify({ v: expected, label });
      const previous = pendingOps.current[what];
      const operationId = previous?.key === key ? previous.id : newOperationId();
      pendingOps.current[what] = { key, id: operationId };
      try {
        const res = await send(expected, operationId);
        delete pendingOps.current[what];
        version.current = res.task.version;
        setAnswered(res.task);
        setMessage({ kind: 'ok', text: ok });
        setHistoryRefresh((n) => n + 1);
        onChanged(res.task, listChanged);
      } catch (err) {
        const conflict = err instanceof Error && 'status' in err && (err as { status: number }).status === 409;
        setMessage({ kind: conflict ? 'conflict' : 'error', text: failureText(err) });
        setFailed((f) => ({ ...f, [what]: true }));
      } finally {
        setSaving((s) => without(s, what));
      }
    });
    queue.current = run;
    return run;
  }

  // A department or parent change moves the task in the list, so the list reloads.
  const save = (what: string, changes: Changes, label: string, note = '') =>
    write(
      what,
      JSON.stringify(changes),
      (expectedVersion, operationId) => api<TaskMutationResponse>('PATCH', `/api/tasks/${encodeURIComponent(taskId)}`, { expectedVersion, operationId, changes }),
      `${label}を保存しました。${note}`,
      'tags' in changes || 'parentId' in changes,
    );

  const reopen = () =>
    void write(
      'status',
      'reopen',
      (expectedVersion, operationId) => api<TaskMutationResponse>('POST', `/api/tasks/${encodeURIComponent(taskId)}/reopen`, { expectedVersion, operationId }),
      'タスクを再開しました（未着手）。',
    );

  function chooseStatus(status: TaskStatus, confirmed = false) {
    if (!task || saving.status || status === task.status) return;
    // Only officers can reopen a done task, so a member confirms a completion first (as on the list).
    if (status === 'done' && !canReopen && !confirmed) {
      setMessage(null);
      setConfirmDone(true);
      return;
    }
    setConfirmDone(false);
    // The pressed button shows at once; it goes back if the save fails.
    setPendingStatus(status);
    const note = status === 'done' && openChildren > 0 ? openChildrenText(openChildren) : '';
    void save('status', { status }, `状態（${TASK_STATUS_LABELS[status]}）`, note).finally(() => setPendingStatus(null));
  }

  const notFound = detail.error && (detail.error.status === 404 || detail.error.status === 400 || detail.error.status === 403);
  if (notFound) {
    return (
      <p className="status error" role="alert" data-testid="task-not-found">
        タスクが見つからないか、表示する権限がありません。
      </p>
    );
  }
  const editable = !!task && canEditRole(task.workspaceId);
  const today = tasksToday();
  const due = task ? deadlineInfo(task, today) : null;
  // Parent tasks: from the list already loaded (no request of their own).
  const nested = family && task && task.parentId !== undefined ? family : null;
  const parentTask = nested && task?.parentId ? (nested.tasks.find((t) => t.id === task.parentId) ?? null) : null;
  const childTasks = nested && task ? nested.tasks.filter((t) => t.parentId === task.id).sort(childOrder) : [];
  const openChildren = openCount(childTasks);

  return (
    <div className="task-detail" data-testid="task-detail">
      <LoadStatus loader={detail} what="タスク" />
      {task && due && (
        <>
          <header className="detail-head task-detail-head">
            <div className="detail-title">
              <h2 className="thread-title">{task.title}</h2>
              <StatusChip status={task.status} />
            </div>
            <dl className="facts">
              <div>
                <dt>{task.helperIds !== undefined ? '主担当' : '担当者'}</dt>
                <dd className={task.assignee ? undefined : 'meta-warn'}>{task.assignee?.displayName ?? '未割当'}</dd>
              </div>
              {task.helpers && task.helpers.length > 0 && (
                <div>
                  <dt>副担当</dt>
                  <dd>{task.helpers.map((h) => h.displayName).join('、')}</dd>
                </div>
              )}
              <div>
                <dt>期限</dt>
                <dd className={`due due-${due.tone}`}>
                  <strong>{due.label}</strong>
                  {due.date && <small>{due.date}</small>}
                </dd>
              </div>
              {nested && task.parentId && (
                <div>
                  <dt>親タスク</dt>
                  <dd>
                    <button type="button" className="link-button" onClick={() => nested.onOpen(task.parentId!)}>
                      {taskNumber(task.parentId)} {parentTask?.title ?? ''}
                    </button>
                  </dd>
                </div>
              )}
              {task.tagLabels && task.tagLabels.length > 0 && (
                <div>
                  <dt>部局</dt>
                  <dd>
                    <TagChips labels={task.tagLabels} />
                  </dd>
                </div>
              )}
              <div>
                <dt>更新</dt>
                <dd>{sinceText(task.updatedAt)}</dd>
              </div>
            </dl>
            {detail.data!.provenance.length > 0 && (
              <div className="provenance" aria-label="元の受信案件">
                <span className="provenance-label">元の受信案件</span>
                <ul>
                  {detail.data!.provenance.map((p) => (
                    <li key={p.href}>
                      <span className={`source-badge ${p.kind === 'mail' ? 'source-email' : 'source-line'}`}>{p.kind === 'mail' ? 'メール' : 'LINE'}</span> <a href={p.href}>{p.label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </header>
          {message && (
            <div className={`status ${message.kind === 'ok' ? 'ok' : message.kind}`} role={message.kind === 'ok' ? 'status' : 'alert'}>
              {message.text}
              {message.kind === 'conflict' && (
                <button type="button" onClick={reload}>
                  最新の内容を読み込む
                </button>
              )}
            </div>
          )}
          {editable ? (
            <section className="detail-section" aria-label="状態">
              <h3 className="section-label">状態<span className="hint">押すとすぐ保存</span></h3>
              {task.status === 'done' && !canReopen ? (
                <p className="hint">完了しています。再開できるのは役員（委員長・副委員長・役員会）だけです。</p>
              ) : (
                <TaskStatusButtons
                  task={task}
                  canReopen={canReopen}
                  saving={!!saving.status}
                  disabled={!!saving.status}
                  pending={pendingStatus}
                  confirmingDone={confirmDone}
                  openChildren={openChildren}
                  onChoose={(s) => chooseStatus(s)}
                  onConfirmDone={() => chooseStatus('done', true)}
                  onCancelDone={() => setConfirmDone(false)}
                  onReopen={() => void reopen()}
                />
              )}
            </section>
          ) : (
            <p className="status info">閲覧のみの権限です。タスクは変更できません。</p>
          )}
          {nested && !task.parentId && (
            <section className="detail-section task-children" aria-label="子タスク">
              <h3 className="section-label">
                子タスク
                {childTasks.length > 0 && (
                  <span className="hint">
                    {childTasks.length - openChildren}/{childTasks.length} 完了
                  </span>
                )}
              </h3>
              {childTasks.length === 0 ? (
                <p className="hint">子タスクはありません。大きな仕事は子タスクに分けると、だれが何をどこまで進めたかが見えます。</p>
              ) : (
                <ul className="task-child-list">
                  {childTasks.map((c) => {
                    const childDue = deadlineInfo(c, today);
                    return (
                      <li key={c.id}>
                        <StatusChip status={c.status} />
                        <button type="button" className="link-button" onClick={() => nested.onOpen(c.id)}>
                          {c.title}
                        </button>
                        <span className="hint">
                          {assigneeText(c)}・
                          <span className={`due due-${childDue.tone}`}>
                            <strong>{childDue.label}</strong>
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {editable && (
                <button type="button" className="secondary small" onClick={() => nested.onAddChild(task)}>
                  ＋ 子タスクを追加
                </button>
              )}
            </section>
          )}
          <TaskFields
            task={task}
            members={members.data ?? []}
            departments={departments}
            parentChoices={nested ? parentChoices(nested.tasks, task.id) : null}
            hasChildren={childTasks.length > 0}
            editable={editable}
            saving={saving}
            failed={failed}
            onSave={save}
          />
          <details className="history task-history">
            <summary>
              変更履歴{history.data ? `（${history.data.length} 件）` : ''}
            </summary>
            <LoadStatus loader={history} what="変更履歴" compact />
            {history.data?.length === 0 && <p className="empty">変更履歴はまだありません。</p>}
            <ul data-testid="task-history">
              {(history.data ?? []).map((h) => (
                <li key={h.id}>
                  <span className="history-meta">
                    {fmtDate(h.at)} ・ {h.actorName}（{TASK_SOURCE_LABELS[h.source] ?? h.source}）・ 版 {h.version}
                  </span>
                  <span>
                    {h.action === 'created' ? '作成' : h.action === 'reopened' ? '再開' : '変更'}{' '}
                    {h.displayChanges
                      .filter((c) => h.action !== 'created' || c.field === 'title')
                      .map((c) => {
                        // The Task API records a parent by its number ("12"); show it as Discord does ("#12").
                        const show = (v: string | null) =>
                          (c.field === 'tags' ? departmentNames(v, departments) : c.field === 'parentId' && v !== null ? taskNumber(/^\d+$/.test(v) ? `task-${v}` : v) : v) ?? 'なし';
                        return `${TASK_FIELD_LABELS[c.field] ?? c.field}「${show(c.before)}」→「${show(c.after)}」`;
                      })
                      .join('、')}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          <p className="hint task-record-meta">
            タスク ID: <span data-testid="task-id">{task.id}</span> ／ 版: <span data-testid="task-version">{task.version}</span>（Discord の /todo でも同じ ID を使います）
          </p>
        </>
      )}
    </div>
  );
}

/** One editable field: its save and reset buttons appear only while it differs from the saved value. */
function Field({ label, children, dirty, disabled, saving = false, failed = false, saveLabel, onSave, onReset, extra, wide = false }: {
  label: ReactNode;
  children: ReactNode;
  dirty: boolean;
  disabled: boolean;
  saving?: boolean;
  failed?: boolean;
  saveLabel: string;
  onSave: () => void;
  onReset: () => void;
  extra?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`edit-field ${wide ? 'field-wide' : ''} ${dirty ? 'dirty' : ''}`}>
      {label}
      {children}
      {(dirty || extra || saving || failed) && (
        <div className="field-actions">
          {dirty && (
            <>
              <button type="button" className="small" disabled={disabled} onClick={onSave}>
                {saving ? '保存中…' : saveLabel}
              </button>
              <button type="button" className="quiet" disabled={disabled} onClick={onReset}>
                元に戻す
              </button>
            </>
          )}
          {extra}
          {saving && !dirty && (
            <span className="hint" role="status">
              保存中…
            </span>
          )}
          {failed && !saving && <span className="field-failed">保存できませんでした</span>}
        </div>
      )}
    </div>
  );
}

function TaskFields({
  task,
  members,
  departments,
  parentChoices: choices,
  hasChildren,
  editable,
  saving,
  failed,
  onSave,
}: {
  task: TaskView;
  members: TaskMember[];
  departments: Department[];
  /** Projects this task can go under; null without parent tasks. */
  parentChoices: TaskView[] | null;
  hasChildren: boolean;
  editable: boolean;
  saving: Record<string, true>;
  failed: Record<string, true>;
  onSave: (what: string, changes: Changes, label: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(task.title);
  const [assignee, setAssignee] = useState<string | null>(task.assigneeId);
  // Helpers (2026-10-28), only from a Task API that has them; edited and saved with the assignee.
  const helping = task.helperIds !== undefined;
  const [helpers, setHelpers] = useState<string[]>(task.helperIds ?? []);
  // A helper chosen as the assignee leaves the helpers; no assignee, no helpers (the Task API's rules).
  const chooseAssignee = (value: string | null) => {
    setAssignee(value);
    setHelpers((h) => (value === null ? [] : h.filter((v) => v !== value)));
  };
  const [deadline, setDeadline] = useState(task.deadline ?? '');
  const [reqs, setReqs] = useState(task.requirements);
  const [tags, setTags] = useState<string[]>(task.tags ?? []);
  const [parent, setParent] = useState<string | null>(task.parentId ?? null);
  // Follow newer server values only where this draft is untouched. A save or a
  // conflict reload must not discard edits to another field.
  const [previous, setPrevious] = useState(task);
  if (task.version !== previous.version) {
    setPrevious(task);
    if (title === previous.title || title.trim() === task.title) setTitle(task.title);
    // The assignee and the helpers are one draft: both follow, or neither.
    if (assignee === previous.assigneeId && helpers.join(',') === (previous.helperIds ?? []).join(',')) {
      setAssignee(task.assigneeId);
      setHelpers(task.helperIds ?? []);
    }
    if (deadline === (previous.deadline ?? '')) setDeadline(task.deadline ?? '');
    const nextReqs = { ...reqs };
    for (const field of REQUIREMENT_FIELDS) {
      if (reqs[field] === previous.requirements[field] || reqs[field].trim() === task.requirements[field]) nextReqs[field] = task.requirements[field];
    }
    setReqs(nextReqs);
    if (tags.join(',') === (previous.tags ?? []).join(',')) setTags(task.tags ?? []);
    if (parent === (previous.parentId ?? null)) setParent(task.parentId ?? null);
  }
  // Only the field being saved waits.
  const disabled = (what: string) => !editable || !!saving[what];
  const state = (what: string) => ({ saving: !!saving[what], failed: !!failed[what] });
  const dirty = {
    title: title !== task.title,
    assignee: assignee !== task.assigneeId || helpers.join(',') !== (task.helperIds ?? []).join(','),
    deadline: (deadline || null) !== task.deadline,
    tags: (task.tags ?? []).join(',') !== tags.join(','),
    parent: (task.parentId ?? null) !== parent,
    ...Object.fromEntries(REQUIREMENT_FIELDS.map((f) => [f, reqs[f] !== task.requirements[f]])),
  } as Record<string, boolean>;
  const unsaved = [
    dirty.title && 'タイトル',
    dirty.assignee && (helping ? '担当' : '担当者'),
    dirty.deadline && '期限',
    dirty.tags && '部局',
    dirty.parent && '親タスク',
    ...REQUIREMENT_FIELDS.map((f) => dirty[f] && REQUIREMENT_LABELS[f]),
  ].filter(Boolean);
  const missing = task.missingRequirements.map((f) => REQUIREMENT_LABELS[f]);

  return (
    <div className="task-fields">
      <section className="detail-section" aria-label="基本情報">
        <h3 className="section-label">基本情報</h3>
        <div className="form-grid">
          <Field
            wide
            label={<label htmlFor="task-title">タイトル</label>}
            dirty={dirty.title!}
            disabled={disabled('title') || title.trim() === ''}
            {...state('title')}
            saveLabel="タイトルを保存"
            onSave={() => void onSave('title', { title }, 'タイトル')}
            onReset={() => setTitle(task.title)}
          >
            <input id="task-title" value={title} maxLength={TASK_LIMITS.titleMax} disabled={!editable} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          {helping ? (
            <Field
              wide
              label={null}
              dirty={dirty.assignee!}
              disabled={disabled('assignee')}
              {...state('assignee')}
              saveLabel="担当を保存"
              onSave={() => void onSave('assignee', { assigneeId: assignee, helperIds: helpers }, '担当')}
              onReset={() => {
                setAssignee(task.assigneeId);
                setHelpers(task.helperIds ?? []);
              }}
            >
              <div className="assignee-pair">
                <label htmlFor="task-assignee">
                  主担当
                  <AssigneeSelect id="task-assignee" members={members} value={assignee} disabled={!editable} onChange={chooseAssignee} />
                </label>
                <div>
                  <label htmlFor="task-helpers">副担当（任意・{TASK_LIMITS.helpersMax} 人まで）</label>
                  <HelperPicker id="task-helpers" members={members} assignee={assignee} value={helpers} disabled={!editable} known={task.helpers} onChange={setHelpers} />
                </div>
              </div>
            </Field>
          ) : (
            <Field
              label={<label htmlFor="task-assignee">担当者</label>}
              dirty={dirty.assignee!}
              disabled={disabled('assignee')}
              {...state('assignee')}
              saveLabel="担当者を保存"
              onSave={() => void onSave('assignee', { assigneeId: assignee }, '担当者')}
              onReset={() => setAssignee(task.assigneeId)}
            >
              <AssigneeSelect id="task-assignee" members={members} value={assignee} disabled={!editable} onChange={setAssignee} />
            </Field>
          )}
          <Field
            label={<label htmlFor="task-deadline">期限</label>}
            dirty={dirty.deadline!}
            disabled={disabled('deadline')}
            {...state('deadline')}
            saveLabel="期限を保存"
            onSave={() => void onSave('deadline', { deadline: deadline || null }, '期限')}
            onReset={() => setDeadline(task.deadline ?? '')}
            extra={
              editable && task.deadline !== null && !dirty.deadline ? (
                <button type="button" className="quiet" disabled={disabled('deadline')} onClick={() => void onSave('deadline', { deadline: null }, '期限')}>
                  期限をなしにする
                </button>
              ) : undefined
            }
          >
            <input id="task-deadline" type="date" value={deadline} disabled={!editable} onChange={(e) => setDeadline(e.target.value)} />
          </Field>
          {departments.length > 0 && task.tags && (
            <Field
              wide
              label={null}
              dirty={dirty.tags!}
              disabled={disabled('tags') || tags.length === 0}
              {...state('tags')}
              saveLabel="部局を保存"
              onSave={() => void onSave('tags', { tags }, '部局')}
              onReset={() => setTags(task.tags ?? [])}
            >
              <DepartmentPicker departments={departments} value={tags} onChange={setTags} disabled={!editable} />
            </Field>
          )}
          {choices && (
            <Field
              wide
              label={<label htmlFor="task-parent">親タスク</label>}
              dirty={dirty.parent!}
              disabled={disabled('parent')}
              {...state('parent')}
              saveLabel="親タスクを保存"
              onSave={() => void onSave('parent', { parentId: parent }, '親タスク')}
              onReset={() => setParent(task.parentId ?? null)}
            >
              <select
                id="task-parent"
                value={parent ?? ''}
                disabled={!editable || hasChildren}
                aria-describedby={hasChildren ? 'task-parent-hint' : undefined}
                onChange={(e) => setParent(e.target.value || null)}
              >
                <option value="">なし</option>
                {parent && !choices.some((t) => t.id === parent) && <option value={parent}>{taskNumber(parent)}</option>}
                {choices.map((t) => (
                  <option key={t.id} value={t.id}>
                    {taskNumber(t.id)} {t.title}
                  </option>
                ))}
              </select>
              {hasChildren && <p id="task-parent-hint" className="hint">子タスクがあるタスクは、ほかのタスクの下に入れられません（親子は 1 段までです）。</p>}
            </Field>
          )}
        </div>
      </section>
      <section className="detail-section" aria-label="タスクの内容">
        <h3 className="section-label">
          タスクの内容
          {missing.length > 0 && <span className="meta-warn task-missing">未記入: {missing.join('・')}</span>}
        </h3>
        <div className="form-grid">
          {REQUIREMENT_FIELDS.map((field) => (
            <Field
              key={field}
              label={<label htmlFor={`task-${field}`}>{REQUIREMENT_LABELS[field]}</label>}
              dirty={dirty[field]!}
              disabled={disabled(field)}
              {...state(field)}
              saveLabel={`${REQUIREMENT_LABELS[field]}を保存`}
              onSave={() => void onSave(field, { [field]: reqs[field] }, REQUIREMENT_LABELS[field])}
              onReset={() => setReqs({ ...reqs, [field]: task.requirements[field] })}
            >
              <textarea id={`task-${field}`} rows={3} maxLength={TASK_LIMITS.textMax} value={reqs[field]} disabled={!editable} onChange={(e) => setReqs({ ...reqs, [field]: e.target.value })} />
            </Field>
          ))}
        </div>
      </section>
      {unsaved.length > 0 && (
        <p className="unsaved-bar" role="status" data-testid="task-unsaved">
          未保存の変更: {unsaved.join('・')}（項目ごとの「保存」を押すと保存します）
        </p>
      )}
    </div>
  );
}
