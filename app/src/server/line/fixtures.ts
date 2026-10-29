import type { LineAccount, LineGrant } from './types.js';

// Entirely synthetic LINE sample data. Every ID is an opaque mock value padded with
// zeros (not a real user, group, room, bot or message), every person is a neutral
// sample name, and nothing here is read from a real account, export, database or log.

export const mockLineId = (prefix: 'U' | 'C' | 'R', suffix: string): string => `${prefix}${suffix.padStart(32, '0')}`;
export const mockEventId = (n: number): string => `01MOCKEVENT${String(n).padStart(15, '0')}`;
const msgId = (n: number): string => String(900_000_000_000 + n);

export const LINE_SUPPORT = 'line-oa-support';
export const LINE_SHOP = 'line-oa-shop';
export const LINE_LEGACY = 'line-legacy';

export const BOT = { support: mockLineId('U', 'b001'), shop: mockLineId('U', 'b002') };
export const LINE_USER = { l1: mockLineId('U', 'c001'), l2: mockLineId('U', 'c002'), member3: mockLineId('U', 'c003') };
export const LINE_GROUP = mockLineId('C', 'd001');
export const LINE_ROOM = mockLineId('R', 'e001');

export const SAMPLE_LINE_ACCOUNTS: LineAccount[] = [
  { id: LINE_SUPPORT, name: 'LINE公式 サポート（模擬）', kind: 'official_account', destination: BOT.support, outbound: 'push_mock' },
  { id: LINE_SHOP, name: 'LINE公式 店舗（模擬）', kind: 'official_account', destination: BOT.shop, outbound: 'push_mock' },
  { id: LINE_LEGACY, name: 'LINE 旧履歴（読み取り専用）', kind: 'legacy_archive', destination: null, outbound: 'disabled' },
];

/** Per-account grants. Reply is a separate capability; editor A deliberately has no LINE access. */
export const SAMPLE_LINE_GRANTS: LineGrant[] = [
  { userId: 'u-editor-c', accountId: LINE_SUPPORT, level: 'edit', reply: true },
  { userId: 'u-editor-c', accountId: LINE_SHOP, level: 'edit', reply: false },
  { userId: 'u-editor-c', accountId: LINE_LEGACY, level: 'edit', reply: true },
  { userId: 'u-viewer-b', accountId: LINE_SUPPORT, level: 'read', reply: false },
  { userId: 'u-viewer-b', accountId: LINE_LEGACY, level: 'read', reply: false },
];

type Source = { type: 'user'; userId: string } | { type: 'group'; groupId: string; userId?: string } | { type: 'room'; roomId: string; userId?: string };

function ev(n: number, accountId: string, destination: string, timestamp: string, source: Source, body: Record<string, unknown>, labels: { senderLabel?: string; targetLabel?: string } = {}) {
  return {
    schema: 'line-event/v1',
    accountId,
    destination,
    webhookEventId: mockEventId(n),
    isRedelivery: false,
    timestamp,
    source,
    cursor: `mock-feed-${String(n).padStart(4, '0')}`,
    ...labels,
    ...body,
  };
}

const L1 = { type: 'user', userId: LINE_USER.l1 } as const;
const L2 = { type: 'user', userId: LINE_USER.l2 } as const;
const G1 = { type: 'group', groupId: LINE_GROUP, userId: LINE_USER.member3 } as const;
const G1_NO_USER = { type: 'group', groupId: LINE_GROUP } as const;
const ROOM = { type: 'room', roomId: LINE_ROOM, userId: LINE_USER.l2 } as const;

const s = (n: number, ts: string, source: Source, body: Record<string, unknown>, labels?: { senderLabel?: string; targetLabel?: string }) =>
  ev(n, LINE_SUPPORT, BOT.support, ts, source, body, labels);
const text = (n: number, value: string) => ({ type: 'message', message: { id: msgId(n), type: 'text', text: value } });

const L1_LABELS = { senderLabel: '顧客サンプルL1', targetLabel: '顧客サンプルL1' };
const L2_LABELS = { senderLabel: '顧客サンプルL2', targetLabel: '顧客サンプルL2' };
const G1_LABELS = { senderLabel: '参加者サンプル3', targetLabel: 'サポート相談グループ（模擬）' };

export const UNSENT_TEXT = '注文番号は SAMPLE-0001 です。';

/** Batch 1 is applied on reset; batch 2 is released by the demo administrator. */
export interface LineFeedBatch {
  batch: 1 | 2;
  kind: 'events' | 'legacy';
  accountId?: string;
  items: unknown[];
}

const FIRST_TEXT = s(11, '2026-09-02T01:00:00.000Z', L1, text(11, '注文した商品の配送状況を教えてください。'), L1_LABELS);

