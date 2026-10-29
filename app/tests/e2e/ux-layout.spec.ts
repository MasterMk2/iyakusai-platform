import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { ReceiptView } from '../../src/shared/api.js';
import type { TaskView } from '../../src/shared/tasks.js';
import { expect, test } from './fixtures.js';

// All API data is synthetic and intercepted in the browser. The shared fixture
// rejects any non-loopback request; this suite never opens a live account.
const WIDTHS = [375, 768, 940, 1440];
const FIRST_THREAD = 'th_0000000000000001';
const FIRST_TASK = 'UX-001';
const WORKSPACE = 'dept-soumu';

async function syntheticWorkspace(page: Page, options: { role?: 'viewer' | 'editor' | 'admin'; conflictOnce?: string; writeDelayMs?: number } = {}) {
  const role = options.role ?? 'editor';
  const box = { id: 'contact', name: 'お問い合わせ', address: 'contact@committee.example' };
  const boxes = [box, { id: 'soumu', name: '総務部', address: 'soumu@committee.example' }, { id: 'koho', name: '広報課', address: 'koho@committee.example' }];
  const receipt: ReceiptView = {
    receiptId: 'rc_0000000000000001', threadId: FIRST_THREAD, mailbox: box, mailboxes: [box, boxes[1]!],
    access: 'edit', canEditAssignmentAndLabels: true, canEditStatus: true,
    receivedAt: '2026-10-15T01:20:00Z', subject: '備品搬入の日程と当日の受付について',
    from: { name: 'サンプル商事　窓口担当', address: 'delivery@partner.example' },
    to: [{ name: '医薬祭実行委員会', address: box.address }], cc: [],
    text: '医薬祭実行委員会 ご担当者さま\n\n備品の搬入にあたり、当日の受付方法を確認させてください。\n搬入を担当するスタッフは二名です。到着後に連絡する窓口と、返却時の確認方法をご案内いただけますと幸いです。\n\nよろしくお願いいたします。\nサンプル商事　窓口担当',
    hasHtml: false, sanitizedHtml: null, blockedRemoteResources: 0, attachments: [],
    triage: { version: 1, status: 'unhandled', assignee: null, labels: ['搬入・返却'] }, notes: [], history: [],
  };
  const tasks: TaskView[] = [
    {
      id: FIRST_TASK, workspaceId: WORKSPACE, title: '備品搬入の受付手順を確認する',
      description: '窓口担当者が迷わず案内できるよう、受付の手順を確認する。',
      assigneeId: 'iy-000002', deadline: '2026-10-18', status: 'in_progress',
      requirements: { purpose: '搬入当日に受付が滞らないようにする。', deliverable: '当日の受付手順と連絡先の確認メモ', completionCriteria: '関係する担当者の確認が取れている。', openQuestions: '到着時刻の最終確認' },
      version: 1, createdAt: '2026-10-14T01:00:00Z', createdBy: 'iy-000001', updatedAt: '2026-10-15T01:00:00Z', updatedBy: 'iy-000001',
      assignee: { id: 'iy-000002', displayName: '合成 花子', active: true }, overdue: false, missingRequirements: [], tags: ['soumu'], tagLabels: ['総務部'],
    },
  ];
  tasks.push(
    { ...tasks[0]!, id: 'UX-002', title: '掲示物の最終版を確認する', deadline: '2026-10-20', status: 'todo', assigneeId: null, assignee: null, requirements: { ...tasks[0]!.requirements, openQuestions: '' }, missingRequirements: ['openQuestions'], tags: ['soumu', 'koho'], tagLabels: ['総務部', '広報課'] },
    { ...tasks[0]!, id: 'UX-003', title: '受付で使う予備資材をまとめる', deadline: null, status: 'blocked', tags: ['soumu'], tagLabels: ['総務部'] },
    { ...tasks[0]!, id: 'UX-004', title: '委員向け案内文を共有する', deadline: '2026-10-16', status: 'done', tags: ['soumu'], tagLabels: ['総務部'] },
  );
  const mailPatches: Record<string, unknown>[] = [];
  const taskPatches: Record<string, unknown>[] = [];
  // Every task write in order, e.g. 'patch UX-002 {"status":"in_progress"}' or 'reopen UX-004 {}'.
  const taskWrites: string[] = [];
  const unexpected: string[] = [];
  const inboxItems = () => [
    { source: 'email', threadId: receipt.threadId, mailbox: box, mailboxes: receipt.mailboxes, subject: receipt.subject, latestReceivedAt: receipt.receivedAt, receiptCount: 1, matchCount: 1, snippet: '当日の受付方法と、返却時の確認方法についてのお問い合わせです。', senders: ['サンプル商事'], statuses: [receipt.triage.status], labels: receipt.triage.labels, assignees: receipt.triage.assignee ? [receipt.triage.assignee.displayName] : [], canSetStatus: true },
    { source: 'email', threadId: 'th_0000000000000002', mailbox: boxes[2], mailboxes: [boxes[2]], subject: '来場者向け案内の掲載内容の確認', latestReceivedAt: '2026-10-15T00:00:00Z', receiptCount: 2, matchCount: 2, snippet: '掲載する案内文の確認をお願いいたします。', senders: ['サンプル制作室'], statuses: ['in_progress'], labels: ['広報'], assignees: ['合成 花子'], canSetStatus: true },
    { source: 'email', threadId: 'th_0000000000000003', mailbox: boxes[1], mailboxes: [boxes[1]], subject: '資料を受け取りました', latestReceivedAt: '2026-10-14T07:40:00Z', receiptCount: 1, matchCount: 1, snippet: '資料の送付ありがとうございました。内容を確認します。', senders: ['サンプル協力団体'], statuses: ['done'], labels: [], assignees: [], canSetStatus: true },
  ];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/api/session') return respond({ demoAuthentication: false, authMode: 'discord', user: { id: 'iy-000001', displayName: '合成 太郎', roleLabel: '委員', canManageAccess: false }, account: { initialLoginId: 'iy-000001', studentId: '21000001', departments: [], signIn: { previousLoginAt: null, failedSince: 0 } }, degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 14 });
    if (path === '/api/mail/status') return respond({ enabled: true, canOpen: true, reauthRequired: false, idleHours: 12, unhandledTotal: 1 });
    // Sending is not set up on this synthetic server (no reply or new-mail buttons).
    if (path === '/api/mail/send/options') return respond({ enabled: false, from: [], fromName: '', bcc: null, maxAttachmentBytes: 0, maxRecipients: 0, senderName: '合成 太郎' });
    // Committee contacts (2026-10-26): the thread asks once which senders are contacts; none here.
    if (path === '/api/contacts/by-address') return respond([]);
    if (path === '/api/mailboxes') return respond(boxes.map((b, i) => ({ ...b, access: 'edit', threadCount: i ? 1 : 3, unhandledCount: i ? 0 : 1 })));
    if (path === '/api/tasks/context') return respond({ enabled: true, bound: true, tagging: true, memberships: [{ workspace: { id: WORKSPACE, name: '総務部', description: '' }, role }, { workspace: { id: 'dept-koho', name: '広報課', description: '' }, role }] });
    if (path === '/api/rental/me') return respond({ permissions: [] });
    if (path === '/api/line/accounts') return respond([]);
    if (path === '/api/inbox/labels') return respond([{ label: '搬入・返却', count: 1 }, { label: '広報', count: 1 }]);
    if (path === '/api/inbox') return respond({ items: inboxItems(), total: 3, page: 1, pageSize: 5, counts: { email: 3, line: 0 }, lineEnabled: false });
    if (path === `/api/threads/${FIRST_THREAD}`) return respond({ threadId: FIRST_THREAD, mailbox: box, mailboxes: receipt.mailboxes, subject: receipt.subject, receipts: [receipt] });
    if (path === `/api/receipts/${receipt.receiptId}/assignees`) return respond([{ id: 'iy-000002', displayName: '合成 花子' }]);
    if (path === `/api/receipts/${receipt.receiptId}/triage` && request.method() === 'PATCH') {
      const body = request.postDataJSON() as { expectedVersion: number; assigneeId?: string | null; labels?: string[] };
      mailPatches.push(body);
      if (body.expectedVersion !== receipt.triage.version) return respond({ error: 'conflict', current: receipt.triage }, 409);
      receipt.triage = { ...receipt.triage, version: receipt.triage.version + 1, ...(body.labels ? { labels: body.labels } : {}), ...('assigneeId' in body ? { assignee: body.assigneeId ? { id: body.assigneeId, displayName: '合成 花子', hasMailboxAccess: true } : null } : {}) };
      return respond(receipt.triage);
    }
    if (path === `/api/cases/mail/${receipt.receiptId}/tasks`) return respond({ canCreate: false, tasks: [{ id: FIRST_TASK, title: tasks[0]!.title, status: tasks[0]!.status, workspaceId: WORKSPACE }], pending: [], unavailable: false });
    if (/^\/api\/tasks\/workspaces\/[^/]+\/members$/.test(path)) return respond([{ userId: 'iy-000001', displayName: '合成 太郎', role: 'editor', active: true }, { userId: 'iy-000002', displayName: '合成 花子', role: 'editor', active: true }]);
    if (/^\/api\/tasks\/workspaces\/[^/]+\/tasks$/.test(path)) return respond(tasks);
    if (path === `/api/tasks/${FIRST_TASK}/history`) return respond([{ id: 'ux-history-1', version: 1, action: 'created', actorName: '合成 太郎', at: tasks[0]!.createdAt, source: 'web', displayChanges: [{ field: 'title', before: null, after: tasks[0]!.title }] }]);
    const write = /^\/api\/tasks\/(UX-\d{3})(\/reopen)?$/.exec(path);
    const i = write ? tasks.findIndex(t => t.id === write[1]) : -1;
    const conflict = { error: 'version_conflict', message: '他の委員が更新しました。' };
    // Reopening, as the Task service does it: officers only, done tasks only, back to to-do.
    if (write?.[2] && i >= 0 && request.method() === 'POST') {
      const body = request.postDataJSON() as { expectedVersion: number; operationId: string };
      taskWrites.push(`reopen ${write[1]} {}`);
      if (role !== 'admin') return respond({ error: 'forbidden', message: '再開できるのは役員だけです。' }, 403);
      if (body.expectedVersion !== tasks[i]!.version) return respond(conflict, 409);
      if (tasks[i]!.status !== 'done') return respond({ error: 'invalid_transition', message: '再開できるのは完了したタスクだけです。' }, 400);
      tasks[i] = { ...tasks[i]!, status: 'todo', version: tasks[i]!.version + 1 };
      return respond({ task: tasks[i], replayed: false });
    }
    if (write && !write[2] && i >= 0 && request.method() === 'PATCH') {
      const body = request.postDataJSON() as { expectedVersion: number; changes: Partial<TaskView>; operationId: string };
      taskPatches.push(body);
      // A slow Task service: the answer comes after the given time.
      if (options.writeDelayMs) await new Promise(r => setTimeout(r, options.writeDelayMs));
      taskWrites.push(`patch ${write[1]} ${JSON.stringify(body.changes)}`);
      if (options.conflictOnce === write[1]) {
        // Another member saved first.
        options.conflictOnce = undefined;
        tasks[i] = { ...tasks[i]!, version: tasks[i]!.version + 1 };
        return respond(conflict, 409);
      }
      if (body.expectedVersion !== tasks[i]!.version) return respond(conflict, 409);
      if (tasks[i]!.status === 'done' && body.changes.status && body.changes.status !== 'done') return respond({ error: 'invalid_transition', message: '完了したタスクは「再開」操作で未着手に戻してから変更してください。' }, 400);
      const requirements = { ...tasks[i]!.requirements };
      for (const field of ['purpose', 'deliverable', 'completionCriteria', 'openQuestions'] as const) {
        const value = (body.changes as Record<string, unknown>)[field];
        if (typeof value === 'string') requirements[field] = value.trim();
      }
      tasks[i] = { ...tasks[i]!, ...body.changes, ...(typeof body.changes.title === 'string' ? { title: body.changes.title.trim() } : {}), requirements, version: tasks[i]!.version + 1 };
      return respond({ task: tasks[i], replayed: false });
    }
    if (path === `/api/tasks/${FIRST_TASK}`) return respond({ task: tasks[0], provenance: [{ kind: 'mail', label: receipt.subject, href: `#/all?thread=${FIRST_THREAD}` }] });
    unexpected.push(`${request.method()} ${path}`);
    return respond({ error: 'not_found' }, 404);
  });
  return { receipt, tasks, mailPatches, taskPatches, taskWrites, unexpected };
}

