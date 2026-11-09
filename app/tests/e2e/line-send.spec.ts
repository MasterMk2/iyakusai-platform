import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { BroadcastOptionsResponse, BroadcastPreviewResponse, BroadcastRecipientView } from '../../src/shared/line.js';
import { installBotFake } from './assistant-fake.js';
import { expect, loginAs, resetSample, test } from './fixtures.js';

// Sending from the official LINE with the mail form's shape (2026-11-09): 宛先 picked by typing a name (chips),
// the fixed checks on the text the server confirmed, 編集に戻る, and the Bot's proofreading. Demo data and the mock
// push connector only; the many-recipient case answers the options and the preview with synthetic data.

test.beforeEach(async ({ page }) => {
  await resetSample(page);
  mkdirSync('.tmp', { recursive: true });
});

const openLineTab = (page: Page) => page.getByRole('navigation', { name: '機能' }).getByRole('link', { name: '公式LINE' }).click();

async function openSend(page: Page) {
  await openLineTab(page);
  await page.getByTestId('line-broadcast-side').click();
  return page.getByTestId('line-broadcast');
}

test('the official LINE is sent like a mail: pick by name, check, go back to edit, check again, send once', async ({ page }) => {
  await loginAs(page, 'u-editor-c');
  const form = await openSend(page);
  await expect(form.getByRole('heading', { name: /公式LINEを送信/ })).toBeVisible();
  await expect(form.getByTestId('line-send-account')).toHaveText('LINE公式 サポート（模擬）');

  // Nothing chosen and nothing written: the button says what is missing next to each field.
  await form.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(form.locator('#line-send-to-error')).toContainText('宛先を選んでください。');
  await expect(form.locator('#line-send-body-error')).toHaveText('本文を入力してください。');

  // Typing part of the name offers the person; Enter that ends a Japanese conversion picks nothing.
  const to = form.getByRole('combobox', { name: '宛先' });
  await to.fill('サンプルL1');
  const suggestion = form.getByTestId('line-to-suggestion');
  await expect(suggestion).toHaveCount(1);
  await expect(suggestion).toContainText('顧客サンプルL1');
  await to.press('ArrowDown');
  await to.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  await expect(form.getByTestId('line-chips')).toHaveCount(0);
  await to.press('Enter');
  await expect(form.getByTestId('line-chips')).toContainText('顧客サンプルL1');
  await expect(to).toHaveValue('');
  // The picked person is not offered again.
  await to.fill('サンプルL1');
  await expect(form.getByText('「サンプルL1」に当たる相手がいません')).toBeVisible();
  await to.fill('');

  const body = form.getByRole('textbox', { name: '本文' });
  await body.fill('医薬祭実行委員会です。\n2026年11月13日（木）の搬入は 9 時からです。地図の画像も見てください。');
  await form.getByRole('button', { name: '送信内容を確認' }).click();
  const preview = form.getByTestId('broadcast-preview');
  await expect(preview.getByTestId('broadcast-count')).toContainText('1 人（通数として 1 通）');
  await expect(preview.getByTestId('broadcast-body')).toContainText('2026年11月13日（木）の搬入');
  const screen = preview.getByTestId('line-screen');
  await expect(screen).toContainText('「2026年11月13日(木)」の曜日が違います');
  await expect(screen).toContainText('画像が付いていません');
  await expect(preview.getByTestId('broadcast-confirm').locator('xpath=..')).toContainText('注意 2 件を確かめたうえで、上記の 1 人に、この内容で送ります');
  await expect(preview.getByTestId('broadcast-send')).toBeDisabled();
  await page.screenshot({ path: '.tmp/line-send-checks.png', fullPage: true });

  // Back to the form: the person and the text are kept; the fixed text is checked again.
  await preview.getByRole('button', { name: '編集に戻る' }).click();
  await expect(form.getByTestId('line-chips')).toContainText('顧客サンプルL1');
  await body.fill('医薬祭実行委員会です。\n2026年11月13日（金）の搬入は 9 時からです。');
  await form.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(preview.getByTestId('line-screen')).toContainText('気になる点は見つかりませんでした');
  await preview.getByTestId('broadcast-confirm').check();
  await preview.getByRole('button', { name: '1 人に模擬送信する' }).dblclick();
  await expect(form.getByTestId('broadcast-message')).toContainText('1 人');
  // The form is empty again for the next message.
  await expect(form.getByTestId('line-chips')).toHaveCount(0);
  await expect(body).toHaveValue('');
});

