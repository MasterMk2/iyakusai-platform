import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { todayInTimeZone } from '../../shared/dates.js';
import {
  createTaskSchema,
  formatIssues,
  reopenTaskSchema,
  taskListQuerySchema,
  updateMemberSchema,
  updateTaskSchema,
} from '../../shared/schemas.js';
import {
  REQUIREMENT_FIELDS,
  type ChangeSource,
  type FieldChange,
  type HistoryAction,
  type HistoryView,
  type MeResponse,
  type MemberMutationResponse,
  type MembershipAuditView,
  type MemberView,
  type PersonaView,
  type Task,
  type TaskMutationResponse,
  type TaskStatus,
  type TaskView,
} from '../../shared/types.js';
import { FaultInjector } from '../storage/faults.js';
import { CommitUncertainError, StaleStateError, type Store } from '../storage/store.js';
import { AppError } from './errors.js';
import { activeMembership, requireTaskAccess, requireUser, requireWorkspaceRole } from './permissions.js';
import { createSeedState } from './seed.js';
import { MAX_OPERATION_RECORDS, type AppState, type ResultRef } from './state.js';
import { toAuditView, toHistoryView, toMemberView, toTaskView } from './views.js';

/** 操作の呼び出し元。Web UI と模擬 Bot は同じ操作を同じ権限判定で使う。 */
export interface ActorContext {
  actorId: string;
  source: Exclude<ChangeSource, 'system'>;
  /** 再送で同じ操作を二重に適用しないための ID。 */
  operationId?: string;
  /** 指定した委員会のタスクだけを対象にする（模擬 Bot のチャンネル単位）。 */
  scopeWorkspaceId?: string;
  /**
   * 再送判定の範囲（Discord 連携の guild/channel など）。指定すると委員会に加えて指紋に含め、
   * 同じ委員会に対応する別チャンネルからの同じ操作 ID の再送も別内容として扱う。
   */
  scopeKey?: string;
}

export interface TaskServiceOptions {
  store: Store;
  /** 保存済みの状態がないときにサンプルデータを作るか。保護モードでは false（無断で初期化しない）。 */
  seedIfMissing?: boolean;
  faults?: FaultInjector;
  clock?: () => Date;
}

const STATUS_ORDER: Record<TaskStatus, number> = { in_progress: 0, blocked: 1, todo: 2, done: 3 };

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('VALIDATION', '入力内容を確認してください。', { details: formatIssues(result.error) });
  }
  return result.data;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** scope は模擬 Bot のチャンネルの委員会。別チャンネルでの同じ操作 ID の再送を別内容として扱う。 */
function fingerprint(kind: string, target: string, payload: unknown, scope: string | undefined): string {
  return createHash('sha256').update(stableStringify({ kind, target, payload, scope })).digest('hex');
}

const RELOAD_FAILED_MESSAGE =
  '保存データの確定状態を確認できないため、処理を止めています。しばらくしてから再度お試しください（続く場合は運用者がサービスを確認してください）。';

/**
 * 委員会タスクの共通操作。すべての読み取りと変更で所属と役割を確認し、
 * 変更は「複製に適用 → 保存 → 成功時のみ反映」の順で行う。
 */
export class TaskService {
  private state: AppState;
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * 保存が確定したか不明、または保存ファイルが他から変わっていた。メモリ上の状態は古い可能性があるため使わず、
   * 次の読み取り・変更の前に保存ファイルを読み直す（読み直せるまで 503）。
   */
  private reloadRequired = false;
  readonly faults: FaultInjector;
  private readonly store: Store;
  private readonly clock: () => Date;

  private constructor(state: AppState, options: TaskServiceOptions) {
    this.state = state;
    this.store = options.store;
    this.faults = options.faults ?? new FaultInjector();
    this.clock = options.clock ?? (() => new Date());
  }

