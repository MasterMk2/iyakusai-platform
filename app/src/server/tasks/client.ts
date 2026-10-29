import type { TaskContextResponse, TaskHistoryEntry, TaskMember, TaskMutationResponse, TaskView } from '../../shared/tasks.js';
import type { TaskSummaryResponse } from '../../shared/task-summary.js';
import { signedHeaders } from './signing.js';

// Typed server-side client of the Task service integration API. Every call is signed
// with the gateway key and names the actor (the Task user bound to the server-verified
// principal). Errors are classified: a 4xx answer is definitive (nothing was applied),
// anything else (timeout, network, 5xx, unverifiable answer) is "unavailable" and, for a
// write, its outcome is unknown.

export const TASK_API_PREFIX = '/api/integration/v1';

export interface TaskErrorBody {
  code: string;
  message: string;
  details?: { path: string; message: string }[];
  current?: TaskView;
}

export class TaskServiceError extends Error {
  constructor(
    readonly kind: 'definitive' | 'unavailable',
    readonly status: number,
    readonly body: TaskErrorBody | null,
  ) {
    super(body?.message ?? 'タスクサービスに接続できません。');
  }
}

export interface TaskServiceClientOptions {
  /** Origin of the Task service, e.g. http://127.0.0.1:17631 (no path). */
  baseUrl: string;
  key: Buffer;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Method = 'GET' | 'POST' | 'PATCH';

/**
 * The eight Task operations the common Web uses. Implemented over signed HTTP
 * (TaskServiceClient) or in process (InProcessTaskBackend); both report failures as
 * TaskServiceError with the same definitive / unavailable split.
 */
export interface TaskBackend {
  summary(actor: string): Promise<TaskSummaryResponse>;
  me(actor: string): Promise<{ user: { id: string; displayName: string }; memberships: TaskContextResponse['memberships'] }>;
  listTasks(actor: string, workspaceId: string, query: Record<string, string | undefined>): Promise<TaskView[]>;
  /** Every task of every department in one read (2026-10-25; only a Task service with department tags). */
  listAllTasks(actor: string): Promise<TaskView[]>;
  members(actor: string, workspaceId: string): Promise<TaskMember[]>;
  createTask(actor: string, workspaceId: string, input: Record<string, unknown>): Promise<TaskMutationResponse>;
  getTask(actor: string, taskId: string): Promise<TaskView>;
  updateTask(actor: string, taskId: string, input: Record<string, unknown>): Promise<TaskMutationResponse>;
  reopenTask(actor: string, taskId: string, input: Record<string, unknown>): Promise<TaskMutationResponse>;
  history(actor: string, taskId: string): Promise<TaskHistoryEntry[]>;
}

export class TaskServiceClient implements TaskBackend {
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TaskServiceClientOptions) {
    this.origin = new URL(options.baseUrl).origin;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async call<T>(actor: string, method: Method, path: string, payload?: unknown, query?: Record<string, string | undefined>): Promise<T> {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) search.set(k, v);
    const fullPath = `${TASK_API_PREFIX}${path}${search.size > 0 ? `?${search.toString()}` : ''}`;
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers: Record<string, string> = signedHeaders(this.options.key, { client: 'web-gateway', method, path: fullPath, body, actor });
    if (body) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}${fullPath}`, { method, headers, body: body || undefined, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    } catch {
      throw new TaskServiceError('unavailable', 0, null);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (response.ok) {
      if (json === null || typeof json !== 'object') throw new TaskServiceError('unavailable', response.status, null);
      return json as T;
    }
    const error = (json as { error?: TaskErrorBody } | null)?.error;
    // 401 means the gateway signature/actor was not accepted: a configuration fault, not a user error.
    if (response.status >= 400 && response.status < 500 && response.status !== 401 && error && typeof error.code === 'string' && typeof error.message === 'string') {
      throw new TaskServiceError('definitive', response.status, error);
    }
    throw new TaskServiceError('unavailable', response.status, null);
  }

  summary(actor: string): Promise<TaskSummaryResponse> {
    return this.call(actor, 'GET', '/summary');
  }

  me(actor: string): Promise<{ user: { id: string; displayName: string }; memberships: TaskContextResponse['memberships'] }> {
    return this.call(actor, 'GET', '/me');
  }

  listTasks(actor: string, workspaceId: string, query: Record<string, string | undefined>): Promise<TaskView[]> {
    return this.call(actor, 'GET', `/workspaces/${encodeURIComponent(workspaceId)}/tasks`, undefined, query);
  }

  listAllTasks(actor: string): Promise<TaskView[]> {
    return this.call(actor, 'GET', '/tasks');
  }

  members(actor: string, workspaceId: string): Promise<TaskMember[]> {
    return this.call(actor, 'GET', `/workspaces/${encodeURIComponent(workspaceId)}/members`);
  }

  createTask(actor: string, workspaceId: string, input: Record<string, unknown>): Promise<TaskMutationResponse> {
    return this.call(actor, 'POST', `/workspaces/${encodeURIComponent(workspaceId)}/tasks`, input);
  }

  getTask(actor: string, taskId: string): Promise<TaskView> {
    return this.call(actor, 'GET', `/tasks/${encodeURIComponent(taskId)}`);
  }

  updateTask(actor: string, taskId: string, input: Record<string, unknown>): Promise<TaskMutationResponse> {
    return this.call(actor, 'PATCH', `/tasks/${encodeURIComponent(taskId)}`, input);
  }

  reopenTask(actor: string, taskId: string, input: Record<string, unknown>): Promise<TaskMutationResponse> {
    return this.call(actor, 'POST', `/tasks/${encodeURIComponent(taskId)}/reopen`, input);
  }

  history(actor: string, taskId: string): Promise<TaskHistoryEntry[]> {
    return this.call(actor, 'GET', `/tasks/${encodeURIComponent(taskId)}/history`);
  }
}
