import { api, ApiFailure, toFailure } from '../../api';
import type { ApiError } from '../../../shared/api';
import type {
  CalendarApplyRequest,
  CalendarPreviewRequest,
  CalendarPreviewResponse,
  GrantApplyRequest,
  GrantApplyResponse,
  GrantPreviewRequest,
  GrantPreviewResponse,
  GrantsResponse,
  HandoverSummary,
  OrgApplyRequest,
  OrgPreviewRequest,
  OrgPreviewResponse,
  RolloverApplyResponse,
  RolloverMetaResponse,
  RolloverRunView,
  RolloverTasksResponse,
  RolloverUndoResponse,
} from '../../../shared/rollover';

// The year rollover's calls to the server (rollover/routes.ts). Every route is for access administrators only; the
// server checks it on each call.

export const rolloverApi = {
  meta: (year: number | null, signal?: AbortSignal) => api<RolloverMetaResponse>('GET', `/api/rollover/meta${year === null ? '' : `?year=${year}`}`, undefined, signal),
  orgPreview: (body: OrgPreviewRequest, signal?: AbortSignal) => api<OrgPreviewResponse>('POST', '/api/rollover/organizations/preview', body, signal),
  orgApply: (body: OrgApplyRequest) => api<RolloverApplyResponse>('POST', '/api/rollover/organizations/apply', body),
  calendarPreview: (body: CalendarPreviewRequest, signal?: AbortSignal) => api<CalendarPreviewResponse>('POST', '/api/rollover/calendar/preview', body, signal),
  calendarApply: (body: CalendarApplyRequest) => api<RolloverApplyResponse>('POST', '/api/rollover/calendar/apply', body),
  undo: (runId: string) => api<RolloverUndoResponse>('POST', `/api/rollover/runs/${encodeURIComponent(runId)}/undo`, {}),
  tasks: (signal?: AbortSignal) => api<RolloverTasksResponse>('GET', '/api/rollover/tasks', undefined, signal),
  grants: (signal?: AbortSignal) => api<GrantsResponse>('GET', '/api/rollover/grants', undefined, signal),
  grantPreview: (body: GrantPreviewRequest) => api<GrantPreviewResponse>('POST', '/api/rollover/grants/preview', body),
  grantApply: (body: GrantApplyRequest) => api<GrantApplyResponse>('POST', '/api/rollover/grants/apply', body),
  handover: (year: number, signal?: AbortSignal) => api<HandoverSummary>('GET', `/api/rollover/handover?year=${year}`, undefined, signal),
};

/** The run a 409 names (a copy already made for the year, or the same confirm sent twice). */
export function runOf(err: unknown): RolloverRunView | null {
  if (!(err instanceof ApiFailure) || err.status !== 409) return null;
  const run = (err.body as (ApiError & { run?: RolloverRunView }) | null)?.run;
  return run ?? null;
}

/** The server's error code of a failure, or null. */
export const errorCode = (err: unknown): string | null => (err instanceof ApiFailure ? (err.body?.error ?? null) : null);

/** A random ID for one confirm (the server refuses the same ID twice). */
export function requestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `rq-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Downloads what a POST answers as a file with this name (the CSV of the tasks, the handover draft). */
export async function download(url: string, body: unknown, filename: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-SMM-CSRF': '1' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw toFailure(err);
  }
  if (!res.ok) {
    let json: ApiError | null;
    try {
      json = (await res.json()) as ApiError;
    } catch {
      json = null;
    }
    throw new ApiFailure(res.status, json, json?.message ?? `サーバーがエラーを返しました（${res.status}）。`);
  }
  const href = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
