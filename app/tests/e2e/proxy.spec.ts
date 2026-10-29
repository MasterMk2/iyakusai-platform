import { expect, openThread, test } from './fixtures.js';

// Synthetic trusted-proxy smoke: the browser talks to the local test-only proxy
// harness (tests/e2e/proxy-harness.mjs), which supplies the identity header.
const PROXY_BASE = 'http://127.0.0.1:5181';
test.use({ baseURL: PROXY_BASE });

const as = (identity: string | null): { extraHTTPHeaders: Record<string, string> } => ({ extraHTTPHeaders: identity ? { 'x-harness-user': identity } : {} });

async function expectNoDemoControls(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('demo-auth-banner')).toHaveCount(0);
  await expect(page.locator('button[data-persona]')).toHaveCount(0);
  for (const name of ['ペルソナを切り替える', 'サンプルをリセット', 'リセットする']) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }
  await expect(page.getByText('障害シミュレーション')).toHaveCount(0);
  await expect(page.getByText('同期で失敗させる受信箱')).toHaveCount(0);
}

test.describe('mapped editor', () => {
  test.use(as('editor-a@idp.example'));

  test('sees the authenticated user, only permitted mailboxes, and can add a note', async ({ page }) => {
    await page.goto('/#/all');
    await expect(page.getByTestId('proxy-auth-banner')).toContainText('合成データ');
    await expect(page.getByTestId('proxy-auth-banner')).toContainText('送信もできません');
    await expect(page.getByTestId('current-user')).toContainText('認証済みの利用者: 編集担当A（編集者（サポート・営業））');
    await expectNoDemoControls(page);

    const sidebar = page.getByRole('navigation', { name: '受信箱' });
    await expect(sidebar).toContainText('サポート窓口');
    await expect(sidebar).toContainText('営業窓口');
    await expect(sidebar).not.toContainText('請求窓口');

    await openThread(page, '見積もりの依頼');
    const card = page.locator('article.receipt').first();
    const note = `プロキシ経由の合成メモ ${Date.now()}`;
    await card.getByRole('textbox', { name: '内部メモ' }).fill(note);
    await card.getByRole('button', { name: 'メモを追加' }).click();
    await expect(card.locator('.note-body').filter({ hasText: note })).toBeVisible();
    await expect(card.locator('.note').filter({ hasText: note }).locator('.note-meta')).toContainText('編集担当A');
  });
});

test.describe('mapped administrator', () => {
  test.use(as('admin@idp.example'));

  test('gets access administration and mock sync but no demo reset, fault or persona controls', async ({ page }) => {
    await page.goto('/#/all');
    await expect(page.getByTestId('current-user')).toContainText('デモ管理者');
    await expect(page.getByRole('heading', { name: /権限とモック同期/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'モック同期（差分）' })).toBeVisible();
    await expectNoDemoControls(page);

    for (const url of ['/api/personas', '/api/demo/faults']) expect((await page.request.get(url)).status(), url).toBe(404);
    // A write with the (harness-translated) public Origin reaches routing: the demo route does not exist.
    expect((await page.request.post('/api/demo/reset', { headers: { origin: PROXY_BASE } })).status()).toBe(404);
    // A write without Origin is refused before routing.
    expect((await page.request.post('/api/admin/sync', { data: {} })).status()).toBe(403);
  });
});

test.describe('session mode not confirmed', () => {
  test.use(as('editor-a@idp.example'));

  const failures: [string, (route: import('@playwright/test').Route) => Promise<void>][] = [
    ['server error', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal","message":"サーバー内部でエラーが発生しました。"}' })],
    ['cross-origin refusal', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden","message":"別オリジンからの API 要求は受け付けません。"}' })],
    ['network failure', (route) => route.abort('connectionrefused')],
  ];
  for (const [label, fail] of failures) {
    test(`${label} shows a neutral banner, never mock authentication, and no operations`, async ({ page }) => {
      await page.route('**/api/session', fail);
      await page.goto('/#/all');
      const banner = page.getByTestId('session-unavailable-banner');
      await expect(banner).toContainText('ログイン状態を確認できていません');
      await expect(banner).toContainText('合成データ');
      await expect(banner).toContainText('送信もできません');
      await expect(page.getByRole('alert')).toContainText('セッションを読み込めませんでした');
      await expect(page.getByTestId('proxy-auth-banner')).toHaveCount(0);
      await expect(page.getByText('モック認証')).toHaveCount(0);
      await expect(page.getByTestId('current-user')).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: '受信箱' })).toHaveCount(0);
      await expectNoDemoControls(page);
    });
  }
});

test.describe('missing or unmapped identity', () => {
  for (const identity of [null, 'stranger@idp.example']) {
    test.describe(`identity ${identity ?? '(none)'}`, () => {
      test.use(as(identity));

      test('shows no mail, persona list or demo controls', async ({ page }) => {
        await page.goto('/#/all');
        await expect(page.getByTestId('proxy-auth-banner')).toBeVisible();
        await expect(page.getByRole('alert')).toContainText('セッションを読み込めませんでした');
        await expect(page.getByTestId('current-user')).toHaveCount(0);
        await expect(page.getByRole('navigation', { name: '受信箱' })).toHaveCount(0);
        await expectNoDemoControls(page);
      });
    });
  }
});
