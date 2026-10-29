import { expect, loginAs, resetSample, test } from './fixtures.js';
import type { TaskSummaryResponse } from '../../src/shared/task-summary.js';
const s: TaskSummaryResponse = {
  today: '2026-10-14', generatedAt: '2026-10-14T01:00:00Z', total: 12,
  deadlines: { overdue: 2, today: 3, tomorrow: 1, upcoming: 2, later: 1, none: 3 },
  departments: [{ workspaceId: 'ws-planning', name: 'サンプル企画委員会', parentId: null, remaining: 7, overdue: 2, today: 3 }, { workspaceId: 'ws-publicity', name: 'サンプル広報委員会', parentId: null, remaining: 5, overdue: 0, today: 0 }],
  byDate: [{ deadline: '2026-10-13', remaining: 2 }, { deadline: '2026-10-14', remaining: 3 }],
};
test.beforeEach(async ({ page }) => { await resetSample(page); await loginAs(page, 'u-editor-a'); });
test('home counts, department link, date detail and phone layout', async ({ page }) => {
  let summaries = 0, lists = 0;
  page.on('request', r => { if (r.url().includes('/workspaces/') && r.url().includes('/tasks')) lists++; });
  await page.route('**/api/tasks/summary', route => { summaries++; return route.fulfill({ json: s }); });
  await page.goto('/#/home');
  const home = page.getByTestId('home-tasks');
  await expect(page.getByTestId('task-remaining-total')).toHaveText('12件');
  await expect(page.getByTestId('task-deadline-overdue')).toHaveText('2件');
  await expect(page.getByTestId('remaining-ws-planning')).toHaveText('7');
  expect(summaries).toBe(1); expect(lists).toBe(0);
  await home.getByText('日付ごとの残数', { exact: true }).click();
  await expect(home.locator('.task-by-date')).toContainText('2026/10/13（火）・期限超過');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(home).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.tmp/home-task-counts-phone.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: '.tmp/home-task-counts-desktop.png', fullPage: true });
  await home.getByRole('link', { name: 'サンプル企画委員会', exact: true }).click();
  const statuses = page.getByRole('group', { name: '表示する状態' });
  for (const name of ['未着手', '進行中', '保留']) await expect(statuses.getByRole('checkbox', { name, exact: true })).toBeChecked();
  await expect(statuses.getByRole('checkbox', { name: '完了', exact: true })).not.toBeChecked();
  await expect(page.getByTestId('task-workspace')).toHaveValue('ws-planning');
  // Rows carry a "完了" status button, so count the status labels instead of searching the text.
  await expect(page.getByTestId('task-list').locator('.chip.task-status-done')).toHaveCount(0);
});
test('failure preserves old counts and exposes retry; refresh retrieves current counts', async ({ page }) => {
  let count = 0;
  await page.route('**/api/tasks/summary', route => {
    count++;
    return count === 2 ? route.fulfill({ status: 503, json: { error: 'task_service_unavailable', message: '再試行してください。' } }) : route.fulfill({ json: { ...s, total: count > 2 ? 11 : 12 } });
  });
  await page.goto('/#/home');
  await expect(page.getByTestId('task-remaining-total')).toHaveText('12件');
  await page.getByRole('button', { name: '最新の状態にする' }).click();
  await expect(page.getByTestId('home-tasks').getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('task-remaining-total')).toHaveText('12件');
  await expect(page.getByTestId('home-tasks')).toContainText('前回取得した件数');
  await page.getByTestId('home-tasks').getByRole('button', { name: '再試行' }).click();
  await expect(page.getByTestId('task-remaining-total')).toHaveText('11件');
});

test('department hierarchy, multi-department explanation and 320px phone', async ({ page }) => {
  const names = [['yakuin','役員会',null],['soumu','総務部',null],['kaikei','会計課','soumu'],['system','システム課','soumu'],['naimu','内務部',null],['kikaku','企画課','naimu'],['kaijo','会場課','naimu'],['gaimu','外務部',null],['koho','広報課','gaimu'],['shogai','渉外課','gaimu']];
  const departments = names.map(([key,name,parent],i) => ({ workspaceId: 'dept-'+key, name: name!, parentId: parent ? 'dept-'+parent : null, remaining: [3,3,2,1,7,4,4,2,1,1][i]!, overdue: i === 6 ? 2 : 0, today: i === 5 ? 3 : 0 }));
  await page.route('**/api/tasks/context', route => route.fulfill({ json: { enabled: true, bound: true, tagging: true, memberships: departments.map(d => ({ workspace: { id: d.workspaceId, name: d.name, description: '' }, role: 'editor' })) } }));
  await page.route('**/api/tasks/summary', route => route.fulfill({ json: { ...s, departments } }));
  await page.goto('/#/home');
  const home = page.getByTestId('home-tasks');
  await page.reload();
  await expect(home).toContainText('部署別');
  await expect(home.locator('.department-child')).toHaveCount(6);
  await expect(home).toContainText('未完了の合計では1件');
  await expect(home.getByRole('link',{name:'システム課',exact:true})).toHaveAttribute('href','#/tasks?ws=dept-system&remaining=1');
  await page.setViewportSize({width:320,height:740});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0,0));
  await page.screenshot({path:'.tmp/home-task-counts-departments-phone.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(() => window.scrollTo(0,0));
  await page.screenshot({path:'.tmp/home-task-counts-departments-desktop.png',fullPage:true});
});
