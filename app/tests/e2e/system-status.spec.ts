import type { Page } from '@playwright/test';
import type { SystemStatusResponse } from '../../src/shared/system.js';
import { expect, test } from './fixtures.js';

// 設定 › サーバーの状態 (2026-11-21): access administrators see how busy the server is; the part asks again only while it
// is the one shown. The server is a stand-in (page.route); every number is synthetic.

const GiB = 1024 ** 3;

function reading(over: Partial<SystemStatusResponse> = {}): SystemStatusResponse {
  return {
    sampledAt: '2026-11-21T05:03:20.000Z',
    cpu: { percent: 23.4, windowSeconds: 10, cores: 6, level: 'ok' },
    load: { one: 0.42, five: 0.35, fifteen: 0.3, perCore: 0.07, level: 'ok' },
    memory: { totalBytes: 8 * GiB, availableBytes: 5.5 * GiB, usedPercent: 31.3, level: 'ok' },
    disks: [{ label: 'データ・バックアップ', totalBytes: 800 * GiB, freeBytes: 700 * GiB, usedPercent: 12.5, level: 'ok' }],
    uptimeSeconds: 3 * 86400 + 4 * 3600 + 120,
    app: { startedAt: '2026-11-20T15:39:00.000Z', uptimeSeconds: 13 * 3600 + 24 * 60, rssBytes: 210 * 1024 ** 2, container: { usedBytes: 300 * 1024 ** 2, limitBytes: GiB, usedPercent: 29.3, level: 'ok' } },
    level: 'ok',
    ...over,
  };
}

async function open(page: Page, hash: string, o: { admin?: boolean; status?: () => { status: number; json: unknown } } = {}) {
  const admin = o.admin ?? true;
  const calls: string[] = [];
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
      case '/api/system/status': {
        calls.push(path);
        const answer = o.status ? o.status() : { status: 200, json: reading() };
        return respond(answer.json, answer.status);
      }
      default:
        return respond({ error: 'not_found' }, 404);
    }
  });
  await page.clock.install({ time: new Date('2026-11-21T05:03:20.000Z') });
  await page.goto(hash);
  await expect(page.getByRole('heading', { name: '設定', exact: true, level: 2 })).toBeAttached();
  return calls;
}

const nav = (page: Page) => page.getByRole('navigation', { name: '設定の項目' });
const panel = (page: Page) => page.getByTestId('system-status');
const meter = (page: Page, name: string) => panel(page).locator(`[data-meter="${name}"]`);

test('an access administrator opens サーバーの状態 and reads each meter and the line at the top', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '/#/settings/system');
  await expect(nav(page).getByRole('link', { name: 'サーバーの状態' })).toHaveAttribute('aria-current', 'page');
  await expect(panel(page).getByRole('heading', { name: 'サーバーの状態', level: 3 })).toBeVisible();
  await expect(page.getByTestId('system-summary')).toHaveText('いまは問題ありません。');
  await expect(page.getByTestId('system-summary')).toHaveClass(/\binfo\b/);
  await expect(page.getByTestId('system-sampled-at')).toHaveText('14:03:20 時点');
  await expect(meter(page, 'cpu').locator('.system-value')).toHaveText('23%');
  await expect(meter(page, 'cpu').locator('.system-detail')).toHaveText('6 コア・直近 10 秒の平均');
  await expect(meter(page, 'memory').locator('.system-detail')).toHaveText('使用 2.5 GB／全体 8.0 GB（空き 5.5 GB）');
  await expect(meter(page, 'disk:データ・バックアップ').locator('dt')).toHaveText('ディスク（データ・バックアップ）');
  await expect(meter(page, 'disk:データ・バックアップ').locator('.system-detail')).toHaveText('空き 700 GB／全体 800 GB');
  await expect(meter(page, 'app-memory').locator('.system-detail')).toHaveText('使用 300 MB／上限 1.0 GB');
  // Nothing is coloured when all is fine (ui-guidelines §3, §4).
  await expect(panel(page).locator('.system-chip')).toHaveCount(0);
  const facts = panel(page).locator('dl.pay-facts');
  await expect(facts).toContainText('0.42・0.35・0.30（1 コアあたり 0.07）');
  await expect(facts).toContainText('3 日 4 時間');
  await expect(facts).toContainText('13 時間 24 分（2026/11/21 00:39 に起動）');
});

