import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { installWorld, TODAY } from './redesign-world.js';

// The screens rebuilt on 2026-10-25 (home, tasks, the mailbox), walked with synthetic data at production
// scale: 18 mailboxes, about 60 threads, about 50 tasks. Every request is answered in the browser.

const taskList = (page: Page) => page.getByRole('region', { name: 'タスク一覧', exact: true });
const threadList = (page: Page) => page.getByRole('region', { name: 'スレッド一覧', exact: true });
// Reads of a task list: every department at once (2026-10-25) or one department (an older Task API).
const TASK_LISTS = /^\/api\/tasks\/(all|workspaces\/[^/]+\/tasks)$/;

function requests(page: Page, pattern: RegExp) {
  const seen: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (pattern.test(url.pathname)) seen.push(url.search);
  });
  return seen;
}

async function shot(page: Page, name: string) {
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: `.tmp/ux-redesign-${name}.png`, fullPage: false, animations: 'disabled' });
}

test('the tab reads メール on every screen and names the page', async ({ page }) => {
  await installWorld(page);
  await page.goto('/#/all');
  const tabs = page.getByRole('navigation', { name: '機能' });
  await expect(tabs.getByRole('link')).toHaveText(['ホーム', 'タスク', '物品貸出', 'メール', '連絡先', 'Bot', '設定']);
  await expect(tabs.getByRole('link', { name: 'メール', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveTitle('メール｜医薬祭 委員会アプリ');
});

test('home leads with the counts that need action, and each opens its place', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page);
  await page.goto('/#/home');
  const attention = page.getByTestId('home-attention');
  await expect(attention.getByTestId('attention-task-overdue')).toContainText('タスクの期限超過');
  await expect(attention.getByTestId('attention-mail')).toContainText('未対応のメール');
  // The mailbox card lists only mailboxes with unhandled mail, the most first, and the newest unhandled threads.
  const inbox = page.getByTestId('home-inbox');
  const boxes = inbox.locator('.box-counts li');
  const counts = (await boxes.locator('.count-badge').allInnerTexts()).map(Number);
  expect(counts.every((n) => n > 0)).toBe(true);
  expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  await expect(inbox.locator('.home-mail-rows li')).toHaveCount(5);
  await shot(page, 'home-1440');
  // One click on an unhandled thread opens it, with the list filtered to unhandled mail.
  const first = world.threads.find((t) => t.receipts.some((r) => r.triage.status === 'unhandled'))!;
  await inbox.locator('.home-mail-rows li').first().getByRole('button').click();
  await expect(page).toHaveURL(new RegExp(`thread=${first.id}`));
  await expect(threadList(page).getByRole('combobox', { name: '対応状況', exact: true })).toHaveValue('unhandled');
  await expect(page.getByRole('region', { name: 'スレッド詳細' }).getByRole('heading', { level: 2 })).toHaveText(first.receipts[0]!.subject);
});

test('a department overdue count on home opens that list already filtered', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page);
  await page.goto('/#/home');
  await page.getByRole('link', { name: /^外務部の期限超過 \d+ 件を開く$/ }).click();
  await expect(page).toHaveURL(/#\/tasks\?ws=dept-gaimu&focus=overdue/);
  const pane = taskList(page);
  await expect(pane.getByRole('button', { name: /^期限超過/ })).toHaveAttribute('aria-pressed', 'true');
  const rows = pane.locator('[data-task-id]');
  const overdue = world.tasks.filter((t) => t.overdue && (t.tags ?? []).some((k) => ['gaimu', 'shogai', 'koho'].includes(k)));
  await expect(rows).toHaveCount(overdue.length);
  for (const due of await pane.locator('.task-row .due strong').allInnerTexts()) expect(due).toMatch(/日超過$/);
});

test('tasks: one press for my own, counts beside every filter, and no request to the Task service for any of it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page);
  const lists = requests(page, TASK_LISTS);
  await page.goto('/#/tasks?ws=dept-gaimu');
  const pane = taskList(page);
  const rows = pane.locator('[data-task-id]');
  await expect(rows.first()).toBeVisible();
  const fetched = lists.length;
  expect(fetched).toBeGreaterThan(0);
  // Most rows fit the first screen (was two before 2026-10-25).
  const inView = await rows.evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().bottom <= innerHeight).length);
  expect(inView).toBeGreaterThanOrEqual(7);
  // Open tasks first, nearest deadline first; done tasks last.
  const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')));
  const shown = ids.map((id) => world.tasks.find((t) => t.id === id)!);
  const firstDone = shown.findIndex((t) => t.status === 'done');
  expect(shown.slice(firstDone).every((t) => t.status === 'done')).toBe(true);
  const deadlines = shown.slice(0, firstDone).map((t) => t.deadline ?? '9999');
  expect([...deadlines].sort()).toEqual(deadlines);
  // My own tasks.
  const mine = pane.getByRole('button', { name: /^自分の担当/ });
  const count = Number((await mine.locator('.option-count').innerText()).trim());
  await mine.click();
  await expect(mine).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(count);
  for (const meta of await pane.locator('.task-row .row-meta').allInnerTexts()) expect(meta).toContain('担当: 合成 花子');
  await expect(pane.locator('.task-list-summary .count')).toHaveText(`${count} 件を表示`);
  await mine.click();
  await expect(mine).toHaveAttribute('aria-pressed', 'false');
  // Search and order too; one button clears every filter.
  await pane.getByRole('searchbox', { name: 'タスクを検索' }).fill('お礼状');
  await expect(rows.first()).toContainText('お礼状');
  await pane.getByLabel('並べ順').selectOption('updated');
  await pane.getByRole('button', { name: /^期限超過/ }).click();
  await pane.getByRole('button', { name: '絞り込みを解除' }).click();
  await expect(pane.getByRole('searchbox', { name: 'タスクを検索' })).toHaveValue('');
  await expect(pane.getByRole('button', { name: /^期限超過/ })).toHaveAttribute('aria-pressed', 'false');
  expect(lists).toHaveLength(fetched);
  expect(world.calls.filter((c) => c.startsWith('UNHANDLED'))).toEqual([]);
});

test('my own tasks come from the Task service ID in the context; an older server does not offer the filter', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page);
  await page.goto('/#/tasks?ws=dept-gaimu');
  const pane = taskList(page);
  // The session ID (iy-…) never appears on tasks; the context's own Task ID (discord-…) does.
  const mine = world.tasks.filter((t) => t.assignee?.displayName === '合成 花子' && (t.tags ?? []).some((k) => ['gaimu', 'shogai', 'koho'].includes(k)));
  expect(mine.length).toBeGreaterThan(0);
  expect(mine.every((t) => t.assigneeId?.startsWith('discord-'))).toBe(true);
  await expect(pane.getByRole('button', { name: /^自分の担当/ }).locator('.option-count')).toHaveText(String(mine.length));
  await expect(page.getByTestId('department-overview')).toContainText('合成 花子（自分）');

  const old = await page.context().newPage();
  await installWorld(old, { oldServer: true });
  await old.goto('/#/tasks?ws=dept-gaimu');
  await expect(taskList(old).locator('[data-task-id]').first()).toBeVisible();
  await expect(taskList(old).getByRole('button', { name: /^自分の担当/ })).toHaveCount(0);
  await expect(old.getByTestId('department-overview')).not.toContainText('（自分）');
  await old.close();
});

