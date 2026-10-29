import type { LineIngestReport } from '../../shared/line.js';
import {
  contentOfEvent,
  eventFingerprint,
  lineEventSchema,
  messageFingerprint,
  normalizeLegacyRecord,
  sha256,
  targetOfEvent,
  type LineEventEnvelope,
} from './normalize.js';
import { nextLineId, type LineConversation, type LineState, type LineTarget, type MessagingTarget } from './types.js';

// Applies normalized records. Idempotent and source-scoped:
// - events are keyed by (account, webhookEventId) and messages by (account, messageId);
// - the same key with different content is a conflict and changes nothing;
// - an unsend leaves a tombstone, removes the content and nulls every body-derived
//   fingerprint, so a later redelivery can never bring the text back;
// - the same external ID under another account is a different record.

export const SYSTEM_ACTOR = 'system';

export function conversationIdFor(accountId: string, target: LineTarget): string {
  const key = target.kind === 'messaging_api' ? `${accountId}|api|${target.type}|${target.id}` : `${accountId}|legacy|${target.ref}`;
  return `lc_${sha256(key).slice(0, 16)}`;
}

export function messageIdFor(accountId: string, source: 'event' | 'legacy', externalId: string): string {
  return `lm_${sha256(`${accountId}|${source}|${externalId}`).slice(0, 16)}`;
}

export function emptyReport(): LineIngestReport {
  return { imported: 0, duplicates: 0, conflicts: 0, suppressed: 0, rejected: 0, unsent: 0, stateEvents: 0 };
}

const TYPE_LABEL: Record<MessagingTarget['type'], string> = { user: 'LINE 利用者', group: 'LINE グループ', room: 'LINE トークルーム' };

function ensureConversation(state: LineState, accountId: string, target: LineTarget, title: string, named = false): LineConversation {
  const id = conversationIdFor(accountId, target);
  let conv = state.conversations.find((c) => c.id === id);
  // A name from the receiver (the person's LINE display name) replaces the masked ID, and a newer name an older one.
  if (conv && named) conv.title = title;
  if (!conv) {
    conv = {
      id,
      accountId,
      target,
      title,
      origin: target.kind === 'messaging_api' ? 'event_feed' : 'legacy_export',
      eligibility: { relation: 'unknown', relationAt: null, lastUserMessageAt: null, memberCount: null, memberCountAt: null },
      triage: { version: 1, status: 'unhandled', assigneeId: null, labels: [] },
      notes: [],
      history: [],
    };
    state.conversations.push(conv);
  }
  return conv;
}

const newer = (at: string, than: string | null) => than === null || Date.parse(at) >= Date.parse(than);

function applyUnsend(state: LineState, accountId: string, externalMessageId: string, now: string): string | null {
  if (!state.tombstones.some((t) => t.accountId === accountId && t.externalMessageId === externalMessageId)) {
    state.tombstones.push({ accountId, externalMessageId, at: now });
  }
  for (const pe of state.processedEvents) {
    if (pe.accountId === accountId && pe.messageId === externalMessageId) pe.fingerprint = null;
  }
  const message = state.messages.find(
    (m) => m.accountId === accountId && m.provenance.source === 'event_feed' && m.externalMessageId === externalMessageId,
  );
  if (!message || message.content.kind === 'unsent') return null;
  message.content = { kind: 'unsent' };
  message.fingerprint = null;
  const conv = state.conversations.find((c) => c.id === message.conversationId);
  // Only safe identifiers are recorded; the original text is gone.
  conv?.history.push({ id: nextLineId(state, 'lhist'), at: now, actorId: SYSTEM_ACTOR, action: 'message_unsent', from: null, to: message.id });
  return message.id;
}