test('a reading that needs a look is named at the top, worst first, with its label beside the meter', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '/#/settings/system', {
    status: () => ({
      status: 200,
      json: reading({
        memory: { totalBytes: 8 * GiB, availableBytes: 0.8 * GiB, usedPercent: 90, level: 'warn' },
        disks: [{ label: 'データ', totalBytes: 100 * GiB, freeBytes: 3 * GiB, usedPercent: 97, level: 'alert' }],
        level: 'alert',
      }),
    }),
  });
  const summary = page.getByTestId('system-summary');
  await expect(summary).toHaveText('すぐ対応：ディスク（データ）の空きが 3.0 GB しかない（議事録の録音を取り込めません）、メモリの使用率が高い（90%）');
  await expect(summary).toHaveClass(/\berror\b/);
  await expect(meter(page, 'disk:データ').locator('.system-chip')).toHaveText('すぐ対応');
  await expect(meter(page, 'memory').locator('.system-chip')).toHaveText('注意');
  await expect(meter(page, 'cpu').locator('.system-chip')).toHaveCount(0);
});

test('it asks again every 10 seconds only while it is the part shown', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const calls = await open(page, '/#/settings/account');
  // Every part is mounted: this one asked once to know whether to list itself, and is listed.
  await expect(nav(page).getByRole('link', { name: 'サーバーの状態' })).toBeVisible();
  await expect.poll(() => calls.length).toBe(1);
  await page.clock.fastForward(35_000);
  expect(calls.length).toBe(1);

  await nav(page).getByRole('link', { name: 'サーバーの状態' }).click();
  // Opened after a while: asked at once, then every 10 seconds.
  await expect.poll(() => calls.length).toBe(2);
  await page.clock.fastForward(10_000);
  await expect.poll(() => calls.length).toBe(3);
  await page.clock.fastForward(10_000);
  await expect.poll(() => calls.length).toBe(4);

  await nav(page).getByRole('link', { name: 'アカウント' }).click();
  await page.clock.fastForward(35_000);
  expect(calls.length).toBe(4);
});

test('a failed refresh keeps the last values and says how old they are', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let n = 0;
  await open(page, '/#/settings/system', {
    status: () => (++n === 1 ? { status: 200, json: reading() } : { status: 503, json: { error: 'unavailable', message: 'いまは使えません。' } }),
  });
  await expect(meter(page, 'cpu').locator('.system-value')).toHaveText('23%');
  await page.getByRole('button', { name: '今すぐ更新' }).click();
  await expect(page.getByTestId('system-refresh-error')).toContainText('更新できませんでした');
  await expect(page.getByTestId('system-refresh-error')).toContainText('14:03:20 時点の値です');
  await expect(meter(page, 'cpu').locator('.system-value')).toHaveText('23%');
});

test('a member without the grant never sees it or asks for it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const calls = await open(page, '/#/settings/system', { admin: false });
  await expect(nav(page).getByRole('link', { name: 'アカウント' })).toHaveAttribute('aria-current', 'page');
  await expect(nav(page).getByRole('link', { name: 'サーバーの状態' })).toHaveCount(0);
  expect(calls).toEqual([]);
});

test('a server from before it does not list it, and its address opens the account', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '/#/settings/system', { status: () => ({ status: 404, json: { error: 'not_found' } }) });
  await expect(nav(page).getByRole('link', { name: 'ログインの記録' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'サーバーの状態' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'アカウント' })).toHaveAttribute('aria-current', 'page');
});

test('a phone shows the part alone without a sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, '/#/settings/system');
  await expect(meter(page, 'cpu').locator('.system-value')).toHaveText('23%');
  await expect(page.getByRole('link', { name: '← 設定の一覧' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