export const LINE_FEED: LineFeedBatch[] = [
  {
    batch: 1,
    kind: 'events',
    items: [
      s(10, '2026-09-01T00:00:00.000Z', L1, { type: 'follow' }, L1_LABELS),
      FIRST_TEXT,
      // Delivered out of order: the 01:02 text arrives before the 01:01 image.
      s(13, '2026-09-02T01:02:00.000Z', L1, text(13, UNSENT_TEXT), L1_LABELS),
      s(12, '2026-09-02T01:01:00.000Z', L1, { type: 'message', message: { id: msgId(12), type: 'image' } }, L1_LABELS),
      s(20, '2026-09-01T00:00:00.000Z', G1_NO_USER, { type: 'join' }, { targetLabel: G1_LABELS.targetLabel }),
      s(21, '2026-09-01T00:00:01.000Z', G1_NO_USER, { type: 'member_count', memberCount: 4 }, { targetLabel: G1_LABELS.targetLabel }),
      s(22, '2026-09-03T02:00:00.000Z', G1, text(22, 'グループでの問い合わせです。返信はこのグループ全員に届きます。'), G1_LABELS),
      s(30, '2026-09-03T03:00:00.000Z', L2, text(30, '以前の件でもう一度質問です。'), L2_LABELS),
      s(31, '2026-09-04T03:00:00.000Z', L2, { type: 'unfollow' }, L2_LABELS),
      s(40, '2026-09-04T05:00:00.000Z', ROOM, text(40, 'トークルームからの連絡です（参加状況は未確認）。'), { senderLabel: '顧客サンプルL2', targetLabel: 'トークルーム（模擬）' }),
      // Same external user ID as above, but under another account: a separate conversation.
      ev(50, LINE_SHOP, BOT.shop, '2026-09-01T00:00:00.000Z', L1, { type: 'follow' }, { targetLabel: '顧客サンプルL1（店舗）' }),
      ev(51, LINE_SHOP, BOT.shop, '2026-09-05T06:00:00.000Z', L1, text(51, '店舗限定キーワード: 来店予約の変更をお願いします。'), { senderLabel: '顧客サンプルL1', targetLabel: '顧客サンプルL1（店舗）' }),
    ],
  },
  {
    batch: 1,
    kind: 'legacy',
    accountId: LINE_LEGACY,
    items: [
      legacyRow(1, 'legacy-chat-001', 'user', '旧履歴の会話サンプル', '2026-08-01T01:00:00.000Z', 'text', '以前のやり取りのサンプルです（旧履歴・合成）。', false, false, '旧履歴の相手サンプル'),
      legacyRow(2, 'legacy-chat-001', 'user', '旧履歴の会話サンプル', '2026-08-01T01:05:00.000Z', 'text', 'こちらは自分が送った旧履歴のサンプルです。', true, false, null),
      legacyRow(3, 'legacy-chat-001', 'user', '旧履歴の会話サンプル', '2026-08-01T01:06:00.000Z', 'text', null, false, true, '旧履歴の相手サンプル'),
      legacyRow(4, 'legacy-chat-001', 'user', '旧履歴の会話サンプル', '2026-08-01T01:07:00.000Z', 'image', null, false, false, '旧履歴の相手サンプル'),
      mirrorRow(1, 'legacy-chat-002', '旧履歴のグループサンプル', '2026-08-02T02:00:00.000Z', '旧履歴グループの参加者', '旧履歴グループの合成メッセージです。'),
      mirrorRow(2, 'legacy-chat-002', '旧履歴のグループサンプル', '2026-08-02T02:10:00.000Z', '旧履歴グループの参加者', null, 'sticker'),
    ],
  },
  {
    batch: 2,
    kind: 'events',
    items: [
      s(14, '2026-09-08T01:00:00.000Z', L1, text(14, '追加: 配送先を変更したいです。'), L1_LABELS),
      // Redelivery of an already applied event: duplicate, no change.
      { ...FIRST_TEXT, isRedelivery: true },
      // Same event ID with different text: conflict, rejected without change.
      { ...FIRST_TEXT, message: { id: msgId(11), type: 'text', text: '改ざんされた本文（合成）' } },
      // The user withdraws a message; a later redelivery must not bring it back.
      s(15, '2026-09-08T01:05:00.000Z', L1, { type: 'unsend', unsend: { messageId: msgId(13) } }, L1_LABELS),
      { ...s(13, '2026-09-02T01:02:00.000Z', L1, text(13, UNSENT_TEXT), L1_LABELS), isRedelivery: true },
      // Late arrival with an older timestamp: placed in time order.
      s(23, '2026-09-03T01:30:00.000Z', G1, text(23, '（遅れて届いた）事前の連絡です。'), G1_LABELS),
      // Not accepted: carries a reply token, and an unknown account.
      { ...s(16, '2026-09-08T02:00:00.000Z', L1, text(16, '応答トークン付きの封筒（合成）'), L1_LABELS), replyToken: 'mock-reply-token-not-stored' },
      ev(17, 'line-oa-unknown', mockLineId('U', 'b999'), '2026-09-08T02:00:00.000Z', L1, text(17, '未登録アカウント宛て（合成）')),
    ],
  },
];

function legacyRow(n: number, chatId: string, kind: string, name: string, sentAt: string, msgKind: string, body: string | null, isMine: boolean, e2ee: boolean, sender: string | null) {
  return {
    format: 'legacy-snapshot/v1',
    exportId: 'mock-legacy-export-1',
    cursor: `row-${n}`,
    chat: { chat_id: chatId, kind, name },
    message: { message_id: `legacy-msg-${String(n).padStart(4, '0')}`, sent_at: sentAt, body, kind: msgKind, is_mine: isMine, e2ee, sender_display_name: sender },
    // Not imported: raw provider payloads stay out of this app.
    raw_json: '{"note":"synthetic raw payload that must not be imported"}',
  };
}

function mirrorRow(n: number, chatRef: string, name: string, ts: string, author: string, content: string | null, kind = 'text') {
  return {
    format: 'legacy-mirror/v1',
    exportId: 'mock-legacy-mirror-1',
    chat: { ref: chatRef, kind: 'group', name },
    record: { id: `mirror-${String(n).padStart(4, '0')}`, ts, ts_jst: ts, author, kind, content, src_line: n },
  };
}

export const MAX_LINE_BATCH = 2;
