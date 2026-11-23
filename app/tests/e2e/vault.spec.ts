import type { Page } from '@playwright/test';
import type { VaultEntriesResponse, VaultMetaResponse, VaultSectionsResponse } from '../../src/shared/vault.js';
import { expect, test } from './fixtures.js';

// 設定 › パスワード帳 (2026-11-23). The server is a stand-in (page.route): the Discord login's answers, a password book
// with one section and one entry, and the password typed again. Every name, ID and password is synthetic.

const PASSWORD = 'Synthetic-Pass-0001';
const SECTION = { id: 'vs_0000000000000001', name: '合成の区分', note: '', myRole: 'view' as const, canManage: false, entryCount: 1, lastPrintedAt: null, changesSincePrint: 1, version: 2 };
const ENTRY = { id: 've_0000000000000001', sectionId: SECTION.id, name: '合成の管理画面', url: 'https://console.example.invalid', username: 'synthetic-admin', hasPassword: true, hasNotes: false, updatedAt: '2026-11-23T01:00:00.000Z', updatedByName: '合成 委員長', version: 1 };

async function open(page: Page, o: { canOpen?: boolean; fresh?: boolean } = {}) {
  let fresh = o.fresh ?? true;
  const calls: string[] = [];
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
        return respond({ sections: [SECTION], canAdminister: false } satisfies VaultSectionsResponse);
      case 'GET /api/vault/entries':
        return fresh ? respond({ entries: [ENTRY], unreadable: 0 } satisfies VaultEntriesResponse) : reauth();
      case `POST /api/vault/entries/${ENTRY.id}/reveal`:
        return fresh ? respond({ field: 'password', value: PASSWORD }) : reauth();
      case 'POST /api/auth/reauth':
        fresh = true;
        return respond({ ok: true });
      default:
        return respond({ error: 'not_found' }, 404);
    }
  });
  await page.goto('/#/settings/vault');
  return { calls };
}

test('a member opens the book after typing the password again, copies a password, and leaves no value behind', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1280, height: 900 });
  const { calls } = await open(page, { fresh: false });
  await expect(page.getByRole('navigation', { name: '設定の項目' }).getByRole('link', { name: 'パスワード帳' })).toBeVisible();
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

  // Another part of the settings: nothing of the book stays on the page.
  await page.getByRole('navigation', { name: '設定の項目' }).getByRole('link', { name: '画面の色' }).click();
  await expect(page.getByTestId('vault-panel')).toHaveCount(0);
  expect(await page.evaluate((secret) => document.body.innerHTML.includes(secret), PASSWORD)).toBe(false);
  // Back: the list again, every value hidden.
  await page.getByRole('navigation', { name: '設定の項目' }).getByRole('link', { name: 'パスワード帳' }).click();
  await expect(page.getByTestId('vault-entry')).toHaveCount(1);
  await expect(page.getByTestId('vault-shown-password')).toHaveCount(0);

  // 閉じる drops the list too.
  await page.getByTestId('vault-lock').click();
  await expect(page.getByTestId('vault-entry')).toHaveCount(0);
  await expect(page.getByTestId('vault-locked')).toBeVisible();
});

test('a member on no section, or a server without the book, does not see it in the list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { canOpen: false });
  await expect(page.getByRole('heading', { name: '設定', exact: true, level: 2 })).toBeAttached();
  await expect(page.getByRole('navigation', { name: '設定の項目' }).getByRole('link', { name: 'アカウント' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '設定の項目' }).getByRole('link', { name: 'パスワード帳' })).toHaveCount(0);
  await expect(page.getByTestId('vault-panel')).toHaveCount(0);
});

test('on a phone the copy button is large and nothing scrolls sideways', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page);
  await expect(page.getByTestId('vault-entry')).toHaveCount(1);
  expect((await page.getByTestId('vault-copy').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
