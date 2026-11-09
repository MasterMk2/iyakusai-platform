import { mkdirSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import type { BroadcastOptionsResponse, BroadcastPreviewResponse, LineFileResponse, LineMediaResponse } from '../../src/shared/line.js';
import { expect, loginAs, resetSample, test } from './fixtures.js';

// Images (up to four) and files sent as links from the official LINE forms (2026-11-10). The demo server has no
// public address, so the uploads and the confirmation are answered with synthetic data here; the server side is
// tested in tests/mailbox/line-send.test.ts.

test.beforeEach(async ({ page }) => {
  await resetSample(page);
  mkdirSync('.tmp', { recursive: true });
});

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n%synthetic\n%%EOF\n');

async function fakeUploads(page: Page) {
  let n = 0;
  await page.route('**/api/line/media', async (route) => {
    n += 1;
    const body: LineMediaResponse = { id: `lmd_${String(n).padStart(16, '0')}`, previewUrl: `data:image/png;base64,${PNG.toString('base64')}`, expiresAt: '2026-11-17T00:00:00Z' };
    await route.fulfill({ status: 201, json: body });
  });
  await page.route('**/api/line/files', async (route) => {
    n += 1;
    const body: LineFileResponse = { id: `lfl_${String(n).padStart(16, '0')}`, name: '出展要項.pdf', bytes: 120_000, kindLabel: 'PDF', expiresAt: '2026-11-17T00:00:00Z' };
    await route.fulfill({ status: 201, json: body });
  });
}

test('a broadcast takes several images and a file, the period is chosen, and the confirmation shows the links', async ({ page }) => {
  let asked: Record<string, unknown> | null = null;
  await page.route('**/api/line/accounts/*/broadcast', async (route: Route) => {
    const res = await route.fetch();
    const options = (await res.json()) as BroadcastOptionsResponse;
    await route.fulfill({ json: { ...options, imagesEnabled: true, filesEnabled: true } });
  });
  await page.route('**/api/line/accounts/*/broadcast/preview', async (route) => {
    asked = route.request().postDataJSON() as Record<string, unknown>;
    const link = 'https://app.example.invalid/line-files/' + 'a'.repeat(64) + '.pdf';
    const preview: BroadcastPreviewResponse = {
      consentId: 'c'.repeat(43), expiresAt: '2026-11-10T00:05:00Z', account: { id: 'line-oa-support', name: 'LINE公式 サポート（模擬）' },
      recipients: [{ conversationId: 'lc_0000000000000001', title: '顧客サンプルL1', maskedId: '…c001' }], count: 1,
      body: `${String(asked.body)}\n\n📎 添付ファイル（12月10日（木）まで開けます）\n出展要項.pdf（PDF・117 KB）\n${link}`,
      image: { previewUrl: `data:image/png;base64,${PNG.toString('base64')}` },
      images: [{ previewUrl: `data:image/png;base64,${PNG.toString('base64')}` }, { previewUrl: `data:image/png;base64,${PNG.toString('base64')}` }],
      files: [{ name: '出展要項.pdf', bytes: 120_000, kindLabel: 'PDF', url: link }], publicUntil: '2026-12-10T14:59:59.999Z', publicDays: 30,
      monthUsed: 0, monthlyLimit: 200, lineUsage: null, lineLimit: null, mock: true, notices: ['LINE はファイルをそのまま送れないため、本文の末尾にファイルのリンク（1 個）を付けます。'],
    };
    await route.fulfill({ json: preview });
  });
  await fakeUploads(page);
  await loginAs(page, 'u-editor-c');
  await page.getByRole('navigation', { name: '機能' }).getByRole('link', { name: '公式LINE' }).click();
  await page.getByTestId('line-broadcast-side').click();
  const form = page.getByTestId('line-broadcast');
  const to = form.getByRole('combobox', { name: '宛先' });
  await to.fill('サンプルL1');
  await to.press('ArrowDown');
  await to.press('Enter');
  await form.getByRole('textbox', { name: '本文' }).fill('出展要項と会場図を送ります。');

  // Two images at once, then a file; the period appears once something is attached.
  await expect(form.getByTestId('line-public-days')).toHaveCount(0);
  await form.getByTestId('line-image-input').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: PNG },
    { name: 'b.png', mimeType: 'image/png', buffer: PNG },
  ]);
  await expect(form.getByTestId('line-attach-images').getByRole('img')).toHaveCount(2);
  await form.getByTestId('line-file-input').setInputFiles({ name: '出展要項.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(form.getByTestId('line-attach-files')).toContainText('出展要項.pdf');
  await expect(form.getByTestId('line-attach-files')).toContainText('PDF・117 KB');
  const days = form.getByTestId('line-public-days');
  await expect(days).toHaveValue('7');
  await days.selectOption('30');
  await page.screenshot({ path: '.tmp/line-attach-form.png', fullPage: true });

  await form.getByRole('button', { name: '送信内容を確認' }).click();
  expect(asked).toMatchObject({ imageIds: ['lmd_0000000000000001', 'lmd_0000000000000002'], fileIds: ['lfl_0000000000000003'], publicDays: 30 });
  const preview = form.getByTestId('broadcast-preview');
  await expect(preview.getByTestId('preview-images').getByRole('img')).toHaveCount(2);
  await expect(preview.getByTestId('preview-files')).toContainText('出展要項.pdf（PDF・117 KB）');
  await expect(preview.getByTestId('preview-public-until')).toHaveText('12月10日（木）まで開けます');
  await expect(preview.getByTestId('broadcast-body')).toContainText('📎 添付ファイル');
  // The text names 添付 and a file goes with it: no warning about a missing attachment.
  await expect(preview.getByTestId('line-screen')).not.toContainText('付いていません');
  await page.screenshot({ path: '.tmp/line-attach-preview.png', fullPage: true });

  // Back to the form: the images and the file stay; one image can be taken off.
  await preview.getByRole('button', { name: '編集に戻る' }).click();
  await form.getByRole('button', { name: '画像 1 を外す' }).click();
  await expect(form.getByTestId('line-attach-images').getByRole('img')).toHaveCount(1);
  await expect(form.getByTestId('line-attach-files')).toContainText('出展要項.pdf');
  // On a phone: no sideways scroll, and the 外す buttons are big enough to tap.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const remove = await form.getByRole('button', { name: '出展要項.pdf を外す' }).boundingBox();
  expect(remove!.height).toBeGreaterThanOrEqual(24);
  await form.getByTestId('line-attach-images').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.tmp/line-attach-mobile.png' });
});

