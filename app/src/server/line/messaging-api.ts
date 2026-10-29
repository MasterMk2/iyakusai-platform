import type { LinePushConnector, LinePushOutcome, LinePushRequest, LineQuota } from './connector.js';

// The Messaging API push adapter (2026-10-28). One text message per request, with the intent's retry key as
// X-Line-Retry-Key so an explicit retry of the same intent is answered 409 (accepted earlier) instead of a
// second message. HTTP 200 means LINE accepted the request; it says nothing about delivery or reading.
// The channel access token is only ever put in the Authorization header: never logged or returned.
// https://developers.line.biz/en/reference/messaging-api/#send-push-message
// https://developers.line.biz/en/docs/messaging-api/retrying-api-request/

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;
const MONTHLY_LIMIT_WAIT_SECONDS = 3600;

/** Connection errors that mean the request never reached LINE (safe to retry). */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function causeCode(err: unknown): string | null {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : null;
}

const isTimeout = (err: unknown) => (err as { name?: unknown } | null)?.name === 'TimeoutError' || (err as { name?: unknown } | null)?.name === 'AbortError';

async function messageOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : '';
  } catch {
    return '';
  }
}

export class MessagingApiConnector implements LinePushConnector {
  readonly kind = 'messaging_api' as const;

  constructor(
    private readonly accessToken: string,
    private readonly apiBase = 'https://api.line.me',
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {}

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.accessToken}`, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  }

  async push(request: LinePushRequest): Promise<LinePushOutcome> {
    let res: Response;
    try {
      res = await this.request('/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Retry-Key': request.retryKey },
        body: JSON.stringify({ to: request.to, messages: [{ type: 'text', text: request.text }] }),
      });
    } catch (err) {
      if (isTimeout(err)) return { kind: 'unknown', reason: 'timeout' };
      const code = causeCode(err);
      return code && NOT_SENT_CODES.has(code) ? { kind: 'not_sent' } : { kind: 'unknown', reason: 'server_error' };
    }
    if (res.status === 200) {
      await res.body?.cancel();
      return { kind: 'accepted', requestId: res.headers.get('x-line-request-id') ?? 'unknown' };
    }
    if (res.status === 409) {
      const accepted = res.headers.get('x-line-accepted-request-id');
      await res.body?.cancel();
      // 409 without the header is a conflict of another kind: not a proof that this key was accepted.
      return accepted ? { kind: 'accepted_duplicate', acceptedRequestId: accepted } : { kind: 'rejected', httpStatus: 409, reason: 'invalid' };
    }
    if (res.status >= 500) {
      await res.body?.cancel();
      return { kind: 'unknown', reason: 'server_error' };
    }
    const message = await messageOf(res);
    switch (res.status) {
      case 429:
        // Also the answer when the month's messages are used up: retrying soon would only fail again.
        return { kind: 'rejected', httpStatus: 429, reason: 'rate_limited', retryAfterSeconds: /monthly limit/i.test(message) ? MONTHLY_LIMIT_WAIT_SECONDS : 60 };
      case 401:
        return { kind: 'rejected', httpStatus: 401, reason: 'not_configured' };
      case 403:
        return { kind: 'rejected', httpStatus: 403, reason: 'permission_denied' };
      case 400:
        return { kind: 'rejected', httpStatus: 400, reason: 'invalid' };
      default:
        return { kind: 'rejected', httpStatus: res.status, reason: 'invalid' };
    }
  }

  private async getJson(path: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.request(path);
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const body: unknown = await res.json();
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async quota(): Promise<LineQuota | null> {
    const [limit, usage] = await Promise.all([this.getJson('/v2/bot/message/quota'), this.getJson('/v2/bot/message/quota/consumption')]);
    if (!limit || !usage || typeof usage.totalUsage !== 'number') return null;
    if (limit.type === 'none') return { limit: null, used: usage.totalUsage };
    return typeof limit.value === 'number' ? { limit: limit.value, used: usage.totalUsage } : null;
  }

  async memberCount(target: { type: 'group' | 'room'; id: string }): Promise<number | null> {
    if (!/^[CR][0-9a-f]{32}$/.test(target.id)) return null;
    const body = await this.getJson(`/v2/bot/${target.type}/${target.id}/members/count`);
    const count = body?.count;
    return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : null;
  }
}
