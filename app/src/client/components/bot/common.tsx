import type { AssistantJob, AssistantJobState } from '../../../shared/assistant';
import { parseMailRequest } from '../../../shared/mailDraft';
import { ApiFailure } from '../../api';

/** Labels and tones of a job state. Every state has its text; the colour only repeats it (../docs/ui-guidelines.md §4). */
const STATE_TAGS: Record<AssistantJobState, { label: string; tone: 'info' | 'warn' | 'ok' | 'error' | 'none' }> = {
  queued: { label: '待機中', tone: 'warn' },
  running: { label: '処理中', tone: 'info' },
  done: { label: '完了', tone: 'ok' },
  failed: { label: '失敗', tone: 'error' },
  canceled: { label: '取り消し', tone: 'none' },
};

export function StateTag({ state }: { state: AssistantJobState }) {
  const tag = STATE_TAGS[state];
  return <span className={`bot-tag bot-tag-${tag.tone}`}>{tag.label}</span>;
}

export const isActive = (job: AssistantJob) => job.state === 'queued' || job.state === 'running';

/** A 16-byte random operation ID (hex). crypto.randomUUID is missing on plain-http addresses. */
export function newOperationId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The operation ID of one logical request. A retry of the same request (same key) reuses the ID, so the
 * Bot host replays the earlier answer instead of doing the work twice. A definitive refusal (4xx) or a
 * success ends the operation (settleOperation); an unknown outcome (network, 5xx) keeps it.
 */
export type OperationSlots = Record<string, { key: string; id: string } | null>;

/** The operation ID of the request in `slot`; the same request again keeps its ID (see OperationSlots). */
export function operationFor(slots: OperationSlots, slot: string, key: string): string {
  const current = slots[slot];
  if (current && current.key === key) return current.id;
  const created = { key, id: newOperationId() };
  slots[slot] = created;
  return created.id;
}

/** A refusal (4xx) or a success ends the request in `slot`; an unknown outcome keeps it for a retry. */
export function settleOperation(slots: OperationSlots, slot: string, err: unknown): void {
  if (err instanceof ApiFailure && err.status >= 400 && err.status < 500) slots[slot] = null;
}

/** The Bot-host failures that must not be shown as a success or a number. */
export function ErrorLine({ error, what, onRetry }: { error: ApiFailure; what: string; onRetry?: () => void }) {
  return (
    <p className="status error" role="alert">
      {what}できませんでした: {error.message}
      {onRetry && (
        <button type="button" onClick={onRetry}>
          再試行
        </button>
      )}
    </p>
  );
}

/** The result of one action on a row: the Bot's message, or what failed. */
export type Outcome = { text: string } | { error: ApiFailure };

export function OutcomeLine({ outcome, testId, what }: { outcome: Outcome; testId: string; what: string }) {
  if ('error' in outcome) {
    return (
      <span data-testid={testId}>
        <ErrorLine error={outcome.error} what={what} />
      </span>
    );
  }
  if (!outcome.text) return null;
  return (
    <p className="status ok" role="status" data-testid={testId}>
      {outcome.text}
    </p>
  );
}

/** A feature that is off, with the reason; the form stays visible but cannot be sent. */
export function FeatureOff({ reason }: { reason: string }) {
  return (
    <p className="banner" role="status" data-testid="bot-feature-off">
      {reason}
    </p>
  );
}

const JST = 'Asia/Tokyo';

/** Today in Japan as YYYY-MM-DD. The server's times carry +09:00, so their date part is the Japanese date. */
export function jstToday(now = Date.now()): string {
  return new Date(now).toLocaleDateString('sv-SE', { timeZone: JST });
}

export const jstDateOf = (iso: string) => iso.slice(0, 10);

/** A datetime-local value (YYYY-MM-DDTHH:mm, Japanese wall time) as an ISO time with +09:00. */
export function dueToIso(local: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? `${local}:00+09:00` : null;
}

export function sizeLabel(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line that says what a job or a list row is about, from its input. A mail draft reads "相手 宛：要件". */
export function summaryOf(job: AssistantJob): string {
  const input = job.input;
  const mail = job.kind === 'doc' && input.docType === 'mail' && typeof input.content === 'string' ? parseMailRequest(input.content) : null;
  const text = mail ? `${mail.to} 宛：${mail.purpose}` : job.kind === 'ask' ? input.question : job.kind === 'image' ? input.prompt : input.content;
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return value.length > 80 ? `${value.slice(0, 80)}…` : value || '（内容なし）';
}

export const KIND_LABELS = { ask: '質問', doc: '文書', image: '画像' } as const;