  /** 保存済みの状態を読み込む。なければサンプルデータを作成して保存する。 */
  static async open(options: TaskServiceOptions): Promise<TaskService> {
    const clock = options.clock ?? (() => new Date());
    const loaded = await options.store.load();
    if (loaded) return new TaskService(loaded, options);
    if (options.seedIfMissing === false) {
      throw new AppError('LOAD_FAILED', '保存済みのデータがありません。保護モードではサンプルデータを自動作成しません。');
    }
    const seeded = createSeedState(clock());
    await options.store.save(seeded);
    return new TaskService(seeded, options);
  }

  get storageDescription(): string {
    return this.store.description;
  }

  /** 起動時の設定検証用の複製（委員会・利用者の存在確認）。 */
  snapshotForValidation(): AppState {
    return structuredClone(this.state);
  }

  private today(): string {
    return todayInTimeZone(this.clock());
  }

  // ---- 読み取り ----

  listPersonas(): PersonaView[] {
    this.requireLoaded();
    return this.state.users.map(({ id, displayName, email, personaNote }) => ({ id, displayName, email, personaNote }));
  }

  getMe(actorId: string): MeResponse {
    this.requireLoaded();
    const user = requireUser(this.state, actorId);
    const memberships = this.state.memberships
      .filter((membership) => membership.userId === actorId && membership.active)
      .flatMap((membership) => {
        const workspace = this.state.workspaces.find((candidate) => candidate.id === membership.workspaceId);
        return workspace ? [{ workspace: structuredClone(workspace), role: membership.role }] : [];
      });
    const { id, displayName, email, personaNote } = user;
    return { user: { id, displayName, email, personaNote }, memberships };
  }

  async listTasks(actorId: string, workspaceId: string, query: unknown = {}): Promise<TaskView[]> {
    await this.beforeRead();
    const state = this.state;
    requireWorkspaceRole(state, actorId, workspaceId, 'viewer');
    const filters = parseInput(taskListQuerySchema, query);
    const today = this.today();
    return state.tasks
      .filter((task) => task.workspaceId === workspaceId)
      .map((task) => toTaskView(state, task, today))
      .filter((task) => filters.status === undefined || task.status === filters.status)
      .filter((task) => {
        if (filters.assignee === undefined) return true;
        if (filters.assignee === 'none') return task.assigneeId === null;
        return task.assigneeId === filters.assignee;
      })
      .filter((task) => {
        if (filters.deadline === undefined) return true;
        if (filters.deadline === 'none') return task.deadline === null;
        if (filters.deadline === 'set') return task.deadline !== null;
        return task.overdue;
      })
      .sort(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
          (a.deadline ?? '9999-99-99').localeCompare(b.deadline ?? '9999-99-99') ||
          Number(a.id.slice(5)) - Number(b.id.slice(5)),
      );
  }

  async getTask(actorId: string, taskId: string, scopeWorkspaceId?: string): Promise<TaskView> {
    await this.beforeRead();
    const state = this.state;
    const task = requireTaskAccess(state, actorId, taskId, 'viewer', scopeWorkspaceId);
    return toTaskView(state, task, this.today());
  }

  async getHistory(actorId: string, taskId: string): Promise<HistoryView[]> {
    await this.beforeRead();
    const state = this.state;
    requireTaskAccess(state, actorId, taskId, 'viewer');
    return state.history
      .filter((entry) => entry.taskId === taskId)
      .map((entry) => toHistoryView(state, entry))
      .reverse();
  }

  async listMembers(actorId: string, workspaceId: string): Promise<MemberView[]> {
    await this.beforeRead();
    const state = this.state;
    requireWorkspaceRole(state, actorId, workspaceId, 'viewer');
    return state.memberships
      .filter((membership) => membership.workspaceId === workspaceId)
      .map((membership) => toMemberView(state, membership));
  }

  async listMembershipAudit(actorId: string, workspaceId: string): Promise<MembershipAuditView[]> {
    await this.beforeRead();
    const state = this.state;
    requireWorkspaceRole(state, actorId, workspaceId, 'admin');
    return state.membershipAudit
      .filter((entry) => entry.workspaceId === workspaceId)
      .map((entry) => toAuditView(state, entry))
      .reverse();
  }