test('a home link filters the mailbox once: after clearing, another mailbox opens unfiltered', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installWorld(page);
  await page.goto('/#/home');
  await page.getByTestId('home-inbox').locator('.home-mail-rows li').first().getByRole('button').click();
  const status = threadList(page).getByRole('combobox', { name: '対応状況', exact: true });
  await expect(status).toHaveValue('unhandled');
  await threadList(page).getByRole('button', { name: '条件をクリア' }).click();
  await expect(status).toHaveValue('');
  await expect(page).not.toHaveURL(/filter=/);
  await page.getByRole('navigation', { name: '受信箱' }).getByRole('button', { name: /^協賛/ }).click();
  await expect(threadList(page).getByRole('heading', { name: '協賛' })).toBeVisible();
  await expect(status).toHaveValue('');
  await page.reload();
  await expect(threadList(page).getByRole('combobox', { name: '対応状況', exact: true })).toHaveValue('');
});

test('tasks: the empty detail pane gives the department at a glance, and its counts filter the list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installWorld(page);
  await page.goto('/#/tasks?ws=dept-gaimu');
  const overview = page.getByTestId('department-overview');
  await expect(overview.getByRole('heading', { name: '外務部の概要' })).toBeVisible();
  const unassigned = overview.locator('.overview-stat').filter({ hasText: '未割当' });
  const n = Number((await unassigned.locator('strong').innerText()).trim());
  await unassigned.click();
  const pane = taskList(page);
  await expect(pane.getByRole('button', { name: /^未割当/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(pane.locator('[data-task-id]')).toHaveCount(n);
  for (const meta of await pane.locator('.task-row .row-meta').allInnerTexts()) expect(meta).toContain('担当: 未割当');
});

test('a row status change saves in place: the list is not fetched again and the rows stay put afterwards', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { delayMs: 300 });
  const lists = requests(page, TASK_LISTS);
  await page.goto('/#/tasks?ws=dept-gaimu');
  const pane = taskList(page);
  const rows = pane.locator('li.task-row');
  await expect(rows.nth(3)).toBeVisible();
  await page.waitForLoadState('networkidle');
  const fetched = lists.length;
  expect(fetched).toBeGreaterThan(0);
  const id = await rows.nth(1).locator('[data-task-id]').getAttribute('data-task-id');
  // Follow the task, not the position: a saved task is the newest change among those due the same day.
  const row = pane.locator('li.task-row', { has: page.locator(`[data-task-id="${id}"]`) });
  await row.getByRole('button', { name: '保留', exact: true }).click();
  await expect(row.getByRole('button', { name: '保留', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(pane.getByRole('status').filter({ hasText: 'を保留にしました。' })).toBeVisible();
  expect(world.tasks.find((t) => t.id === id)!.status).toBe('blocked');
  expect(lists).toHaveLength(fetched);
  // The notice above the list moved the rows once; nothing moves them again while other parts reload.
  const settled = await rows.nth(3).boundingBox();
  await page.waitForTimeout(800);
  const later = await rows.nth(3).boundingBox();
  expect(later!.y).toBe(settled!.y);
});

test('task detail: the status saves on one press; a field shows its save button only once it changed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page);
  await page.goto('/#/tasks?ws=dept-gaimu&task=T-101');
  const detail = page.getByRole('region', { name: 'タスク詳細', exact: true });
  await expect(detail.getByTestId('task-version')).toHaveText(String(world.tasks.find((t) => t.id === 'T-101')!.version));
  const version = Number(await detail.getByTestId('task-version').innerText());
  // Nothing changed: no save buttons and no unsaved note.
  await expect(detail.getByRole('button', { name: /を保存$/ })).toHaveCount(0);
  await expect(detail.getByTestId('task-unsaved')).toHaveCount(0);
  await detail.getByLabel('担当者', { exact: true }).selectOption({ label: '見本 さくら' });
  await expect(detail.getByTestId('task-unsaved')).toContainText('担当者');
  await expect(detail.getByRole('button', { name: /を保存$/ })).toHaveText(['担当者を保存']);
  await detail.getByRole('button', { name: '担当者を保存' }).click();
  await expect(detail.getByRole('status').filter({ hasText: '担当者を保存しました。' })).toBeVisible();
  await expect(detail.getByTestId('task-version')).toHaveText(String(version + 1));
  await expect(detail.getByTestId('task-unsaved')).toHaveCount(0);
  await expect(detail.locator('.facts')).toContainText('見本 さくら');
  // The status at the top of the detail.
  await detail.getByRole('region', { name: '状態' }).getByRole('button', { name: '保留', exact: true }).click();
  await expect(detail.getByTestId('task-version')).toHaveText(String(version + 2));
  expect(world.tasks.find((t) => t.id === 'T-101')!.status).toBe('blocked');
  // A member is asked before completing (only officers can reopen).
  await detail.getByRole('region', { name: '状態' }).getByRole('button', { name: '完了', exact: true }).click();
  await expect(detail.getByRole('button', { name: '完了にする' })).toBeFocused();
  await detail.getByRole('button', { name: 'やめる' }).click();
  expect(world.tasks.find((t) => t.id === 'T-101')!.status).toBe('blocked');
  await shot(page, 'task-detail-1440');
});

test('mailbox: list boxes filter at once, the mailbox column lists names and unhandled counts only', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page);
  const inbox = requests(page, /^\/api\/inbox$/);
  await page.goto('/#/all');
  const list = threadList(page);
  await expect(page.getByTestId('thread-count')).toHaveText('全 62 件中 1–20 件');
  const sidebar = page.getByRole('navigation', { name: '受信箱' });
  await expect(sidebar.getByRole('button')).toHaveCount(19);
  await expect(sidebar).not.toContainText('@committee.example');
  await list.getByRole('combobox', { name: '対応状況', exact: true }).selectOption('unhandled');
  const unhandled = world.threads.filter((t) => t.receipts.some((r) => r.triage.status === 'unhandled')).length;
  await expect(page.getByTestId('thread-count')).toHaveText(`全 ${unhandled} 件中 1–${Math.min(20, unhandled)} 件`);
  expect(inbox.at(-1)).toContain('status=unhandled');
  // A mailbox shows its address under its name.
  await sidebar.getByRole('button', { name: /^協賛/ }).click();
  await expect(list.getByRole('heading', { name: '協賛' })).toBeVisible();
  await expect(list).toContainText('sponsorship@committee.example');
  expect(inbox.at(-1)).toContain('mailboxId=sponsorship');
  await shot(page, 'mailbox-1440');
});

