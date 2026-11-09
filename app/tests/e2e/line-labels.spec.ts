import type { Page } from '@playwright/test';
import { expect, loginAs, resetSample, test } from './fixtures.js';

// Labels of an official LINE conversation set from its list row (2026-11-10): the exhibit categories, the
// names already used and the organizations ledger are offered, each click saves at once, and the labels are
// the conversation's ordinary labels (the ラベル filter and the detail pane). Synthetic data only.

test.beforeEach(async ({ page }) => {
  await resetSample(page);
});

const row = (page: Page, title: string) =>
  page.locator('li.thread-row', { has: page.locator('button.thread[data-conversation-id] .subject', { hasText: new RegExp(`^${title}$`) }) });

async function openLineTab(page: Page) {
  await page.getByRole('navigation', { name: '機能' }).getByRole('link', { name: '公式LINE' }).click();
  await expect(page.getByTestId('thread-count')).toHaveText(/^全 7 件中/);
}

test('labels are set from a LINE row: a category, a typed name, a name used before and a ledger name', async ({ page }) => {
  await loginAs(page, 'u-editor-c');
  await openLineTab(page);

  const first = row(page, '顧客サンプルL2');
  await first.getByRole('button', { name: '「顧客サンプルL2」のラベルを付ける' }).click();
  const editor = first.getByRole('region', { name: '「顧客サンプルL2」のラベル' });
  await expect(editor).toContainText('まだありません');
  const toggle = first.getByRole('button', { name: '「顧客サンプルL2」のラベルを閉じる' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // One click on a category saves it; it shows as pressed.
  const categories = editor.getByRole('group', { name: '企画の区分' });
  await categories.getByRole('button', { name: '飲食' }).click();
  await expect(editor.getByRole('status')).toHaveText('「飲食」を付けました。');
  await expect(categories.getByRole('button', { name: '✓ 飲食' })).toHaveAttribute('aria-pressed', 'true');

  // A typed name is added with Enter; 全角 letters are kept as the server keeps them.
  const name = editor.getByRole('textbox', { name: '団体名など' });
  await name.fill('合成チームＡ');
  await name.press('Enter');
  await expect(editor.getByRole('status')).toHaveText('「合成チームA」を付けました。');
  await expect(name).toHaveValue('');

  // Esc closes the editor and returns to the row's button; the row shows the labels, and the filter offers them.
  await name.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(first.getByRole('button', { name: '「顧客サンプルL2」のラベルを付ける' })).toBeFocused();
  await expect(first.locator('.chip.label')).toHaveText(['合成チームA', '飲食']);
  const filter = page.getByLabel('ラベル', { exact: true });
  await expect(filter.locator('option')).toContainText(['飲食（1）', '合成チームA（1）']);

  // Another row is offered the name used before, and the ledger's names for the typed text.
  const second = row(page, 'トークルーム（模擬）');
  await second.getByRole('button', { name: '「トークルーム（模擬）」のラベルを付ける' }).click();
  const other = second.getByRole('region', { name: '「トークルーム（模擬）」のラベル' });
  await other.getByRole('group', { name: 'これまでに使ったラベル' }).getByRole('button', { name: '＋ 合成チームA' }).click();
  await expect(other.getByRole('status')).toHaveText('「合成チームA」を付けました。');
  await other.getByRole('textbox', { name: '団体名など' }).fill('合成商事');
  await other.getByRole('group', { name: '入力に合う名前' }).getByRole('button', { name: '＋ 合成商事株式会社' }).click();
  await expect(other.getByRole('status')).toHaveText('「合成商事株式会社」を付けました。');

  // × takes a label off again.
  await other.getByRole('button', { name: 'ラベル「合成チームA」を外す' }).click();
  await expect(other.getByRole('status')).toHaveText('「合成チームA」を外しました。');
  await expect(filter.locator('option')).toContainText(['合成チームA（1）', '合成商事株式会社（1）']);

  // The filter finds the conversation by its label, and the detail pane shows the same labels.
  await filter.selectOption({ label: '合成商事株式会社（1）' });
  await expect(page.getByTestId('thread-count')).toHaveText(/^全 1 件中/);
  await second.locator('button.thread').click();
  await expect(page.locator('.thread-detail .triage .chip.label')).toHaveText(['合成商事株式会社×']);
});

test('a label changed by someone else first is not overwritten from the row', async ({ page }) => {
  await loginAs(page, 'u-editor-c');
  await openLineTab(page);
  const target = row(page, '顧客サンプルL2');
  await target.getByRole('button', { name: '「顧客サンプルL2」のラベルを付ける' }).click();
  const editor = target.getByRole('region', { name: '「顧客サンプルL2」のラベル' });

  // Someone else saves a label while this editor still has the older version.
  const id = await target.locator('button.thread').getAttribute('data-conversation-id');
  const current = await (await page.request.get(`/api/line/conversations/${id}`)).json();
  const saved = await page.request.patch(`/api/line/conversations/${id}/triage`, {
    headers: { 'X-SMM-CSRF': '1' },
    data: { expectedVersion: current.triage.version, labels: ['合成の先客'] },
  });
  expect(saved.ok()).toBe(true);

  await editor.getByRole('group', { name: '企画の区分' }).getByRole('button', { name: 'ステージ' }).click();
  await expect(editor.getByRole('alert')).toContainText('ほかの人が先に変更したため、「ステージ」を付ける変更は保存していません');
  await expect(editor.locator('.chip.label')).toHaveText(['合成の先客×']);

  // The next click starts from the newer version and keeps the other person's label.
  await editor.getByRole('group', { name: '企画の区分' }).getByRole('button', { name: 'ステージ' }).click();
  await expect(editor.getByRole('status')).toHaveText('「ステージ」を付けました。');
  await expect(editor.locator('.chip.label')).toHaveText(['合成の先客×', 'ステージ×']);
});

test('a reader without the right to change the handling sees the labels but no button', async ({ page }) => {
  await loginAs(page, 'u-viewer-b');
  await page.getByRole('navigation', { name: '機能' }).getByRole('link', { name: '公式LINE' }).click();
  const readOnly = row(page, '顧客サンプルL1');
  await expect(readOnly).toBeVisible();
  await expect(readOnly.getByRole('group', { name: '「顧客サンプルL1」の対応状況' })).toHaveCount(0);
  await expect(readOnly.locator('.label-toggle')).toHaveCount(0);
});
