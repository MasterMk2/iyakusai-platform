/* global document, innerWidth */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const origin = 'http://127.0.0.1:18751';
const output = '.tmp/rental-access-browser';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
await context.addCookies([{ name: 'smm_demo_persona', value: 'u-admin', url: origin }]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const get = async () => (await context.request.get(`${origin}/api/rental/admin/access`)).json();
const other = await browser.newContext();
await other.addCookies([{ name: 'smm_demo_persona', value: 'u-viewer-b', url: origin }]);
try {
  await page.goto(`${origin}/#/settings`);
  const panel = page.getByTestId('rental-access');
  await panel.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !!document.querySelector('.rental-access-person'));
  let data = await get();
  assert.equal(data.allMembersAdmin, true);
  const member = data.people.find((p) => p.id === 'u-viewer-b');
  assert.ok(member);
  await panel.getByRole('combobox', { name: `${member.displayName} さんの個別設定` }).selectOption('admin');
  await panel.getByRole('button', { name: `${member.displayName} さんの権限を保存` }).click();
  await panel.getByRole('status').filter({ hasText: '個別設定を「物品管理者」' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.rental-access-person select')?.disabled);
  data = await get();
  assert.deepEqual(data.people.find((p) => p.id === member.id).storedPermissions, ['rental.admin', 'rental.issue', 'rental.loan']);
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await panel.screenshot({ path: `${output}/desktop-panel.png` });

  await panel.getByRole('checkbox', { name: '全員に物品の管理者権限を付ける' }).uncheck();
  await panel.getByRole('button', { name: '全員設定を保存' }).click();
  await panel.getByRole('button', { name: '個別設定に切り替える' }).waitFor();
  assert.equal((await get()).allMembersAdmin, true, 'Confirmation must precede mutation');
  await panel.getByRole('button', { name: '個別設定に切り替える' }).click();
  await panel.getByRole('status').filter({ hasText: '全員設定をオフにしました' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.rental-access-person select')?.disabled);
  assert.equal((await get()).allMembersAdmin, false);
  assert.equal((await (await other.request.get(`${origin}/api/rental/me`)).json()).issuer_reset_allowed, true);
  await panel.getByRole('combobox', { name: `${member.displayName} さんの個別設定` }).selectOption('loan');
  await panel.getByRole('button', { name: `${member.displayName} さんの権限を保存` }).click();
  await panel.getByRole('status').filter({ hasText: '個別設定を「貸出・返却」' }).waitFor();
  assert.deepEqual((await (await other.request.get(`${origin}/api/rental/me`)).json()).permissions, ['rental.loan']);
  assert.equal((await other.request.get(`${origin}/api/rental/issuer/state`)).status(), 403);
  await page.reload();
  await panel.getByRole('combobox', { name: `${member.displayName} さんの個別設定` }).waitFor();
  assert.equal(await panel.getByRole('combobox', { name: `${member.displayName} さんの個別設定` }).inputValue(), 'loan');

  // Another administrator changes the policy after this page fetched its version.
  data = await get();
  const response = await context.request.put(`${origin}/api/rental/admin/access`, {
    headers: { origin }, data: { kind: 'policy', allMembersAdmin: true, expectedRevision: data.revision },
  });
  assert.equal(response.status(), 200);
  await panel.getByRole('combobox', { name: `${member.displayName} さんの個別設定` }).selectOption('none');
  await panel.getByRole('button', { name: `${member.displayName} さんの権限を保存` }).click();
  await panel.getByRole('alert').filter({ hasText: '別の管理者が先に変更' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.rental-access-person select')?.disabled);
  data = await get();
  assert.equal(data.allMembersAdmin, true);
  assert.deepEqual(data.people.find((p) => p.id === member.id).storedPermissions, ['rental.loan']);

  await page.setViewportSize({ width: 320, height: 844 });
  await panel.getByRole('searchbox').fill(member.displayName);
  assert.equal(await panel.locator('.rental-access-person').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No mobile horizontal overflow');
  await panel.locator('summary').click();
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  await panel.screenshot({ path: `${output}/mobile-panel.png` });
  await panel.getByRole('combobox', { name: `${member.displayName} さんの個別設定` }).focus();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT');

  // A lost connection retains the saved settings and allows retry.
  await page.route('**/api/rental/admin/access', (route) => route.abort('internetdisconnected'));
  await panel.getByRole('combobox', { name: `${member.displayName} さんの個別設定` }).selectOption('issue');
  await panel.getByRole('button', { name: `${member.displayName} さんの権限を保存` }).click();
  await panel.getByRole('alert').filter({ hasText: 'サーバーに接続できませんでした' }).waitFor();
  assert.equal(await panel.getByRole('combobox', { name: `${member.displayName} さんの個別設定` }).inputValue(), 'issue');
  await page.unroute('**/api/rental/admin/access');
  await panel.getByRole('button', { name: `${member.displayName} さんの権限を保存` }).click();
  await panel.getByRole('status').filter({ hasText: '個別設定を「発行・台帳変更」' }).waitFor();

  const memberPage = await other.newPage();
  await memberPage.goto(`${origin}/#/settings`);
  await memberPage.getByRole('heading', { name: '設定', exact: true }).waitFor();
  assert.equal(await memberPage.getByTestId('rental-access').count(), 0);
  assert.equal((await other.request.get(`${origin}/api/rental/admin/access`)).status(), 403);
  assert.deepEqual(errors, []);
  const result = { passed: true, realHttpAndSqlite: true, syntheticAccountsOnly: true, checks: ['individualSave', 'offConfirmation', 'immediateCapabilities', 'reloadPersistence', 'conflictNoOverwrite', 'nameFilter', '320pxNoOverflow', 'keyboardFocus', 'offlineRetry', 'nonManagerHidden'], pageErrors: errors };
  writeFileSync(`${output}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await context.close(); await other.close(); await browser.close(); }
