import type { AssistantCandidate, AssistantJob, AssistantMemberListResponse, AssistantMeta, AssistantReminder, AssistantSummary } from '../../shared/assistant.js';
import { signedHeaders } from '../tasks/signing.js';

// Signed client of the Bot host's assistant integration API (/api/integration/v1/assistant/*, contract §3).
// Same TLS, signature and actor rules as the task client: the host is reached over https (trust comes
// from the operator's CA setting in the environment, NODE_EXTRA_CA_CERTS), every call names the actor
// (discord-<ID>), and a 4xx answer is definitive (nothing was applied) while anything else is
// "unavailable" (for a write, the outcome is unknown). Responses are relayed after the server has
// rewritten file URLs and checked file types; this client never returns a raw Bot path to a browser.

export const ASSISTANT_API_PREFIX = '/api/integration/v1/assistant';

/** Wait the Bot host allows for a reminder or candidate write before it answers 202 (contract §3-3). */
export const LONG_WRITE_TIMEOUT_MS = 12_000;
export const DEFAULT_TIMEOUT_MS = 8_000;

export interface AssistantErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class AssistantServiceError extends Error {
  constructor(
    readonly kind: 'definitive' | 'unavailable' | 'rejected',
    readonly status: number,
    readonly body: AssistantErrorBody | null,
  ) {
    super(body?.message ?? 'Bot に接続できません。');
  }
}

/** A JSON answer with its HTTP status (202 means the Bot is still working on it). */
export interface AssistantAnswer<T> {
  status: number;
  body: T;
}

export interface AssistantFileAnswer {
  mime: string;
  body: Buffer;
}

export interface AssistantServiceClientOptions {
  /** Origin of the Bot host, e.g. https://<BOT_HOST>:18431 (no path). */
  baseUrl: string;
  key: Buffer;
  timeoutMs?: number;
  longTimeoutMs?: number;
  maxFileBytes?: number;
  fetchImpl?: typeof fetch;
}

/** Content types the browser may receive from a generated file, keyed by the media type the Bot sends. */
export const ALLOWED_FILE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown': 'text/markdown; charset=utf-8',
  'text/plain': 'text/plain; charset=utf-8',
};

type Method = 'GET' | 'POST';
type Query = Record<string, string | undefined>;

