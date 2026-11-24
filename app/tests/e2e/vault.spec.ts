import type { Page } from '@playwright/test';
import type { VaultEntriesResponse, VaultMembersResponse, VaultMetaResponse, VaultSectionSummary, VaultSectionsResponse } from '../../src/shared/vault.js';
import { expect, openTab, test } from './fixtures.js';

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

type Options = {
  canOpen?: boolean;
  fresh?: boolean;
  hash?: string;
  role?: 'view' | 'edit';
  /** A book without any group yet (an administrator's first visit). */
  noSections?: boolean;
  canAdminister?: boolean;
  /** The typed password runs out just before the first registration is saved. */
  expireOnSave?: boolean;
};

async function open(page: Page, o: Options = {}) {
  let fresh = o.fresh ?? true;
  let expired = false;
  const calls: string[] = [];
  const posted: unknown[] = [];
  const section = { ...SECTION, myRole: o.role ?? SECTION.myRole };
  const sections: VaultSectionSummary[] = o.noSections ? [] : [section];
  const entries = o.noSections ? [] : [ENTRY];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    calls.push(`${request.method()} ${path}`);
    const reauth = () => respond({ error: 'vault_reauth_required', message: 'パスワード帳を使うには、パスワードをもう一度入力してください。' }, 401);
    const members = /^\/api\/vault\/sections\/(vs_[0-9a-f]{16})\/members$/.exec(path);
    if (request.method() === 'GET' && members && members[1] !== SECTION.id) {
      const made = sections.find((s) => s.id === members[1])!;
      return respond({ section: made, members: [], openers: [{ id: 'iy-000002', name: '合成 太郎', role: 'manage', via: ['個人の指定'] }], choices: { departments: [], people: [] } } satisfies VaultMembersResponse);
    }
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
        return respond({ enabled: true, canOpen: o.canOpen ?? true, canAdminister: o.canAdminister ?? false, revealMinutes: 10, freshUntil: fresh ? '2026-11-23T01:10:00.000Z' : null } satisfies VaultMetaResponse);
      case 'GET /api/vault/sections':
        return respond({ sections, canAdminister: o.canAdminister ?? false } satisfies VaultSectionsResponse);
      case 'POST /api/vault/sections': {
        if (!fresh) return reauth();
        const body = request.postDataJSON() as { name: string; note: string };
        const made = { id: 'vs_00000000000000a1', name: body.name, note: body.note, myRole: 'manage' as const, canManage: true, entryCount: 0, lastPrintedAt: null, changesSincePrint: 0, version: 1 };
        sections.push(made);
        return respond({ section: made }, 201);
      }
      case 'GET /api/vault/entries':
        return fresh ? respond({ entries, unreadable: 0 } satisfies VaultEntriesResponse) : reauth();
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
        if (o.expireOnSave && !expired) {
          expired = true;
          fresh = false;
        }
        if (!fresh) return reauth();
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
  // The book is the last link of the 運営 menu (2026-11-23), and the menu is marked while the book is shown.
  const tab = page.getByTestId('nav-vault');
  await expect(tab).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#nav-menu-ops a').last()).toHaveAttribute('data-testid', 'nav-vault');
  await expect(page.locator('.nav-group[data-group="ops"]')).toHaveClass(/is-current/);
  // Past the window: the password first, and no list is asked for until it is typed.
  await expect(page.getByTestId('vault-reauth')).toBeVisible();
  expect(calls).not.toContain('GET /api/vault/entries');
  await page.getByLabel('パスワード', { exact: true }).fill('synthetic password 0000');
  await page.getByRole('button', { name: 'パスワード帳を開く' }).click();
  await expect(page.getByTestId('vault-entry')).toHaveCount(1);
  await expect(page.getByTestId('vault-entry')).not.toContainText(PASSWORD);
  // A viewer has no add and no change.
  await expect(page.getByTestId('vault-add')).toHaveCount(0);
  await expect(page.getByTestId('vault-entry').getByRole('button', { name: '編集', exact: true })).toHaveCount(0);

  await page.getByTestId('vault-copy').click();
  await expect(page.getByRole('status').filter({ hasText: 'コピーしました' })).toContainText('30 秒後にクリップボードを空にします');
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
  await openTab(page, 'vault');
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
  await expect(page.getByTestId('vault-form-openers')).toContainText('見られる人（2 人）');
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
  await expect(page.getByRole('status').filter({ hasText: '登録しました' })).toContainText('「合成の請求サービス」を登録しました');
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
  await expect(page.getByText('あなたが見られるグループがありません')).toBeVisible();
});

