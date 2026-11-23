import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

// Every browser test records all requests and aborts anything that is not the
// local demo server, then asserts that no such request was even attempted.
export const test = base.extend<{ external: string[]; dialogs: string[] }>({
  external: [async ({ context }, use) => {
    const external: string[] = [];
    const isLocal = (url: string) => {
      const u = new URL(url);
      return u.protocol === 'data:' || u.protocol === 'about:' || u.protocol === 'blob:' || u.hostname === '127.0.0.1';
    };
    context.on('request', (req) => {
      if (!isLocal(req.url())) external.push(req.url());
    });
    await context.route('**/*', (route) => (isLocal(route.request().url()) ? route.continue() : route.abort()));
    await use(external);
    expect(external, 'no automatic external network requests').toEqual([]);
  }, { auto: true }],
  dialogs: [async ({ page }, use) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await use(dialogs);
    expect(dialogs, 'no script-triggered dialogs').toEqual([]);
  }, { auto: true }],
});

export { expect };

/**
 * Opens a module from the tabs. Since 2026-11-23 some sit in a menu (連絡・運営, src/client/navLayout.ts): its button
 * is pressed first when the menu is closed.
 */
export async function openTab(page: Page, key: string): Promise<void> {
  const link = page.getByTestId(`nav-${key}`);
  const toggle = page.locator('.nav-group').filter({ has: link }).locator('.nav-group-toggle');
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await link.click();
}

/** The module tabs' row as shown with every menu closed: a tab's name, or a menu's name with ▾. */
export async function tabRow(page: Page): Promise<string[]> {
  return page.locator('.global-nav > ul > li').evaluateAll((items) =>
    items
      .filter((li) => !(li as HTMLElement).hidden)
      .map((li) => {
        const label = li.querySelector(':scope > a > span, :scope > button > span');
        const own = label ? [...label.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('') : '';
        return li.classList.contains('nav-group') ? `${own}▾` : own;
      }),
  );
}

// Reset and fault injection are demo-administrator controls, so fixtures perform
// them as the administrator before the test switches to its intended persona.
export async function resetSample(page: Page): Promise<void> {
  await page.context().clearCookies();
  expect((await page.request.post('/api/session', { data: { userId: 'u-admin' } })).ok()).toBe(true);
  expect((await page.request.post('/api/demo/reset')).ok()).toBe(true);
  await page.context().clearCookies();
}

/** Arms demo faults from a separate administrator API session, leaving the browser persona unchanged. */
export async function injectFaults(admin: APIRequestContext, faults: Partial<{ failNextRequests: number; delayNextRequests: number; delayMs: number }>): Promise<void> {
  expect((await admin.post('/api/session', { data: { userId: 'u-admin' } })).ok()).toBe(true);
  const current = await (await admin.get('/api/demo/faults')).json();
  expect((await admin.put('/api/demo/faults', { data: { ...current, ...faults } })).ok()).toBe(true);
}

export async function loginAs(page: Page, personaId: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('about:blank'); // force a full reload even if only the hash would change
  await page.goto('/#/all');
  await expect(page.getByTestId('demo-auth-banner')).toContainText('デモ用モック認証');
  await page.locator(`button[data-persona="${personaId}"]`).click();
  await expect(page.getByTestId('current-user')).toBeVisible();
}

export function threadButton(page: Page, subject: string) {
  return page.locator('button.thread', { has: page.locator('.subject', { hasText: subject }) });
}

export async function openThread(page: Page, subject: string) {
  await threadButton(page, subject).first().click();
  await expect(page.locator('.thread-title')).toContainText(subject);
}

export async function threadIdOf(page: Page, subject: string): Promise<string> {
  const id = await threadButton(page, subject).first().getAttribute('data-thread-id');
  if (!id) throw new Error(`thread not found: ${subject}`);
  return id;
}
