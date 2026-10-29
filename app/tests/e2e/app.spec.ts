import { expect, injectFaults, loginAs, openThread, resetSample, test, threadButton, threadIdOf } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await resetSample(page);
});

test('editor triages a receipt: status, assignee, labels, note, history, persistence', async ({ page }) => {
  await loginAs(page, 'u-editor-a');
  const sidebar = page.getByRole('navigation', { name: '受信箱' });
  await expect(sidebar).toContainText('サポート窓口');
  await expect(sidebar).toContainText('営業窓口');
  await expect(sidebar).not.toContainText('請求窓口');

  await openThread(page, '見積もりの依頼');
  const card = page.locator('article.receipt').first();
  await card.getByLabel('対応状況').selectOption('in_progress');
  await card.getByLabel('担当者').selectOption({ label: '編集担当C' });
  await card.getByLabel('追加するラベル').fill('見積');
  await card.getByRole('button', { name: '追加', exact: true }).click();
  await card.getByRole('button', { name: '保存' }).click();
  await expect(card.getByText('保存しました。')).toBeVisible();

  await card.getByRole('textbox', { name: '内部メモ' }).fill('E2E: 合成メモを追加');
  await card.getByRole('button', { name: 'メモを追加' }).click();
  await expect(card.locator('.note-body')).toContainText('E2E: 合成メモを追加');

  await card.locator('details.history summary').click();
  await expect(card.locator('details.history')).toContainText('状態 「未対応」→「対応中」');
  await expect(card.locator('details.history')).toContainText('担当 「なし」→「編集担当C」');
  await expect(card.locator('details.history')).toContainText('メモ追加');

  // List chips reflect the change; the change survives a full reload (local demo persistence).
  await expect(threadButton(page, '見積もりの依頼')).toContainText('対応中');
  await page.reload();
  await expect(threadButton(page, '見積もりの依頼')).toContainText('担当: 編集担当C');
  await expect(threadButton(page, '見積もりの依頼')).toContainText('見積');
});

test('page size: chosen from the list, keeps the first row in view, remembered on this device', async ({ page }) => {
  await loginAs(page, 'u-editor-a');
  const count = page.getByTestId('thread-count');
  const size = page.getByLabel('表示件数');
  // Without a remembered choice the list shows 20 rows (2026-10-25; it was 5).
  await expect(size).toHaveValue('20');
  // The sample has between 6 and 10 threads for this persona: two pages at 5, one page at 10.
  const total = Number((await count.textContent())!.match(/全 (\d+) 件/)![1]);
  expect(total).toBeGreaterThan(5);
  expect(total).toBeLessThanOrEqual(10);
  await expect(count).toHaveText(`全 ${total} 件中 1–${total} 件`);
  await size.selectOption('5');
  await expect(count).toHaveText(`全 ${total} 件中 1–5 件`);
  await page.getByRole('button', { name: '次へ' }).click();
  await expect(count).toHaveText(`全 ${total} 件中 6–${total} 件`);

  // From page 2 at 5 rows (rows 6–) to 10 rows: the page holding row 6 is page 1.
  await size.selectOption('10');
  await expect(count).toHaveText(`全 ${total} 件中 1–${total} 件`);
  await expect(page.locator('.threads > li')).toHaveCount(total);
  await expect(page.getByRole('button', { name: '次へ' })).toHaveCount(0);

  await page.reload();
  await expect(count).toHaveText(`全 ${total} 件中 1–${total} 件`);
  await expect(page.getByLabel('表示件数')).toHaveValue('10');
});

test('unified and mailbox views, thread detail, paging and recipient policy', async ({ page }) => {
  await loginAs(page, 'u-editor-a');
  await expect(page.getByTestId('thread-count')).toHaveText('全 6 件中 1–5 件');
  await page.getByRole('button', { name: '次へ' }).click();
  await expect(page.getByTestId('thread-count')).toHaveText('全 6 件中 6–6 件');

  await page.locator('button[data-mailbox-id="mbx-support"]').click();
  await expect(page.getByTestId('thread-count')).toHaveText('全 3 件中 1–3 件');
  await expect(page.locator('.thread-list h2')).toHaveText('サポート窓口');
  await openThread(page, 'ログインできません');
  await expect(page.locator('article.receipt')).toHaveCount(2);

  // The two-mailbox contract message shows only this mailbox's address.
  await page.locator('button[data-mailbox-id="mbx-sales"]').click();
  await openThread(page, '契約更新と請求について');
  const card = page.locator('article.receipt').first();
  await expect(card).toContainText('sales@shared-mail.example');
  await expect(card).toContainText('partner2@partner.example');
  await expect(card).not.toContainText('billing@shared-mail.example');
  await expect(card).not.toContainText('請求窓口だけの内部メモ');
});