test('mail detail: the subject once, one status control, earlier messages folded, the body on the first screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page);
  const thread = world.threads[0]!; // three messages
  await page.goto(`/#/all?thread=${thread.id}`);
  const detail = page.getByRole('region', { name: 'スレッド詳細' });
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText(thread.receipts[0]!.subject);
  await expect(detail.getByText(thread.receipts[0]!.subject, { exact: true })).toHaveCount(1);
  await expect(detail.locator('details.receipt-fold')).toHaveCount(thread.receipts.length - 1);
  await expect(detail.locator('article.receipt')).toHaveCount(1);
  // The newest message is the one open at the top level; earlier ones open inside their fold.
  const form = detail.locator('.thread-detail > article.receipt').getByRole('form', { name: '対応情報の編集' });
  await expect(form.getByLabel('対応状況')).toHaveCount(0);
  await expect(form.getByRole('button', { name: '保存', exact: true })).toBeHidden();
  const body = await detail.locator('.mail-text').boundingBox();
  expect(body!.y).toBeLessThan(900);
  // An earlier message opens with its own handling.
  await detail.locator('details.receipt-fold summary').first().click();
  await expect(detail.locator('article.receipt')).toHaveCount(2);
  // Changing the assignee shows the save button; saving hides it again.
  await form.getByLabel('担当者').selectOption({ label: '試験 一郎' });
  await expect(form.getByText('未保存の変更があります')).toBeVisible();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByText('保存しました。')).toBeVisible();
  await expect(form.getByRole('button', { name: '保存', exact: true })).toBeHidden();
  await shot(page, 'mail-detail-1440');
});

test('at 1024px the mailbox column folds into a choice above the list', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await installWorld(page);
  await page.goto('/#/all');
  await expect(page.getByRole('navigation', { name: '受信箱' })).toBeHidden();
  const choice = threadList(page).getByRole('combobox', { name: '表示する受信箱' });
  await expect(choice).toBeVisible();
  await expect(choice.locator('option[value="m:planning"]')).toHaveText(/^企画（未対応 \d+）$/);
  await choice.selectOption('m:planning');
  await expect(page).toHaveURL(/#\/mailbox\/planning/);
  await expect(threadList(page).getByRole('heading', { name: '企画' })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(1024);
});

test('on a phone the task filters fold under one button and the list comes first', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await installWorld(page);
  await page.goto('/#/tasks?ws=dept-gaimu');
  const pane = taskList(page);
  const toggle = pane.locator('.filters-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(pane.getByRole('group', { name: '表示する状態' })).toBeHidden();
  await expect(pane.locator('[data-task-id]').first()).toBeInViewport();
  await toggle.click();
  await pane.getByRole('button', { name: /^期限超過/ }).click();
  await expect(toggle).toHaveText('絞り込み（1 つ適用中）');
  await toggle.click();
  await expect(pane.getByRole('button', { name: /^期限超過/ })).toBeHidden();
  await expect(pane.locator('.task-list-summary .count')).toContainText('件を表示');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
  await shot(page, 'tasks-375');
});

// Several departments at once (2026-10-25): a part covers its sections.
const GAIMU = ['gaimu', 'shogai', 'koho'];
const NAIMU = ['naimu', 'kikaku', 'kaijo'];
const tagged = (keys: string[]) => (t: { tags?: string[] }) => (t.tags ?? []).some((k) => keys.includes(k));

test('tasks: several departments at once, chosen over the list, with no further request', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { persona: 'officer' });
  const lists = requests(page, TASK_LISTS);
  await page.goto('/#/tasks?ws=dept-gaimu');
  const pane = taskList(page);
  const rows = pane.locator('[data-task-id]');
  const toggle = pane.getByRole('button', { name: /^表示する部局/ });
  await expect(toggle.locator('.department-filter-label')).toHaveText('外務部');
  await expect(rows).toHaveCount(world.tasks.filter(tagged(GAIMU)).length);
  expect(lists).toHaveLength(1);
  // One press opens the departments over the list: the rows do not move.
  const before = await rows.first().boundingBox();
  await toggle.click();
  const panel = pane.getByRole('group', { name: '表示する部局' });
  await expect(panel).toBeVisible();
  expect(await rows.first().boundingBox()).toEqual(before);
  await shot(page, 'tasks-departments-1440');
  const option = (key: string) => panel.locator('.department-filter-option').filter({ has: page.locator(`input[data-department="${key}"]`) });
  const box = (key: string) => panel.locator(`input[data-department="${key}"]`);
  // The sections of a chosen part are in, and say so.
  await expect(box('shogai')).toBeChecked();
  await expect(box('shogai')).toBeDisabled();
  await expect(option('shogai')).toContainText('（外務部に含む）');
  // A count says what choosing that department would show.
  await expect(option('naimu').locator('.option-count')).toHaveText(String(world.tasks.filter(tagged(NAIMU)).length));
  await box('naimu').check();
  await expect(rows).toHaveCount(world.tasks.filter(tagged([...NAIMU, ...GAIMU])).length);
  await expect(page).toHaveURL(/ws=dept-naimu%2Cdept-gaimu/);
  await expect(toggle.locator('.department-filter-label')).toHaveText('内務部・外務部');
  await expect(box('kikaku')).toBeDisabled();
  // Taking a part out takes its sections out too.
  await box('gaimu').uncheck();
  await expect(rows).toHaveCount(world.tasks.filter(tagged(NAIMU)).length);
  await expect(box('shogai')).not.toBeChecked();
  // "だけ表示" shows one department in one press and gives the focus back.
  await panel.getByRole('button', { name: '広報課だけ表示' }).click();
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle.locator('.department-filter-label')).toHaveText('広報課');
  await expect(rows).toHaveCount(world.tasks.filter(tagged(['koho'])).length);
  // The department being viewed is not repeated on its rows; a second department is.
  const metas = await pane.locator('.task-row .row-meta').allInnerTexts();
  expect(metas.some((m) => m.includes('広報課'))).toBe(false);
  expect(metas.some((m) => m.includes('渉外課'))).toBe(true);
  // Escape and a press outside close the choice.
  await toggle.click();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.click();
  await pane.getByRole('heading', { name: 'タスク', exact: true }).click();
  await expect(panel).toBeHidden();
  // Nothing chosen: the list says so and offers every department.
  await toggle.click();
  await panel.getByRole('button', { name: 'すべて外す' }).click();
  await panel.getByRole('button', { name: '閉じる' }).click();
  await expect(toggle.locator('.department-filter-label')).toHaveText('部局を選んでいません');
  await expect(pane.getByText('表示する部局が選ばれていません。')).toBeVisible();
  await pane.getByRole('button', { name: 'すべての部局を表示' }).click();
  await expect(toggle.locator('.department-filter-label')).toHaveText('すべての部局');
  await expect(rows).toHaveCount(world.tasks.length);
  // None of it asked the Task service again.
  expect(lists).toHaveLength(1);
  expect(world.calls.filter((c) => c.startsWith('UNHANDLED'))).toEqual([]);
  // The tasks tab (no department in the link) opens with the last choice made in this browser.
  await toggle.click();
  await panel.getByRole('button', { name: '役員会だけ表示' }).click();
  await page.goto('/#/home');
  await page.goto('/#/tasks');
  await expect(toggle.locator('.department-filter-label')).toHaveText('役員会');
  await expect(rows).toHaveCount(world.tasks.filter(tagged(['yakuin'])).length);
});

test('on a phone the department choice fits the screen and one press shows a department alone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const world = await installWorld(page);
  await page.goto('/#/tasks');
  const pane = taskList(page);
  const toggle = pane.getByRole('button', { name: /^表示する部局/ });
  // A member here sees 外務部 and its sections; with nothing chosen before, all of them (外務部 covers both).
  await expect(toggle.locator('.department-filter-label')).toHaveText('外務部');
  await toggle.click();
  const panel = pane.getByRole('group', { name: '表示する部局' });
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await shot(page, 'tasks-departments-375');
  await panel.getByRole('button', { name: '渉外課だけ表示' }).click();
  await expect(pane.locator('[data-task-id]')).toHaveCount(world.tasks.filter(tagged(['shogai'])).length);
});

