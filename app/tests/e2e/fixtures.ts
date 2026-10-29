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
