import type { Page } from '@playwright/test';
import type { RentalAccessPermission, RentalAccessResponse } from '../../src/shared/rental-access.js';
import { expect, test } from './fixtures.js';

// The rental permissions on the settings screen (2026-10-26): a save uses the answer of the server, only its row
// waits, a choice made in another row is kept, saves go one after another with the newer revision, and a failure
// shows on its row. All data is synthetic.
async function settings(page: Page, o: { delayMs?: number; failFor?: string } = {}) {
  const person = (id: string, displayName: string, roleLabel: string) => ({ id, displayName, roleLabel, storedPermissions: [] as RentalAccessPermission[], effectivePermissions: [] as RentalAccessPermission[], effectiveAdmin: false });
  const data: RentalAccessResponse = {
    revision: 0,
    allMembersAdmin: false,
    people: [person('iy-000001', '合成 委員長', '総務部'), person('iy-000002', '合成 太郎', '企画部'), person('iy-000003', '合成 花子', '委員')],
    history: [],
  };
  const puts: Record<string, unknown>[] = [];
  let gets = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/api/session') return respond({
      demoAuthentication: false, authMode: 'discord', user: { id: 'iy-000001', displayName: '合成 委員長', roleLabel: '総務部', canManageAccess: true },
      account: { initialLoginId: 'iy-000001', studentId: '21000001', departments: ['総務部'], signIn: { previousLoginAt: null, failedSince: 0 } },
      degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 14,
    });
    if (path === '/api/rental/admin/access' && method === 'GET') { gets++; return respond(data); }
    if (path === '/api/rental/admin/access' && method === 'PUT') {
      const body = route.request().postDataJSON() as { kind: string; userId?: string; permissions?: RentalAccessPermission[]; allMembersAdmin?: boolean; expectedRevision: number };
      puts.push(body);
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (body.expectedRevision !== data.revision) return respond({ error: 'conflict', message: '別の管理者が先に変更しました。最新の設定を読み直してから保存してください。' }, 409);
      if (o.failFor && body.userId === o.failFor) return respond({ error: 'not_found', message: '利用できるアカウントが見つかりません。' }, 404);
      if (body.kind === 'policy') data.allMembersAdmin = body.allMembersAdmin!;
      else {
        const p = data.people.find((x) => x.id === body.userId)!;
        p.storedPermissions = [...body.permissions!].sort();
        p.effectivePermissions = p.storedPermissions.includes('rental.admin') ? ['rental.issue', 'rental.loan'] : p.storedPermissions;
        p.effectiveAdmin = p.storedPermissions.includes('rental.admin');
      }
      data.revision++;
      return respond(structuredClone(data));
    }
    return respond({ error: 'not_found' }, 404);
  });
  await page.goto('/#/settings');
  const panel = page.getByTestId('rental-access');
  await expect(panel).toBeVisible();
  return { panel, puts, gets: () => gets };
}

test('only the saved row waits, a choice in another row is kept, and the next save uses the newer revision', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { panel, puts, gets } = await settings(page, { delayMs: 1500 });
  const taro = panel.getByLabel('合成 太郎 さんの個別設定');
  const hanako = panel.getByLabel('合成 花子 さんの個別設定');
  await taro.selectOption('loan');
  await panel.getByRole('button', { name: '合成 太郎 さんの権限を保存' }).click();
  await expect(panel.getByRole('button', { name: '合成 太郎 さんの権限を保存' })).toHaveText('保存中…');
  // The other rows and the policy are not stopped.
  await expect(hanako).toBeEnabled();
  await expect(panel.getByRole('checkbox', { name: '全員に物品の管理者権限を付ける' })).toBeEnabled();
  await hanako.selectOption('admin');
  await expect(panel.getByTestId('rental-access-message')).toHaveText('合成 太郎 さんの個別設定を「貸出・返却」にしました。');
  await expect(panel.locator('li').filter({ hasText: '合成 太郎' })).toContainText('現在：貸出・返却');
  // The choice made while the first save was running is still there.
  await expect(hanako).toHaveValue('admin');
  await panel.getByRole('button', { name: '合成 花子 さんの権限を保存' }).click();
  await expect(panel.getByTestId('rental-access-message')).toHaveText('合成 花子 さんの個別設定を「物品管理者」にしました。');
  await expect(panel.getByRole('button', { name: '合成 花子 さんの権限を保存' })).toBeDisabled();
  expect(puts.map((p) => p.expectedRevision)).toEqual([0, 1]);
  expect(gets()).toBe(1);
});

test('two saves pressed at once go one after another without a conflict', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { panel, puts } = await settings(page, { delayMs: 800 });
  await panel.getByLabel('合成 太郎 さんの個別設定').selectOption('loan');
  await panel.getByLabel('合成 花子 さんの個別設定').selectOption('issue');
  await panel.getByRole('button', { name: '合成 太郎 さんの権限を保存' }).click();
  await panel.getByRole('button', { name: '合成 花子 さんの権限を保存' }).click();
  await expect(panel.getByTestId('rental-access-message')).toHaveText('合成 花子 さんの個別設定を「発行・台帳変更」にしました。');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(puts.map((p) => [p.userId, p.expectedRevision])).toEqual([['iy-000002', 0], ['iy-000003', 1]]);
});

test('a failed save says so on its row and keeps the choice', async ({ page }) => {
  const { panel } = await settings(page, { failFor: 'iy-000003' });
  const hanako = panel.getByLabel('合成 花子 さんの個別設定');
  await hanako.selectOption('loan');
  await panel.getByRole('button', { name: '合成 花子 さんの権限を保存' }).click();
  await expect(panel.locator('li').filter({ hasText: '合成 花子' }).getByRole('alert')).toContainText('保存できませんでした：利用できるアカウントが見つかりません。');
  await expect(hanako).toHaveValue('loan');
  await expect(panel.getByRole('button', { name: '合成 花子 さんの権限を保存' })).toBeEnabled();
});

test('ticks are squares of their own size, not thin bars', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { panel } = await settings(page);
  const box = await panel.getByRole('checkbox', { name: '全員に物品の管理者権限を付ける' }).boundingBox();
  expect(box && Math.round(box.width)).toBe(20);
  expect(box && Math.round(box.height)).toBe(20);
});