// Query strings of the task list requests, to show a status change costs no list request.
function listRequests(page: Page) {
  const seen: string[] = [];
  page.on('request', r => { const url = new URL(r.url()); if (/^\/api\/tasks\/workspaces\/[^/]+\/tasks$/.test(url.pathname)) seen.push(url.search); });
  return seen;
}

async function settleAndCheck(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const size = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(size.content, 'the page does not overflow horizontally').toBeLessThanOrEqual(size.viewport);
  const overflowingPanels = await page.locator('.list-pane, .detail-pane, .task-fields-section, .handling').evaluateAll(panels => panels
    .filter(panel => panel.getClientRects().length > 0 && panel.scrollWidth > panel.clientWidth + 1)
    .map(panel => ({ classes: panel.className, content: panel.scrollWidth, viewport: panel.clientWidth })));
  expect(overflowingPanels, 'visible content panels do not hide horizontal overflow').toEqual([]);
}

async function shot(page: Page, name: string) {
  await settleAndCheck(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: `.tmp/ux-${name}.png`, fullPage: true, animations: 'disabled' });
}

for (const width of WIDTHS) {
  test(`mail list, handling save and return at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await syntheticWorkspace(page);
    await page.goto('/#/all');
    const list = page.getByRole('region', { name: 'スレッド一覧', exact: true });
    await expect(list.getByRole('button', { name: new RegExp(state.receipt.subject) })).toBeVisible();
    await shot(page, `mail-list-${width}`);
    await list.getByRole('button', { name: new RegExp(state.receipt.subject) }).click();
    const detail = page.getByRole('region', { name: 'スレッド詳細', exact: true });
    const form = detail.getByRole('form', { name: '対応情報の編集' });
    await expect(form).toBeVisible();
    await expect(detail.locator('.mail-text')).toContainText('搬入を担当するスタッフは二名です。');
    await shot(page, `mail-detail-${width}`);
    await form.getByRole('combobox', { name: '担当者', exact: true }).selectOption('iy-000002');
    await form.getByLabel('追加するラベル').fill('受付確認');
    await form.getByRole('button', { name: '追加', exact: true }).click();
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(form.getByText('保存しました。')).toBeVisible();
    expect(state.mailPatches).toEqual([{ expectedVersion: 1, assigneeId: 'iy-000002', labels: ['搬入・返却', '受付確認'] }]);
    await settleAndCheck(page);
    const back = detail.getByRole('button', { name: /一覧に戻る/ });
    if (await back.isVisible()) await back.click();
    else {
      await expect(list).toBeVisible();
      await page.goto('/#/all');
    }
    await expect(page).toHaveURL(/#\/all$/);
    await expect(list).toBeVisible();
    await list.getByRole('button', { name: new RegExp(state.receipt.subject) }).click();
    await expect(form.getByRole('combobox', { name: '担当者', exact: true })).toHaveValue('iy-000002');
    await expect(form.getByLabel('ラベル「受付確認」を外す')).toBeVisible();
    expect(state.unexpected).toEqual([]);
  });

  test(`task list, one-field save and return at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await syntheticWorkspace(page);
    await page.goto(`/#/tasks?ws=${WORKSPACE}`);
    const row = page.locator(`[data-task-id="${FIRST_TASK}"]`);
    await expect(row).toBeVisible();
    await shot(page, `task-list-${width}`);
    await row.click();
    const detail = page.getByRole('region', { name: 'タスク詳細', exact: true });
    await expect(detail.getByTestId('task-version')).toHaveText('1');
    await expect(detail.getByLabel('タイトル', { exact: true })).toHaveValue(state.tasks[0]!.title);
    await shot(page, `task-detail-${width}`);
    const title = '備品搬入の受付手順を担当者へ共有する';
    await detail.getByLabel('タイトル', { exact: true }).fill(title);
    await detail.getByRole('button', { name: 'タイトルを保存', exact: true }).click();
    await expect(detail.getByRole('status').filter({ hasText: 'タイトルを保存しました。' })).toBeVisible();
    await expect(detail.getByTestId('task-version')).toHaveText('2');
    expect(state.taskPatches).toHaveLength(1);
    expect(state.taskPatches[0]).toMatchObject({ expectedVersion: 1, changes: { title } });
    expect(state.taskPatches[0]!.operationId).toEqual(expect.any(String));
    expect(Object.keys(state.taskPatches[0]!.changes as object)).toEqual(['title']);
    await settleAndCheck(page);
    const back = detail.getByRole('button', { name: /一覧に戻る/ });
    if (await back.isVisible()) await back.click();
    else {
      await expect(page.getByRole('region', { name: 'タスク一覧', exact: true })).toBeVisible();
      await page.goto(`/#/tasks?ws=${WORKSPACE}`);
    }
    await expect(page).toHaveURL(new RegExp(`#/tasks\\?ws=${WORKSPACE}$`));
    await expect(row).toContainText(title);
    expect(state.unexpected).toEqual([]);
  });
}

