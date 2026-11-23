import type { Page } from '@playwright/test';
import type { SiteEditorAccessResponse, SiteEditorMetaResponse, SiteEditorPagesResponse } from '../../src/shared/site-editor.js';
import { expect, test } from './fixtures.js';

// The Webサイト tab (2026-11-23; before, a part of the settings). The server is a stand-in (page.route): the Discord
// login's answers, the editor's meta, its list of posts and, for an access administrator, who may write and publish.
// Every name and ID is synthetic.

const POSTS: SiteEditorPagesResponse = {
  ok: true,
  pages: [
    { id: '20261101-a1b2', title: '合成の古い記事', date: '2026-11-01', published: true, savedAt: 1_793_500_000_000 },
    { id: '20261120-c3d4', title: '合成の新しい記事', date: '2026-11-20', published: false, savedAt: 1_795_000_000_000 },
    { id: '20261110-e5f6', title: 'とても長い題名の合成の記事'.repeat(6), date: '2026-11-10', published: true, savedAt: 1_794_000_000_000 },
  ],
};

async function open(page: Page, o: { canEdit?: boolean; admin?: boolean; enabled?: boolean; pages?: SiteEditorPagesResponse | 'down'; hash?: string } = {}) {
  const calls: string[] = [];
  await page.route(/\/(api|site-editor)\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    calls.push(`${request.method()} ${path}`);
    const admin = o.admin ?? false;
    switch (`${request.method()} ${path}`) {
      case 'GET /api/session':
        return respond({
          demoAuthentication: false,
          authMode: 'discord',
          user: { id: 'iy-000002', displayName: '合成 太郎', roleLabel: '総務部', canManageAccess: admin },
          account: { initialLoginId: 'iy-000002', studentId: '21000002', departments: ['総務部'], signIn: { previousLoginAt: null, failedSince: 0 } },
          degraded: false,
          passwordPolicy: { minLength: 12, maxLength: 128 },
          sessionDays: 14,
        });
      case 'GET /api/site-editor/meta': {
        const canEdit = o.canEdit ?? true;
        return respond({
          enabled: o.enabled ?? true,
          canEdit: canEdit || admin,
          canPublish: admin,
          canAdminister: admin,
          editorUrl: canEdit || admin ? '/site-editor/editor/posts.html' : null,
          siteUrl: canEdit || admin ? 'https://blog.example.invalid/blog/' : null,
        } satisfies SiteEditorMetaResponse);
      }
      case 'GET /site-editor/api/pages':
        return o.pages === 'down'
          ? respond({ wge: 1, ok: false, reason: 'unavailable', message: 'Webサイトの編集サーバーにつながりません。' }, 502)
          : respond(o.pages ?? POSTS);
      case 'GET /api/site-editor/access':
        return respond({
          access: { editors: { everyone: true, departments: [], userIds: [] }, publishers: { departments: [], userIds: [] }, version: 0, updatedAt: null, updatedByName: null },
          choices: { departments: ['総務部', '役員会'], people: [{ id: 'iy-000002', name: '合成 太郎', departments: ['総務部'] }] },
        } satisfies SiteEditorAccessResponse);
      default:
        return respond({ error: 'not_found' }, 404);
    }
  });
  await page.goto(o.hash ?? '/#/site');
  return { calls };
}

test('a writer opens the tab, sees the posts newest first with their state, and each opens in the editor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { calls } = await open(page);
  const tab = page.getByTestId('nav-site');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute('aria-current', 'page');
  // Just before パスワード帳 (absent here) and 設定.
  await expect(page.locator('.global-nav a').nth(-2)).toHaveAttribute('data-testid', 'nav-site');
  const rows = page.getByTestId('site-post');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('合成の新しい記事');
  await expect(rows.nth(0)).toContainText('2026/11/20');
  await expect(rows.nth(0)).toContainText('下書き');
  await expect(rows.nth(2)).toContainText('合成の古い記事');
  await expect(rows.nth(2)).toContainText('公開中');
  await expect(page.getByRole('heading', { name: /記事/ })).toContainText('3 件・公開中 2 件');
  await expect(rows.nth(0).getByRole('link')).toHaveAttribute('href', '/site-editor/editor/index.html#p=20261120-c3d4');
  await expect(rows.nth(0).getByRole('link')).toHaveAttribute('target', '_blank');
  await expect(page.getByTestId('site-new')).toHaveAttribute('href', '/site-editor/editor/posts.html');
  await expect(page.getByTestId('site-view')).toHaveAttribute('href', 'https://blog.example.invalid/blog/');
  await expect(page.getByText('書いた記事は、公開できる人か権限管理者が公開します。')).toBeVisible();
  // A writer chooses nobody: the access list is never asked for.
  await expect(page.getByTestId('site-access')).toHaveCount(0);
  expect(calls).not.toContain('GET /api/site-editor/access');

  // Coming back from the editor's browser tab reads the list again.
  const before = calls.filter((c) => c === 'GET /site-editor/api/pages').length;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => calls.filter((c) => c === 'GET /site-editor/api/pages').length).toBeGreaterThan(before);

  // The settings no longer list it.
  await page.getByTestId('nav-settings').click();
  await expect(page.getByRole('navigation', { name: '設定の項目' }).getByRole('link', { name: 'Webサイト' })).toHaveCount(0);
  await page.getByTestId('nav-site').click();
  await expect(page).toHaveURL(/#\/site$/);
  await expect(rows).toHaveCount(3);
});

test('an access administrator chooses who may write and publish under the posts', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { admin: true });
  await expect(page.getByTestId('site-post')).toHaveCount(3);
  await expect(page.getByText('あなたは書くことと公開（公開の取り消しも）ができます。')).toBeVisible();
  const access = page.getByTestId('site-access');
  await expect(access).toBeVisible();
  await expect(access.getByRole('heading', { name: '書ける人・公開できる人' })).toBeVisible();
  await expect(access.getByLabel('役員会')).toBeVisible();
});

test('its first address under the settings opens the tab', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { hash: '/#/settings/site' });
  await expect(page).toHaveURL(/#\/site$/);
  await expect(page.getByTestId('nav-site')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('site-post')).toHaveCount(3);
});

test('no posts yet says how to begin', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { pages: { ok: true, pages: [] } });
  await expect(page.getByText('まだ記事はありません。「新しい記事を書く」から始めます。')).toBeVisible();
  await expect(page.getByTestId('site-new')).toBeVisible();
});

test('the editor server down says so next to the list, with a way to try again', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { pages: 'down' });
  await expect(page.getByRole('alert')).toContainText('Webサイトの編集サーバーにつながりません。');
  await expect(page.getByRole('button', { name: 'もう一度読み込む' })).toBeVisible();
  // The way to write stays.
  await expect(page.getByTestId('site-new')).toBeVisible();
});

test('a member who may not write has no tab, and the address explains why it is empty', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { calls } = await open(page, { canEdit: false });
  await expect(page.getByTestId('nav-settings')).toBeVisible();
  await expect(page.getByTestId('nav-site')).toHaveCount(0);
  await expect(page.getByTestId('site-absent')).toContainText('あなたには書く権限がありません');
  expect(calls).not.toContain('GET /site-editor/api/pages');
});

for (const width of [375, 320]) {
  test(`on a phone ${width}px wide the tab fits, a long title wraps, and nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await open(page);
    await expect(page.getByTestId('site-post')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const tab = await page.getByTestId('nav-site').boundingBox();
    expect(tab!.x + tab!.width).toBeLessThanOrEqual(width);
    expect((await page.getByTestId('site-new').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
}