/** Hides or shows the page as a switch to another browser tab would. */
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('an administrator on a book without groups is led from making a group to registering a password', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { noSections: true, canAdminister: true });
  const first = page.getByTestId('vault-first');
  await expect(first).toContainText('グループを作る');
  await expect(first).toContainText('パスワードを登録');
  await expect(page.getByTestId('vault-add')).toHaveCount(0);
  await page.getByTestId('vault-section-name').fill('合成のシステム');
  await page.getByTestId('vault-section-create').click();
  await expect(first).toHaveCount(0);
  await expect(page.getByTestId('vault-notice')).toContainText('グループ「合成のシステム」を作りました');
  await expect(page.getByTestId('vault-section-tools')).toContainText('合成のシステム');
  // Nothing registered yet: no search, and registering is the strong button.
  await expect(page.getByText('まだパスワードがありません。「パスワードを登録」から登録します。')).toBeVisible();
  await expect(page.getByTestId('vault-search')).toHaveCount(0);
  await expect(page.getByTestId('vault-add')).not.toHaveClass(/secondary/);
  await page.getByTestId('vault-add').click();
  // One group to put it in: its name, not a choice, and who sees it.
  await expect(page.getByTestId('vault-form-section-one')).toContainText('合成のシステム');
  await expect(page.getByTestId('vault-form-section')).toHaveCount(0);
  await expect(page.getByTestId('vault-form-openers')).toContainText('見られる人（1 人）');
});

test('a registration being filled in stays when the tab is hidden, with the new password back to dots; without one the book closes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { role: 'edit' });
  await page.getByRole('button', { name: '「合成の管理画面」のパスワードを表示' }).click();
  await expect(page.getByTestId('vault-shown-password')).toHaveText(PASSWORD);
  await page.getByTestId('vault-add').click();
  const form = page.getByTestId('vault-form');
  // The login's own fields come first, the group last.
  const labels = await form.locator('label').allInnerTexts();
  expect(labels.map((l) => l.split('\n')[0]!.trim()).slice(0, 4)).toEqual(['サイト名', 'URL（任意）', 'ユーザー名（任意）', '登録メールアドレス（任意）']);
  await page.getByTestId('vault-form-name').fill('合成の請求サービス');
  await page.getByTestId('vault-form-password').fill('Synthetic-Billing-0001');
  await form.getByRole('button', { name: '見る', exact: true }).click();
  await expect(page.getByTestId('vault-form-password')).not.toHaveClass(/vault-masked/);

  await setHidden(page, true);
  await setHidden(page, false);
  await expect(page.getByTestId('vault-form-name')).toHaveValue('合成の請求サービス');
  await expect(page.getByTestId('vault-form-password')).toHaveValue('Synthetic-Billing-0001');
  await expect(page.getByTestId('vault-form-password')).toHaveClass(/vault-masked/);
  await expect(page.getByTestId('vault-shown-password')).toHaveCount(0);
  await expect(page.getByTestId('vault-entry')).toHaveCount(1);

  // Without a form, hiding the tab closes the book as before.
  await form.getByRole('button', { name: 'やめる', exact: true }).click();
  await setHidden(page, true);
  await setHidden(page, false);
  await expect(page.getByTestId('vault-locked')).toContainText('画面を離れたため');
  await expect(page.getByTestId('vault-entry')).toHaveCount(0);
});

test('when the typed password runs out during a registration, the form asks for it and registers what was typed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { posted, calls } = await open(page, { role: 'edit', expireOnSave: true });
  await page.getByTestId('vault-add').click();
  await page.getByTestId('vault-form-name').fill('合成の請求サービス');
  await page.getByTestId('vault-form-password').fill('Synthetic-Billing-0001');
  await page.getByTestId('vault-form-save').click();
  await expect(page.getByTestId('vault-form-reauth')).toContainText('10 分が過ぎました');
  // Still the form, as typed; no lock screen.
  await expect(page.getByTestId('vault-reauth')).toHaveCount(0);
  await expect(page.getByTestId('vault-form-name')).toHaveValue('合成の請求サービス');
  await expect(page.getByTestId('vault-form-save')).toBeDisabled();
  await page.getByTestId('vault-form-reauth-password').fill('synthetic password 0000');
  await page.getByTestId('vault-form-save').click();
  await expect(page.getByRole('status').filter({ hasText: '登録しました' })).toContainText('「合成の請求サービス」を登録しました');
  expect(calls.filter((c) => c === 'POST /api/auth/reauth')).toHaveLength(1);
  // The refused save and the one after the password carry the same token (one registration, never two).
  expect(posted).toHaveLength(2);
  const [a, b] = posted as { clientToken: string; password: string }[];
  expect(a!.clientToken).toBe(b!.clientToken);
  expect(b!.password).toBe('Synthetic-Billing-0001');
  // The paper copy is offered right there, and opens the group's print confirmation.
  await page.getByTestId('vault-reprint').click();
  await expect(page.getByTestId('vault-print-confirm')).toBeVisible();
  await expect(page.getByTestId('vault-print-confirm')).toContainText('このグループのパスワードとメモを 1 件すべて紙に出します');
});

for (const width of [375, 320]) {
  test(`on a phone ${width}px wide the tabs and the 運営 menu fit, the copy button is large and nothing scrolls sideways`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 812 });
    await open(page);
    await expect(page.getByTestId('vault-entry')).toHaveCount(1);
    expect((await page.getByTestId('vault-copy').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByTestId('nav-group-ops').click();
    const tab = await page.getByTestId('nav-vault').boundingBox();
    expect(tab!.x + tab!.width).toBeLessThanOrEqual(width);
  });
}
