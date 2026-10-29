import type { Page } from '@playwright/test';
import type { MailAccessResponse } from '../../src/shared/mailbox.js';
import { expect, test } from './fixtures.js';

// The grants of the committee mailbox on the settings screen (2026-10-26): a tick shows at once while the save is
// slow, the other ticks stay usable, a failed save goes back and says so on its row, and department grants.
async function settings(page: Page, o: { delayMs?: number; failFor?: string } = {}) {
  const data: MailAccessResponse = {
    people: [
      { id: 'iy-000001', displayName: '合成 委員長', roleLabel: '総務部' },
      { id: 'iy-000002', displayName: '合成 太郎', roleLabel: '企画部・渉外課' },
      { id: 'iy-000003', displayName: '合成 花子', roleLabel: '委員' },
    ],
    mailboxes: [
      { id: 'contact', name: '問い合わせ', address: 'contact@committee.example' },
      { id: 'iyakusai', name: '共用アカウント', address: 'iyakusai@committee.example' },
    ],
    grants: [],
    sendGrants: [],
    sendable: ['iyakusai'],
    departments: ['企画部', '渉外課', '総務部'],
    departmentGrants: [],
    ingest: { messages: 1, latestStoredAt: '2026-10-26T08:00:00Z', sources: {} },
  };
  const puts: Record<string, unknown>[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/api/session') return respond({
      demoAuthentication: false, authMode: 'discord', user: { id: 'iy-000001', displayName: '合成 委員長', roleLabel: '総務部', canManageAccess: true },
      account: { initialLoginId: 'iy-000001', studentId: '21000001', departments: ['総務部'], signIn: { previousLoginAt: null, failedSince: 0 } },
      degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 14,
    });
    if (path === '/api/mail/status') return respond({ enabled: true, canOpen: true, reauthRequired: false, idleHours: 12, unhandledTotal: 0 });
    if (path === '/api/mail/admin/access' && method === 'GET') return respond(data);
    if (path === '/api/mail/admin/access' && method === 'PUT') {
      const body = route.request().postDataJSON() as { userId?: string; department?: string; mailboxId: string; edit?: boolean; send?: boolean };
      puts.push(body);
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (o.failFor && body.userId === o.failFor) return respond({ error: 'validation', message: 'このアカウントは見つからないか、利用できない状態です。' }, 422);
      const on = (body.edit ?? body.send)!;
      const kind = body.send !== undefined ? 'send' : 'edit';
      if (body.department) {
        data.departmentGrants = data.departmentGrants.filter((g) => !(g.department === body.department && g.mailboxId === body.mailboxId && g.kind === kind));
        if (on) data.departmentGrants.push({ department: body.department, mailboxId: body.mailboxId, kind });
      } else {
        const list = kind === 'edit' ? 'grants' : 'sendGrants';
        data[list] = data[list].filter((g) => !(g.userId === body.userId && g.mailboxId === body.mailboxId));
        if (on) data[list].push({ userId: body.userId!, mailboxId: body.mailboxId });
      }
      return respond(data);
    }
    return respond({ error: 'not_found' }, 404);
  });
  await page.goto('/#/settings');
  const panel = page.getByTestId('mail-access');
  await expect(panel).toBeVisible();
  return { panel, puts };
}

test('a tick shows at once while the save is slow, and the other ticks stay usable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { panel, puts } = await settings(page, { delayMs: 2000 });
  const taro = panel.getByLabel('合成 太郎 さんの編集権限');
  const hanako = panel.getByLabel('合成 花子 さんの編集権限');
  await taro.check({ timeout: 1000 });
  await expect(taro).toBeChecked({ timeout: 300 });
  await expect(hanako).toBeEnabled();
  await hanako.check({ timeout: 1000 });
  await expect(hanako).toBeChecked({ timeout: 300 });
  await expect(panel.getByTestId('mail-access-message')).toContainText('合成 花子 さんの「問い合わせ」の編集権限を付けました。', { timeout: 5000 });
  await expect(taro).toBeChecked();
  expect(puts).toEqual([{ userId: 'iy-000002', mailboxId: 'contact', edit: true }, { userId: 'iy-000003', mailboxId: 'contact', edit: true }]);
  // Only the answers of the saves were used: no reload of the whole list.
  const gets = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/api/mail/admin/access')).length);
  expect(gets).toBe(3);
});

test('a failed save goes back and says so on its row', async ({ page }) => {
  const { panel } = await settings(page, { failFor: 'iy-000003' });
  const hanako = panel.getByLabel('合成 花子 さんの編集権限');
  // click, not check: the tick shows and goes back when the refusal arrives.
  await hanako.click();
  await expect(hanako).not.toBeChecked();
  await expect(panel.getByTestId('grant-people').getByRole('listitem').filter({ hasText: '合成 花子' })).toContainText('保存できませんでした');
  await expect(panel.getByTestId('mail-access-message')).toContainText('合成 花子 さん：このアカウントは見つからないか');
});

test('a department grant covers its members, who show it as 部局 and cannot untick it there', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { panel, puts } = await settings(page);
  await panel.getByLabel('受信箱').selectOption('iyakusai');
  const departments = panel.getByTestId('grant-departments');
  await expect(departments.getByRole('listitem')).toHaveText([/企画部/, /渉外課/, /総務部/]);
  await departments.getByLabel('渉外課 の送信権限').check();
  await expect(panel.getByTestId('mail-access-message')).toContainText('渉外課（部局）の「共用アカウント」の送信権限を付けました。');
  expect(puts.at(-1)).toEqual({ department: '渉外課', mailboxId: 'iyakusai', send: true });
  const taroSend = panel.getByLabel('合成 太郎 さんの送信権限');
  await expect(taroSend).toBeChecked();
  await expect(taroSend).toBeDisabled();
  await expect(panel.getByTestId('grant-people').getByRole('listitem').filter({ hasText: '合成 太郎' })).toContainText('部局');
  // Someone with no department is not covered.
  await expect(panel.getByLabel('合成 花子 さんの送信権限')).not.toBeChecked();
  await page.screenshot({ path: '.tmp/mail-access-departments.png', fullPage: true });
});