  /** 模擬 Bot 用の対応表。実在の Discord 識別子は含まない。 */
  mockBotDirectory() {
    this.requireLoaded();
    const state = this.state;
    return {
      channels: state.mockBot.channels.map((channel) => ({
        ...channel,
        workspaceName: state.workspaces.find((workspace) => workspace.id === channel.workspaceId)?.name ?? '',
      })),
      accounts: state.mockBot.accounts.map((account) => ({
        ...account,
        displayName: state.users.find((user) => user.id === account.userId)?.displayName ?? '',
      })),
    };
  }

  // ---- 変更 ----

  async createTask(ctx: ActorContext, workspaceId: string, input: unknown): Promise<TaskMutationResponse> {
    const parsed = parseInput(createTaskSchema, input);
    const payload = { ...parsed, operationId: undefined };
    return this.mutateTask(ctx, 'create-task', workspaceId, payload, (draft, now) => {
      requireWorkspaceRole(draft, ctx.actorId, workspaceId, 'editor');
      if (ctx.scopeWorkspaceId !== undefined && ctx.scopeWorkspaceId !== workspaceId) {
        throw new AppError('FORBIDDEN', 'この委員会を利用する権限がありません。');
      }
      const assigneeId = payload.assigneeId ?? null;
      if (assigneeId !== null) this.requireAssignable(draft, workspaceId, assigneeId);
      draft.counters.task += 1;
      const task: Task = {
        id: `task-${draft.counters.task}`,
        workspaceId,
        title: payload.title,
        description: payload.description ?? '',
        assigneeId,
        deadline: payload.deadline ?? null,
        status: 'todo',
        requirements: {
          purpose: payload.requirements?.purpose ?? '',
          deliverable: payload.requirements?.deliverable ?? '',
          completionCriteria: payload.requirements?.completionCriteria ?? '',
          openQuestions: payload.requirements?.openQuestions ?? '',
        },
        version: 1,
        createdAt: now,
        createdBy: ctx.actorId,
        updatedAt: now,
        updatedBy: ctx.actorId,
      };
      draft.tasks.push(task);
      const changes: FieldChange[] = [{ field: 'title', before: null, after: task.title }];
      if (task.description !== '') changes.push({ field: 'description', before: null, after: task.description });
      if (task.assigneeId !== null) changes.push({ field: 'assigneeId', before: null, after: task.assigneeId });
      if (task.deadline !== null) changes.push({ field: 'deadline', before: null, after: task.deadline });
      changes.push({ field: 'status', before: null, after: task.status });
      for (const field of REQUIREMENT_FIELDS) {
        if (task.requirements[field] !== '') changes.push({ field, before: null, after: task.requirements[field] });
      }
      this.appendHistory(draft, ctx, task, 'created', changes, now);
      return task.id;
    });
  }

  async updateTask(ctx: ActorContext, taskId: string, input: unknown): Promise<TaskMutationResponse> {
    const parsed = parseInput(updateTaskSchema, input);
    return this.applyTaskUpdate(ctx, taskId, parsed.changes, parsed.expectedVersion);
  }

  /**
   * 模擬 Bot のように更新版を持たない入口用。expectedVersion を省略した場合は最新版に適用する。
   */
  async updateTaskUnversioned(
    ctx: ActorContext,
    taskId: string,
    changes: unknown,
    expectedVersion?: number,
  ): Promise<TaskMutationResponse> {
    const parsed = parseInput(updateTaskSchema.shape.changes, changes);
    return this.applyTaskUpdate(ctx, taskId, parsed, expectedVersion);
  }

