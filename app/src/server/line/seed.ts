import { STATUS_LABELS } from '../../shared/api.js';
import { LINE_FEED, LINE_USER, LINE_SUPPORT, SAMPLE_LINE_ACCOUNTS, SAMPLE_LINE_GRANTS } from './fixtures.js';
import type { LineIngestReport } from '../../shared/line.js';
import { applyEventBatch, applyLegacyBatch, conversationIdFor, emptyReport } from './ingest.js';
import { LINE_SCHEMA_VERSION, LINE_STATE_KIND, nextLineId, type LineState } from './types.js';

const SAMPLE_TIME = '2026-09-06T09:00:00.000Z';

export interface LineSeedOptions {
  /**
   * Whether the sample reply grants are included. The hosted (trusted-proxy) mode
   * seeds with every reply capability off: production default is deny, and an
   * administrator must grant it explicitly (audited).
   */
  replyGrants: boolean;
}

/** Applies every feed batch up to `batch` that is not applied yet. */
export function releaseLineBatches(state: LineState, upTo: number, now: string): LineIngestReport {
  const total = emptyReport();
  for (const b of LINE_FEED) {
    if (b.batch <= state.feed.releasedBatch || b.batch > upTo) continue;
    const id = `mock-line-batch-${b.batch}-${b.kind}`;
    const r = b.kind === 'events' ? applyEventBatch(state, id, b.items, now) : applyLegacyBatch(state, id, b.accountId ?? '', b.items, now);
    for (const key of Object.keys(total) as (keyof LineIngestReport)[]) total[key] += r[key];
  }
  state.feed.releasedBatch = Math.max(state.feed.releasedBatch, upTo);
  return total;
}

export function createLineSeedState(now: string, options: LineSeedOptions): LineState {
  const state: LineState = {
    kind: LINE_STATE_KIND,
    schemaVersion: LINE_SCHEMA_VERSION,
    accounts: structuredClone(SAMPLE_LINE_ACCOUNTS),
    grants: SAMPLE_LINE_GRANTS.map((g) => ({ ...g, reply: options.replyGrants && g.reply })),
    accessVersion: 1,
    conversations: [],
    messages: [],
    processedEvents: [],
    tombstones: [],
    feed: { releasedBatch: 0, cursors: {} },
    drafts: [],
    consents: [],
    outbox: [],
    audit: [],
    seq: 0,
  };
  releaseLineBatches(state, 1, now);

  const conv = state.conversations.find((c) => c.id === conversationIdFor(LINE_SUPPORT, { kind: 'messaging_api', type: 'user', id: LINE_USER.l1 }));
  if (!conv) throw new Error('line seed: missing sample conversation');
  const push = (action: 'assignee' | 'status' | 'note_added', from: string | null, to: string | null) =>
    conv.history.push({ id: nextLineId(state, 'lhist'), at: SAMPLE_TIME, actorId: 'u-editor-c', action, from, to });
  conv.triage.assigneeId = 'u-editor-c';
  push('assignee', null, '編集担当C');
  push('status', STATUS_LABELS.unhandled, STATUS_LABELS.in_progress);
  conv.triage.status = 'in_progress';
  conv.notes.push({ id: nextLineId(state, 'lnote'), authorId: 'u-editor-c', createdAt: SAMPLE_TIME, body: 'サンプルメモ: 配送状況を確認中です（LINE）。' });
  push('note_added', null, null);

  state.audit.push({ id: nextLineId(state, 'laudit'), at: now, actorId: 'system', action: 'line_reset', detail: 'LINE の合成サンプルを初期化' });
  return state;
}
