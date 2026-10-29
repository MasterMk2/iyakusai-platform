import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

// Account login in the labelled loopback MOCK composition (server on port 5182, synthetic
// providers): first registration through a mock DM code, own password, protected common entry,
// logout, normal password login, recovery and revocation - in a real browser.

const BASE = 'http://127.0.0.1:5182';
const PASSWORD = 'synthetic passphrase 42';
test.use({ baseURL: BASE });

async function readMockCode(page: Page, label: string): Promise<string> {
  const outbox = page.getByTestId('mock-dm-outbox');
  await expect(async () => {
    await outbox.getByRole('button', { name: '更新' }).click();
    await expect(outbox.locator(`[data-dm-recipient="${label}"]`).first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  return (await outbox.locator(`[data-dm-recipient="${label}"]`).first().getByTestId('mock-dm-code').textContent())!.trim();
}

async function register(page: Page, email: string, label: string, password = PASSWORD) {
  await page.goto('/');
  await page.getByRole('tab', { name: '初回登録・パスワード再設定' }).click();
  await page.getByRole('form', { name: '確認コードの申請' }).getByLabel('メールアドレス').fill(email);
  await page.getByRole('button', { name: '確認コードを申請' }).click();
  await expect(page.getByRole('form', { name: '確認コードの入力' })).toBeVisible();
  const code = await readMockCode(page, label);
  await page.getByLabel('確認コード（数字）').fill(code);
  await page.getByRole('button', { name: 'コードを確認' }).click();
  const form = page.getByRole('form', { name: 'パスワードの設定' });
  await expect(form).toBeVisible();
  await form.getByLabel('新しいパスワード', { exact: true }).fill(password);
  await form.getByLabel('新しいパスワード（確認）').fill(password);
  await form.getByRole('button', { name: 'パスワードを設定してログイン' }).click();
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect(page.getByRole('tab', { name: 'ログイン' })).toBeVisible();
}

test('first registration by mock DM code, own password, protected common entry, logout and password login', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.getByTestId('mock-composition-banner')).toBeVisible();
  await page.getByRole('tab', { name: '初回登録・パスワード再設定' }).click();
  await page.getByRole('form', { name: '確認コードの申請' }).getByLabel('メールアドレス').fill('editor-a@staff.invalid');
  await page.getByRole('button', { name: '確認コードを申請' }).click();
  const code = await readMockCode(page, '編集担当A');
  // A wrong code is refused; the right one leads to the password form.
  await page.getByLabel('確認コード（数字）').fill('00000000');
  await page.getByRole('button', { name: 'コードを確認' }).click();
  await expect(page.getByRole('alert')).toContainText('コードが正しくないか');
  await page.getByLabel('確認コード（数字）').fill(code);
  await page.getByRole('button', { name: 'コードを確認' }).click();
  const form = page.getByRole('form', { name: 'パスワードの設定' });
  await expect(form).toContainText('12〜128 文字');
  await form.getByLabel('新しいパスワード', { exact: true }).fill('short');
  await expect(form).toContainText('文字以上必要です');
  await form.getByLabel('新しいパスワード', { exact: true }).fill(PASSWORD);
  await form.getByLabel('新しいパスワード（確認）').fill(`${PASSWORD}!`);
  await expect(form).toContainText('一致しません');
  await form.getByLabel('新しいパスワード（確認）').fill(PASSWORD);
  await form.getByRole('button', { name: 'パスワードを設定してログイン' }).click();

  await expect(page.getByTestId('current-user')).toContainText('編集担当A');
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === '__Host-smm_session')!;
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
  // Common entry: inbox by default, task and settings navigation.
  await expect(page.locator('[data-mailbox-id="mbx-support"]')).toBeVisible();
  await page.getByTestId('nav-tasks').click();
  await expect(page.getByTestId('tasks-disabled')).toBeVisible();
  await page.getByTestId('nav-settings').click();
  await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();

  await logout(page);
  await page.getByRole('form', { name: 'ログイン' }).getByLabel('メールアドレス').fill('editor-a@staff.invalid');
  await page.getByLabel('パスワード', { exact: true }).fill('wrong password 123');
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('メールアドレスまたはパスワードが正しくない');
  await page.getByLabel('パスワード', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByTestId('current-user')).toContainText('編集担当A');
  await logout(page);
});

test('nested-group member logs in but sees only the mailboxes granted to them; no demo controls exist', async ({ page }) => {
  await page.context().clearCookies();
  await register(page, 'viewer-b@staff.invalid', '閲覧担当B');
  await expect(page.getByTestId('current-user')).toContainText('閲覧担当B');
  await expect(page.locator('[data-mailbox-id="mbx-support"]')).toBeVisible();
  await expect(page.locator('[data-mailbox-id="mbx-billing"]')).toBeVisible();
  await expect(page.locator('[data-mailbox-id="mbx-sales"]')).toHaveCount(0);
  await expect(page.getByText('デモ用ペルソナ')).toHaveCount(0);
  expect((await page.request.get('/api/personas')).status()).toBe(404);
  await logout(page);
});

test('membership loss in the mock directory ends every session of that person', async ({ page, browser }) => {
  await page.context().clearCookies();
  await register(page, 'noaccess-d@staff.invalid', '権限なしD');
  await expect(page.getByTestId('current-user')).toContainText('権限なしD');

  // A second browser logs in with the password; a later password reset ends it.
  const other = await browser.newContext({ baseURL: BASE });
  const second = await other.newPage();
  await second.goto('/');
  await second.getByRole('form', { name: 'ログイン' }).getByLabel('メールアドレス').fill('noaccess-d@staff.invalid');
  await second.getByLabel('パスワード', { exact: true }).fill(PASSWORD);
  await second.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(second.getByTestId('current-user')).toContainText('権限なしD');

  // Membership removed through the (mock-only) directory controls in Settings.
  await page.getByTestId('nav-settings').click();
  const row = page.getByTestId('mock-directory').locator('[data-mock-person="u-noaccess-d"]');
  await row.getByRole('button', { name: '会員資格を外す' }).click();
  await second.reload();
  await expect(second.getByRole('tab', { name: 'ログイン' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'ログイン' })).toBeVisible();
  await other.close();
});
