import type { Page } from '@playwright/test';
import { expect, loginAs, resetSample, tabRow, test } from './fixtures.js';

// The module tabs' two menus (連絡・運営, 2026-11-23, src/client/navLayout.ts). Mail and tasks stay one press away;
// the rest take two. A press beside an open menu only closes it. The password book's answer is a stand-in.

async function start(page: Page, o: { vault?: boolean; rentalStopped?: boolean } = {}) {
  await resetSample(page);
  await page.route('**/api/vault/meta', (route) => route.fulfill({ json: { enabled: true, canOpen: o.vault ?? true, canAdminister: false, revealMinutes: 10, freshUntil: null } }));
  if (o.rentalStopped) await page.route('**/api/rental/me', (route) => route.fulfill({ json: { enabled: false, permissions: [] } }));
  await loginAs(page, 'u-editor-a');
}

test('a menu opens under its button, lists its links, and closes when one is picked; mail stays one press away', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await start(page);
  await page.goto('/#/home');
  await expect.poll(() => tabRow(page)).toEqual(['ホーム', 'タスク', 'メール', '連絡▾', '運営▾', 'Bot', '設定']);
  const tabs = page.getByRole('navigation', { name: '機能' });
  await expect(tabs.getByRole('link')).toHaveText(['ホーム', 'タスク', 'メール', 'Bot', '設定']);

  const contact = page.getByTestId('nav-group-contact');
  await expect(contact).toHaveAttribute('aria-expanded', 'false');
  await contact.click();
  await expect(contact).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#nav-menu-contact').getByRole('link')).toHaveText(['公式LINE', '連絡先', '掲示板']);
  // Another menu's button takes over.
  await page.getByTestId('nav-group-ops').click();
  await expect(page.locator('#nav-menu-contact')).toBeHidden();
  await expect(page.locator('#nav-menu-ops').getByRole('link')).toHaveText(['会計', '物品貸出', 'パスワード帳']);
  await page.getByTestId('nav-group-ops').click();
  await expect(page.locator('#nav-menu-ops')).toBeHidden();

  await contact.click();
  await page.getByTestId('nav-line').click();
  await expect(page).toHaveURL(/#\/line/);
  await expect(page.locator('#nav-menu-contact')).toBeHidden();
  // The menu is marked while one of its pages is shown, and says which to a screen reader.
  await expect(page.locator('.nav-group[data-group="contact"]')).toHaveClass(/is-current/);
  await expect(contact).toHaveAccessibleName(/^連絡\s?（表示中：公式LINE）$/);
  await contact.click();
  await expect(page.getByTestId('nav-line')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('nav-line').click();
  await expect(page.locator('#nav-menu-contact')).toBeHidden();

  await page.getByTestId('nav-inbox').click();
  await expect(page).toHaveURL(/#\/all/);
  await expect(page.getByTestId('nav-inbox')).toHaveAttribute('aria-current', 'page');
});

test('a press beside an open menu only closes it, and Esc closes it with the focus back on its button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await start(page);
  await page.goto('/#/all');
  const contact = page.getByTestId('nav-group-contact');
  await contact.click();
  // Over the first mail of the list: the press lands on the scrim, and the mail does not open.
  const url = page.url();
  await page.mouse.click(640, 560);
  await expect(page.locator('#nav-menu-contact')).toBeHidden();
  expect(page.url()).toBe(url);
  await expect(page.getByTestId('nav-scrim')).toHaveCount(0);

  await contact.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#nav-menu-contact')).toBeHidden();
  await expect(contact).toBeFocused();
});

test('by keyboard: Enter opens, Tab walks the links, and tabbing past the last one closes the menu', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await start(page);
  await page.goto('/#/home');
  await page.getByTestId('nav-inbox').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('nav-group-contact')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#nav-menu-contact')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('nav-line')).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('nav-board')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#nav-menu-contact')).toBeHidden();
  await expect(page.getByTestId('nav-group-ops')).toBeFocused();
  await page.keyboard.press(' ');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('nav-books')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/books/);
});

for (const width of [375, 320]) {
  test(`on a phone ${width}px wide the seven tabs fit at 14px on one line, and a menu spans the screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await start(page);
    await page.goto('/#/all');
    await expect.poll(() => tabRow(page)).toEqual(['ホーム', 'タスク', 'メール', '連絡▾', '運営▾', 'Bot', '設定']);
    const row = page.locator('.global-nav > ul > li > a, .global-nav .nav-group-toggle');
    for (const box of await row.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()))) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.right).toBeLessThanOrEqual(width);
    }
    const labels = await page.locator('.global-nav > ul > li > a > span, .nav-group-toggle > span').evaluateAll((els) =>
      els.map((el) => [el.textContent, getComputedStyle(el).fontSize, Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))] as const),
    );
    for (const [label, size, lines] of labels) {
      expect(size, `${label}`).toBe('14px');
      expect(lines, `${label} on one line`).toBe(1);
    }
    await page.getByTestId('nav-group-ops').click();
    const menu = (await page.locator('#nav-menu-ops').boundingBox())!;
    expect(Math.round(menu.x)).toBe(0);
    expect(Math.round(menu.width)).toBe(width);
    for (const h of await page.locator('#nav-menu-ops a').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(48);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByTestId('nav-vault').click();
    await expect(page).toHaveURL(/#\/vault/);
  });
}

test('rental stopped and no password book: 会計 is a tab in the 運営 menu’s place', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await start(page, { vault: false, rentalStopped: true });
  await page.goto('/#/home');
  await expect.poll(() => tabRow(page)).toEqual(['ホーム', 'タスク', 'メール', '連絡▾', '会計', 'Bot', '設定']);
  await expect(page.getByTestId('nav-group-ops')).toHaveCount(0);
  await page.getByTestId('nav-books').click();
  await expect(page).toHaveURL(/#\/books/);
  await expect(page.getByTestId('nav-books')).toHaveAttribute('aria-current', 'page');
});
