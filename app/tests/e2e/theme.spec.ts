import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { installWorld } from './redesign-world.js';

// The colour theme (2026-10-28): 若葉 by default; the header's button steps 若葉 → ライト → ダーク, and
// 設定 › 画面の色 also offers 端末の設定に合わせる. Kept in this browser.

const ground = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
const WAKABA_GROUND = 'rgb(243, 247, 236)';
const LIGHT_GROUND = 'rgb(243, 246, 250)';
const DARK_GROUND = 'rgb(14, 21, 29)';

const settingsChoice = (page: Page) => page.getByRole('group', { name: '画面の色' });
const toggle = (page: Page) => page.getByTestId('theme-toggle');

test('若葉 is the default, and the header button steps through ライト and ダーク in step with 設定', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await installWorld(page);
  await page.goto('/#/settings');
  await expect(settingsChoice(page).getByRole('radio', { name: '若葉' })).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'wakaba');
  expect(await ground(page)).toBe(WAKABA_GROUND);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#2e5e2a');
  await expect(toggle(page)).toHaveAccessibleName('画面の色: 若葉（押すとライト）');

  await toggle(page).click();
  expect(await ground(page)).toBe(LIGHT_GROUND);
  await expect(settingsChoice(page).getByRole('radio', { name: 'ライト' })).toBeChecked();
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#163960');

  await toggle(page).click();
  expect(await ground(page)).toBe(DARK_GROUND);
  await expect(settingsChoice(page).getByRole('radio', { name: 'ダーク' })).toBeChecked();
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0b1826');

  await page.reload();
  await expect(settingsChoice(page).getByRole('radio', { name: 'ダーク' })).toBeChecked();
  expect(await ground(page)).toBe(DARK_GROUND);

  await toggle(page).click();
  expect(await ground(page)).toBe(WAKABA_GROUND);
  await expect(settingsChoice(page).getByRole('radio', { name: '若葉' })).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('iyakusai.theme'))).toBeNull();
});

test('a dark device still opens in 若葉; 端末の設定に合わせる turns it dark, and ライト keeps it light', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await installWorld(page);
  await page.goto('/#/settings');
  expect(await ground(page)).toBe(WAKABA_GROUND);

  await settingsChoice(page).getByRole('radio', { name: '端末の設定に合わせる' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
  expect(await ground(page)).toBe(DARK_GROUND);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0b1826');
  await expect(toggle(page)).toHaveAccessibleName('画面の色: 自動（押すと若葉）');
  expect(await page.evaluate(() => localStorage.getItem('iyakusai.theme'))).toBe('system');

  await page.reload();
  expect(await ground(page)).toBe(DARK_GROUND);

  await settingsChoice(page).getByRole('radio', { name: 'ライト' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await ground(page)).toBe(LIGHT_GROUND);
});

test('the header button fits a 375px phone as a 44px dot', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await installWorld(page);
  await page.goto('/#/home');
  await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
  const box = await toggle(page).boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/theme-wakaba-phone.png', animations: 'disabled' });
});

for (const theme of ['wakaba', 'dark'] as const) {
  test(`the main screens in the ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((t) => localStorage.setItem('iyakusai.theme', t), theme);
    const world = await installWorld(page, { persona: 'officer', nested: true });
    mkdirSync('.tmp', { recursive: true });
    const shot = (name: string) => page.screenshot({ path: `.tmp/theme-${theme}-${name}.png`, animations: 'disabled' });

    await page.goto('/#/home');
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await shot('home');

    await page.goto('/#/tasks');
    const pane = page.getByRole('region', { name: 'タスク一覧', exact: true });
    await expect(pane.locator('[data-task-id]').first()).toBeVisible();
    await shot('tasks');
    await pane.getByRole('button', { name: '関係図', exact: true }).click();
    await pane.locator('.bowtie-department button').first().click();
    await shot('tasks-bowtie');

    await page.goto(`/#/all?thread=${world.threads[0]!.id}`);
    await expect(page.getByRole('region', { name: 'スレッド詳細' }).getByRole('heading', { level: 2 })).toBeVisible();
    await shot('mail');
    expect(await ground(page)).toBe(theme === 'wakaba' ? WAKABA_GROUND : DARK_GROUND);
  });
}