export class AssistantServiceClient {
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly longTimeoutMs: number;
  private readonly maxFileBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AssistantServiceClientOptions) {
    this.origin = new URL(options.baseUrl).origin;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.longTimeoutMs = options.longTimeoutMs ?? LONG_WRITE_TIMEOUT_MS;
    this.maxFileBytes = options.maxFileBytes ?? 20 * 1024 * 1024;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private pathWith(path: string, query?: Query): string {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) search.set(k, v);
    return `${ASSISTANT_API_PREFIX}${path}${search.size > 0 ? `?${search.toString()}` : ''}`;
  }

  /** One signed JSON call. The signed path is the exact path sent on the wire (query included). */
  private async call<T>(actor: string, method: Method, path: string, payload?: unknown, query?: Query, timeoutMs = this.timeoutMs): Promise<AssistantAnswer<T>> {
    const fullPath = this.pathWith(path, query);
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers: Record<string, string> = signedHeaders(this.options.key, { client: 'web-gateway', method, path: fullPath, body, actor });
    if (body) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}${fullPath}`, { method, headers, body: body || undefined, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch {
      throw new AssistantServiceError('unavailable', 0, null);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (response.ok) {
      if (json === null || typeof json !== 'object') throw new AssistantServiceError('unavailable', response.status, null);
      return { status: response.status, body: json as T };
    }
    const error = (json as { error?: AssistantErrorBody } | null)?.error;
    // 401 means the gateway signature or actor was not accepted: a configuration fault, not a user error.
    if (response.status >= 400 && response.status < 500 && response.status !== 401 && error && typeof error.code === 'string' && typeof error.message === 'string') {
      throw new AssistantServiceError('definitive', response.status, error);
    }
    throw new AssistantServiceError('unavailable', response.status, null);
  }

  meta(actor: string): Promise<AssistantMeta> {
    return this.call<AssistantMeta>(actor, 'GET', '/meta').then((a) => a.body);
  }

  summary(actor: string): Promise<AssistantSummary> {
    return this.call<AssistantSummary>(actor, 'GET', '/summary').then((a) => a.body);
  }

  members(actor: string): Promise<AssistantMemberListResponse> {
    return this.call<AssistantMemberListResponse>(actor, 'GET', '/members').then((a) => a.body);
  }

  createJob(actor: string, body: Record<string, unknown>): Promise<AssistantAnswer<{ job: AssistantJob }>> {
    return this.call(actor, 'POST', '/jobs', body);
  }

  getJob(actor: string, jobId: string): Promise<AssistantAnswer<{ job: AssistantJob }>> {
    return this.call(actor, 'GET', `/jobs/${encodeURIComponent(jobId)}`);
  }

  listJobs(actor: string, query: Query): Promise<{ jobs: AssistantJob[]; next: string | null }> {
    return this.call<{ jobs: AssistantJob[]; next: string | null }>(actor, 'GET', '/jobs', undefined, query).then((a) => a.body);
  }

  similar(actor: string, q: string): Promise<{ jobs: { job: AssistantJob; score: number }[] }> {
    return this.call<{ jobs: { job: AssistantJob; score: number }[] }>(actor, 'GET', '/similar', undefined, { q }).then((a) => a.body);
  }

  cancelJob(actor: string, jobId: string): Promise<{ job: AssistantJob }> {
    return this.call<{ job: AssistantJob }>(actor, 'POST', `/jobs/${encodeURIComponent(jobId)}/cancel`, {}).then((a) => a.body);
  }

  reminders(actor: string, scope: 'mine' | 'all'): Promise<{ reminders: AssistantReminder[]; snapshotAt: string | null }> {
    return this.call<{ reminders: AssistantReminder[]; snapshotAt: string | null }>(actor, 'GET', '/reminders', undefined, { scope }).then((a) => a.body);
  }

  createReminder(actor: string, body: Record<string, unknown>): Promise<AssistantAnswer<{ job: AssistantJob }>> {
    return this.call(actor, 'POST', '/reminders', body, undefined, this.longTimeoutMs);
  }

  reminderAction(actor: string, reminderId: string, action: 'done' | 'delete', body: Record<string, unknown>): Promise<AssistantAnswer<{ job: AssistantJob }>> {
    return this.call(actor, 'POST', `/reminders/${encodeURIComponent(reminderId)}/${action}`, body, undefined, this.longTimeoutMs);
  }

  candidates(actor: string, state: 'open' | 'recent'): Promise<{ candidates: AssistantCandidate[] }> {
    return this.call<{ candidates: AssistantCandidate[] }>(actor, 'GET', '/candidates', undefined, { state }).then((a) => a.body);
  }

  candidateAction(actor: string, candidateId: string, action: string, body: Record<string, unknown>): Promise<AssistantAnswer<{ job: AssistantJob }>> {
    return this.call(actor, 'POST', `/candidates/${encodeURIComponent(candidateId)}/${action}`, body, undefined, this.longTimeoutMs);
  }

  /**
   * A generated file. Only the allowed media types pass; anything else, a size over the limit (by the
   * declared length or while reading), or a body that is not the declared size is refused as "rejected".
   */
  async file(actor: string, jobId: string, name: string): Promise<AssistantFileAnswer> {
    const fullPath = `${ASSISTANT_API_PREFIX}/files/${encodeURIComponent(jobId)}/${encodeURIComponent(name)}`;
    const headers = signedHeaders(this.options.key, { client: 'web-gateway', method: 'GET', path: fullPath, body: '', actor });
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}${fullPath}`, { method: 'GET', headers, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    } catch {
      throw new AssistantServiceError('unavailable', 0, null);
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new AssistantServiceError('definitive', 404, { code: 'NOT_FOUND', message: 'ファイルが見つかりません。' });
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new AssistantServiceError('unavailable', response.status, null);
    }
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const mime = ALLOWED_FILE_TYPES[mediaType];
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (!mime || (Number.isFinite(declared) && declared > this.maxFileBytes)) {
      await response.body.cancel().catch(() => undefined);
      throw new AssistantServiceError('rejected', 502, { code: 'ASSISTANT_FILE_REJECTED', message: 'このファイルの形式は表示・ダウンロードできません。' });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch {
        // A connection cut mid-file must not reach the browser as a shorter, apparently complete file.
        throw new AssistantServiceError('unavailable', 0, null);
      }
      if (next.done) break;
      const value = next.value;
      total += value.byteLength;
      if (total > this.maxFileBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AssistantServiceError('rejected', 502, { code: 'ASSISTANT_FILE_REJECTED', message: 'ファイルが大きすぎるため、表示・ダウンロードできません。' });
      }
      chunks.push(Buffer.from(value));
    }
    if (Number.isFinite(declared) && total !== declared) throw new AssistantServiceError('unavailable', response.status, null);
    return { mime, body: Buffer.concat(chunks, total) };
  }
}