test('a new task starts with the departments being viewed, and the list keeps them afterwards', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { persona: 'officer' });
  await page.goto('/#/tasks?ws=dept-kikaku,dept-koho');
  const pane = taskList(page);
  await expect(pane.getByRole('button', { name: /^表示する部局/ }).locator('.department-filter-label')).toHaveText('企画課・広報課');
  await pane.getByRole('button', { name: '＋ 新しいタスク' }).click();
  const form = page.getByRole('form', { name: '新しいタスク' });
  await expect(form.locator('input[data-department="kikaku"]')).toBeChecked();
  await expect(form.locator('input[data-department="koho"]')).toBeChecked();
  await expect(form.locator('input[data-department="naimu"]')).not.toBeChecked();
  await form.getByLabel(/^タイトル/).fill('合成の新しいタスク');
  await form.getByRole('button', { name: '作成する' }).click();
  await expect(page).toHaveURL(/ws=dept-kikaku%2Cdept-koho&task=T-/);
  expect(world.calls).toContain('POST /api/tasks/workspaces/dept-kikaku/tasks');
  expect(world.tasks[0]!.tags).toEqual(['kikaku', 'koho']);
  await expect(pane.locator(`[data-task-id="${world.tasks[0]!.id}"]`)).toBeVisible();
});

test('a Task API without the parts of sections keeps the one-department list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { noParts: true });
  await page.goto('/#/tasks?ws=dept-gaimu');
  await expect(page.getByTestId('task-workspace')).toHaveValue('dept-gaimu');
  await expect(taskList(page).locator('[data-task-id]').first()).toBeVisible();
  await expect(taskList(page).getByRole('button', { name: /^表示する部局/ })).toHaveCount(0);
  // The list by department needs every department in one list, so it is not offered either.
  await expect(taskList(page).getByRole('button', { name: '部局ごと', exact: true })).toHaveCount(0);
  await expect(taskList(page).getByRole('button', { name: '関係図', exact: true })).toHaveCount(0);
  expect(world.calls).toContain('GET /api/tasks/workspaces/dept-gaimu/tasks');
  expect(world.calls.filter((c) => c.includes('/api/tasks/all'))).toEqual([]);
});

// Parent tasks (2026-10-25): a project with its children right under it.
/** The list's rows in order: a task ID, ">" for a child, "~" for a project shown only for its children, "bar" for a children bar. */
const rowOrder = (page: Page) =>
  taskList(page)
    .locator('ul.task-list > li')
    .evaluateAll((items) =>
      items.map((li) =>
        li.classList.contains('task-children-bar')
          ? 'bar'
          : `${li.querySelector('[data-task-id]')?.getAttribute('data-task-id') ?? '?'}${li.classList.contains('task-child') ? '>' : ''}${li.classList.contains('task-context') ? '~' : ''}`,
      ),
    );
const taskRow = (page: Page, id: string) => taskList(page).locator('li.task-row', { has: page.locator(`[data-task-id="${id}"]`) });
const titleOf = (world: { tasks: { id: string; title: string }[] }, id: string) => world.tasks.find((t) => t.id === id)!.title;

test('parent tasks: children sit under their project, fold away, and a project outside the choice comes dimmed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { persona: 'officer', nested: true });
  const lists = requests(page, TASK_LISTS);
  await page.goto('/#/tasks?ws=dept-gaimu');
  const pane = taskList(page);
  await expect(pane.locator('[data-task-id="T-101"]')).toBeVisible();
  await page.waitForLoadState('networkidle');
  const fetched = lists.length;
  const rows = await rowOrder(page);
  const at = rows.indexOf('T-101');
  expect(rows[at + 1]).toBe('bar');
  expect(rows.slice(at + 2, at + 5).sort()).toEqual(['T-108>', 'T-110>', 'T-130>']);
  await expect(taskRow(page, 'T-101')).toContainText('子タスク 1/3 完了');
  // 施設使用報告書 (総務部) is not in 外務部, but its child is tagged 渉外課: shown dimmed, without buttons.
  expect(rows[rows.indexOf('T-104~') + 1]).toBe('bar');
  expect(rows[rows.indexOf('T-104~') + 2]).toBe('T-122>');
  await expect(taskRow(page, 'T-104')).toContainText('条件外（子タスクのため表示）');
  await expect(taskRow(page, 'T-104').getByRole('button', { name: '保留', exact: true })).toHaveCount(0);
  // The count is of the chosen tasks; the dimmed project is not one of them.
  await expect(pane.locator('.task-list-summary .count')).toHaveText(`${world.tasks.filter(tagged(['gaimu', 'shogai', 'koho'])).length} 件`);
  // A project folds its children away and back.
  const project = titleOf(world, 'T-101');
  const toggle = pane.getByRole('button', { name: `「${project}」の子タスク 3 件`, exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  const folded = pane.getByRole('button', { name: `「${project}」の子タスク 3 件を表示`, exact: true });
  await expect(folded).toHaveAttribute('aria-expanded', 'false');
  await expect(pane.locator('[data-task-id="T-108"]')).toHaveCount(0);
  await folded.click();
  await expect(pane.locator('[data-task-id="T-108"]')).toBeVisible();
  // A child left out by the filters is counted on the bar.
  await pane.locator('input[data-status="done"]').uncheck();
  await expect(pane.locator('[data-task-id="T-130"]')).toHaveCount(0);
  await expect(pane.getByRole('button', { name: `「${project}」の子タスク 2 件（ほか 1 件は条件外）`, exact: true })).toBeVisible();
  expect(lists).toHaveLength(fetched);
  await shot(page, 'tasks-nested-1440');
});

test('parent tasks in the detail: a project lists its children, a child links back, and a new child starts under it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { nested: true });
  await page.goto('/#/tasks?ws=dept-gaimu&task=T-101');
  const detail = page.getByRole('region', { name: 'タスク詳細', exact: true });
  const kids = detail.getByRole('region', { name: '子タスク' });
  await expect(kids.locator('li')).toHaveCount(3);
  await expect(kids.locator('.section-label')).toContainText('1/3 完了');
  // A project cannot go under another (one level), and says why.
  await expect(detail.locator('#task-parent')).toBeDisabled();
  await expect(detail.locator('#task-parent-hint')).toHaveText('子タスクがあるタスクは、ほかのタスクの下に入れられません（親子は 1 段までです）。');
  await shot(page, 'task-detail-project-1440');
  // A child links back to its project; its parent choice leaves out children and itself.
  await kids.getByRole('button', { name: titleOf(world, 'T-108'), exact: true }).click();
  await expect(page).toHaveURL(/task=T-108/);
  await expect(detail.getByRole('region', { name: '子タスク' })).toHaveCount(0);
  await expect(detail.locator('#task-parent')).toHaveValue('T-101');
  const offered = await detail.locator('#task-parent option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(offered).toContain('T-125');
  for (const id of ['T-108', 'T-110', 'T-130', 'T-122']) expect(offered).not.toContain(id);
  await detail.locator('.facts').getByRole('button', { name: new RegExp(titleOf(world, 'T-101')) }).click();
  await expect(page).toHaveURL(/task=T-101/);
  // A new child: its project and the project's departments are already chosen.
  await detail.getByRole('button', { name: '＋ 子タスクを追加' }).click();
  const form = page.getByRole('form', { name: '新しいタスク' });
  await expect(form.getByLabel('親タスク（任意）', { exact: true })).toHaveValue('T-101');
  await expect(form.locator('input[data-department="shogai"]')).toBeChecked();
  await form.getByLabel(/^タイトル/).fill('合成の子タスク');
  await form.getByRole('button', { name: '作成する' }).click();
  await expect(page).toHaveURL(/task=T-153/);
  const created = world.tasks[0]!;
  expect(created.id).toBe('T-153');
  expect(created.parentId).toBe('T-101');
  expect(world.calls.filter((c) => c.startsWith('POST /api/tasks/workspaces/'))).toEqual(['POST /api/tasks/workspaces/dept-shogai/tasks']);
  await expect(taskList(page).getByRole('button', { name: `「${titleOf(world, 'T-101')}」の子タスク 4 件`, exact: true })).toBeVisible();
  await expect(detail.locator('.facts')).toContainText('親タスク');
});

test('completing a project with open children says they stay open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { nested: true });
  await page.goto('/#/tasks?ws=dept-gaimu');
  const row = taskRow(page, 'T-101');
  await row.getByRole('button', { name: '完了', exact: true }).click();
  await expect(row.locator('.task-done-confirm')).toContainText('未完了の子タスクが 2 件あります（子タスクは完了になりません）。');
  await row.getByRole('button', { name: '完了にする' }).click();
  await expect(taskList(page).getByRole('status').filter({ hasText: 'を完了にしました。未完了の子タスクが 2 件あります' })).toBeVisible();
  expect(world.tasks.find((t) => t.id === 'T-101')!.status).toBe('done');
  expect(world.tasks.find((t) => t.id === 'T-108')!.status).toBe('in_progress');
});

