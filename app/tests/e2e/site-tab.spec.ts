import type { Page } from '@playwright/test';
import type { SiteEditorAccessResponse, SiteEditorDeletedPage, SiteEditorMetaResponse, SiteEditorPagesResponse } from '../../src/shared/site-editor.js';
import { expect, openTab, test } from './fixtures.js';

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
  // Deleting and restoring change these, as the editor's server does: only a post that is not published is deleted.
  const posts = o.pages === 'down' ? null : structuredClone(o.pages ?? POSTS);
  const deleted: SiteEditorDeletedPage[] = [];
  await page.route(/\/(api|site-editor)\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    calls.push(`${request.method()} ${path}`);
    const admin = o.admin ?? false;
    const change = /^POST \/site-editor\/api\/pages\/([a-z0-9-]+)\/(delete|restore)$/.exec(`${request.method()} ${path}`);
    if (change && posts) {
      const [, id, action] = change;
      if (request.headers()['x-wge-request'] !== '1') return respond({ wge: 1, ok: false, reason: 'forbidden' }, 403);
      if (action === 'delete') {
        const post = posts.pages.find((p) => p.id === id);
        if (!post) return respond({ wge: 1, ok: false, reason: 'deleted' }, 404);
        if (post.published) return respond({ wge: 1, ok: false, reason: 'published' }, 409);
        posts.pages = posts.pages.filter((p) => p !== post);
        deleted.unshift({ id: post.id, title: post.title ?? '', date: post.date, deletedAt: Date.parse('2026-11-24T03:00:00Z') });
        return respond({ wge: 1, ok: true, deletedAt: Date.parse('2026-11-24T03:00:00Z') });
      }
      const back = deleted.find((p) => p.id === id);
      if (!back) return respond({ wge: 1, ok: false, reason: 'not-deleted' }, 409);
      deleted.splice(deleted.indexOf(back), 1);
      posts.pages.push({ id: back.id, title: back.title, date: back.date, published: false, savedAt: 1_795_000_000_000 });
      return respond({ wge: 1, ok: true, draft: { revision: 0 }, published: null });
    }
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
        return posts === null ? respond({ wge: 1, ok: false, reason: 'unavailable', message: 'Webサイトの編集サーバーにつながりません。' }, 502) : respond(posts);
      case 'GET /site-editor/api/deleted-pages':
        return respond({ wge: 1, ok: true, pages: deleted });
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
  // The last link of the 連絡 menu (2026-11-23), which is marked while the site is shown.
  const tab = page.getByTestId('nav-site');
  await expect(tab).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#nav-menu-contact a').last()).toHaveAttribute('data-testid', 'nav-site');
  await expect(page.locator('.nav-group[data-group="contact"]')).toHaveClass(/is-current/);
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
  await openTab(page, 'site');
  await expect(page).toHaveURL(/#\/site$/);
  await expect(rows).toHaveCount(3);
});

test('a writer deletes a draft without a question, undoes it, and restores another from the deleted posts', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { calls } = await open(page);
  const rows = page.getByTestId('site-post');
  await expect(rows).toHaveCount(3);
  // Only the draft can be deleted: a published post is taken back in the editor first.
  await expect(page.getByTestId('site-post-delete')).toHaveCount(1);
  await expect(page.getByTestId('site-trash')).toHaveCount(0);

  await page.getByRole('button', { name: '「合成の新しい記事」を削除' }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('site-notice')).toContainText('「合成の新しい記事」を削除しました。');
  await expect(page.getByRole('heading', { name: /記事/ }).first()).toContainText('2 件・公開中 2 件');
  const trash = page.getByTestId('site-trash');
  await expect(trash).toContainText('削除した記事（1 件）');
  expect(calls).toContain('POST /site-editor/api/pages/20261120-c3d4/delete');

  // 元に戻す next to the message brings it back as a draft, and the deleted posts close up.
  await page.getByTestId('site-undo').click();
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('site-notice')).toContainText('元に戻しました');
  await expect(trash).toHaveCount(0);

  // Deleted again, it is restored from the deleted posts too.
  await page.getByRole('button', { name: '「合成の新しい記事」を削除' }).click();
  await expect(rows).toHaveCount(2);
  await trash.locator('summary').click();
  await expect(page.getByTestId('site-trash-post')).toContainText('2026/11/24 に削除');
  await page.getByRole('button', { name: '「合成の新しい記事」を元に戻す' }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('下書き');
  expect(calls.filter((c) => c.endsWith('/restore'))).toHaveLength(2);
});

test('a post published meanwhile is not deleted, and the message says why', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { pages: { ok: true, pages: [{ id: '20261120-c3d4', title: '合成の新しい記事', date: '2026-11-20', published: false, savedAt: 1 }] } });
  // Someone published it after the list was read: the editor's server refuses, and the site stays as it is.
  await page.route('**/site-editor/api/pages/20261120-c3d4/delete', (route) => route.fulfill({ status: 409, json: { wge: 1, ok: false, reason: 'published' } }));
  await page.getByTestId('site-post-delete').click();
  await expect(page.getByTestId('site-notice')).toContainText('公開中のため削除できません。エディタで公開を取り消してから削除してください。');
  await expect(page.getByTestId('site-undo')).toHaveCount(0);
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
  test(`on a phone ${width}px wide the link fits in the 連絡 menu, a long title wraps, and nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await open(page);
    await expect(page.getByTestId('site-post')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByTestId('nav-group-contact').click();
    const tab = await page.getByTestId('nav-site').boundingBox();
    expect(tab!.x + tab!.width).toBeLessThanOrEqual(width);
    expect((await page.getByTestId('site-new').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Deleting a draft and opening the deleted posts keep the buttons in reach and nothing sideways.
    await page.keyboard.press('Escape');
    expect((await page.getByTestId('site-post-delete').boundingBox())!.height).toBeGreaterThanOrEqual(36);
    await page.getByTestId('site-post-delete').click();
    await page.getByTestId('site-trash').locator('summary').click();
    const restore = await page.getByTestId('site-trash-restore').boundingBox();
    expect(restore!.x + restore!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