  private async applyTaskUpdate(
    ctx: ActorContext,
    taskId: string,
    changes: z.infer<typeof updateTaskSchema>['changes'],
    expectedVersion: number | undefined,
  ): Promise<TaskMutationResponse> {
    return this.mutateTask(ctx, 'update-task', taskId, { changes, expectedVersion }, (draft, now) => {
      const task = requireTaskAccess(draft, ctx.actorId, taskId, 'editor', ctx.scopeWorkspaceId);
      this.checkVersion(draft, task, expectedVersion);

      const fieldChanges: FieldChange[] = [];
      const record = (field: FieldChange['field'], before: string | null, after: string | null) => {
        if (before !== after) fieldChanges.push({ field, before, after });
      };
      if (changes.title !== undefined) record('title', task.title, changes.title);
      if (changes.description !== undefined) record('description', task.description, changes.description);
      if (changes.assigneeId !== undefined) {
        if (changes.assigneeId !== null && changes.assigneeId !== task.assigneeId) {
          this.requireAssignable(draft, task.workspaceId, changes.assigneeId);
        }
        record('assigneeId', task.assigneeId, changes.assigneeId);
      }
      if (changes.deadline !== undefined) record('deadline', task.deadline, changes.deadline);
      if (changes.status !== undefined) {
        if (task.status === 'done' && changes.status !== 'done') {
          throw new AppError('INVALID_TRANSITION', '完了したタスクは「再開」操作で未着手に戻してから変更してください。');
        }
        record('status', task.status, changes.status);
      }
      for (const field of REQUIREMENT_FIELDS) {
        const value = changes[field];
        if (value !== undefined) record(field, task.requirements[field], value);
      }
      if (fieldChanges.length === 0) throw new AppError('NO_CHANGE', '変更点がありません。');

      for (const change of fieldChanges) {
        switch (change.field) {
          case 'title':
            task.title = change.after ?? '';
            break;
          case 'description':
            task.description = change.after ?? '';
            break;
          case 'assigneeId':
            task.assigneeId = change.after;
            break;
          case 'deadline':
            task.deadline = change.after;
            break;
          case 'status':
            task.status = change.after as TaskStatus;
            break;
          default:
            task.requirements[change.field] = change.after ?? '';
        }
      }
      this.bumpVersion(task, ctx, now);
      this.appendHistory(draft, ctx, task, 'updated', fieldChanges, now);
      return task.id;
    });
  }

  /** 完了したタスクを未着手に戻す。完了からの状態変更はこの操作だけで行う。 */
  async reopenTask(ctx: ActorContext, taskId: string, input: unknown): Promise<TaskMutationResponse> {
    const parsed = parseInput(reopenTaskSchema, input);
    return this.reopenTaskUnversioned(ctx, taskId, parsed.expectedVersion);
  }

  async reopenTaskUnversioned(ctx: ActorContext, taskId: string, expectedVersion?: number): Promise<TaskMutationResponse> {
    return this.mutateTask(ctx, 'reopen-task', taskId, { expectedVersion }, (draft, now) => {
      const task = requireTaskAccess(draft, ctx.actorId, taskId, 'editor', ctx.scopeWorkspaceId);
      this.checkVersion(draft, task, expectedVersion);
      if (task.status !== 'done') throw new AppError('INVALID_TRANSITION', '再開できるのは完了したタスクだけです。');
      task.status = 'todo';
      this.bumpVersion(task, ctx, now);
      this.appendHistory(draft, ctx, task, 'reopened', [{ field: 'status', before: 'done', after: 'todo' }], now);
      return task.id;
    });
  }