test('an officer completing a project in the detail is told its children stay open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { persona: 'officer', nested: true });
  await page.goto('/#/tasks?ws=dept-gaimu&task=T-101');
  const detail = page.getByRole('region', { name: 'タスク詳細', exact: true });
  await expect(detail.getByRole('region', { name: '子タスク' }).locator('li')).toHaveCount(3);
  await detail.getByRole('region', { name: '状態' }).getByRole('button', { name: '完了', exact: true }).click();
  await expect(detail.getByRole('status').filter({ hasText: '状態（完了）を保存しました。未完了の子タスクが 2 件あります' })).toBeVisible();
  expect(world.tasks.find((t) => t.id === 'T-101')!.status).toBe('done');
});

test('a parent the Task API refuses says which rule it was; an allowed one moves the task under its project', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { nested: true });
  // 広報課: a department this member can edit.
  await page.goto('/#/tasks?ws=dept-gaimu&task=T-121');
  const detail = page.getByRole('region', { name: 'タスク詳細', exact: true });
  await detail.locator('#task-parent').selectOption('T-116');
  // Meanwhile someone else put that task under another project.
  world.tasks.find((t) => t.id === 'T-116')!.parentId = 'T-125';
  await detail.getByRole('button', { name: '親タスクを保存' }).click();
  await expect(detail.getByRole('alert')).toContainText('その親タスクにはできません。親子は 1 段までです');
  expect(world.tasks.find((t) => t.id === 'T-121')!.parentId).toBeNull();
  await detail.locator('#task-parent').selectOption('T-125');
  await detail.getByRole('button', { name: '親タスクを保存' }).click();
  await expect(detail.getByRole('status').filter({ hasText: '親タスクを保存しました。' })).toBeVisible();
  expect(world.tasks.find((t) => t.id === 'T-121')!.parentId).toBe('T-125');
  await expect(taskList(page).getByRole('button', { name: `「${titleOf(world, 'T-125')}」の子タスク 2 件`, exact: true })).toBeVisible();
  const rows = await rowOrder(page);
  const at = rows.indexOf('T-125');
  expect(rows.slice(at + 2, at + 4).sort()).toEqual(['T-116>', 'T-121>']);
});

test('on a phone the children stay indented under their project without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await installWorld(page, { nested: true });
  await page.goto('/#/tasks?ws=dept-gaimu');
  const pane = taskList(page);
  const parent = pane.locator('[data-task-id="T-101"]');
  const child = pane.locator('[data-task-id="T-108"]');
  await expect(child).toBeVisible();
  const left = (l: typeof child) => l.evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft));
  expect(await left(child)).toBeGreaterThan(await left(parent));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await parent.scrollIntoViewIfNeeded();
  await shot(page, 'tasks-nested-375');
});

test('helpers in the detail: they wait for an assignee, save with it, and leave when made the assignee', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { helping: true });
  const task = () => world.tasks.find((t) => t.id === 'T-121')!;
  expect(task().assigneeId).toBeNull();
  // 広報課: a department this member can edit.
  await page.goto('/#/tasks?ws=dept-gaimu&task=T-121');
  const detail = page.getByRole('region', { name: 'タスク詳細', exact: true });
  await expect(detail.locator('.facts')).toContainText('主担当');
  await expect(detail.locator('#task-helpers')).toBeDisabled();
  await expect(detail.locator('#task-helpers-hint')).toHaveText('副担当は、主担当を決めると付けられます。');
  await detail.locator('#task-assignee').selectOption({ label: '試験 一郎' });
  // The assignee is not offered as a helper.
  await expect(detail.locator('#task-helpers option', { hasText: '試験 一郎' })).toHaveCount(0);
  await detail.locator('#task-helpers').selectOption({ label: '見本 さくら' });
  await detail.locator('#task-helpers').selectOption({ label: '例示 美咲' });
  await expect(detail.getByRole('list', { name: '副担当' }).locator('li')).toHaveText([/見本 さくら/, /例示 美咲/]);
  await detail.getByRole('button', { name: '担当を保存' }).click();
  await expect(detail.getByRole('status').filter({ hasText: '担当を保存しました。' })).toBeVisible();
  expect([task().assignee?.displayName, task().helpers?.map((h) => h.displayName)]).toEqual(['試験 一郎', ['見本 さくら', '例示 美咲']]);
  await expect(taskRow(page, 'T-121')).toContainText('担当: 試験 一郎（副 見本 さくら、例示 美咲）');
  await expect(detail.locator('.facts')).toContainText('見本 さくら、例示 美咲');
  await shot(page, 'task-detail-helpers-1440');
  // A helper made the assignee leaves the helpers; × removes one.
  await detail.locator('#task-assignee').selectOption({ label: '見本 さくら' });
  await expect(detail.getByRole('list', { name: '副担当' }).locator('li')).toHaveText([/例示 美咲/]);
  await detail.getByRole('button', { name: '例示 美咲を副担当から外す' }).click();
  await expect(detail.getByRole('list', { name: '副担当' })).toHaveCount(0);
  await detail.getByRole('button', { name: '担当を保存' }).click();
  await expect.poll(() => [task().assignee?.displayName, task().helperIds]).toEqual(['見本 さくら', []]);
  expect(world.calls.filter((c) => c.startsWith('UNHANDLED'))).toEqual([]);
});