test('the reply in a conversation saves the images and the file with the draft and asks with the period', async ({ page }) => {
  const drafts: Record<string, unknown>[] = [];
  let previewAsked: Record<string, unknown> | null = null;
  await page.route(/\/api\/line\/conversations\/lc_[0-9a-f]+$/, async (route) => {
    const res = await route.fetch();
    const detail = await res.json();
    await route.fulfill({ json: { ...detail, reply: { ...detail.reply, imagesEnabled: true, filesEnabled: true } } });
  });
  await page.route('**/reply/draft', async (route) => {
    const input = route.request().postDataJSON() as Record<string, unknown>;
    drafts.push(input);
    await route.fulfill({ json: { id: 'ld_0000000000000001', version: drafts.length, body: String(input.body).trim(), updatedAt: '2026-11-10T00:00:00Z', imageId: null, images: [], files: [] } });
  });
  await page.route('**/reply/preview', async (route) => {
    previewAsked = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 422, json: { error: 'validation', message: '合成：ここで止めます。' } });
  });
  await fakeUploads(page);
  await loginAs(page, 'u-editor-c');
  await page.getByRole('navigation', { name: '機能' }).getByRole('link', { name: '公式LINE' }).click();
  await page.locator('button[data-line-account-id="line-oa-support"]').click();
  await page.locator('button.thread[data-conversation-id]', { has: page.locator('.subject', { hasText: /^顧客サンプルL1$/ }) }).click();
  const reply = page.getByRole('region', { name: 'LINE で返信（模擬送信）' });
  await reply.getByRole('textbox', { name: '本文' }).fill('資料をお送りします。');
  await reply.getByTestId('line-image-input').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG });
  await expect(reply.getByTestId('line-attach-images').getByRole('img')).toHaveCount(1);
  await reply.getByTestId('line-file-input').setInputFiles({ name: '出展要項.pdf', mimeType: 'application/pdf', buffer: PDF });
  await reply.getByTestId('line-public-days').selectOption('1');
  await reply.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(reply.getByTestId('line-reply-message')).toContainText('合成：ここで止めます。');
  expect(drafts.at(-1)).toMatchObject({ body: '資料をお送りします。', imageIds: ['lmd_0000000000000001'], fileIds: ['lfl_0000000000000002'] });
  expect(previewAsked).toMatchObject({ draftVersion: 1, publicDays: 1 });
});
