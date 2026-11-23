import type { Page } from '@playwright/test';
import type { VaultEntriesResponse, VaultMembersResponse, VaultMetaResponse, VaultSectionsResponse } from '../../src/shared/vault.js';
import { expect, test } from './fixtures.js';

// 設定 › パスワード帳 (2026-11-23). The server is a stand-in (page.route): the Discord login's answers, a password book
// with one section and one entry, and the password typed again. Every name, ID and password is synthetic.

const PASSWORD = 'Synthetic-Pass-0001';
const SECTION = { id: 'vs_0000000000000001', name: '合成の区分', note: '', myRole: 'view' as const, canManage: false, entryCount: 1, lastPrintedAt: null, changesSincePrint: 1, version: 2 };
const ENTRY = {
  id: 've_0000000000000001',
  sectionId: SECTION.id,
  name: '合成の管理画面',
  purpose: '合成のサーバーの設定',
  url: 'https://console.example.invalid',
  username: 'synthetic-admin',
  email: 'synthetic-admin@example.invalid',
  hasPassword: true, hasNotes: false, updatedAt: '2026-11-23T01:00:00.000Z', updatedByName: '合成 委員長', version: 1 };

async function open(page: Page, o: { canOpen?: boolean; fresh?: boolean; hash?: string; role?: 'view' | 'edit' } = {}) {
  let fresh = o.fresh ?? true;
  const calls: string[] = [];
  const posted: unknown[] = [];
  const section = { ...SECTION, myRole: o.role ?? SECTION.myRole };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    calls.push(`${request.method()} ${path}`);
    const reauth = () => respond({ error: 'vault_reauth_required', message: 'パスワード帳を使うには、パスワードをもう一度入力してください。' }, 401);
    switch (`${request.method()} ${path}`) {
      case 'GET /api/session':
        return respond({
          demoAuthentication: false,
          authMode: 'discord',
          user: { id: 'iy-000002', displayName: '合成 太郎', roleLabel: '総務部', canManageAccess: false },
          account: { initialLoginId: 'iy-000002', studentId: '21000002', departments: ['総務部'], signIn: { previousLoginAt: null, failedSince: 0 } },
          degraded: false,
          passwordPolicy: { minLength: 12, maxLength: 128 },
          sessionDays: 14,
        });
      case 'GET /api/vault/meta':
        return respond({ enabled: true, canOpen: o.canOpen ?? true, canAdminister: false, revealMinutes: 10, freshUntil: fresh ? '2026-11-23T01:10:00.000Z' : null } satisfies VaultMetaResponse);
      case 'GET /api/vault/sections':
        return respond({ sections: [section], canAdminister: false } satisfies VaultSectionsResponse);
      case 'GET /api/vault/entries':
        return fresh ? respond({ entries: [ENTRY], unreadable: 0 } satisfies VaultEntriesResponse) : reauth();
      case `POST /api/vault/entries/${ENTRY.id}/reveal`:
        return fresh ? respond({ field: 'password', value: PASSWORD }) : reauth();
      case `GET /api/vault/sections/${SECTION.id}/members`:
        return respond({
          section,
          members: [],
          openers: [
            { id: 'iy-000001', name: '合成 委員長', role: 'manage', via: ['個人の指定'] },
            { id: 'iy-000002', name: '合成 太郎', role: 'edit', via: ['総務部'] },
          ],
          choices: { departments: [], people: [] },
        } satisfies VaultMembersResponse);
      case 'POST /api/vault/entries':
        posted.push(request.postDataJSON());
        return respond({ entry: { ...ENTRY, id: 've_0000000000000002', ...(request.postDataJSON() as object), hasPassword: true, hasNotes: false, version: 1 } }, 201);
      case 'POST /api/auth/reauth':
        fresh = true;
        return respond({ ok: true });
      default:
        return respond({ error: 'not_found' }, 404);
    }
  });
  await page.goto(o.hash ?? '/#/vault');
  return { calls, posted };
}