test('my own tasks include the ones I help on, and the row names the helpers', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { helping: true });
  await page.goto('/#/tasks?ws=dept-gaimu');
  const pane = taskList(page);
  // T-101: 合成 太郎 with 合成 花子 (this member) and two more helping.
  await expect(taskRow(page, 'T-101')).toContainText('担当: 合成 太郎（副 合成 花子、試験 一郎 ほか 1 人）');
  const gaimu = (t: (typeof world.tasks)[number]) => (t.tags ?? []).some((k) => ['gaimu', 'shogai', 'koho'].includes(k));
  const mine = world.tasks.filter((t) => gaimu(t) && (t.assignee?.displayName === '合成 花子' || t.helpers?.some((h) => h.displayName === '合成 花子')));
  const mineAsMain = mine.filter((t) => t.assignee?.displayName === '合成 花子');
  expect(mine.length).toBeGreaterThan(mineAsMain.length);
  const chip = pane.getByRole('button', { name: /^自分の担当/ });
  await expect(chip.locator('.option-count')).toHaveText(String(mine.length));
  await chip.click();
  await expect(pane.locator('[data-task-id="T-101"]')).toBeVisible();
  await expect(page.getByTestId('department-overview')).toContainText('副担当のタスクも数えています。');
});

test('a new task can start with helpers once it has an assignee', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { persona: 'officer', helping: true });
  await page.goto('/#/tasks?ws=dept-koho');
  await taskList(page).getByRole('button', { name: '＋ 新しいタスク' }).click();
  const form = page.getByRole('form', { name: '新しいタスク' });
  await form.getByLabel(/^タイトル/).fill('合成の分担タスク');
  await expect(form.locator('#create-helpers')).toBeDisabled();
  await form.locator('#create-assignee').selectOption({ label: '仮名 次郎' });
  await form.locator('#create-helpers').selectOption({ label: '模擬 結衣' });
  await form.getByRole('button', { name: '作成する' }).click();
  await expect(page).toHaveURL(/task=T-153/);
  expect([world.tasks[0]!.assignee?.displayName, world.tasks[0]!.helpers?.map((h) => h.displayName)]).toEqual(['仮名 次郎', ['模擬 結衣']]);
});

test('a Task API without helpers keeps the single assignee', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page);
  await page.goto('/#/tasks?ws=dept-gaimu&task=T-121');
  const detail = page.getByRole('region', { name: 'タスク詳細', exact: true });
  await expect(detail.getByLabel('担当者', { exact: true })).toBeVisible();
  await expect(detail.locator('#task-helpers')).toHaveCount(0);
  await detail.getByLabel('担当者', { exact: true }).selectOption({ label: '試験 一郎' });
  await detail.getByRole('button', { name: '担当者を保存' }).click();
  await expect.poll(() => world.tasks.find((t) => t.id === 'T-121')!.assignee?.displayName).toBe('試験 一郎');
  expect(world.tasks.find((t) => t.id === 'T-121')!).not.toHaveProperty('helperIds');
});

test('on a phone the helpers wrap inside the detail without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await installWorld(page, { helping: true });
  await page.goto('/#/tasks?ws=dept-gaimu&task=T-101');
  const detail = page.getByRole('region', { name: 'タスク詳細', exact: true });
  await expect(detail.getByRole('list', { name: '副担当' }).locator('li')).toHaveCount(3);
  const remove = detail.getByRole('button', { name: /を副担当から外す$/ }).first();
  const box = (await remove.boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(32);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await detail.locator('#task-helpers').scrollIntoViewIfNeeded();
  await shot(page, 'task-detail-helpers-375');
});

// The list by department (2026-10-28): a heading per department, sections inside their part.
const tree = (page: Page) => taskList(page).getByTestId('task-tree');
/** A department in the tree: its heading, its own rows and its sections. */
const node = (page: Page, key: string) => tree(page).locator(`li.task-tree-node[data-department="${key}"]`);
const heading = (page: Page, name: string, level: number) => taskList(page).getByRole('heading', { name: new RegExp(`^${name} `), level });
/** A department's own rows in order, written as rowOrder does. */
const nodeRows = (page: Page, key: string) =>
  node(page, key)
    .locator(':scope > ul.task-tree-rows > li')
    .evaluateAll((items) =>
      items.map((li) =>
        li.classList.contains('task-children-bar')
          ? 'bar'
          : `${li.querySelector('[data-task-id]')?.getAttribute('data-task-id') ?? '?'}${li.classList.contains('task-child') ? '>' : ''}${li.classList.contains('task-context') ? '~' : ''}`,
      ),
    );

