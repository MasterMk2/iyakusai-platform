import { createHash, randomBytes } from 'node:crypto';
import type { MockLineConnectorState, MockPushOutcome } from '../../shared/line.js';

// Outbound boundary for manual LINE replies: the mock below, and the Messaging API adapter
// (messaging-api.ts, 2026-10-28) that the committee's line.json turns on with a channel access token.

export interface LinePushRequest {
  /** UUID generated once per intent; must be identical on every explicit retry. */
  retryKey: string;
  accountId: string;
  /** Stored, verified target ID. Never taken from a client. */
  to: string;
  targetType: 'user' | 'group' | 'room';
  text: string;
}

/**
 * Result classes mirror the documented push semantics:
 * - accepted: HTTP 200 means the platform accepted the request, NOT delivered or read;
 * - accepted_duplicate: HTTP 409 with an accepted request ID for the same retry key;
 * - not_sent: failed before the request left (safe to retry with the same key);
 * - rejected: 4xx (429 rate limit, 403 permission, 400 ineligible/invalid, not configured);
 * - unknown: timeout or 5xx; the request may or may not have been accepted.
 */
export type LinePushOutcome =
  | { kind: 'accepted'; requestId: string }
  | { kind: 'accepted_duplicate'; acceptedRequestId: string }
  | { kind: 'not_sent' }
  | { kind: 'rejected'; httpStatus: number; reason: 'rate_limited' | 'permission_denied' | 'not_configured' | 'ineligible' | 'invalid'; retryAfterSeconds?: number }
  | { kind: 'unknown'; reason: 'timeout' | 'server_error' };

/** This month's messages as LINE counts them (null limit: the plan has no fixed limit). */
export interface LineQuota {
  limit: number | null;
  used: number;
}

export interface LinePushConnector {
  readonly kind: 'mock' | 'messaging_api';
  push(request: LinePushRequest): Promise<LinePushOutcome>;
  /** LINE's own count for the month, or null when it could not be read. */
  quota?(): Promise<LineQuota | null>;
  /** Members of a group or room the account is in, or null (not a member, or not readable). */
  memberCount?(target: { type: 'group' | 'room'; id: string }): Promise<number | null>;
}

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Mock push connector. Stands in for the provider side: it remembers accepted
 * retry keys for 24 hours (like X-Line-Retry-Key) and answers a repeated key
 * with an accepted duplicate. It performs no I/O of any kind. Scripted outcomes
 * (demo administrator / tests) simulate failures.
 */
export class MockLinePushConnector implements LinePushConnector {
  readonly kind = 'mock' as const;
  /** Every push call (test evidence). Holds hashes, not message text. */
  readonly calls: { retryKey: string; to: string; textHash: string; outcome: LinePushOutcome['kind'] }[] = [];
  /** Same retry key used with a different recipient or text (must stay 0). */
  violations = 0;
  private readonly accepted = new Map<string, { requestId: string; fingerprint: string; at: number }>();
  private queue: MockPushOutcome[] = [];
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Requests that the platform accepted (each retry key counts once). */
  get acceptedCount(): number {
    return this.accepted.size;
  }

  script(outcomes: MockPushOutcome[]): void {
    this.queue = [...outcomes];
  }

  state(): MockLineConnectorState {
    return { queued: [...this.queue], acceptedCount: this.accepted.size };
  }

  reset(): void {
    this.queue = [];
    this.accepted.clear();
    this.calls.length = 0;
    this.violations = 0;
  }

  async push(request: LinePushRequest): Promise<LinePushOutcome> {
    await Promise.resolve();
    const textHash = createHash('sha256').update(request.text).digest('hex');
    const fingerprint = `${request.accountId}|${request.targetType}|${request.to}|${textHash}`;
    const outcome = this.decide(request.retryKey, fingerprint);
    this.calls.push({ retryKey: request.retryKey, to: request.to, textHash, outcome: outcome.kind });
    return outcome;
  }

  private decide(retryKey: string, fingerprint: string): LinePushOutcome {
    const next = this.queue.shift() ?? 'accept';
    if (next === 'fail_before_accept') return { kind: 'not_sent' };
    const prior = this.accepted.get(retryKey);
    if (prior && this.now() - prior.at < DEDUP_WINDOW_MS) {
      if (prior.fingerprint !== fingerprint) this.violations += 1;
      return { kind: 'accepted_duplicate', acceptedRequestId: prior.requestId };
    }
    const accept = () => {
      const requestId = `mock-req-${randomBytes(6).toString('hex')}`;
      this.accepted.set(retryKey, { requestId, fingerprint, at: this.now() });
      return requestId;
    };
    switch (next) {
      case 'accept':
        return { kind: 'accepted', requestId: accept() };
      case 'accept_response_lost':
        accept();
        return { kind: 'unknown', reason: 'timeout' };
      case 'server_error':
        return { kind: 'unknown', reason: 'server_error' };
      case 'rate_limited':
        return { kind: 'rejected', httpStatus: 429, reason: 'rate_limited', retryAfterSeconds: 60 };
      case 'permission_denied':
        return { kind: 'rejected', httpStatus: 403, reason: 'permission_denied' };
      case 'not_configured':
        return { kind: 'rejected', httpStatus: 401, reason: 'not_configured' };
      case 'ineligible':
        return { kind: 'rejected', httpStatus: 400, reason: 'ineligible' };
    }
  }
}
