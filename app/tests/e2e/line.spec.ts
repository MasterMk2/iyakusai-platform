import type { Page } from '@playwright/test';
import { expect, loginAs, resetSample, test } from './fixtures.js';

// Synthetic LINE inbox in demo mode: mock data and the mock push connector only.
// The shared fixture also asserts that no external network request is attempted.

test.beforeEach(async ({ page }) => {
  await resetSample(page);
});

const lineItem = (page: Page, title: string) =>
  page.locator('button.thread[data-conversation-id]', { has: page.locator('.subject', { hasText: new RegExp(`^${title}$`) }) });

async function openLine(page: Page, accountId: string, title: string) {
  await page.locator(`button[data-line-account-id="${accountId}"]`).click();
  await lineItem(page, title).click();
  await expect(page.locator('.thread-title')).toContainText(title);
}

test('editor sees email and LINE together, previews the exact reply, edits require re-confirmation, and one mock send is recorded', async ({ page }) => {
  await loginAs(page, 'u-editor-c');
  await expect(page.getByTestId('source-counts')).toHaveText('内訳: メール 6 件 ／ LINE 7 件');
  await page.getByLabel('種類').selectOption('line');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByTestId('thread-count')).toHaveText('全 7 件中 1–5 件');
  await expect(page.locator('button.thread .source-email')).toHaveCount(0);

  await openLine(page, 'line-oa-support', '顧客サンプルL1');
  const detail = page.locator('.thread-detail');
  await expect(page.getByTestId('line-mock-notice')).toContainText('実際の LINE への送信は接続されていません');
  await expect(detail.locator('.line-placeholder').first()).toContainText('内容は取り込んでいません');

  const box = detail.getByRole('textbox', { name: '返信本文' });
  await box.fill('E2E の返信（合成）');
  await detail.getByRole('button', { name: '下書きを保存して送信内容を確認' }).click();
  const preview = page.getByTestId('line-reply-preview');
  await expect(page.getByTestId('preview-account')).toHaveText('LINE公式 サポート（模擬）');
  await expect(page.getByTestId('preview-target')).toHaveText('顧客サンプルL1（1:1 トーク・ID …c001）');
  await expect(page.getByTestId('preview-recipients')).toContainText('1 人');
  await expect(page.getByTestId('preview-method')).toHaveText('プッシュメッセージ（模擬）');
  await expect(page.getByTestId('preview-body')).toHaveText('E2E の返信（合成）');
  await expect(preview).toContainText('月間のメッセージ通数');
  await expect(preview.getByRole('button', { name: '模擬送信する' })).toBeDisabled();

  // Editing after the preview discards it.
  await box.fill('E2E の返信（合成・修正）');
  await expect(preview).toHaveCount(0);
  await expect(detail.getByText('もう一度確認が必要です')).toBeVisible();
  await detail.getByRole('button', { name: '下書きを保存して送信内容を確認' }).click();
  await expect(page.getByTestId('preview-body')).toHaveText('E2E の返信（合成・修正）');
  await page.getByLabel('上記の送信先・本文で送信することを確認しました').check();
  await page.getByRole('button', { name: '模擬送信する' }).dblclick();

  await expect(page.getByTestId('line-reply-message')).toContainText('受付済み（模擬）');
  const outbox = page.locator('li.outbox');
  await expect(outbox).toHaveCount(1);
  await expect(outbox.getByTestId('outbox-status')).toHaveText('受付済み（模擬）');
  await expect(outbox).toContainText('配信や既読は確認できません');
  await expect(outbox).toContainText('E2E の返信（合成・修正）');
  await expect(detail).not.toContainText('配信済み');

  await page.reload();
  await expect(page.locator('li.outbox')).toHaveCount(1);
  await page.locator('details.history summary').click();
  await expect(page.locator('details.history')).toContainText('返信の送信を開始');
  await expect(page.locator('details.history')).not.toContainText('E2E の返信');
});

test('read-only viewer cannot reply, legacy history is read-only, and users without LINE access see nothing', async ({ page }) => {
  await loginAs(page, 'u-viewer-b');
  const sidebar = page.getByRole('navigation', { name: '受信箱' });
  await expect(sidebar).toContainText('LINE公式 サポート（模擬）');
  await expect(sidebar).not.toContainText('店舗');

  await openLine(page, 'line-oa-support', '顧客サンプルL1');
  await expect(page.getByTestId('line-reply-unavailable')).toContainText('返信する権限がありません');
  await expect(page.getByRole('textbox', { name: '返信本文' })).toHaveCount(0);
  await expect(page.getByText('閲覧のみの権限です')).toBeVisible();
  const convUrl = page.url();
  const conversationId = new URL(convUrl).hash.split('conv=')[1]!;

  // A forged send from this session is refused by the server.
  const forged = await page.request.post(`/api/line/conversations/${conversationId}/reply/send`, {
    data: { consentId: 'A'.repeat(43), operationId: '00000000-0000-4000-8000-000000000001', draftId: `ld_${'0'.repeat(16)}`, draftVersion: 1, body: '偽装した送信' },
  });
  expect(forged.status()).toBe(403);

  await openLine(page, 'line-legacy', '旧履歴の会話サンプル');
  await expect(page.getByTestId('line-reply-unavailable')).toContainText('旧履歴の会話は');
  await expect(page.locator('.thread-detail')).toContainText('［暗号化のため内容を取得できませんでした］');

  await loginAs(page, 'u-noaccess-d');
  await expect(page.locator('[data-line-account-id]')).toHaveCount(0);
  await page.goto(convUrl);
  await expect(page.getByTestId('thread-not-found')).toBeVisible();
});

test('administrator manages LINE grants and releases synthetic events without reading contents; unsend hides the text', async ({ page }) => {
  await loginAs(page, 'u-admin');
  await expect(page.getByRole('heading', { name: 'LINE アカウントごとの権限' })).toBeVisible();
  await expect(page.getByLabel('閲覧担当B の LINE「LINE公式 サポート（模擬）」返信権限')).not.toBeChecked();
  await page.getByRole('button', { name: 'LINE の模擬イベントを取り込む' }).click();
  await expect(page.getByText(/LINE の模擬イベントを取り込みました: 追加 2 ／ 重複 1 ／ 競合 1 ／ 抑止 1 ／ 拒否 2 ／ 送信取消 1/)).toBeVisible();
  await expect(page.locator('ul.line-audit')).toContainText('送信取消を反映');
  await expect(page.locator('ul.line-audit')).not.toContainText('SAMPLE-0001');
  await expect(page.locator('button.thread')).toHaveCount(0);

  await loginAs(page, 'u-editor-c');
  await openLine(page, 'line-oa-support', '顧客サンプルL1');
  await expect(page.locator('.thread-detail')).toContainText('［送信者がこのメッセージの送信を取り消しました］');
  await expect(page.locator('.thread-detail')).not.toContainText('SAMPLE-0001');
  await expect(page.locator('.thread-detail')).toContainText('追加: 配送先を変更したいです。');
});