test('by department: each department heads its own tasks, sections sit inside their part, and nothing is fetched again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { persona: 'officer', nested: true });
  const lists = requests(page, TASK_LISTS);
  await page.goto('/#/tasks');
  const pane = taskList(page);
  await expect(pane.locator('[data-task-id]').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  const fetched = lists.length;
  const byDepartment = pane.getByRole('button', { name: '部局ごと', exact: true });
  await byDepartment.click();
  await expect(byDepartment).toHaveAttribute('aria-pressed', 'true');
  await expect(pane.getByTestId('task-list')).toHaveCount(0);
  // A part's heading counts its sections' tasks too, each task once; a section is a level down, inside it.
  await expect(heading(page, '総務部', 2)).toContainText(`${world.tasks.filter(tagged(['somu', 'kaikei', 'system'])).length} 件`);
  await expect(heading(page, '会計課', 3)).toContainText(`${world.tasks.filter(tagged(['kaikei'])).length} 件`);
  await expect(node(page, 'somu').locator('li.task-tree-node[data-department="kaikei"]')).toHaveCount(1);
  // The count above the tree is of the tasks, not of their places.
  await expect(pane.locator('.task-list-summary .count')).toHaveText(`${world.tasks.length} 件`);
  // A task with two departments is under both, and the department it is under is not repeated on its row.
  await expect(node(page, 'kaikei').locator('[data-task-id="T-102"]')).toHaveCount(1);
  await expect(node(page, 'shogai').locator('[data-task-id="T-102"]')).toHaveCount(1);
  const copy = (key: string, id: string) => node(page, key).locator('li.task-row', { has: page.locator(`[data-task-id="${id}"]`) });
  await expect(copy('kaikei', 'T-102').locator('.row-meta')).toContainText('渉外課');
  await expect(copy('kaikei', 'T-102').locator('.row-meta')).not.toContainText('会計課');
  // Children sit under their project in each of their departments; the bar counts those under another one.
  const project = titleOf(world, 'T-101');
  const shogai = await nodeRows(page, 'shogai');
  expect(shogai.slice(shogai.indexOf('T-101'), shogai.indexOf('T-101') + 3)).toEqual(['T-101', 'bar', 'T-130>']);
  await expect(node(page, 'shogai').getByRole('button', { name: `「${project}」の子タスク 1 件（ほか 2 件は別の部局）`, exact: true })).toBeVisible();
  // Under 広報課 the project (渉外課) is dimmed and says where it is.
  const koho = await nodeRows(page, 'koho');
  expect(koho[koho.indexOf('T-101~') + 1]).toBe('bar');
  expect(koho.slice(koho.indexOf('T-101~') + 2, koho.indexOf('T-101~') + 4).sort()).toEqual(['T-108>', 'T-110>']);
  await expect(copy('koho', 'T-101')).toContainText('渉外課のタスク（子タスクのため表示）');
  await expect(copy('koho', 'T-101').getByRole('button', { name: '保留', exact: true })).toHaveCount(0);
  await expect(copy('shogai', 'T-104')).toContainText('総務部のタスク（子タスクのため表示）');
  // A status set on one copy shows on the other at once.
  await copy('kaikei', 'T-102').getByRole('button', { name: '保留', exact: true }).click();
  await expect(copy('shogai', 'T-102').getByRole('button', { name: '保留', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await tree(page).scrollIntoViewIfNeeded();
  await pane.evaluate((e) => e.scrollTo(0, 0));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'tasks-tree-1440');
  // A department folds away; the rest stay.
  const kaikei = heading(page, '会計課', 3).getByRole('button');
  await kaikei.click();
  await expect(kaikei).toHaveAttribute('aria-expanded', 'false');
  await expect(node(page, 'kaikei').locator('[data-task-id]')).toHaveCount(0);
  await expect(node(page, 'shogai').locator('[data-task-id="T-102"]')).toHaveCount(1);
  // One press folds every department, leaving the headings and their counts; one more opens them.
  await pane.getByRole('button', { name: 'すべてたたむ', exact: true }).click();
  await expect(tree(page).locator('[data-task-id]')).toHaveCount(0);
  for (const name of ['総務部', '内務部', '外務部', '役員会']) await expect(heading(page, name, 2).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await shot(page, 'tasks-tree-folded-1440');
  await pane.getByRole('button', { name: 'すべて開く', exact: true }).click();
  await expect(node(page, 'kaikei').locator('[data-task-id="T-102"]')).toHaveCount(1);
  expect(lists).toHaveLength(fetched);
  expect(world.calls.filter((c) => c.startsWith('UNHANDLED'))).toEqual([]);
  // The view and the folded departments are kept in this browser; 一覧 goes back to the plain list.
  await kaikei.click();
  await page.reload();
  await expect(byDepartment).toHaveAttribute('aria-pressed', 'true');
  await expect(heading(page, '会計課', 3).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await pane.getByRole('button', { name: '一覧', exact: true }).click();
  await expect(pane.getByTestId('task-tree')).toHaveCount(0);
  await expect(pane.getByTestId('task-list').locator('[data-task-id="T-102"]')).toHaveCount(1);
});

test('by department: the filters and the department choice shape the tree, and an empty department stays as a heading', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { persona: 'officer', nested: true });
  await page.goto('/#/tasks?ws=dept-gaimu');
  const pane = taskList(page);
  await pane.getByRole('button', { name: '部局ごと', exact: true }).click();
  // Only the chosen departments: 外務部 with its two sections.
  await expect(tree(page).locator(':scope > li')).toHaveCount(1);
  await expect(node(page, 'gaimu').locator('li.task-tree-node')).toHaveCount(2);
  // The search leaves 広報課 with nothing: its heading stays, says 0 件 and has nothing to open.
  await pane.getByRole('searchbox', { name: 'タスクを検索' }).fill('台帳');
  const matching = world.tasks.filter((t) => t.title.includes('台帳'));
  await expect(pane.locator('.task-list-summary .count')).toHaveText(`${matching.length} 件を表示`);
  await expect(heading(page, '渉外課', 3)).toContainText(`${matching.length} 件`);
  await expect(heading(page, '広報課', 3)).toContainText('0 件');
  await expect(heading(page, '広報課', 3).getByRole('button')).toHaveCount(0);
  // A heading folds with the keyboard too.
  const shogai = heading(page, '渉外課', 3).getByRole('button');
  await shogai.focus();
  await page.keyboard.press('Enter');
  await expect(shogai).toHaveAttribute('aria-expanded', 'false');
  await expect(shogai).toBeFocused();
  await page.keyboard.press('Space');
  await expect(shogai).toHaveAttribute('aria-expanded', 'true');
  // A filter counts the overdue tasks on each heading.
  await pane.getByRole('searchbox', { name: 'タスクを検索' }).fill('');
  const overdue = world.tasks.filter((t) => tagged(GAIMU)(t) && t.status !== 'done' && t.deadline !== null && t.deadline < TODAY).length;
  expect(overdue).toBeGreaterThan(0);
  await expect(heading(page, '外務部', 2)).toContainText(`期限超過 ${overdue}`);
  await pane.getByRole('button', { name: /^期限超過/ }).click();
  await expect(tree(page).locator('li.task-row')).not.toHaveCount(0);
  for (const id of await tree(page).locator('li.task-row:not(.task-context) [data-task-id]').evaluateAll((e) => e.map((x) => x.getAttribute('data-task-id')))) {
    const t = world.tasks.find((x) => x.id === id)!;
    expect(t.deadline! < TODAY && t.status !== 'done').toBe(true);
  }
});

test('by department on a phone: the switch fits, sections are indented, and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await installWorld(page, { nested: true });
  await page.goto('/#/tasks');
  const pane = taskList(page);
  await pane.getByRole('button', { name: '部局ごと', exact: true }).click();
  await expect(heading(page, '渉外課', 3)).toBeVisible();
  const left = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!.x;
  const partHead = heading(page, '外務部', 2);
  const sectionHead = heading(page, '渉外課', 3);
  const sectionRow = node(page, 'shogai').locator('li.task-row').first();
  expect(await left(sectionHead)).toBeGreaterThan(await left(partHead));
  expect(await left(sectionRow)).toBeGreaterThan(await left(sectionHead));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const bar = (await pane.locator('.task-list-summary').boundingBox())!;
  expect(bar.x + bar.width).toBeLessThanOrEqual(375);
  await shot(page, 'tasks-tree-375');
});

// The connections view (2026-10-28): departments, tasks and projects in three columns with lines between.
const bowtie = (page: Page) => taskList(page).getByTestId('task-bowtie');
const column = (page: Page, name: string) => bowtie(page).getByRole('list', { name, exact: true });
const link = (page: Page, key: string) => bowtie(page).locator(`path[data-link="${key}"]`);
const box = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!;
/** The column's nodes do not overlap, top to bottom. */
async function apart(l: ReturnType<Page['locator']>) {
  const boxes = await l.evaluateAll((items) => items.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom - 0.5);
}

test('connections: departments on the left, tasks in the middle, projects on the right, and a department brings its lines forward', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { persona: 'officer', nested: true });
  const lists = requests(page, TASK_LISTS);
  await page.goto('/#/tasks');
  const pane = taskList(page);
  await expect(pane.locator('[data-task-id]').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  const fetched = lists.length;
  const view = pane.getByRole('button', { name: '関係図', exact: true });
  await view.click();
  await expect(view).toHaveAttribute('aria-pressed', 'true');
  await expect(pane.getByTestId('task-list')).toHaveCount(0);
  await expect(pane.getByTestId('task-tree')).toHaveCount(0);
  // The projects with children are on the right, every other task once in the middle.
  const projects = world.tasks.filter((t) => world.tasks.some((c) => c.parentId === t.id));
  await expect(column(page, '親タスク').locator('[data-task-id]')).toHaveCount(projects.length);
  await expect(column(page, 'タスク').locator('[data-task-id]')).toHaveCount(world.tasks.length - projects.length);
  await expect(column(page, '親タスク').locator('[data-task-id="T-101"]')).toContainText('子 1/3 完了');
  // Three columns side by side, each top to bottom without overlaps.
  const [d, t, p] = [await box(column(page, '部局')), await box(column(page, 'タスク')), await box(column(page, '親タスク'))];
  expect(d.x + d.width).toBeLessThan(t.x);
  expect(t.x + t.width).toBeLessThan(p.x);
  for (const name of ['部局', 'タスク', '親タスク']) await apart(column(page, name).locator(':scope > li'));
  // A task with two departments has a line from each; a child a line to its project, which sits level with its children.
  await expect(link(page, 'kaikei>T-102')).toHaveCount(1);
  await expect(link(page, 'shogai>T-102')).toHaveCount(1);
  for (const id of ['T-108', 'T-110', 'T-130']) await expect(link(page, `${id}>T-101`)).toHaveCount(1);
  const children = await Promise.all(['T-108', 'T-110', 'T-130'].map(async (id) => box(column(page, 'タスク').locator(`[data-task-id="${id}"]`))));
  const project = await box(column(page, '親タスク').locator('[data-task-id="T-101"]'));
  const middle = children.reduce((sum, b) => sum + b.y + b.height / 2, 0) / children.length;
  expect(Math.abs(project.y + project.height / 2 - middle)).toBeLessThan(2);
  // A part counts its sections' tasks too, each once, as in the tree.
  await expect(column(page, '部局').getByRole('button', { name: /^外務部 / })).toHaveText(`外務部 ${world.tasks.filter((x) => tagged(GAIMU)(x) && !projects.includes(x)).length} 件`);
  await pane.evaluate((e) => e.scrollTo(0, 0));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'tasks-bowtie-1440');
  // A department pressed brings forward its lines and their tasks and projects; pressed again, all are even.
  const shogai = column(page, '部局').getByRole('button', { name: /^渉外課 / });
  await shogai.click();
  await expect(shogai).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(0, 0);
  await expect(bowtie(page)).toHaveClass(/has-focus/);
  await expect(link(page, 'shogai>T-102')).toHaveClass(/is-related/);
  await expect(link(page, 'kaikei>T-102')).not.toHaveClass(/is-related/);
  await expect(link(page, 'T-130>T-101')).toHaveClass(/is-related/);
  await expect(column(page, '親タスク').locator('li', { has: page.locator('[data-task-id="T-101"]') })).toHaveClass(/is-related/);
  await expect(column(page, 'タスク').locator('li', { has: page.locator('[data-task-id="T-102"]') })).toHaveClass(/is-related/);
  await shot(page, 'tasks-bowtie-traced-1440');
  await shogai.click();
  await expect(shogai).toHaveAttribute('aria-pressed', 'false');
  await expect(bowtie(page)).not.toHaveClass(/has-focus/);
  // With the keyboard: Enter presses a department, Space lets it go.
  await shogai.focus();
  await page.keyboard.press('Enter');
  await expect(shogai).toHaveAttribute('aria-pressed', 'true');
  await expect(link(page, 'shogai>T-102')).toHaveClass(/is-related/);
  await page.keyboard.press('Space');
  await expect(shogai).toHaveAttribute('aria-pressed', 'false');
  await shogai.blur();
  await expect(bowtie(page)).not.toHaveClass(/has-focus/);
  // A task opens its detail and shows its own lines.
  await column(page, 'タスク').locator('[data-task-id="T-102"]').click();
  await expect(page).toHaveURL(/task=T-102/);
  await expect(column(page, 'タスク').locator('[data-task-id="T-102"]')).toHaveAttribute('aria-current', 'true');
  await expect(link(page, 'kaikei>T-102')).toHaveClass(/is-related/);
  await expect(link(page, 'T-130>T-101')).not.toHaveClass(/is-related/);
  expect(lists).toHaveLength(fetched);
  expect(world.calls.filter((c) => c.startsWith('UNHANDLED'))).toEqual([]);
  // The view is kept in this browser; the filters shape it as they shape the list.
  await page.reload();
  await expect(view).toHaveAttribute('aria-pressed', 'true');
  await pane.getByRole('searchbox', { name: 'タスクを検索' }).fill('お礼状');
  const matching = world.tasks.filter((x) => x.title.includes('お礼状'));
  await expect(pane.locator('.task-list-summary .count')).toHaveText(`${matching.length} 件を表示`);
  await expect(bowtie(page).locator('[data-task-id]')).toHaveCount(new Set([...matching.map((x) => x.id), ...matching.flatMap((x) => (x.parentId ? [x.parentId] : []))]).size);
  await pane.getByRole('button', { name: '一覧', exact: true }).click();
  await expect(pane.getByTestId('task-bowtie')).toHaveCount(0);
  await expect(pane.getByTestId('task-list').locator(`[data-task-id="${matching[0]!.id}"]`)).toHaveCount(1);
});

