import { SAMPLE_GRANTS, SAMPLE_MAILBOXES, SAMPLE_TRIAGE, SAMPLE_USERS } from '../connector/fixtures.js';
import { MockInboundConnector } from '../connector/mock.js';
import { STATUS_LABELS } from '../../shared/api.js';
import { displayName } from './access.js';
import { applyBatches, fetchAll, receiptIdFor } from './sync.js';
import { nextId, type AppState } from './types.js';

export const SYSTEM_ACTOR = 'system';
const SAMPLE_TIME = '2026-09-06T09:00:00.000Z';

/** Fresh synthetic sample: fixture users/mailboxes/grants, initial mock import, sample handling data. */
export async function createSeedState(now: string): Promise<AppState> {
  const state: AppState = {
    schemaVersion: 1,
    users: structuredClone(SAMPLE_USERS),
    mailboxes: structuredClone(SAMPLE_MAILBOXES),
    committeeSharedMailReadPolicy: {
      version: 1,
      mode: 'synthetic-fixture',
      targets: SAMPLE_MAILBOXES.map((m) => ({ mailboxId: m.id, address: m.address, sourceKey: m.sourceKey, connectorId: 'mock-inbound' })),
      syntheticCurrentMemberIds: ['u-editor-a', 'u-viewer-b', 'u-editor-c', 'u-noaccess-d'],
    },
    grants: structuredClone(SAMPLE_GRANTS),
    accessVersion: 1,
    messages: [],
    receipts: [],
    audit: [],
    mockConnector: { releasedBatch: 1, cursors: {} },
    seq: 0,
  };
  const connector = new MockInboundConnector({ releasedBatch: () => state.mockConnector.releasedBatch, failingSourceKey: () => null });
  applyBatches(state, connector.id, await fetchAll(state, connector, 'incremental'), SYSTEM_ACTOR, now);

  for (const sample of SAMPLE_TRIAGE) {
    const receipt = state.receipts.find((r) => r.id === receiptIdFor(connector.id, sample.sourceKey, sample.providerMessageId));
    if (!receipt) throw new Error(`seed: missing receipt ${sample.providerMessageId}`);
    const push = (action: 'assignee' | 'status' | 'labels' | 'note_added', from: string | null, to: string | null) =>
      receipt.history.push({ id: nextId(state, 'hist'), at: SAMPLE_TIME, actorId: sample.actorId, action, from, to });
    if (sample.assigneeId) {
      receipt.triage.assigneeId = sample.assigneeId;
      push('assignee', null, displayName(state, sample.assigneeId));
    }
    if (sample.status) {
      push('status', STATUS_LABELS[receipt.triage.status], STATUS_LABELS[sample.status]);
      receipt.triage.status = sample.status;
    }
    if (sample.labels) {
      receipt.triage.labels = [...sample.labels];
      push('labels', null, sample.labels.join(', '));
    }
    if (sample.note) {
      receipt.notes.push({ id: nextId(state, 'note'), authorId: sample.actorId, createdAt: SAMPLE_TIME, body: sample.note });
      push('note_added', null, null);
    }
  }
  state.audit.push({ id: nextId(state, 'audit'), at: now, actorId: SYSTEM_ACTOR, action: 'reset', detail: '合成サンプルデータを初期化' });
  return state;
}