  async updateMember(
    ctx: ActorContext,
    workspaceId: string,
    userId: string,
    input: unknown,
  ): Promise<MemberMutationResponse> {
    const parsed = parseInput(updateMemberSchema, input);
    const payload = { role: parsed.role, active: parsed.active };
    const { value, replayed } = await this.mutate(
      ctx,
      'update-member',
      `${workspaceId}/${userId}`,
      payload,
      (draft, now): ResultRef => {
        requireWorkspaceRole(draft, ctx.actorId, workspaceId, 'admin');
        const membership = draft.memberships.find(
          (candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId,
        );
        if (!membership) throw new AppError('NOT_FOUND', 'この委員会に該当するメンバーがいません。');
        if (userId === ctx.actorId) {
          throw new AppError('FORBIDDEN', '自分自身の役割や有効・無効は変更できません（管理者がいなくなるのを防ぐため）。');
        }
        const changes: Array<{ field: 'role' | 'active'; before: string; after: string }> = [];
        if (payload.role !== undefined && payload.role !== membership.role) {
          changes.push({ field: 'role', before: membership.role, after: payload.role });
          membership.role = payload.role;
        }
        if (payload.active !== undefined && payload.active !== membership.active) {
          changes.push({ field: 'active', before: String(membership.active), after: String(payload.active) });
          membership.active = payload.active;
        }
        if (changes.length === 0) throw new AppError('NO_CHANGE', '変更点がありません。');
        draft.counters.audit += 1;
        draft.membershipAudit.push({
          id: `audit-${draft.counters.audit}`,
          workspaceId,
          targetUserId: userId,
          actorId: ctx.actorId,
          at: now,
          changes,
        });
        return { type: 'member', workspaceId, userId };
      },
    );
    if (value.type !== 'member') throw new AppError('INTERNAL', '操作記録の種類が一致しません。');
    // 再送時も現在の権限で確認し、現在の内容を返す。
    requireWorkspaceRole(this.state, ctx.actorId, value.workspaceId, 'admin');
    const membership = this.state.memberships.find(
      (candidate) => candidate.workspaceId === value.workspaceId && candidate.userId === value.userId,
    );
    if (!membership) throw new AppError('NOT_FOUND', 'この委員会に該当するメンバーがいません。');
    return { member: toMemberView(this.state, membership), replayed };
  }

  /** サンプルデータに戻す。デモ用の操作で、障害注入の設定も解除する。 */
  async resetDemoData(): Promise<void> {
    await this.exclusive(async () => {
      await this.reloadIfRequired();
      await this.commit(createSeedState(this.clock()));
      this.faults.clear();
    });
  }

  // ---- 内部処理 ----

  private requireLoaded(): void {
    if (this.reloadRequired) throw new AppError('LOAD_FAILED', RELOAD_FAILED_MESSAGE);
  }

  private async beforeRead(): Promise<void> {
    await this.faults.beforeLoad();
    if (this.reloadRequired) await this.exclusive(() => this.reloadIfRequired());
  }

  /** 直列化の内側で呼ぶ。保存ファイルを読み直して（POSIX では fsync して確定させて）から使う。 */
  private async reloadIfRequired(): Promise<void> {
    if (!this.reloadRequired) return;
    let loaded: AppState | null;
    try {
      loaded = await this.store.load();
    } catch {
      throw new AppError('LOAD_FAILED', RELOAD_FAILED_MESSAGE);
    }
    if (!loaded) throw new AppError('LOAD_FAILED', RELOAD_FAILED_MESSAGE);
    this.state = loaded;
    this.reloadRequired = false;
  }

  /**
   * 状態全体（タスク・版・履歴・操作記録）を 1 回の保存で確定し、確定したときだけメモリに反映する。
   * 確定前の失敗はメモリもファイルも変更前のまま。確定したか不明な失敗と、他からの変更の検出では、
   * メモリ上の状態を使わず次の操作の前に読み直す。
   */
  private async commit(next: AppState): Promise<void> {
    try {
      await this.store.save(next);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof CommitUncertainError) {
        this.reloadRequired = true;
        throw new AppError(
          'SAVE_FAILED',
          '保存の完了を確認できませんでした。変更が反映されたかどうかは確定していません。同じ操作 ID で再送してください（反映済みであれば重複せず、現在の内容を返します）。',
        );
      }
      if (error instanceof StaleStateError) {
        this.reloadRequired = true;
        throw new AppError('SAVE_FAILED', '保存データが他の処理で変更されていたため、保存しませんでした。最新の内容を確認してから、もう一度操作してください。');
      }
      throw new AppError('SAVE_FAILED', '保存に失敗しました。変更は反映されていません。もう一度お試しください。');
    }
    this.state = next;
  }

  private requireAssignable(state: AppState, workspaceId: string, userId: string): void {
    if (!activeMembership(state, userId, workspaceId)) {
      throw new AppError('VALIDATION', '担当者はこの委員会の有効なメンバーから選んでください。', {
        details: [{ path: 'assigneeId', message: 'この委員会の有効なメンバーではありません' }],
      });
    }
  }