test('connections on a phone: the three columns fit, nothing scrolls sideways, and a task opens', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await installWorld(page, { nested: true });
  await page.goto('/#/tasks');
  const pane = taskList(page);
  await pane.getByRole('button', { name: '関係図', exact: true }).click();
  await expect(column(page, '親タスク').locator('[data-task-id="T-101"]')).toBeVisible();
  const [d, t, p] = [await box(column(page, '部局')), await box(column(page, 'タスク')), await box(column(page, '親タスク'))];
  expect(d.x).toBeGreaterThanOrEqual(0);
  expect(d.x + d.width).toBeLessThan(t.x);
  expect(t.x + t.width).toBeLessThan(p.x);
  expect(p.x + p.width).toBeLessThanOrEqual(375);
  expect(t.width).toBeGreaterThanOrEqual(120);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const bar = (await pane.locator('.task-list-summary').boundingBox())!;
  expect(bar.x + bar.width).toBeLessThanOrEqual(375);
  // The status left out of sight is still read with the task.
  await expect(column(page, 'タスク').locator('[data-task-id="T-102"]')).toHaveAccessibleName(/^(未着手|進行中|保留|完了) /);
  await shot(page, 'tasks-bowtie-375');
  await column(page, 'タスク').locator('[data-task-id="T-102"]').click();
  await expect(page).toHaveURL(/task=T-102/);
  await expect(page.getByRole('region', { name: 'タスク詳細', exact: true }).getByRole('heading', { level: 2 })).toBeVisible();
});

test('temporary staff are sent to the rental screen (and to the item they were reading)', async ({ page }) => {
  await page.route('**/rental**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>rental</title><p>rental</p>' }));
  await page.route('**/i/IY-**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>item</title><p>item</p>' }));
  await page.route('**/api/**', (route) =>
    route.fulfill({ json: { demoAuthentication: false, authMode: 'discord', user: { id: 'iy-900001', displayName: '臨時 スタッフ', roleLabel: '臨時スタッフ', canManageAccess: false }, account: { initialLoginId: 'iy-900001', studentId: null, departments: [], temporaryStaff: true, signIn: { previousLoginAt: null, failedSince: 0 } }, degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 1 } }),
  );
  await page.goto('/#/home');
  await expect(page).toHaveURL(/\/rental$/);
  // The rental screen saved where to come back to before sending the person to sign in.
  await page.evaluate(() => sessionStorage.setItem('iyakusai-return', '/i/IY-TEST-0001'));
  await page.goto('/#/home');
  await expect(page).toHaveURL(/\/i\/IY-TEST-0001$/);
});