function recipient(n: number, friend = true): BroadcastRecipientView {
  const id = String(n).padStart(4, '0');
  return { conversationId: `lc_synthetic_${id}`, title: `合成メンバー${n}`, maskedId: `…${id}`, friend, latestAt: `2026-11-0${(n % 9) + 1}T01:00:00Z` };
}

test('with many people: narrow by name, pick with the mouse, remove a chip, pick from the list, or send to everyone', async ({ page }) => {
  const recipients = [...Array.from({ length: 29 }, (_, i) => recipient(i + 1)), recipient(30, false)];
  const asked: { recipients: string[] | 'all'; body: string }[] = [];
  await page.route('**/api/line/accounts/*/broadcast', async (route) => {
    const options: BroadcastOptionsResponse = { account: { id: 'line-oa-support', name: 'LINE公式 サポート（模擬）' }, recipients, monthUsed: 3, monthlyLimit: 200, imagesEnabled: false, mock: true };
    await route.fulfill({ json: options });
  });
  await page.route('**/api/line/accounts/*/broadcast/preview', async (route) => {
    const input = route.request().postDataJSON() as { recipients: string[] | 'all'; body: string };
    asked.push(input);
    const chosen = input.recipients === 'all' ? recipients : recipients.filter((r) => (input.recipients as string[]).includes(r.conversationId));
    const preview: BroadcastPreviewResponse = {
      consentId: 'consent-synthetic', expiresAt: '2026-11-09T15:00:00Z', account: { id: 'line-oa-support', name: 'LINE公式 サポート（模擬）' },
      recipients: chosen.map((r) => ({ conversationId: r.conversationId, title: r.title, maskedId: r.maskedId })), count: chosen.length, body: input.body.trim(),
      image: null, monthUsed: 3, monthlyLimit: 200, lineUsage: 10, lineLimit: 200, mock: true, notices: ['月間のメッセージ通数に数えられます。'],
    };
    await route.fulfill({ json: preview });
  });
  await loginAs(page, 'u-editor-c');
  const form = await openSend(page);
  const to = form.getByRole('combobox', { name: '宛先' });

  // Focusing shows the most recent people; typing narrows them.
  await to.click();
  await expect(form.getByTestId('line-to-suggestion')).toHaveCount(8);
  await to.fill('メンバー2');
  await expect(form.getByTestId('line-to-suggestion').first()).toContainText('合成メンバー2');
  await form.getByTestId('line-to-suggestion').filter({ hasText: '合成メンバー21' }).click();
  await to.fill('メンバー30');
  await form.getByTestId('line-to-suggestion').filter({ hasText: '合成メンバー30' }).click();
  const chips = form.getByTestId('line-chips');
  await expect(chips.getByRole('listitem')).toHaveCount(2);
  await expect(chips.getByRole('listitem').nth(1)).toContainText('友だち未確認');
  // Backspace in the empty field takes the last one back; the × button takes any.
  await to.press('Backspace');
  await expect(chips.getByRole('listitem')).toHaveCount(1);
  await to.fill('メンバー30');
  await to.press('ArrowDown');
  await to.press('Tab');
  await expect(chips.getByRole('listitem')).toHaveCount(2);
  await chips.getByRole('button', { name: '合成メンバー21 を外す' }).click();
  await expect(chips.getByRole('listitem')).toHaveCount(1);

  // Someone whose name is not remembered: the whole list, folded below.
  await form.getByText('一覧から選ぶ（30 人）').click();
  await form.getByRole('searchbox', { name: '一覧を名前で絞り込む' }).fill('メンバー5');
  await form.locator('input[data-conversation-id="lc_synthetic_0005"]').check();
  await expect(chips.getByRole('listitem')).toHaveCount(2);

  // One person's name in a text to two people is pointed out; what was asked is exactly the picked people.
  await form.getByRole('textbox', { name: '本文' }).fill('合成メンバー5さん、資料ありがとうございます。\n明日は 9 時集合です。');
  await form.getByRole('button', { name: '送信内容を確認' }).click();
  const preview = form.getByTestId('broadcast-preview');
  await expect(preview.getByTestId('line-screen')).toContainText('2 人に同じ文が届きます。本文にある「合成メンバー5」の名前は、ほかの相手にも見えます。');
  await expect(preview.getByTestId('line-screen')).toContainText('友だち登録が確認できない相手が 1 人います');
  await expect(preview).toContainText('月間のメッセージ通数に数えられます。');
  expect(asked.at(-1)!.recipients).toEqual(['lc_synthetic_0030', 'lc_synthetic_0005']);

  // Everyone: one tick replaces the field.
  await preview.getByRole('button', { name: '編集に戻る' }).click();
  await form.getByTestId('broadcast-all').check();
  await expect(form.getByTestId('line-to-all')).toHaveText('送れる相手すべて（30 人）');
  await expect(to).toHaveCount(0);
  await form.getByRole('textbox', { name: '本文' }).fill('明日は 9 時集合です。');
  await form.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(preview.getByTestId('broadcast-count')).toContainText('30 人');
  expect(asked.at(-1)!.recipients).toBe('all');
  await expect(preview.getByRole('button', { name: '30 人に模擬送信する' })).toBeDisabled();
  await page.screenshot({ path: '.tmp/line-send-all.png', fullPage: true });
});