function applyEvent(state: LineState, ev: LineEventEnvelope, batchId: string, now: string, report: LineIngestReport, unsentIds: string[]): void {
  const target = targetOfEvent(ev);
  const title = ev.targetLabel ?? `${TYPE_LABEL[target.type]} …${target.id.slice(-4)}`;
  const record = (fingerprint: string | null, messageId: string | null) =>
    state.processedEvents.push({ accountId: ev.accountId, webhookEventId: ev.webhookEventId, fingerprint, messageId });

  switch (ev.type) {
    case 'message': {
      const externalId = ev.message.id;
      if (state.tombstones.some((t) => t.accountId === ev.accountId && t.externalMessageId === externalId)) {
        record(null, externalId);
        report.suppressed += 1;
        return;
      }
      const content = contentOfEvent(ev.message);
      const fp = messageFingerprint(`${target.type}|${target.id}`, ev.timestamp, content);
      const existing = state.messages.find(
        (m) => m.accountId === ev.accountId && m.provenance.source === 'event_feed' && m.externalMessageId === externalId,
      );
      if (existing) {
        if (existing.fingerprint === fp) {
          record(eventFingerprint(ev), externalId);
          report.duplicates += 1;
        } else {
          report.conflicts += 1;
        }
        return;
      }
      const conv = ensureConversation(state, ev.accountId, target, title, ev.targetLabel !== undefined);
      state.messages.push({
        id: messageIdFor(ev.accountId, 'event', externalId),
        accountId: ev.accountId,
        conversationId: conv.id,
        externalMessageId: externalId,
        direction: 'inbound',
        senderLabel: ev.senderLabel ?? (ev.source.userId ? `利用者 …${ev.source.userId.slice(-4)}` : '（送信者不明）'),
        sentAt: ev.timestamp,
        importedAt: now,
        content,
        fingerprint: fp,
        provenance: { source: 'event_feed', batchId, cursor: ev.cursor },
      });
      if (target.type === 'user' && newer(ev.timestamp, conv.eligibility.lastUserMessageAt)) conv.eligibility.lastUserMessageAt = ev.timestamp;
      record(eventFingerprint(ev), externalId);
      report.imported += 1;
      return;
    }
    case 'unsend': {
      record(eventFingerprint(ev), null);
      const id = applyUnsend(state, ev.accountId, ev.unsend.messageId, now);
      if (id) unsentIds.push(id);
      report.unsent += 1;
      return;
    }
    case 'member_count': {
      const conv = ensureConversation(state, ev.accountId, target, title, ev.targetLabel !== undefined);
      if (newer(ev.timestamp, conv.eligibility.memberCountAt)) {
        conv.eligibility.memberCount = ev.memberCount;
        conv.eligibility.memberCountAt = ev.timestamp;
      }
      record(eventFingerprint(ev), null);
      report.stateEvents += 1;
      return;
    }
    default: {
      const relation = ({ follow: 'friend', unfollow: 'unfollowed', join: 'joined', leave: 'left' } as const)[ev.type];
      const conv = ensureConversation(state, ev.accountId, target, title, ev.targetLabel !== undefined);
      // Out-of-order delivery: an older relation event never overrides a newer one.
      if (newer(ev.timestamp, conv.eligibility.relationAt)) {
        conv.eligibility.relation = relation;
        conv.eligibility.relationAt = ev.timestamp;
      }
      record(eventFingerprint(ev), null);
      report.stateEvents += 1;
    }
  }
}

/** Applies validated event-feed envelopes. Unknown accounts or destinations are denied. */
export function applyEventBatch(state: LineState, batchId: string, items: unknown[], now: string): LineIngestReport {
  const report = emptyReport();
  const unsentIds: string[] = [];
  for (const item of items) {
    const parsed = lineEventSchema.safeParse(item);
    if (!parsed.success) {
      report.rejected += 1;
      continue;
    }
    const ev = parsed.data;
    const account = state.accounts.find((a) => a.id === ev.accountId);
    if (!account || account.kind !== 'official_account' || account.destination !== ev.destination) {
      report.rejected += 1;
      continue;
    }
    const fp = eventFingerprint(ev);
    const seen = state.processedEvents.find((p) => p.accountId === ev.accountId && p.webhookEventId === ev.webhookEventId);
    if (seen) {
      if (seen.fingerprint === null) report.suppressed += 1;
      else if (seen.fingerprint === fp) report.duplicates += 1;
      else report.conflicts += 1;
      continue;
    }
    applyEvent(state, ev, batchId, now, report, unsentIds);
    state.feed.cursors[ev.accountId] = ev.cursor;
  }
  recordImport(state, batchId, report, now, unsentIds);
  return report;
}

/** Applies legacy history rows for one legacy archive account. Never creates a sendable target. */
export function applyLegacyBatch(state: LineState, batchId: string, accountId: string, items: unknown[], now: string): LineIngestReport {
  const report = emptyReport();
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account || account.kind !== 'legacy_archive') {
    report.rejected = items.length;
    recordImport(state, batchId, report, now, []);
    return report;
  }
  for (const item of items) {
    const norm = normalizeLegacyRecord(item);
    if (!norm) {
      report.rejected += 1;
      continue;
    }
    const id = messageIdFor(accountId, 'legacy', norm.externalMessageId);
    const fp = messageFingerprint(`legacy|${norm.target.ref}|${norm.direction}`, norm.sentAt, norm.content);
    const existing = state.messages.find((m) => m.id === id);
    if (existing) {
      if (existing.fingerprint === fp) report.duplicates += 1;
      else report.conflicts += 1;
      continue;
    }
    const conv = ensureConversation(state, accountId, norm.target, norm.chatName);
    state.messages.push({
      id,
      accountId,
      conversationId: conv.id,
      externalMessageId: norm.externalMessageId,
      direction: norm.direction,
      senderLabel: norm.senderLabel,
      sentAt: norm.sentAt,
      importedAt: now,
      content: norm.content,
      fingerprint: fp,
      provenance: { source: 'legacy_export', batchId, cursor: norm.cursor },
    });
    state.feed.cursors[accountId] = norm.cursor;
    report.imported += 1;
  }
  recordImport(state, batchId, report, now, []);
  return report;
}

function recordImport(state: LineState, batchId: string, r: LineIngestReport, now: string, unsentIds: string[]): void {
  state.audit.push({
    id: nextLineId(state, 'laudit'),
    at: now,
    actorId: SYSTEM_ACTOR,
    action: 'line_import',
    detail: `LINE 取り込み（${batchId}）: 追加 ${r.imported} / 重複 ${r.duplicates} / 競合 ${r.conflicts} / 抑止 ${r.suppressed} / 拒否 ${r.rejected} / 送信取消 ${r.unsent} / 状態 ${r.stateEvents}`,
  });
  if (unsentIds.length > 0) {
    state.audit.push({ id: nextLineId(state, 'laudit'), at: now, actorId: SYSTEM_ACTOR, action: 'line_unsend', detail: `送信取消を反映: ${unsentIds.join(', ')}` });
  }
}