test('viewer has read-only access and sees only permitted mailboxes, search and labels', async ({ page }) => {
  await loginAs(page, 'u-viewer-b');
  const sidebar = page.getByRole('navigation', { name: '受信箱' });
  await expect(sidebar).toContainText('請求窓口');
  await expect(sidebar).not.toContainText('営業窓口');

  await page.locator('button[data-mailbox-id="mbx-support"]').click();
  await openThread(page, 'ログインできません');
  const card = page.locator('article.receipt').first();
  await expect(card).toContainText('閲覧のみの権限です');
  await expect(card.getByRole('button', { name: '保存' })).toHaveCount(0);
  await expect(card.getByRole('textbox', { name: '内部メモ' })).toHaveCount(0);
  await expect(card).toContainText('サンプルメモ: 再現手順を確認中です。');

  // The support-only scope excludes billing mail; the unified view finds it.
  await page.getByLabel('検索語').fill('請求限定キーワード');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByTestId('thread-count')).toHaveText('0 件');
  await page.getByRole('button', { name: 'すべての許可された受信箱' }).click();
  await page.getByLabel('検索語').fill('請求限定キーワード');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByTestId('thread-count')).toHaveText('全 1 件中 1–1 件');
  await expect(page.locator('.snippet')).toContainText('請求限定キーワード');
  await expect(page.getByRole('combobox', { name: 'ラベル' })).toContainText('請求限定ラベル');
  const billingThread = await threadIdOf(page, '支払い遅延の連絡');

  // Editor A cannot find it, cannot see its label, and gets "not found" through a direct URL.
  await loginAs(page, 'u-editor-a');
  await page.getByLabel('検索語').fill('請求限定キーワード');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByTestId('thread-count')).toHaveText('0 件');
  await expect(page.getByText('条件に一致するスレッドはありません。')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'ラベル' })).not.toContainText('請求限定ラベル');
  await page.goto(`/#/all?thread=${billingThread}`);
  await expect(page.getByTestId('thread-not-found')).toBeVisible();
  await page.goto('/#/mailbox/mbx-billing');
  await expect(page.locator('.status.error')).toContainText('閲覧権限がありません');
});

test('malicious synthetic HTML is inert: no scripts, events, forms, remote loads or navigation', async ({ page }) => {
  await loginAs(page, 'u-editor-a');
  await openThread(page, '【検証用】危険な HTML');
  const iframe = page.locator('iframe.html-frame');
  await expect(iframe).toHaveAttribute('sandbox', '');
  await expect(page.locator('.safety-note')).toContainText('件をブロック');

  const frame = page.frameLocator('iframe.html-frame');
  await expect(frame.locator('h2')).toHaveText('危険な HTML を含む合成メールです');
  await expect(frame.locator('script, form, input, button, iframe, object, embed, svg, video, img, link, meta[http-equiv="refresh"], base')).toHaveCount(0);
  await expect(frame.locator('[onclick], [onerror], [onload], a[href], [src], [style]')).toHaveCount(0);
  await expect(frame.locator('.mail-link').first()).toHaveAttribute('data-href', 'https://phishing.example/login');

  // Clicking an inert link and the formerly event-bearing paragraph does nothing.
  await frame.locator('.mail-link').first().click();
  await frame.getByText('この段落にはイベント属性が付いています。').click();
  await expect(page).toHaveURL(/127\.0\.0\.1/);
  expect(await page.evaluate(() => (window as unknown as { __smmXss?: string }).__smmXss)).toBeUndefined();

  // Plain-text path.
  await page.getByRole('button', { name: 'テキスト表示' }).click();
  await expect(page.getByTestId('mail-text')).toContainText('危険な HTML を含む合成メールです');
  await expect(page.getByTestId('mail-text')).not.toContainText('__smmXss');

  // A newsletter with remote images and a tracking pixel loads nothing remote either.
  await openThread(page, '展示会のご案内');
  await expect(page.frameLocator('iframe.html-frame').locator('.blocked-image')).toHaveCount(2);
});