test('the Bot proofreads the LINE message being written, without the people’s names or IDs', async ({ page }) => {
  const fake = await installBotFake(page);
  await loginAs(page, 'u-editor-c');
  const form = await openSend(page);
  await form.getByRole('combobox', { name: '宛先' }).fill('サンプルL1');
  await form.getByRole('combobox', { name: '宛先' }).press('ArrowDown');
  await form.getByRole('combobox', { name: '宛先' }).press('Enter');
  await form.getByRole('textbox', { name: '本文' }).fill('11月13日（金）の搬入は 9 時からです。');
  const review = form.getByTestId('line-review');
  await expect(review).toContainText('相手の名前と LINE の ID は渡しません');
  await expect(review).toContainText('#bottest');
  await review.getByRole('button', { name: '校閲・ファクトチェックを頼む' }).click();
  await expect(review.getByTestId('job-panel')).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
  const job = [...fake.jobs.values()].find((j) => j.input.docType === 'free');
  expect(job!.kind).toBe('doc');
  const content = String(job!.input.content);
  expect(content).toContain('公式LINEから送る前のメッセージ');
  expect(content).toContain('【相手】1:1 の相手 1 人');
  expect(content).toContain('11月13日（金）の搬入は 9 時からです。');
  expect(content).not.toContain('顧客サンプルL1');
  expect(content).not.toContain('c001');
  await page.screenshot({ path: '.tmp/line-send-review.png', fullPage: true });
  await form.getByRole('textbox', { name: '本文' }).fill('11月13日（金）の搬入は 10 時からです。');
  await expect(review).toContainText('依頼したあとで本文か宛先の人数が変わっています。');
});

test('on a phone the form works with taps only: open from above the list, tap a person, check', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, 'u-editor-c');
  await openLineTab(page);
  await page.getByTestId('line-broadcast-open').click();
  const form = page.getByTestId('line-broadcast');
  await form.getByRole('combobox', { name: '宛先' }).click();
  await form.getByTestId('line-to-suggestion').filter({ hasText: '顧客サンプルL1' }).click();
  await expect(form.getByTestId('line-chips')).toContainText('顧客サンプルL1');
  const remove = form.getByRole('button', { name: '顧客サンプルL1 を外す' });
  const box = await remove.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await form.getByRole('textbox', { name: '本文' }).fill('明日は 9 時集合です。');
  await form.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(form.getByTestId('broadcast-preview')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.tmp/line-send-mobile.png', fullPage: true });
});
