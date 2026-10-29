import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { CROSS } from '../../playwright.cross.config.js';
import { expect, test } from '../e2e/fixtures.js';

// CROSS-SYSTEM gate over actual loopback services: real Task service (protected mode, synthetic
// state) + the common Web entry (demo personas on CROSS.mail, account mock on CROSS.account).
// The "Discord" side is the MOCK transport: signed svc-auth/v1 requests with the per-run bridge key,
// exactly as the operator's Bot bridge would send them. No real Discord is contacted.

const TASK = `http://127.0.0.1:${CROSS.task}`;
const MAIL = `http://127.0.0.1:${CROSS.mail}`;
const ACCOUNT = `http://127.0.0.1:${CROSS.account}`;
const UNAVAILABLE = `http://127.0.0.1:${CROSS.unavailable}`;
const GUILD = '1000000000000000001';
const CHANNEL = { planning: '1000000000000000101', publicity: '1000000000000000102' };
const DISCORD = { chairA: '1000000000000001001', memberA1: '1000000000000001002', memberA2: '1000000000000001003', observerA: '1000000000000001004', memberB1: '1000000000000001007' };

let interaction = BigInt(Date.now()) * 1000n;
const nextInteraction = () => String((interaction += 1n));

/** MOCK Discord transport: what the operator's verified Bot bridge would send. */
async function discord(userId: string, channelId: string, command: Record<string, unknown>, interactionId = nextInteraction()) {
  const key = Buffer.from(readFileSync('.tmp/cross/discord-bridge.key', 'utf8').trim(), 'base64url');
  const path = '/api/integration/v1/discord/commands';
  const body = JSON.stringify({ interactionId, guildId: GUILD, channelId, userId, command });
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString('base64url');
  const canonical = ['svc-auth/v1', 'discord-bridge', 'POST', path, timestamp, nonce, '', createHash('sha256').update(body).digest('hex')].join('\n');
  const res = await fetch(`${TASK}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-svc-client': 'discord-bridge',
      'x-svc-timestamp': timestamp,
      'x-svc-nonce': nonce,
      'x-svc-signature': createHmac('sha256', key).update(canonical).digest('hex'),
    },
    body,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: (await res.json()) as any };
}

async function persona(page: Page, userId: string, base = MAIL) {
  await page.context().clearCookies();
  expect((await page.request.post(`${base}/api/session`, { data: { userId } })).ok()).toBe(true);
}

async function firstThread(request: APIRequestContext, mailboxId: string) {
  const res = await request.get(`${MAIL}/api/threads?mailboxId=${mailboxId}`);
  expect(res.ok()).toBe(true);
  const thread = (await res.json()).items[0] as { threadId: string; subject: string };
  const detail = await (await request.get(`${MAIL}/api/threads/${thread.threadId}`)).json();
  return { threadId: thread.threadId, subject: thread.subject, receiptId: detail.receipts[0].receiptId as string };
}

const caseBody = (extra: Record<string, unknown> = {}) => ({
  clientOperationId: randomUUID(),
  workspaceId: 'ws-planning',
  title: '受信案件の対応',
  assigneeId: null,
  deadline: null,
  requirements: { purpose: '', deliverable: '', completionCriteria: '', openQuestions: '' },
  ...extra,
});

test.beforeAll(async () => {
  for (const url of [`${MAIL}/api/health`, `${UNAVAILABLE}/api/health`, `${ACCOUNT}/api/health`]) {
    await expect.poll(async () => (await fetch(url).catch(() => null))?.status ?? 0, { timeout: 30_000 }).toBe(200);
  }
});

test('mail case -> assigned task in the common UI; mock Discord changes the SAME task; Web shows the same ID, state and history', async ({ page }) => {
  await persona(page, 'u-editor-a');
  const thread = await firstThread(page.request, 'mbx-support');
  await page.goto(`/#/mailbox/mbx-support?thread=${thread.threadId}`);
  const caseTasks = page.getByTestId('case-tasks').first();
  await caseTasks.getByRole('button', { name: 'この案件からタスクを作成' }).click();
  const form = caseTasks.getByRole('form', { name: '受信案件からタスクを作成' });
  await expect(form.getByTestId('case-task-workspace')).toHaveValue('ws-planning');
  // Only active members of the selected committee are offered (no other committee, no inactive member).
  const options = await form.locator('#case-task-assignee option').allTextContents();
  expect(options).toContain('委員 A2');
  expect(options).not.toContain('委員 B1');
  expect(options.join()).not.toContain('旧委員 A3');
  await form.locator('#case-task-assignee').selectOption({ label: '委員 A2' });
  await expect(form.getByLabel('タイトル')).toHaveValue('受信案件の対応');
  await form.getByLabel('タイトル').fill('問い合わせへの返信方針を決める');
  await form.getByLabel('期限（任意）').fill('2026-12-01');
  await form.getByLabel('目的').fill('返信の担当と方針をそろえる');
  await form.getByLabel('成果物').fill('返信案');
  await form.getByLabel('完了条件').fill('委員 A2 が返信案を共有した');
  await form.getByLabel('不明点').fill('返信期限の確認');
  await form.getByRole('button', { name: 'タスクを作成' }).click();
  await expect(caseTasks.getByText(/タスクを作成しました/)).toBeVisible();
  const link = caseTasks.locator('[data-linked-task]');
  await expect(link).toHaveCount(1);
  const taskId = (await link.getAttribute('data-linked-task'))!;

  await link.click();
  await expect(page).toHaveURL(new RegExp(`#/tasks\\?ws=ws-planning&task=${taskId}`));
  const detail = page.getByTestId('task-detail');
  await expect(detail.getByTestId('task-id')).toHaveText(taskId);
  await expect(detail.getByTestId('task-version')).toHaveText('1');
  await expect(detail.getByRole('region', { name: '元の受信案件' })).toContainText(thread.subject);
  await expect(detail.locator('#task-assignee')).toHaveValue('user-member-a2');
  // The subject was not copied into task fields.
  const stored = await (await page.request.get(`${MAIL}/api/tasks/${taskId}`)).json();
  expect(JSON.stringify(stored.task)).not.toContain(thread.subject);
  await expect(page.getByTestId('task-history').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('task-history')).toContainText('（Web）');

  // A Discord mutation without the displayed version is refused before anything is read or changed.
  const unversioned = await discord(DISCORD.memberA2, CHANNEL.planning, { name: 'status', taskId, to: 'in_progress' });
  expect(unversioned.status).toBe(400);
  expect(unversioned.json.error.code).toBe('VALIDATION');
  expect(unversioned.json.task).toBeUndefined();
  // Mock Discord transport changes the status of that same task at its current version.
  const viaDiscord = await discord(DISCORD.memberA2, CHANNEL.planning, { name: 'status', taskId, to: 'in_progress', version: 1 });
  expect(viaDiscord.status).toBe(200);
  expect(viaDiscord.json.task).toMatchObject({ id: taskId, status: 'in_progress', version: 2 });
  await page.reload();
  await expect(detail.getByTestId('task-version')).toHaveText('2');
  await expect(detail.locator('select').filter({ hasText: '進行中' }).first()).toHaveValue('in_progress');
  await expect(page.getByTestId('task-history').locator('li').first()).toContainText('（Discord）');

  // Web edits with a stale version after another Discord change: conflict, reload, then success.
  expect((await discord(DISCORD.memberA1, CHANNEL.planning, { name: 'assign', taskId, assignee: 'me', version: 2 })).json.task.version).toBe(3);
  await detail.getByLabel('期限', { exact: true }).fill('2026-12-15');
  await detail.getByRole('button', { name: '期限を保存' }).click();
  await expect(detail.getByRole('alert')).toContainText('他の操作で先に更新されています');
  await detail.getByRole('button', { name: '最新の内容を読み込む' }).click();
  await expect(detail.getByTestId('task-version')).toHaveText('3');
  await expect(detail.locator('#task-assignee')).toHaveValue('user-member-a1');
  await detail.getByLabel('期限', { exact: true }).fill('2026-12-15');
  await detail.getByRole('button', { name: '期限を保存' }).click();
  await expect(detail.getByTestId('task-version')).toHaveText('4');
  // Requirements and reopen through the common UI; Discord sees the same state.
  await detail.getByLabel('不明点').fill('期限は確認済み');
  await detail.getByRole('button', { name: '不明点を保存' }).click();
  await expect(detail.getByTestId('task-version')).toHaveText('5');
  const shown = await discord(DISCORD.observerA, CHANNEL.planning, { name: 'show', taskId });
  expect(shown.json.task).toMatchObject({ id: taskId, version: 5, deadline: '2026-12-15', requirements: { openQuestions: '期限は確認済み' } });
  // Task list in the common UI lists it under the same ID.
  await page.getByTestId('nav-tasks').click();
  await expect(page.getByTestId('task-list').locator(`[data-task-id="${taskId}"]`)).toBeVisible();
});

