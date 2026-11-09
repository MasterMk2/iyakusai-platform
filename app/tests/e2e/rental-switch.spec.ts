import type { Page } from '@playwright/test';
import type { RentalSwitchResponse } from '../../src/shared/rental-access.js';
import { expect, test } from './fixtures.js';

// 設定 › 使う機能 (2026-11-09): stopping rental takes its tab away at once, after one confirmation that names what is
// out; starting it again brings the tab back without asking. All data is synthetic.
async function open(page: Page, hash: string) {
  const data: RentalSwitchResponse = { enabled: true, loaned: 3, review: 1, history: [] };
  const puts: unknown[] = [];
  let id = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/api/session') return respond({
      demoAuthentication: false, authMode: 'discord', user: { id: 'iy-000001', displayName: '合成 委員長', roleLabel: '総務部', canManageAccess: true },
      account: { initialLoginId: 'iy-000001', studentId: '21000001', departments: ['総務部'], signIn: { previousLoginAt: null, failedSince: 0 } },
      degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 14,
    });
    if (path === '/api/rental/me') return respond({ staff: { id: 'iy-000001', name: '合成 委員長' }, permissions: ['rental.issue', 'rental.loan'], enabled: data.enabled });
    if (path === '/api/rental/admin/switch' && method === 'GET') return respond(data);
    if (path === '/api/rental/admin/switch' && method === 'PUT') {
      const body = route.request().postDataJSON() as { enabled: boolean };
      puts.push(body);
      if (body.enabled !== data.enabled) {
        data.enabled = body.enabled;
        data.history.unshift({ id: ++id, at: '2026-11-09T12:00:00.000Z', actorName: '合成 委員長', enabled: body.enabled });
      }
      return respond(structuredClone(data));
    }
    return respond({ error: 'not_found' }, 404);
  });
  await page.goto(hash);
  return { puts };
}

const tab = (page: Page) => page.getByTestId('nav-rental');

test('stopping asks once with what is out, takes the tab away, and starting again brings it back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { puts } = await open(page, '/#/settings/features');
  const panel = page.getByTestId('features');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('feature-rental-state')).toHaveText('使用中');
  await expect(tab(page)).toBeVisible();

  await panel.getByRole('button', { name: '物品貸出を止める' }).click();
  const warning = panel.getByRole('alert');
  await expect(warning).toContainText('貸出中 3 件・要確認 1 件が残っています');
  await panel.getByRole('button', { name: 'やめる' }).click();
  expect(puts).toEqual([]);

  await panel.getByRole('button', { name: '物品貸出を止める' }).click();
  await panel.getByRole('button', { name: '止める', exact: true }).click();
  await expect(page.getByTestId('feature-rental-state')).toHaveText('停止中');
  await expect(page.getByTestId('features-message')).toContainText('物品貸出を止めました');
  await expect(tab(page)).toHaveCount(0);
  expect(puts).toEqual([{ enabled: false }]);

  await panel.getByRole('button', { name: '物品貸出を再開する' }).click();
  await expect(page.getByTestId('feature-rental-state')).toHaveText('使用中');
  await expect(tab(page)).toBeVisible();
  expect(puts).toEqual([{ enabled: false }, { enabled: true }]);
  await panel.getByText('最近の切り替え（2 件）').click();
  await expect(panel.locator('.rental-access-history li').first()).toContainText('物品貸出：再開');
});

test('a load while rental is stopped shows no rental tab', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '/#/settings/features');
  await page.getByTestId('features').getByRole('button', { name: '物品貸出を止める' }).click();
  await page.getByTestId('features').getByRole('button', { name: '止める', exact: true }).click();
  await expect(tab(page)).toHaveCount(0);
  // Reloading keeps the tab away from the first paint (this browser remembers the last answer).
  await page.reload();
  await expect(page.getByTestId('feature-rental-state')).toHaveText('停止中');
  await expect(tab(page)).toHaveCount(0);
  await expect(page.getByTestId('nav-inbox')).toBeVisible();
});
