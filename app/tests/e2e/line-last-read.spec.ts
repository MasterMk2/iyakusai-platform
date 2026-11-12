import type { Locator, Page } from '@playwright/test';
import { expect, loginAs, resetSample, test } from './fixtures.js';

// An official LINE conversation opens a little below where this person last read (2026-11-13), as the LINE app does:
// the end of what was read stays in view above, what came since below. A reload while it is open does not move it.

test.beforeEach(async ({ page }) => {
  await resetSample(page);
});

/** The fixed menu's height. */
const HEADER = 53;
/** Where the place lands: the page's scroll padding (64px, for the fixed menu) plus clamp(72px, 25vh, 200px), as in styles.css. */
const expectedTop = (viewportHeight: number) => 64 + Math.min(200, Math.max(72, viewportHeight * 0.25));

const lineItem = (page: Page, title: string) =>
  page.locator('button.thread[data-conversation-id]', { has: page.locator('.subject', { hasText: new RegExp(`^${title}$`) }) });

/** The account's list without a conversation open (a full load, so the conversation is opened afresh). */
async function openAccount(page: Page) {
  await page.goto('about:blank');
  await page.goto('/#/line/line-oa-support');
  await expect(lineItem(page, '顧客サンプルL1')).toBeVisible();
}

async function openConversation(page: Page, title: string) {
  await lineItem(page, title).click();
  await expect(page.locator('.thread-title')).toContainText(title);
}

const topOf = (el: Locator) => el.evaluate((node) => node.getBoundingClientRect().top);
const bottomOf = (el: Locator) => el.evaluate((node) => node.getBoundingClientRect().bottom);

for (const size of [
  { name: 'desktop', width: 1280, height: 640 },
  { name: 'phone', width: 375, height: 700 },
]) {
  test(`${size.name}: opens at the latest first, then just below the last row read`, async ({ page, request }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await loginAs(page, 'u-editor-c');
    await openAccount(page);

    // First open on this browser: nothing remembered, so the place is the end of the messages (no "unread" line).
    await openConversation(page, '顧客サンプルL1');
    const end = page.locator('.line-read-place');
    await expect(end).toHaveCount(1);
    await expect(page.getByTestId('line-unread-divider')).toHaveCount(0);
    await expect.poll(() => topOf(end)).toBeCloseTo(expectedTop(size.height), 0);
    const lastRow = page.locator('.line-timeline > li.line-msg').last();
    expect(await bottomOf(lastRow)).toBeGreaterThan(HEADER);

    // A new message comes in while this person is elsewhere.
    expect((await request.post('/api/session', { data: { userId: 'u-admin' } })).ok()).toBe(true);
    expect((await request.post('/api/demo/line/release')).ok()).toBe(true);
    await openAccount(page);
    await openConversation(page, '顧客サンプルL1');
    const divider = page.getByTestId('line-unread-divider');
    await expect(divider).toHaveText('ここから未読');
    await expect(page.locator('.line-read-place')).toHaveCount(0);
    // The new message is right after the line, the last one read just above it and still in view.
    await expect(divider.locator('xpath=following-sibling::li[1]')).toContainText('追加: 配送先を変更したいです。');
    await expect.poll(() => topOf(divider)).toBeCloseTo(expectedTop(size.height), 0);
    const lastRead = divider.locator('xpath=preceding-sibling::li[1]');
    expect(await bottomOf(lastRead)).toBeGreaterThan(HEADER);
    expect(await bottomOf(lastRead)).toBeLessThanOrEqual(await topOf(divider));

    // A reload after a change (here the handling status, pressed without scrolling to it) keeps where the person is.
    const before = await page.evaluate(() => window.scrollY);
    const inProgress = page.getByRole('region', { name: '会話の対応状況' }).getByRole('button', { name: '対応中' });
    await inProgress.evaluate((b: HTMLButtonElement) => b.click());
    await expect(inProgress).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.scrollY)).toBe(before);

    // Opened again with nothing new: back to the end, no line.
    await openAccount(page);
    await openConversation(page, '顧客サンプルL1');
    await expect(page.locator('.line-read-place')).toHaveCount(1);
    await expect(page.getByTestId('line-unread-divider')).toHaveCount(0);

    // A reply sent from here comes in below without a line (the line is decided when the conversation is opened).
    const reply = page.getByRole('region', { name: 'LINE で返信（模擬送信）' });
    await reply.getByRole('textbox', { name: '本文' }).fill('E2E の返信（合成）');
    await reply.getByRole('button', { name: '送信内容を確認' }).click();
    await page.getByLabel('この送信先と内容で送ります').check();
    await page.getByRole('button', { name: '模擬送信する' }).click();
    await expect(page.getByTestId('line-reply-message')).toContainText('受付済み（模擬）');
    await expect(page.locator('.line-timeline > li[data-outbox-message]')).toHaveCount(1);
    await expect(page.getByTestId('line-unread-divider')).toHaveCount(0);
    await expect(page.locator('.line-read-place')).toHaveCount(1);

    // Another person on the same browser has their own place (nothing remembered yet: the end, no line).
    await loginAs(page, 'u-viewer-b');
    await openAccount(page);
    await openConversation(page, '顧客サンプルL1');
    await expect(page.locator('.line-read-place')).toHaveCount(1);
    await expect(page.getByTestId('line-unread-divider')).toHaveCount(0);
  });
}