test('failure, retry and cancel keep the previous state', async ({ page, request }) => {
  await loginAs(page, 'u-editor-a');
  await expect(page.getByTestId('thread-count')).toHaveText('全 6 件中 1–5 件');
  // Faults are armed by the demo administrator in a separate API session.
  await expect(page.locator('details.fault-panel')).toHaveCount(0);

  // Read failure then retry.
  await injectFaults(request, { failNextRequests: 1 });
  await page.getByLabel('検索語').fill('見積');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.locator('.status.error')).toContainText('模擬障害');
  await expect(threadButton(page, '展示会のご案内')).toBeVisible(); // previous results kept
  await page.getByRole('button', { name: '再試行' }).click();
  await expect(page.getByTestId('thread-count')).toHaveText('全 1 件中 1–1 件');

  // Slow read then cancel: the previous list stays.
  await injectFaults(request, { delayNextRequests: 1, delayMs: 5000 });
  await page.getByRole('button', { name: '条件をクリア' }).click();
  await expect(page.getByText('スレッド一覧を読み込み中…')).toBeVisible();
  await page.locator('.thread-list').getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.getByText('スレッド一覧の読み込みを取り消しました。')).toBeVisible();
  await expect(page.getByTestId('thread-count')).toHaveText('全 1 件中 1–1 件');
  await page.getByRole('button', { name: '再読み込み' }).click();
  await expect(page.getByTestId('thread-count')).toHaveText('全 6 件中 1–5 件');

  // Mutation failure keeps the draft and the saved state; retry succeeds.
  await openThread(page, '見積もりの依頼');
  const card = page.locator('article.receipt').first();
  await card.getByLabel('対応状況').selectOption('on_hold');
  await injectFaults(request, { failNextRequests: 1 });
  await card.getByRole('button', { name: '保存' }).click();
  await expect(card.locator('.status.error')).toContainText('模擬障害');
  await expect(card.getByLabel('対応状況')).toHaveValue('on_hold');
  await expect(threadButton(page, '見積もりの依頼')).toContainText('未対応');
  await card.getByRole('button', { name: '再試行' }).click();
  await expect(card.getByText('保存しました。')).toBeVisible();
  await expect(threadButton(page, '見積もりの依頼')).toContainText('保留');

  // Discarding an unsaved edit restores the saved values.
  await card.getByLabel('対応状況').selectOption('done');
  await card.getByRole('button', { name: '変更を取り消す' }).click();
  await expect(card.getByLabel('対応状況')).toHaveValue('on_hold');
});

test('conflicting edit is rejected and the newer state is shown', async ({ page }) => {
  await loginAs(page, 'u-editor-a');
  await openThread(page, '見積もりの依頼');
  const card = page.locator('article.receipt').first();
  const receiptId = await card.getAttribute('data-receipt-id');
  await card.getByLabel('対応状況').selectOption('done');

  // Another session saves first.
  const other = await page.request.patch(`/api/receipts/${receiptId}/triage`, { data: { expectedVersion: 1, status: 'on_hold', labels: ['先行更新'] } });
  expect(other.status()).toBe(200);

  await card.getByRole('button', { name: '保存' }).click();
  await expect(card.locator('.status.conflict')).toContainText('他の利用者が先に更新したため保存しませんでした');
  await expect(card.locator('.status.conflict')).toContainText('状態=完了');
  await expect(card.getByLabel('対応状況')).toHaveValue('on_hold');
  await expect(card.locator('.labels-edit')).toContainText('先行更新');
});