for (const width of [375, 1440]) {
  test(`task status filter shows several statuses at once at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await syntheticWorkspace(page);
    const listRequests: string[] = [];
    page.on('request', r => { const url = new URL(r.url()); if (/^\/api\/tasks\/workspaces\/[^/]+\/tasks$/.test(url.pathname)) listRequests.push(url.search); });
    await page.goto(`/#/tasks?ws=${WORKSPACE}`);
    const pane = page.getByRole('region', { name: 'タスク一覧', exact: true });
    const statuses = pane.getByRole('group', { name: '表示する状態' });
    const rows = pane.locator('[data-task-id]');
    const all = ['未着手', '進行中', '保留', '完了'];
    await expect(rows).toHaveCount(4);
    // Phones fold the filters under one button; wider screens show them.
    const toggle = pane.locator('.filters-toggle');
    if (await toggle.isVisible()) {
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
    for (const name of all) await expect(statuses.getByRole('checkbox', { name, exact: true })).toBeChecked();
    await expect(pane.getByRole('button', { name: '絞り込みを解除' })).toHaveCount(0);
    const fetched = listRequests.length;
    // Everything but done is one tap on its label.
    await statuses.getByText('完了', { exact: true }).click();
    await expect(rows).toHaveCount(3);
    await expect(pane.locator('[data-task-id="UX-004"]')).toHaveCount(0);
    await expect(pane.locator('.task-list-summary .count')).toHaveText('3 件を表示');
    // Two statuses at once: to-do and on hold.
    await statuses.getByText('進行中', { exact: true }).click();
    await expect(rows).toHaveCount(2);
    await expect(pane.locator('[data-task-id="UX-002"]')).toBeVisible();
    await expect(pane.locator('[data-task-id="UX-003"]')).toBeVisible();
    await shot(page, `task-status-filter-${width}`);
    // With nothing chosen the list says why it is empty, and clearing brings every status back.
    await statuses.getByText('未着手', { exact: true }).click();
    await statuses.getByText('保留', { exact: true }).click();
    await expect(rows).toHaveCount(0);
    await expect(pane.getByText('表示する状態が選ばれていません。見たい状態にチェックを入れてください。')).toBeVisible();
    await pane.getByRole('button', { name: '絞り込みを解除' }).click();
    await expect(rows).toHaveCount(4);
    for (const name of all) await expect(statuses.getByRole('checkbox', { name, exact: true })).toBeChecked();
    // Statuses are applied to the fetched list: no new request, and the status never reaches the Task service.
    expect(listRequests).toHaveLength(fetched);
    // Assignee and deadline (2026-10-25) work the same way: the unassigned task only, still no request.
    await pane.getByRole('button', { name: /^未割当/ }).click();
    await expect(rows).toHaveCount(1);
    await expect(pane.locator('[data-task-id="UX-002"]')).toBeVisible();
    await pane.getByRole('button', { name: /^未割当/ }).click();
    await pane.getByRole('combobox', { name: '担当者で絞り込み' }).selectOption('iy-000002');
    await expect(rows).toHaveCount(3);
    await pane.getByRole('button', { name: /^期限なし/ }).click();
    await expect(rows).toHaveCount(1);
    await expect(pane.locator('[data-task-id="UX-003"]')).toBeVisible();
    await pane.getByRole('button', { name: '絞り込みを解除' }).first().click();
    await expect(rows).toHaveCount(4);
    expect(listRequests).toHaveLength(fetched);
    expect(listRequests.every(q => q === '')).toBe(true);
    expect(state.unexpected).toEqual([]);
  });
}