  private checkVersion(state: AppState, task: Task, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && task.version !== expectedVersion) {
      throw new AppError(
        'VERSION_CONFLICT',
        `他の操作で先に更新されています（現在の版: ${task.version}）。最新の内容を確認してから、もう一度操作してください。`,
        { current: toTaskView(state, task, this.today()) },
      );
    }
  }

  private bumpVersion(task: Task, ctx: ActorContext, now: string): void {
    task.version += 1;
    task.updatedAt = now;
    task.updatedBy = ctx.actorId;
  }

  private appendHistory(
    draft: AppState,
    ctx: ActorContext,
    task: Task,
    action: HistoryAction,
    changes: FieldChange[],
    now: string,
  ): void {
    draft.counters.history += 1;
    draft.history.push({
      id: `hist-${draft.counters.history}`,
      taskId: task.id,
      workspaceId: task.workspaceId,
      version: task.version,
      action,
      actorId: ctx.actorId,
      at: now,
      source: ctx.source,
      operationId: ctx.operationId ?? null,
      changes,
    });
  }

  private async mutateTask(
    ctx: ActorContext,
    kind: string,
    target: string,
    payload: unknown,
    apply: (draft: AppState, now: string) => string,
  ): Promise<TaskMutationResponse> {
    const { value, replayed } = await this.mutate(ctx, kind, target, payload, (draft, now): ResultRef => ({
      type: 'task',
      taskId: apply(draft, now),
    }));
    if (value.type !== 'task') throw new AppError('INTERNAL', '操作記録の種類が一致しません。');
    // 再送時も現在の権限とチャンネルの範囲で確認し、現在のタスクを返す。
    const task = requireTaskAccess(this.state, ctx.actorId, value.taskId, 'viewer', ctx.scopeWorkspaceId);
    return { task: toTaskView(this.state, task, this.today()), replayed };
  }

  /**
   * 変更の共通手順。直列化 →（必要なら読み直し）→ 操作 ID の確認 → 複製に適用 → 保存 → 反映。
   * 適用や確定前の保存の失敗では、メモリ上の状態も保存ファイルも変更前のまま残る（commit を参照）。
   */
  private async mutate(
    ctx: ActorContext,
    kind: string,
    target: string,
    payload: unknown,
    apply: (draft: AppState, now: string) => ResultRef,
  ): Promise<{ value: ResultRef; replayed: boolean }> {
    return this.exclusive(async () => {
      await this.reloadIfRequired();
      requireUser(this.state, ctx.actorId);
      const key = ctx.operationId === undefined ? null : `${ctx.source}:${ctx.actorId}:${ctx.operationId}`;
      const scope = ctx.scopeKey === undefined ? ctx.scopeWorkspaceId : `${ctx.scopeKey}|${ctx.scopeWorkspaceId ?? ''}`;
      const print = fingerprint(kind, target, payload, scope);
      if (key !== null) {
        const prior = this.state.operations.find((record) => record.key === key);
        if (prior) {
          if (prior.fingerprint !== print) {
            throw new AppError('IDEMPOTENCY_CONFLICT', '同じ操作 ID で異なる内容が送られました。新しい操作 ID で送り直してください。');
          }
          return { value: structuredClone(prior.result), replayed: true };
        }
      }

      const draft = structuredClone(this.state);
      const now = this.clock().toISOString();
      const value = apply(draft, now);
      if (key !== null && ctx.operationId !== undefined) {
        draft.operations.push({
          key,
          source: ctx.source,
          actorId: ctx.actorId,
          operationId: ctx.operationId,
          fingerprint: print,
          result: value,
          at: now,
        });
        if (draft.operations.length > MAX_OPERATION_RECORDS) {
          draft.operations.splice(0, draft.operations.length - MAX_OPERATION_RECORDS);
        }
      }
      await this.faults.beforeSave();
      await this.commit(draft);
      return { value, replayed: false };
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