test('invalid input is rejected with messages and without losing state', async ({ page }) => {
  await loginAs(page, 'u-editor-a');
  await openThread(page, '見積もりの依頼');
  const card = page.locator('article.receipt').first();
  await card.getByLabel('追加するラベル').fill('あ'.repeat(21));
  await card.getByRole('button', { name: '追加', exact: true }).click();
  await expect(card.locator('.status.error')).toContainText('20 文字以内');
  await card.getByRole('button', { name: 'メモを追加' }).click();
  await expect(card.locator('.notes .status.error')).toContainText('メモを入力してください');
  await card.getByRole('textbox', { name: '内部メモ' }).fill('x'.repeat(2001));
  await card.getByRole('button', { name: 'メモを追加' }).click();
  await expect(card.locator('.notes .status.error')).toContainText('2000 文字以内');
  await expect(card.getByRole('textbox', { name: '内部メモ' })).toHaveValue('x'.repeat(2001));
  await page.getByLabel('検索語').fill('x'.repeat(101));
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByText('検索語は 100 文字以内で入力してください。')).toBeVisible();
});

test('demo admin revokes access, syncs the mock connector idempotently and recovers from a connector failure', async ({ page }) => {
  // Viewer B can see a billing thread before revocation.
  await loginAs(page, 'u-viewer-b');
  const billingThread = await threadIdOf(page, '支払い遅延の連絡');

  await loginAs(page, 'u-admin');
  await expect(page.getByRole('heading', { name: 'デモ管理（権限とモック同期）' })).toBeVisible();
  await expect(page.locator('button.thread')).toHaveCount(0);
  await page.getByLabel('閲覧担当B の 請求窓口 権限').selectOption('none');
  await expect(page.getByText('閲覧担当B の「請求窓口」権限を「権限なし」に変更しました。')).toBeVisible();
  await expect(page.locator('ul.audit')).toContainText('閲覧担当B の「請求窓口」権限: read → none');

  // Mock sync: release batch 2, fail one mailbox, then retry.
  await page.getByRole('button', { name: '新着を模擬配信' }).click();
  await expect(page.getByText('モックの新着バッチ 2 を配信しました。')).toBeVisible();
  await page.getByLabel('同期で失敗させる受信箱（デモ）').selectOption('mbx-support');
  await expect(page.getByText('コネクターの模擬障害を設定しました。')).toBeVisible();
  await page.getByRole('button', { name: 'モック同期（差分）' }).click();
  await expect(page.getByTestId('sync-report')).toContainText('取り込み 1 ／ 重複 0 ／ 不正 1 ／ 失敗 1');
  await page.getByLabel('同期で失敗させる受信箱（デモ）').selectOption('');
  await expect(page.getByText('コネクターの模擬障害を解除しました。')).toBeVisible();
  await page.getByRole('button', { name: 'モック同期（差分）' }).click();
  await expect(page.getByTestId('sync-report')).toContainText('取り込み 1 ／ 重複 1 ／ 不正 0 ／ 失敗 0');
  await page.getByRole('button', { name: 'モック同期（全件再取得）' }).click();
  await expect(page.getByTestId('sync-report')).toContainText('取り込み 0 ／');

  // Revocation is effective for B in every UI path; synced mail and handling data appear for A.
  await loginAs(page, 'u-viewer-b');
  await expect(page.getByRole('navigation', { name: '受信箱' })).not.toContainText('請求窓口');
  await page.goto(`/#/all?thread=${billingThread}`);
  await expect(page.getByTestId('thread-not-found')).toBeVisible();

  await loginAs(page, 'u-editor-a');
  await expect(page.getByTestId('thread-count')).toHaveText('全 7 件中 1–5 件');
  await page.locator('button[data-mailbox-id="mbx-support"]').click();
  await expect(threadButton(page, 'パスワード再設定のお願い')).toBeVisible();
  await expect(threadButton(page, 'ログインできません')).toContainText('対応中');
  await expect(threadButton(page, 'ログインできません')).toContainText('要確認');
  await page.locator('button[data-mailbox-id="mbx-sales"]').click();
  await expect(threadButton(page, '見積もりの依頼')).toContainText('2 通');
});

