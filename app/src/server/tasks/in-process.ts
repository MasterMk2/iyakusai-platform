import { summarizeTaskGroups, type TaskSummaryResponse } from '../../shared/task-summary.js';
import { AppError } from '../../task-service/server/domain/errors.js';
import type { ActorContext, TaskService } from '../../task-service/server/domain/taskService.js';
import type { TaskContextResponse, TaskHistoryEntry, TaskMember, TaskMutationResponse, TaskView } from '../../shared/tasks.js';
import { TaskServiceError, type TaskBackend } from './client.js';

// The Task service running in this process. It answers exactly as the protected integration API
// (src/task-service/server/integration/app.ts) does for the web gateway, so the routes and the
// screens do not change: the same response shapes, the same required operation ID on create, and
// the same failure split. A 4xx AppError is definitive (nothing was applied); 401, a 5xx AppError
// (load/save failures) or any other error is "unavailable", which for a write means the outcome is
// unknown. Results are copied through JSON so no caller holds a reference into the service's state.

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function operationIdOf(input: Record<string, unknown>): string | undefined {
  return typeof input.operationId === 'string' ? input.operationId : undefined;
}

/**
 * This Task service has no department tags, no parent tasks and no helpers (only the Bot-host Task API
 * has); refuse them plainly.
 */
function refuseTags(input: Record<string, unknown>): void {
  const changes = input.changes;
  const sent = (field: string) => field in input || (changes !== null && typeof changes === 'object' && field in changes);
  if (sent('tags')) {
    throw new AppError('VALIDATION', '部局タグはこのサーバーのタスク機能では使えません。', { details: [{ path: 'tags', message: '使えません' }] });
  }
  if (sent('parentId')) {
    throw new AppError('VALIDATION', '親タスクはこのサーバーのタスク機能では使えません。', { details: [{ path: 'parentId', message: '使えません' }] });
  }
  if (sent('helperIds')) {
    throw new AppError('VALIDATION', '副担当はこのサーバーのタスク機能では使えません。', { details: [{ path: 'helperIds', message: '使えません' }] });
  }
}

export class InProcessTaskBackend implements TaskBackend {
  constructor(private readonly service: TaskService) {}

  private async run<T>(call: () => T | Promise<T>): Promise<T> {
    try {
      return copy(await call());
    } catch (err) {
      if (err instanceof AppError && err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 401) {
        throw new TaskServiceError('definitive', err.httpStatus, {
          code: err.code,
          message: err.message,
          ...(err.options.details ? { details: err.options.details } : {}),
          ...(err.options.current ? { current: copy(err.options.current) as unknown as TaskView } : {}),
        });
      }
      throw new TaskServiceError('unavailable', err instanceof AppError ? err.httpStatus : 500, null);
    }
  }

  private ctx(actor: string, input: Record<string, unknown>): ActorContext {
    const operationId = operationIdOf(input);
    return { actorId: actor, source: 'web', ...(operationId !== undefined ? { operationId } : {}) };
  }

  me(actor: string): Promise<{ user: { id: string; displayName: string }; memberships: TaskContextResponse['memberships'] }> {
    return this.run(() => {
      const me = this.service.getMe(actor);
      return { user: { id: me.user.id, displayName: me.user.displayName }, memberships: me.memberships };
    });
  }

  listTasks(actor: string, workspaceId: string, query: Record<string, string | undefined>): Promise<TaskView[]> {
    const defined = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined));
    return this.run(() => this.service.listTasks(actor, workspaceId, defined)) as Promise<TaskView[]>;
  }

  /** Only the Bot-host Task API (department tags) lists every department at once; the screens ask it only then. */
  listAllTasks(): Promise<TaskView[]> {
    return this.run(() => {
      throw new AppError('NOT_FOUND', '部局をまとめた一覧はこのサーバーのタスク機能では使えません。');
    });
  }

  summary(actor: string): Promise<TaskSummaryResponse> {
    return this.run(async () => {
      const { memberships } = this.service.getMe(actor);
      const groups = [];
      for (const { workspace } of memberships) {
        const tasks = await this.service.listTasks(actor, workspace.id);
        groups.push({ workspaceId: workspace.id, name: workspace.name, tasks });
      }
      return summarizeTaskGroups(groups, new Date().toISOString());
    });
  }

  members(actor: string, workspaceId: string): Promise<TaskMember[]> {
    return this.run(async () => {
      const members = await this.service.listMembers(actor, workspaceId);
      // The common screens do not need e-mail addresses.
      return members.map(({ userId, displayName, role, active }) => ({ userId, displayName, role, active }));
    });
  }

  createTask(actor: string, workspaceId: string, input: Record<string, unknown>): Promise<TaskMutationResponse> {
    return this.run(() => {
      refuseTags(input);
      const ctx = this.ctx(actor, input);
      // Same rule as the gateway API: a create must carry an operation ID so a retry never duplicates.
      if (ctx.operationId === undefined) throw new AppError('VALIDATION', '操作 ID（operationId）が必要です。', { details: [{ path: 'operationId', message: '必須です' }] });
      return this.service.createTask(ctx, workspaceId, input);
    }) as Promise<TaskMutationResponse>;
  }

  getTask(actor: string, taskId: string): Promise<TaskView> {
    return this.run(() => this.service.getTask(actor, taskId)) as Promise<TaskView>;
  }

  updateTask(actor: string, taskId: string, input: Record<string, unknown>): Promise<TaskMutationResponse> {
    return this.run(() => {
      refuseTags(input);
      return this.service.updateTask(this.ctx(actor, input), taskId, input);
    }) as Promise<TaskMutationResponse>;
  }

  reopenTask(actor: string, taskId: string, input: Record<string, unknown>): Promise<TaskMutationResponse> {
    return this.run(() => this.service.reopenTask(this.ctx(actor, input), taskId, input)) as Promise<TaskMutationResponse>;
  }

  history(actor: string, taskId: string): Promise<TaskHistoryEntry[]> {
    return this.run(() => this.service.getHistory(actor, taskId)) as Promise<TaskHistoryEntry[]>;
  }
}
