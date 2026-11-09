import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

// 設定 (2026-11-06): one part at a time, chosen from a list beside it (PC) or before it (phone). Parts a server or a
// person does not have leave the list, a choice not saved yet survives a look at another part, and the mail and
// official LINE grants (the same ticks and names) are never both on the screen. All data is synthetic.

const people = [
  { id: 'iy-000001', displayName: '合成 委員長', roleLabel: '総務部' },
  { id: 'iy-000002', displayName: '合成 太郎', roleLabel: '企画部' },
  { id: 'iy-000003', displayName: '合成 花子', roleLabel: 'システム課' },
];

function grants(box: { id: string; name: string; address: string }) {
  return {
    people,
    mailboxes: [box],
    grants: [],
    sendGrants: [],
    sendable: [box.id],
    departments: ['企画部', 'システム課', '総務部'],
    departmentGrants: [],
    ingest: { messages: 1, latestStoredAt: '2026-11-06T00:00:00Z', sources: {} },
  };
}

async function open(page: Page, hash: string, o: { admin?: boolean; bank?: 200 | 403; rental?: boolean } = {}) {
  const admin = o.admin ?? true;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (route.request().method() !== 'GET') return respond({ error: 'not_found' }, 404);
    switch (path) {
      case '/api/session':
        return respond({
          demoAuthentication: false,
          authMode: 'discord',
          user: { id: 'iy-000001', displayName: '合成 委員長', roleLabel: '総務部', canManageAccess: admin },
          account: { initialLoginId: 'iy-000001', studentId: '21000001', departments: ['総務部'], signIn: { previousLoginAt: null, failedSince: 0 } },
          degraded: false,
          passwordPolicy: { minLength: 12, maxLength: 128 },
          sessionDays: 14,
        });
      case '/api/mail/status':
        return respond({ enabled: true, canOpen: true, reauthRequired: false, idleHours: 12, unhandledTotal: 0 });
      case '/api/line/accounts':
        return respond([{ id: 'oa', name: '合成 公式LINE', kind: 'official_account', access: 'edit', canReply: true, sending: 'line', conversationCount: 0, unhandledCount: 0 }]);
      case '/api/auth/cards':
        return respond({ cards: [], devices: [], deviceRegistered: false, people: [] });
      case '/api/mail/admin/access':
        return respond(grants({ id: 'contact', name: '問い合わせ', address: 'contact@committee.example' }));
      case '/api/line/admin/access':
        return respond(grants({ id: 'oa', name: '合成 公式LINE', address: '@synthetic' }));
      case '/api/rental/admin/access':
        return o.rental === false
          ? respond({ error: 'not_found' }, 404)
          : respond({ revision: 0, allMembersAdmin: false, people: people.map((p) => ({ ...p, storedPermissions: [], effectivePermissions: [], effectiveAdmin: false })), history: [] });
      case '/api/rental/admin/switch':
        return o.rental === false ? respond({ error: 'not_found' }, 404) : respond({ enabled: true, loaned: 0, review: 0, history: [] });
      case '/api/bank/status':
        return (o.bank ?? 403) === 403
          ? respond({ error: 'forbidden', message: '銀行の連携は、権限管理者と会計を見る人だけが使えます。' }, 403)
          : respond({
              configured: true, environment: 'sunabar', environmentLabel: 'sunabar（試験環境）', state: 'disconnected', scopes: [], connectedAt: null, connectedBy: null,
              accessTokenExpiresAt: null, refreshable: false, lastRefreshedAt: null, lastError: null, canConnect: admin, canCheck: true, redirectUri: null,
            });
      default:
        return respond({ error: 'not_found' }, 404);
    }
  });
  await page.goto(hash);
  await expect(page.getByRole('heading', { name: '設定', exact: true, level: 2 })).toBeAttached();
}

const nav = (page: Page) => page.getByRole('navigation', { name: '設定の項目' });
const part = (page: Page, key: string) => page.locator(`.settings-part[data-section="${key}"]`);

test('a PC shows the list beside one part; a link opens another part and keeps a choice not saved in the first', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '/#/settings');
  await expect(nav(page).getByRole('link')).toHaveText(['アカウント', '委員カード', '画面の色', 'メールの権限', '公式LINE の権限', '物品の権限', '使う機能', 'ログインの記録']);
  await expect(nav(page).getByRole('link', { name: 'アカウント' })).toHaveAttribute('aria-current', 'page');
  await expect(part(page, 'account')).toBeVisible();
  await expect(page.getByTestId('mail-access')).toBeHidden();

  await nav(page).getByRole('link', { name: 'メールの権限' }).click();
  await expect(page).toHaveURL(/#\/settings\/mail$/);
  await expect(page.getByTestId('mail-access')).toBeVisible();
  await expect(part(page, 'account')).toBeHidden();
  await expect(nav(page).getByRole('link', { name: 'メールの権限' })).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('mail-access').getByRole('searchbox', { name: '名前で絞り込み' }).fill('花子');

  await nav(page).getByRole('link', { name: '物品の権限' }).click();
  await expect(page.getByTestId('rental-access')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('mail-access')).toBeVisible();
  await expect(page.getByTestId('mail-access').getByRole('searchbox', { name: '名前で絞り込み' })).toHaveValue('花子');

  // The mail and the official LINE ticks have the same names; only the part on the screen can be found.
  await expect(page.getByRole('checkbox', { name: 'システム課 の送信権限' })).toHaveCount(1);
  await nav(page).getByRole('link', { name: '公式LINE の権限' }).click();
  await expect(page.getByTestId('line-mail-access')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'システム課 の送信権限' })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
});

test('a part this server or person does not have is not listed, and its address opens the account', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '/#/settings/rental', { rental: false });
  await expect(part(page, 'account')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '物品の権限' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: '使う機能' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'メールの権限' })).toBeVisible();
});

test('a member sees their own parts only; 銀行の連携 shows for one who may see it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '/#/settings', { admin: false, bank: 403 });
  await expect(nav(page).getByRole('link')).toHaveText(['アカウント', '委員カード', '画面の色']);
  await expect(nav(page).getByText('権限', { exact: true })).toHaveCount(0);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('about:blank'); // a new load, not a change of the hash
  await open(page, '/#/settings/bank', { admin: false, bank: 200 });
  await expect(nav(page).getByRole('link')).toHaveText(['アカウント', '委員カード', '画面の色', '銀行の連携']);
  await expect(page.getByRole('region', { name: '銀行の連携' })).toBeVisible();
});

test('a phone shows the list first, then the part alone with the way back to the list', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, '/#/settings');
  await expect(nav(page)).toBeVisible();
  await expect(nav(page).getByRole('link')).toHaveText(['アカウント', '委員カード', '画面の色', 'メールの権限', '公式LINE の権限', '物品の権限', '使う機能', 'ログインの記録']);
  await expect(nav(page).getByRole('link', { name: 'アカウント' })).not.toHaveAttribute('aria-current', 'page');
  await expect(part(page, 'account')).toBeHidden();
  for (const link of await nav(page).getByRole('link').all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await nav(page).getByRole('link', { name: 'メールの権限' }).click();
  await expect(page.getByTestId('mail-access')).toBeVisible();
  await expect(nav(page)).toBeHidden();
  await expect(part(page, 'mail')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await page.getByRole('link', { name: '← 設定の一覧' }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(nav(page)).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'メールの権限' })).toBeFocused();
});