test('sample reset and fault simulation are offered only to the demo administrator', async ({ page }) => {
  for (const persona of ['u-editor-a', 'u-viewer-b', 'u-editor-c', 'u-noaccess-d']) {
    await loginAs(page, persona);
    await expect(page.getByTestId('demo-controls-policy'), persona).toContainText('デモ管理者だけが実行できます');
    await expect(page.getByRole('button', { name: 'サンプルをリセット' }), persona).toHaveCount(0);
    await expect(page.locator('details.fault-panel'), persona).toHaveCount(0);
  }

  // Editor A changes a receipt; only the administrator can return the sample to its initial state.
  await loginAs(page, 'u-editor-a');
  await openThread(page, '見積もりの依頼');
  const card = page.locator('article.receipt').first();
  await card.getByLabel('対応状況').selectOption('on_hold');
  await card.getByRole('button', { name: '保存' }).click();
  await expect(card.getByText('保存しました。')).toBeVisible();

  await loginAs(page, 'u-admin');
  await expect(page.getByTestId('demo-controls-policy')).toHaveCount(0);
  const faults = page.locator('details.fault-panel');
  await faults.locator('summary').click();
  await faults.getByRole('button', { name: '解除' }).click();
  await expect(page.getByText('障害シミュレーションを解除しました。')).toBeVisible();
  await page.getByRole('button', { name: 'サンプルをリセット' }).click();
  await page.getByRole('button', { name: 'リセットする' }).click();
  await expect(page.getByText('合成サンプルを初期化しました。')).toBeVisible();

  await loginAs(page, 'u-editor-a');
  await expect(threadButton(page, '見積もりの依頼')).toContainText('未対応');
});

test('assignment does not grant access', async ({ page }) => {
  await loginAs(page, 'u-editor-a');
  await openThread(page, '見積もりの依頼');
  const card = page.locator('article.receipt').first();
  const options = await card.getByLabel('担当者').locator('option').allTextContents();
  expect(options).toEqual(['担当なし', '編集担当A', '編集担当C']); // only current readers of 営業窓口
  await card.getByLabel('担当者').selectOption({ label: '編集担当C' });
  await card.getByRole('button', { name: '保存' }).click();
  await expect(card.getByText('保存しました。')).toBeVisible();

  // Revoke C's sales access; C then cannot see the assigned receipt, A sees the warning.
  await loginAs(page, 'u-admin');
  await page.getByLabel('編集担当C の 営業窓口 権限').selectOption('none');
  await expect(page.getByText('編集担当C の「営業窓口」権限を「権限なし」に変更しました。')).toBeVisible();
  await loginAs(page, 'u-editor-c');
  await expect(page.getByRole('navigation', { name: '受信箱' })).not.toContainText('営業窓口');
  await expect(threadButton(page, '見積もりの依頼')).toHaveCount(0);
  await loginAs(page, 'u-editor-a');
  await openThread(page, '見積もりの依頼');
  await expect(page.locator('article.receipt').first()).toContainText('現在の担当者はこの受信箱の閲覧権限を失っています');
});

test('common tabs and the home screen; on a phone the list and the opened thread take turns', async ({ page }) => {
  await loginAs(page, 'u-editor-a');
  // Same tabs in the same order on every screen; the current one is marked. Every module tab is always shown
  // (the tasks and rental screens say why they cannot be used here); the rental tab is a separate page.
  const tabs = page.getByRole('navigation', { name: '機能' });
  await expect(tabs.getByRole('link')).toHaveText(['ホーム', 'タスク', '物品貸出', 'メール', '連絡先', 'Bot', '設定']);
  await expect(tabs.getByRole('link', { name: 'メール', exact: true })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: 'ホーム' }).click();
  await expect(page).toHaveTitle('ホーム｜医薬祭 委員会アプリ');
  await expect(tabs.getByRole('link', { name: 'ホーム' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('home-inbox')).toContainText('未対応');
  await expect(page.getByTestId('home-rental')).toHaveCount(0);
  await page.getByTestId('home-inbox').getByRole('button', { name: /メール(を見る|を開く)$/ }).click();
  await expect(page.getByTestId('thread-count')).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('region', { name: 'スレッド詳細' })).toBeHidden();
  await page.locator('button.thread').first().click();
  await expect(page.locator('.thread-title')).toBeVisible();
  await expect(page.getByRole('region', { name: 'スレッド一覧' })).toBeHidden();
  await page.getByRole('button', { name: '← 一覧に戻る' }).click();
  await expect(page.getByTestId('thread-count')).toBeVisible();
  await expect(page.getByRole('region', { name: 'スレッド詳細' })).toBeHidden();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, 'no sideways scrolling on a phone').toBeLessThanOrEqual(375);
});