const taskRow = (page: Page, id: string) => page.getByRole('region', { name: 'タスク一覧', exact: true }).locator('li').filter({ has: page.locator(`[data-task-id="${id}"]`) });
const rowButtons = (page: Page, id: string) => taskRow(page, id).getByRole('group', { name: /」の状態$/ });

for (const width of [375, 1440]) {
  test(`a member changes task status from the list and confirms before completing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await syntheticWorkspace(page);
    const lists = listRequests(page);
    await page.goto(`/#/tasks?ws=${WORKSPACE}`);
    const pane = page.getByRole('region', { name: 'タスク一覧', exact: true });
    await expect(pane.locator('[data-task-id]')).toHaveCount(4);
    const fetched = lists.length;
    // One click saves.
    await rowButtons(page, 'UX-002').getByRole('button', { name: '進行中', exact: true }).click();
    await expect(pane.getByRole('status').filter({ hasText: '「掲示物の最終版を確認する」を進行中にしました。' })).toBeVisible();
    await expect(rowButtons(page, 'UX-002').getByRole('button', { name: '進行中', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(taskRow(page, 'UX-002').locator('.row-line')).toContainText('進行中');
    // A member cannot undo a completion, so the row asks first (no browser dialog); "やめる" changes nothing.
    const buttons = rowButtons(page, 'UX-003');
    await buttons.getByRole('button', { name: '完了', exact: true }).click();
    await expect(buttons).toContainText('完了にすると、戻せるのは役員（委員長・副委員長・役員会）だけです。');
    await expect(buttons.getByRole('button', { name: '完了にする', exact: true })).toBeFocused();
    await buttons.getByRole('button', { name: 'やめる', exact: true }).click();
    await expect(buttons.getByRole('button', { name: '完了にする', exact: true })).toHaveCount(0);
    await expect(buttons.getByRole('button', { name: '保留', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(state.taskWrites).toEqual(['patch UX-002 {"status":"in_progress"}']);
    await buttons.getByRole('button', { name: '完了', exact: true }).click();
    await settleAndCheck(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    mkdirSync('.tmp', { recursive: true });
    await page.screenshot({ path: `.tmp/ux-task-row-status-${width}.png`, fullPage: true, animations: 'disabled' });
    await buttons.getByRole('button', { name: '完了にする', exact: true }).click();
    await expect(pane.getByRole('status').filter({ hasText: '「受付で使う予備資材をまとめる」を完了にしました。' })).toBeVisible();
    // A done row has no buttons for a member, and there is no undo.
    await expect(rowButtons(page, 'UX-003')).toHaveCount(0);
    await expect(rowButtons(page, 'UX-004')).toHaveCount(0);
    await expect(pane.getByRole('button', { name: '元に戻す' })).toHaveCount(0);
    expect(lists).toHaveLength(fetched);
    expect(state.taskWrites).toEqual(['patch UX-002 {"status":"in_progress"}', 'patch UX-003 {"status":"done"}']);
    await settleAndCheck(page);
    expect(state.unexpected).toEqual([]);
  });
}

test('an officer completes without a prompt, undoes to the previous status, and reopens a done task', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await syntheticWorkspace(page, { role: 'admin' });
  const lists = listRequests(page);
  await page.goto(`/#/tasks?ws=${WORKSPACE}&task=${FIRST_TASK}`);
  const pane = page.getByRole('region', { name: 'タスク一覧', exact: true });
  const detail = page.getByRole('region', { name: 'タスク詳細', exact: true });
  await expect(detail.getByTestId('task-version')).toHaveText('1');
  const fetched = lists.length;
  await rowButtons(page, FIRST_TASK).getByRole('button', { name: '完了', exact: true }).click();
  // Officers can reopen, so there is no question; the notice offers undo instead.
  await expect(pane.getByRole('status').filter({ hasText: '「備品搬入の受付手順を確認する」を完了にしました。' })).toBeVisible();
  await expect(pane.getByRole('button', { name: '完了にする', exact: true })).toHaveCount(0);
  // The open detail follows the list.
  await expect(detail.getByTestId('task-version')).toHaveText('2');
  // A done row offers officers only reopening.
  await expect(rowButtons(page, FIRST_TASK).getByRole('button')).toHaveText(['再開する（未着手に戻す）']);
  // Undo goes back to in progress, not just to to-do.
  await pane.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(pane.getByRole('status').filter({ hasText: '「備品搬入の受付手順を確認する」を進行中に戻しました。' })).toBeVisible();
  await expect(rowButtons(page, FIRST_TASK).getByRole('button', { name: '進行中', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.getByTestId('task-version')).toHaveText('4');
  // A task that was already done reopens to to-do.
  await rowButtons(page, 'UX-004').getByRole('button', { name: '再開する（未着手に戻す）' }).click();
  await expect(pane.getByRole('status').filter({ hasText: '「委員向け案内文を共有する」を再開しました（未着手）。' })).toBeVisible();
  await expect(rowButtons(page, 'UX-004').getByRole('button', { name: '未着手', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(state.taskWrites).toEqual(['patch UX-001 {"status":"done"}', 'reopen UX-001 {}', 'patch UX-001 {"status":"in_progress"}', 'reopen UX-004 {}']);
  expect(lists).toHaveLength(fetched);
  expect(state.unexpected).toEqual([]);
});

test('a read-only member sees no status buttons on the rows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await syntheticWorkspace(page, { role: 'viewer' });
  await page.goto(`/#/tasks?ws=${WORKSPACE}`);
  const pane = page.getByRole('region', { name: 'タスク一覧', exact: true });
  await expect(pane.locator('[data-task-id]')).toHaveCount(4);
  await expect(pane.getByRole('group', { name: /」の状態$/ })).toHaveCount(0);
  expect(state.taskWrites).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('a conflicting status change is reported and the list is fetched once to show the newer state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await syntheticWorkspace(page, { conflictOnce: 'UX-002' });
  const lists = listRequests(page);
  await page.goto(`/#/tasks?ws=${WORKSPACE}`);
  const pane = page.getByRole('region', { name: 'タスク一覧', exact: true });
  await expect(pane.locator('[data-task-id]')).toHaveCount(4);
  const fetched = lists.length;
  await rowButtons(page, 'UX-002').getByRole('button', { name: '保留', exact: true }).click();
  await expect(pane.getByRole('alert').filter({ hasText: '変更できませんでした: 他の委員が更新しました。' })).toBeVisible();
  await expect.poll(() => lists.length).toBe(fetched + 1);
  await expect(rowButtons(page, 'UX-002').getByRole('button', { name: '未着手', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // With the newer version the same click saves.
  await rowButtons(page, 'UX-002').getByRole('button', { name: '保留', exact: true }).click();
  await expect(pane.getByRole('status').filter({ hasText: '「掲示物の最終版を確認する」を保留にしました。' })).toBeVisible();
  expect(state.taskPatches.map(p => p.expectedVersion)).toEqual([1, 2]);
  expect(state.unexpected).toEqual([]);
});

test('the home remaining link opens the list with everything but done', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await syntheticWorkspace(page);
  await page.goto(`/#/tasks?ws=${WORKSPACE}&remaining=1`);
  const pane = page.getByRole('region', { name: 'タスク一覧', exact: true });
  const statuses = pane.getByRole('group', { name: '表示する状態' });
  await expect(pane.locator('[data-task-id]')).toHaveCount(3);
  await expect(pane.locator('[data-task-id="UX-004"]')).toHaveCount(0);
  for (const name of ['未着手', '進行中', '保留']) await expect(statuses.getByRole('checkbox', { name, exact: true })).toBeChecked();
  await expect(statuses.getByRole('checkbox', { name: '完了', exact: true })).not.toBeChecked();
  await statuses.getByText('完了', { exact: true }).click();
  await expect(pane.locator('[data-task-id]')).toHaveCount(4);
  expect(state.unexpected).toEqual([]);
});

test('saving one task field preserves another draft and advances its expected version', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await syntheticWorkspace(page);
  await page.goto(`/#/tasks?ws=${WORKSPACE}&task=${FIRST_TASK}`);
  const detail = page.getByRole('region', { name: 'タスク詳細', exact: true });
  const title = '  備品搬入の受付手順を共有する  ';
  const purpose = '  受付と搬入の担当者が同じ手順で案内できるようにする。  ';
  await expect(detail.getByTestId('task-version')).toHaveText('1');
  await detail.getByLabel('タイトル', { exact: true }).fill(title);
  await detail.getByRole('textbox', { name: '目的', exact: true }).fill(purpose);
  await detail.getByRole('button', { name: 'タイトルを保存', exact: true }).click();
  await expect(detail.getByTestId('task-version')).toHaveText('2');
  await expect(detail.getByLabel('タイトル', { exact: true })).toHaveValue(title.trim());
  // A field's save button is there only while the field differs from the saved value.
  await expect(detail.getByRole('button', { name: 'タイトルを保存', exact: true })).toHaveCount(0);
  await expect(detail.getByTestId('task-unsaved')).toContainText('目的');
  await expect(detail.getByRole('textbox', { name: '目的', exact: true })).toHaveValue(purpose);
  await expect(detail.getByRole('button', { name: '目的を保存', exact: true })).toBeEnabled();
  expect(state.taskPatches[0]).toMatchObject({ expectedVersion: 1, changes: { title } });
  expect(Object.keys(state.taskPatches[0]!.changes as object)).toEqual(['title']);
  await detail.getByRole('button', { name: '目的を保存', exact: true }).click();
  await expect(detail.getByTestId('task-version')).toHaveText('3');
  await expect(detail.getByRole('textbox', { name: '目的', exact: true })).toHaveValue(purpose.trim());
  await expect(detail.getByRole('button', { name: '目的を保存', exact: true })).toHaveCount(0);
  await expect(detail.getByTestId('task-unsaved')).toHaveCount(0);
  expect(state.taskPatches[1]).toMatchObject({ expectedVersion: 2, changes: { purpose } });
  expect(Object.keys(state.taskPatches[1]!.changes as object)).toEqual(['purpose']);
  expect(state.taskPatches[0]!.operationId).not.toEqual(state.taskPatches[1]!.operationId);
  expect(state.unexpected).toEqual([]);
});

// 2026-10-26: a slow save waits only on its row or field, the answer is used without a reload, and a failure
// shows where it happened.
test('a slow status save waits only on its row, shows the pressed button at once, and a failure shows on its row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await syntheticWorkspace(page, { writeDelayMs: 1500, conflictOnce: 'UX-003' });
  const lists = listRequests(page);
  await page.goto(`/#/tasks?ws=${WORKSPACE}`);
  const pane = page.getByRole('region', { name: 'タスク一覧', exact: true });
  await expect(pane.locator('[data-task-id]')).toHaveCount(4);
  const fetched = lists.length;
  await rowButtons(page, 'UX-002').getByRole('button', { name: '進行中', exact: true }).click();
  await expect(rowButtons(page, 'UX-002').getByRole('button', { name: '進行中', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 300 });
  await expect(rowButtons(page, 'UX-002')).toContainText('保存中…');
  // The other rows are not stopped.
  await expect(rowButtons(page, 'UX-003').getByRole('button', { name: '未着手', exact: true })).toBeEnabled();
  await rowButtons(page, 'UX-003').getByRole('button', { name: '未着手', exact: true }).click();
  await expect(pane.getByRole('status').filter({ hasText: '「掲示物の最終版を確認する」を進行中にしました。' })).toBeVisible();
  // The refusal shows on its own row, and the button goes back.
  await expect(taskRow(page, 'UX-003').getByRole('alert')).toContainText('変更できませんでした: 他の委員が更新しました。');
  await expect(rowButtons(page, 'UX-003').getByRole('button', { name: '保留', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => lists.length).toBe(fetched + 1);
  expect(state.taskWrites).toEqual(['patch UX-002 {"status":"in_progress"}', 'patch UX-003 {"status":"todo"}']);
  expect(state.unexpected).toEqual([]);
});

test('a slow field save waits only on that field; a second field saves after it with the newer version, without reloads', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await syntheticWorkspace(page, { writeDelayMs: 1200 });
  const lists = listRequests(page);
  const reads = { detail: 0, history: 0 };
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path === `/api/tasks/${FIRST_TASK}` && r.method() === 'GET') reads.detail++;
    if (path === `/api/tasks/${FIRST_TASK}/history`) reads.history++;
  });
  await page.goto(`/#/tasks?ws=${WORKSPACE}&task=${FIRST_TASK}`);
  const detail = page.getByRole('region', { name: 'タスク詳細', exact: true });
  await expect(detail.getByTestId('task-version')).toHaveText('1');
  await expect.poll(() => reads.history).toBe(1);
  const fetched = lists.length;
  await detail.getByLabel('タイトル', { exact: true }).fill('備品搬入の受付手順を共有する');
  await detail.getByRole('textbox', { name: '目的', exact: true }).fill('受付と搬入の担当者が同じ手順で案内できるようにする。');
  await detail.getByRole('button', { name: 'タイトルを保存', exact: true }).click();
  await expect(detail.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled();
  await detail.getByRole('button', { name: '目的を保存', exact: true }).click({ timeout: 500 });
  await expect(detail.getByTestId('task-version')).toHaveText('3');
  await expect(detail.getByRole('status').filter({ hasText: '目的を保存しました。' })).toBeVisible();
  await expect(detail.getByRole('alert')).toHaveCount(0);
  expect(state.taskPatches.map((p) => p.expectedVersion)).toEqual([1, 2]);
  // The answers were used: the detail and the list were not read again; only the history follows.
  await expect.poll(() => reads.history).toBe(3);
  expect(reads.detail).toBe(1);
  expect(lists).toHaveLength(fetched);
  await expect(taskRow(page, FIRST_TASK)).toContainText('備品搬入の受付手順を共有する');
  expect(state.unexpected).toEqual([]);
});