test('a member opens the tab after typing the password again, copies a password, and leaves no value behind', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1280, height: 900 });
  const { calls } = await open(page, { fresh: false });
  const tab = page.getByTestId('nav-vault');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute('aria-current', 'page');
  // The tab sits just before 設定.
  await expect(page.locator('.global-nav a').nth(-2)).toHaveAttribute('data-testid', 'nav-vault');
  // Past the window: the password first, and no list is asked for until it is typed.
  await expect(page.getByTestId('vault-reauth')).toBeVisible();
  expect(calls).not.toContain('GET /api/vault/entries');
  await page.getByLabel('パスワード', { exact: true }).fill('synthetic password 0000');
  await page.getByRole('button', { name: 'パスワード帳を開く' }).click();
  await expect(page.getByTestId('vault-entry')).toHaveCount(1);
  await expect(page.getByTestId('vault-entry')).not.toContainText(PASSWORD);
  // A viewer has no add and no change.
  await expect(page.getByTestId('vault-add')).toHaveCount(0);
  await expect(page.getByTestId('vault-entry').getByRole('button', { name: '変更', exact: true })).toHaveCount(0);

  await page.getByTestId('vault-copy').click();
  await expect(page.getByRole('status')).toContainText('30 秒後にクリップボードを空にします');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PASSWORD);
  await page.getByRole('button', { name: '「合成の管理画面」のパスワードを表示' }).click();
  await expect(page.getByTestId('vault-shown-password')).toHaveText(PASSWORD);

  // Another tab: nothing of the book stays on the page.
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('vault-panel')).toHaveCount(0);
  expect(await page.evaluate((secret) => document.body.innerHTML.includes(secret), PASSWORD)).toBe(false);
  // The settings no longer list it.
  await expect(page.getByRole('navigation', { name: '設定の項目' }).getByRole('link', { name: 'パスワード帳' })).toHaveCount(0);
  // Back: the list again, every value hidden.
  await page.getByTestId('nav-vault').click();
  await expect(page).toHaveURL(/#\/vault$/);
  await expect(page.getByTestId('vault-entry')).toHaveCount(1);
  await expect(page.getByTestId('vault-shown-password')).toHaveCount(0);

  // 閉じる drops the list too.
  await page.getByTestId('vault-lock').click();
  await expect(page.getByTestId('vault-entry')).toHaveCount(0);
  await expect(page.getByTestId('vault-locked')).toBeVisible();
});

test('an editor registers a site with its use, who can open it, its address, user name, e-mail and password', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1280, height: 900 });
  const { posted } = await open(page, { role: 'edit' });
  // The list shows the use and the registered address, and copies the address.
  const row = page.getByTestId('vault-entry');
  await expect(row).toContainText('合成のサーバーの設定');
  await row.getByRole('button', { name: '「合成の管理画面」の登録メールアドレスをコピー' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('synthetic-admin@example.invalid');
  await page.getByTestId('vault-search').fill('サーバーの設定');
  await expect(row).toHaveCount(1);
  await page.getByTestId('vault-search').fill('');

  await page.getByTestId('vault-add').click();
  // Who can open it: the section decides, and the form names them.
  await expect(page.getByTestId('vault-form-openers')).toContainText('いま開ける人（2 人）');
  await expect(page.getByTestId('vault-form-openers')).toContainText('合成 委員長（管理する）');
  await page.getByTestId('vault-form-name').fill('合成の請求サービス');
  await page.getByTestId('vault-form-purpose').fill('合成の請求書の送付');
  await page.getByLabel('URL（任意）').fill('https://billing.example.invalid');
  await page.getByTestId('vault-form-username').fill('synthetic-billing');
  await page.getByTestId('vault-form-email').fill('not an address');
  await expect(page.getByText('メールアドレスの形（○○@○○）にしてください')).toBeVisible();
  await expect(page.getByTestId('vault-form-save')).toBeDisabled();
  await page.getByTestId('vault-form-email').fill('synthetic-billing@example.invalid');
  await page.getByTestId('vault-form-password').fill('Synthetic-Billing-0001');
  await page.getByTestId('vault-form-save').click();
  await expect(page.getByRole('status')).toContainText('「合成の請求サービス」を追加しました');
  expect(posted).toEqual([
    expect.objectContaining({
      sectionId: SECTION.id,
      name: '合成の請求サービス',
      purpose: '合成の請求書の送付',
      url: 'https://billing.example.invalid',
      username: 'synthetic-billing',
      email: 'synthetic-billing@example.invalid',
      password: 'Synthetic-Billing-0001',
    }),
  ]);
});

test('its first address under the settings opens the tab', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { hash: '/#/settings/vault' });
  await expect(page).toHaveURL(/#\/vault$/);
  await expect(page.getByTestId('nav-vault')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('vault-entry')).toHaveCount(1);
});

test('a member on no section has no tab, and the address explains why it is empty', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { canOpen: false });
  await expect(page.getByTestId('nav-settings')).toBeVisible();
  await expect(page.getByTestId('nav-vault')).toHaveCount(0);
  await expect(page.getByTestId('vault-panel')).toHaveCount(0);
  await expect(page.getByText('あなたが見られる区分がありません')).toBeVisible();
});

for (const width of [375, 320]) {
  test(`on a phone ${width}px wide the eleven tabs fit, the copy button is large and nothing scrolls sideways`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 812 });
    await open(page);
    await expect(page.getByTestId('vault-entry')).toHaveCount(1);
    expect((await page.getByTestId('vault-copy').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const tab = await page.getByTestId('nav-vault').boundingBox();
    expect(tab!.x + tab!.width).toBeLessThanOrEqual(width);
  });
}