test('task-only reader sees task fields without any source metadata; revocation hides provenance even from the creator', async ({ page }) => {
  await persona(page, 'u-editor-a');
  const thread = await firstThread(page.request, 'mbx-support');
  const created = await page.request.post(`${MAIL}/api/cases/mail/${thread.receiptId}/tasks`, { data: caseBody({ title: '問い合わせの整理' }) });
  expect(created.status()).toBe(201);
  const taskId = (await created.json()).task.id as string;

  await persona(page, 'u-noaccess-d');
  const raw = await page.request.get(`${MAIL}/api/tasks/${taskId}`);
  const rawText = await raw.text();
  expect(raw.status()).toBe(200);
  for (const hidden of [thread.subject, thread.receiptId, thread.threadId, 'mbx-support']) expect(rawText).not.toContain(hidden);
  await page.goto(`/#/tasks?ws=ws-planning&task=${taskId}`);
  await expect(page.getByTestId('task-id')).toHaveText(taskId);
  await expect(page.getByRole('region', { name: '元の受信案件' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(thread.subject);
  // The case itself is not reachable for this user.
  expect((await page.request.get(`${MAIL}/api/cases/mail/${thread.receiptId}/tasks`)).status()).toBe(404);

  await persona(page, 'u-admin');
  const matrix = await (await page.request.get(`${MAIL}/api/admin/access`)).json();
  expect((await page.request.put(`${MAIL}/api/admin/access`, { data: { userId: 'u-editor-a', mailboxId: 'mbx-support', level: 'none', expectedVersion: matrix.version } })).ok()).toBe(true);
  await persona(page, 'u-editor-a');
  await page.goto(`/#/tasks?ws=ws-planning&task=${taskId}`);
  await expect(page.getByTestId('task-id')).toHaveText(taskId);
  await expect(page.getByRole('region', { name: '元の受信案件' })).toHaveCount(0);
  expect(await (await page.request.get(`${MAIL}/api/tasks/${taskId}`)).text()).not.toContain(thread.subject);
  // Restore the sample grant for the remaining tests.
  await persona(page, 'u-admin');
  const after = await (await page.request.get(`${MAIL}/api/admin/access`)).json();
  expect((await page.request.put(`${MAIL}/api/admin/access`, { data: { userId: 'u-editor-a', mailboxId: 'mbx-support', level: 'edit', expectedVersion: after.version } })).ok()).toBe(true);
});

test('duplicate, concurrent and changed submissions; cancelled creation creates nothing; cross-committee and inbox-only users are refused', async ({ page }) => {
  await persona(page, 'u-editor-a');
  const thread = await firstThread(page.request, 'mbx-support');
  const count = async () => ((await (await page.request.get(`${MAIL}/api/tasks/workspaces/ws-planning/tasks`)).json()) as unknown[]).length;
  const before = await count();
  const body = caseBody({ title: '重複確認' });
  const results = await Promise.all([1, 2, 3].map(() => page.request.post(`${MAIL}/api/cases/mail/${thread.receiptId}/tasks`, { data: body })));
  expect(results.map((r) => r.status()).sort()).toEqual([200, 200, 201]);
  expect(new Set(await Promise.all(results.map(async (r) => (await r.json()).task.id))).size).toBe(1);
  expect(await count()).toBe(before + 1);
  const changed = await page.request.post(`${MAIL}/api/cases/mail/${thread.receiptId}/tasks`, { data: { ...body, title: '別の内容' } });
  expect(changed.status()).toBe(409);
  expect(await changed.text()).not.toContain('task-');
  // Assignee from another committee and a committee where the user is only a viewer: refused by the Task service.
  expect((await page.request.post(`${MAIL}/api/cases/mail/${thread.receiptId}/tasks`, { data: caseBody({ assigneeId: 'user-member-b1' }) })).status()).toBe(400);
  expect((await page.request.post(`${MAIL}/api/cases/mail/${thread.receiptId}/tasks`, { data: caseBody({ workspaceId: 'ws-publicity' }) })).status()).toBe(403);
  expect(await count()).toBe(before + 1);

  // Cancel in the browser.
  await page.goto(`/#/mailbox/mbx-support?thread=${thread.threadId}`);
  const caseTasks = page.getByTestId('case-tasks').first();
  await caseTasks.getByRole('button', { name: 'この案件からタスクを作成' }).click();
  await caseTasks.getByRole('form', { name: '受信案件からタスクを作成' }).getByLabel('タイトル').fill('作らないタスク');
  await caseTasks.getByRole('button', { name: 'キャンセル' }).click();
  await expect(caseTasks.getByRole('form')).toHaveCount(0);
  expect(await count()).toBe(before + 1);

  // Inbox-only reader can read the case but has no task identity.
  await persona(page, 'u-viewer-b');
  expect((await page.request.post(`${MAIL}/api/cases/mail/${thread.receiptId}/tasks`, { data: caseBody() })).status()).toBe(403);
  await page.goto('/#/tasks');
  await expect(page.getByTestId('tasks-unbound')).toBeVisible();
});

test('Web and Discord on the same version: one wins, the other is told; Discord replay and channel scope hold', async ({ page }) => {
  await persona(page, 'u-editor-a');
  const created = await page.request.post(`${MAIL}/api/tasks/workspaces/ws-planning/tasks`, { data: { operationId: randomUUID(), title: '同時更新の確認' } });
  const task = (await created.json()).task as { id: string; version: number };
  const [web, bot] = await Promise.all([
    page.request.patch(`${MAIL}/api/tasks/${task.id}`, { data: { expectedVersion: 1, operationId: randomUUID(), changes: { status: 'blocked' } } }),
    discord(DISCORD.memberA2, CHANNEL.planning, { name: 'status', taskId: task.id, to: 'in_progress', version: 1 }),
  ]);
  expect([web.status(), bot.status].sort()).toEqual([200, 409]);
  const history = await (await page.request.get(`${MAIL}/api/tasks/${task.id}/history`)).json();
  expect(history).toHaveLength(2);

  const current = ((await (await page.request.get(`${MAIL}/api/tasks/${task.id}`)).json()).task as { version: number }).version;
  expect(current).toBe(2);
  const id = nextInteraction();
  const deadline = { name: 'deadline', taskId: task.id, date: '2026-11-30', version: current };
  const first = await discord(DISCORD.memberA1, CHANNEL.planning, deadline, id);
  expect(first.status).toBe(200);
  const replay = await discord(DISCORD.memberA1, CHANNEL.planning, deadline, id);
  expect(replay.json).toMatchObject({ replayed: true });
  const crossChannel = await discord(DISCORD.memberA1, CHANNEL.publicity, deadline, id);
  expect(crossChannel.status).toBe(409);
  expect(JSON.stringify(crossChannel.json)).not.toContain(task.id);
  expect((await discord(DISCORD.memberB1, CHANNEL.publicity, { name: 'show', taskId: task.id })).status).toBe(404);
  expect((await discord(DISCORD.observerA, CHANNEL.planning, { name: 'status', taskId: task.id, to: 'done', version: current + 1 })).status).toBe(403);
  // A stale version from Discord is a conflict, not an overwrite.
  const stale = await discord(DISCORD.memberA1, CHANNEL.planning, { name: 'status', taskId: task.id, to: 'done', version: current });
  expect(stale.status).toBe(409);
  expect(stale.json.error.code).toBe('VERSION_CONFLICT');
  expect((await discord('1000000000000009999', CHANNEL.planning, { name: 'list' })).status).toBe(403);
  expect((await (await page.request.get(`${MAIL}/api/tasks/${task.id}/history`)).json()).length).toBe(3);

  // Browser callers cannot reach the Task service as anyone: unsigned and forged-actor requests are refused.
  const forged = await fetch(`${TASK}/api/integration/v1/me`, { headers: { 'x-svc-actor': 'user-chair-a', 'x-svc-client': 'web-gateway', 'x-demo-user': 'user-chair-a' } });
  expect(forged.status).toBe(401);
  expect((await fetch(`${TASK}/api/personas`)).status).toBe(404);
});

test('organization-eligible account user creates a task from a LINE case; inbox ACL and committee scope stay restricted', async ({ page }) => {
  await page.context().clearCookies();
  const write = { origin: ACCOUNT, 'x-smm-csrf': '1' };
  const req = await page.request.post(`${ACCOUNT}/api/auth/setup/request`, { data: { email: 'editor-c@staff.invalid' }, headers: write });
  expect(req.status()).toBe(202);
  const challengeId = (await req.json()).challengeId as string;
  await expect.poll(async () => ((await (await page.request.get(`${ACCOUNT}/api/mock/dm-outbox`)).json()).messages as unknown[]).length).toBeGreaterThan(0);
  const code = ((await (await page.request.get(`${ACCOUNT}/api/mock/dm-outbox`)).json()).messages as { recipientLabel: string; code: string }[]).find((m) => m.recipientLabel === '編集担当C')!.code;
  expect((await page.request.post(`${ACCOUNT}/api/auth/setup/verify`, { data: { challengeId, code }, headers: write })).status()).toBe(200);
  const password = 'synthetic passphrase 42';
  expect((await page.request.post(`${ACCOUNT}/api/auth/setup/password`, { data: { password, confirmation: password }, headers: write })).status()).toBe(200);

  const mailboxes = ((await (await page.request.get(`${ACCOUNT}/api/mailboxes`)).json()) as { id: string }[]).map((m) => m.id).sort();
  expect(mailboxes).toEqual(['mbx-billing', 'mbx-sales']);
  const context = await (await page.request.get(`${ACCOUNT}/api/tasks/context`)).json();
  expect(context.memberships.map((m: { workspace: { id: string } }) => m.workspace.id)).toEqual(['ws-publicity']);

  const inbox = await (await page.request.get(`${ACCOUNT}/api/inbox?source=line`)).json();
  const conv = (inbox.items as { conversationId: string; account: { id: string; kind: string }; title: string }[]).find((i) => i.account.kind === 'official_account')!;
  await page.goto(`${ACCOUNT}/#/line/${conv.account.id}?conv=${conv.conversationId}`);
  const caseTasks = page.getByTestId('case-tasks');
  await caseTasks.getByRole('button', { name: 'この案件からタスクを作成' }).click();
  const form = caseTasks.getByRole('form', { name: '受信案件からタスクを作成' });
  await expect(form.getByTestId('case-task-workspace')).toHaveValue('ws-publicity');
  await form.locator('#case-task-assignee').selectOption({ label: '委員 B1' });
  await form.getByLabel('タイトル').fill('LINE の問い合わせ対応');
  await form.getByRole('button', { name: 'タスクを作成' }).click();
  await expect(caseTasks.getByText(/タスクを作成しました/)).toBeVisible();
  const taskId = (await caseTasks.locator('[data-linked-task]').first().getAttribute('data-linked-task'))!;
  await caseTasks.locator('[data-linked-task]').first().click();
  await expect(page.getByRole('region', { name: '元の受信案件' })).toContainText(conv.title);
  // The publicity member B1 sees it from Discord under the same ID.
  const fromDiscord = await discord(DISCORD.memberB1, CHANNEL.publicity, { name: 'show', taskId });
  expect(fromDiscord.json.task).toMatchObject({ id: taskId, assigneeId: 'user-member-b1' });
  await page.getByRole('button', { name: 'ログアウト' }).click();
  expect((await page.request.get(`${ACCOUNT}/api/tasks/context`)).status()).toBe(401);
});

test('unavailable Task service: the common UI reports it, nothing is guessed, and the submission stays pending', async ({ page }) => {
  await persona(page, 'u-editor-a', UNAVAILABLE);
  await page.goto(`${UNAVAILABLE}/#/tasks`);
  await expect(page.getByRole('alert')).toContainText('タスクの利用状況を読み込めませんでした');
  await expect(page.getByRole('button', { name: '再試行' })).toBeVisible();
  const threads = await (await page.request.get(`${UNAVAILABLE}/api/threads?mailboxId=mbx-support`)).json();
  const detail = await (await page.request.get(`${UNAVAILABLE}/api/threads/${threads.items[0].threadId}`)).json();
  const receiptId = detail.receipts[0].receiptId as string;
  const body = caseBody();
  const res = await page.request.post(`${UNAVAILABLE}/api/cases/mail/${receiptId}/tasks`, { data: body });
  expect(res.status()).toBe(503);
  expect((await res.json()).error).toBe('task_service_unavailable');
  const pending = await (await page.request.get(`${UNAVAILABLE}/api/cases/mail/${receiptId}/tasks`)).json();
  expect(pending).toMatchObject({ unavailable: false, tasks: [], pending: [{ clientOperationId: body.clientOperationId }] });
  // The inbox itself keeps working.
  await page.getByTestId('nav-inbox').click();
  await expect(page.locator('[data-mailbox-id="mbx-support"]')).toBeVisible();
});
