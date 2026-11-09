import { mkdirSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import type { TaskDraft, TaskDraftItem } from '../../src/shared/assistant.js';
import { expect, test } from './fixtures.js';
import { installWorld } from './redesign-world.js';

// Task drafting (2026-11-09, contract §9) on the task screen: the outline, the wait, the proposal checked and
// corrected, and the chosen tasks created through the ordinary task API (parent first). The task API is the
// synthetic world of tests/e2e/redesign-world.ts; the Bot's draft is answered here, on the page.

const JOB = 'j_00000000000000000042';
const HANAKO = 'discord-900000000000000002';
const ICHIRO = 'discord-900000000000000003';
const SAKURA = 'discord-900000000000000004';

const item = (over: Partial<TaskDraftItem>): TaskDraftItem => ({
  title: '',
  tags: ['kikaku'],
  deadline: null,
  purpose: '',
  deliverable: '',
  completionCriteria: '',
  openQuestions: '',
  assigneeId: null,
  assigneeName: null,
  assigneeBy: null,
  assigneeFacts: '',
  reason: '',
  helperIds: [],
  helperNames: [],
  alternatives: [],
  ...over,
});

const DRAFT: TaskDraft = {
  parent: item({ title: '片付けの段取りを終える', deadline: '2026-11-23', assigneeId: HANAKO, assigneeName: '合成 花子', assigneeBy: 'ai', assigneeFacts: '企画課｜主担当 1・副担当 0', reason: 'まとめ役' }),
  items: [
    item({ title: 'テントを撤去する', deadline: '2026-11-23', completionCriteria: 'テントを返却場所へ', assigneeId: HANAKO, assigneeName: '合成 花子', assigneeBy: 'ai', assigneeFacts: '企画課｜主担当 1・副担当 0', reason: '企画課で、持ちが少ないため', helperIds: [ICHIRO], helperNames: ['試験 一郎'], alternatives: [{ id: ICHIRO, name: '試験 一郎', facts: '企画課｜主担当 2・副担当 0' }] }),
    item({ title: 'ゴミを回収する', tags: ['kaijo'], reason: 'この仕事の部局に合う人が名簿にいないため、担当の案はありません。', alternatives: [{ id: SAKURA, name: '見本 さくら', facts: '会場課｜主担当 0・副担当 1' }] }),
    item({ title: '借りた物品を返す', assigneeId: 'discord-999999999999999999', assigneeName: '名簿にいない人', assigneeBy: 'ai', assigneeFacts: '', reason: '' }),
  ],
  notes: '撤去は日没までに終える前提です。',
  questions: ['ゴミの収集業者を決める'],
  parentTask: null,
  sources: [{ label: '2025医薬祭/会場課/撤収手順.md', excerpt: 'テントは 17 時から撤去' }],
};

interface DraftFake {
  posts: Record<string, unknown>[];
}

async function installDraftFake(page: Page, options: { available?: boolean; fail?: string; draft?: TaskDraft } = {}): Promise<DraftFake> {
  const fake: DraftFake = { posts: [] };
  let polls = 0;
  const job = (state: string, extra: Record<string, unknown> = {}) => ({
    id: JOB, kind: 'taskdraft', op: null, state, actor: { id: 'discord-1', name: '合成 太郎' }, input: {}, progress: null, result: null, error: null,
    discordUrl: null, createdAt: '2026-10-25T10:00:00+09:00', startedAt: null, finishedAt: null, ...extra,
  });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/assistant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/assistant/meta') {
      return json(route, {
        features: { ask: true, doc: true, image: false, remind: true, screening: true, taskdraft: options.available ?? true },
        models: [], docTypes: [], reminderChannels: [], shareChannel: null, isAdmin: false, bot: { alive: true, lastSeenAt: null },
      });
    }
    if (url.pathname === '/api/assistant/taskdraft' && request.method() === 'POST') {
      fake.posts.push(request.postDataJSON() as Record<string, unknown>);
      polls = 0;
      return json(route, { job: job('queued') }, 202);
    }
    if (url.pathname === '/api/assistant/jobs' && url.searchParams.get('kind') === 'taskdraft') return json(route, { jobs: [], next: null });
    if (url.pathname === `/api/assistant/jobs/${JOB}`) {
      polls += 1;
      if (polls === 1) return json(route, { job: job('running', { progress: { phase: 'think', text: 'Bot がタスクの分け方と担当の案を考えています…' } }) });
      if (options.fail) return json(route, { job: job('failed', { error: { code: 'NO_ANSWER', message: options.fail } }) });
      return json(route, { job: job('done', { result: { text: '📝', files: [], draft: options.draft ?? DRAFT } }) });
    }
    return route.fallback();
  });
  return fake;
}

const taskList = (page: Page) => page.getByRole('region', { name: 'タスク一覧' });

async function openDraftForm(page: Page) {
  await taskList(page).getByRole('button', { name: '＋ 新しいタスク' }).click();
  await page.getByRole('group', { name: '作り方' }).getByRole('button', { name: 'Bot に下書きを頼む' }).click();
  return page.getByRole('form', { name: 'Bot に下書きを頼む' });
}

async function shot(page: Page, name: string) {
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: `.tmp/task-draft-${name}.png`, fullPage: true, animations: 'disabled' });
}

test('an outline becomes a checked proposal, and the chosen tasks are created under a new parent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { persona: 'officer', nested: true, helping: true });
  const fake = await installDraftFake(page);
  await page.goto('/#/tasks?ws=dept-kikaku');
  const form = await openDraftForm(page);
  await expect(form.locator('input[data-department="kikaku"]')).toBeChecked();
  await form.getByLabel(/^概略/).fill('11/23 の片付けの段取り。テントの撤去、ゴミの回収、借りた物品の返却まで。');
  await shot(page, 'form-1440');
  await form.getByRole('button', { name: 'Bot に下書きしてもらう' }).click();
  await expect(page.getByTestId('task-draft-progress')).toContainText('分け方と担当の案を考えています');
  expect(fake.posts[0]).toMatchObject({ overview: '11/23 の片付けの段取り。テントの撤去、ゴミの回収、借りた物品の返却まで。', tags: ['kikaku'], useSources: true, deadline: null });
  expect(fake.posts[0]).not.toHaveProperty('parentId');

  const review = page.getByTestId('task-draft-review');
  await expect(review.getByRole('heading', { name: 'Bot の下書き（3 件）' })).toBeVisible();
  await expect(review).toContainText('撤去は日没までに終える前提です。');
  await expect(review.getByRole('region', { name: '決めておくこと' })).toContainText('ゴミの収集業者を決める');
  const rows = review.getByTestId('task-draft-row');
  await expect(rows).toHaveCount(4); // the parent and three tasks
  const [parent, tent, trash, goods] = [rows.nth(0), rows.nth(1), rows.nth(2), rows.nth(3)];
  await expect(parent.locator('> legend')).toHaveText('親タスク（全体のまとめ）');
  // The Bot's proposal is preselected, with the counts and its reason; helpers come along.
  await expect(tent.getByLabel('主担当')).toHaveValue(HANAKO);
  await expect(tent.getByTestId('task-draft-reason')).toHaveText('Bot の案：合成 花子（企画課｜主担当 1・副担当 0）— 企画課で、持ちが少ないため');
  await expect(tent.locator('.chip.helper-chip')).toContainText('試験 一郎');
  // No proposal: the reason and the other candidates, one press away.
  await expect(trash.getByLabel('主担当')).toHaveValue('');
  await expect(trash).toContainText('担当の案はありません。');
  await trash.getByRole('button', { name: /見本 さくら/ }).click();
  await expect(trash.getByLabel('主担当')).toHaveValue(SAKURA);
  // Someone who is not a member is never preselected.
  await expect(goods.getByLabel('主担当')).toHaveValue('');
  await expect(goods.getByTestId('task-draft-reason')).toHaveText('Bot の案（名簿にいない人）はいまの委員の一覧にいないため、選んでいません。');
  // The departments are folded to one line; opening it changes them.
  await expect(trash.locator('.task-draft-tags > summary')).toContainText('部局：会場課');
  await expect(trash.locator('input[data-department="kaijo"]')).toBeHidden();
  await goods.getByLabel('起票する').uncheck();
  await expect(goods.getByLabel('タイトル（必須・120 文字以内）')).toHaveCount(0);
  await tent.getByLabel(/^タイトル/).fill('テントを撤去して返却場所へ運ぶ');
  await shot(page, 'review-1440');

  await review.getByRole('button', { name: '選んだ 3 件を起票する' }).click();
  const done = page.getByTestId('task-draft-done');
  await expect(done.getByRole('heading', { name: '起票しました（3 件）' })).toBeVisible();
  const created = world.tasks.slice(0, 3); // the world puts a new task first
  const [project] = created.filter((t) => t.title === '片付けの段取りを終える');
  expect(project).toBeDefined();
  expect(project!.parentId).toBeNull();
  const children = created.filter((t) => t !== project);
  expect(children.map((t) => t.title).sort()).toEqual(['ゴミを回収する', 'テントを撤去して返却場所へ運ぶ']);
  expect(children.every((t) => t.parentId === project!.id)).toBe(true);
  const tentTask = children.find((t) => t.title.startsWith('テント'))!;
  expect(tentTask.assigneeId).toBe(HANAKO);
  expect(tentTask.helperIds).toEqual([ICHIRO]);
  expect(tentTask.requirements.completionCriteria).toBe('テントを返却場所へ');
  expect(children.find((t) => t.title === 'ゴミを回収する')!.tags).toEqual(['kaijo']);
  // Parent first, then its children: three creations, nothing else.
  expect(world.calls.filter((c) => c.startsWith('POST /api/tasks/workspaces/'))).toEqual([
    'POST /api/tasks/workspaces/dept-kikaku/tasks',
    'POST /api/tasks/workspaces/dept-kikaku/tasks',
    'POST /api/tasks/workspaces/dept-kaijo/tasks',
  ]);
  await shot(page, 'done-1440');
  await done.getByRole('button', { name: '親タスクを開く' }).click();
  await expect(page).toHaveURL(new RegExp(`task=${project!.id}`));
});

test('drafting from a project puts the tasks under it and proposes no new parent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const world = await installWorld(page, { persona: 'officer', nested: true, helping: true });
  const fake = await installDraftFake(page, { draft: { ...DRAFT, parent: null, parentTask: { id: 'T-101', title: '協賛企業へのお礼状' }, items: DRAFT.items.slice(0, 1) } });
  await page.goto('/#/tasks?ws=dept-shogai&task=T-101');
  await page.getByRole('button', { name: '＋ 子タスクを追加' }).click();
  await page.getByRole('group', { name: '作り方' }).getByRole('button', { name: 'Bot に下書きを頼む' }).click();
  const form = page.getByRole('form', { name: 'Bot に下書きを頼む' });
  await expect(form.getByTestId('task-draft-parent')).toContainText('の子タスクとして下書きします。');
  await form.getByLabel(/^概略/).fill('お礼状の発送の残り');
  await form.getByRole('button', { name: 'Bot に下書きしてもらう' }).click();
  await expect.poll(() => fake.posts.length).toBe(1);
  expect(fake.posts[0]).toMatchObject({ parentId: 'T-101' });
  const review = page.getByTestId('task-draft-review');
  await expect(review.getByTestId('task-draft-row')).toHaveCount(1);
  await review.getByRole('button', { name: '選んだ 1 件を起票する' }).click();
  await expect(page.getByTestId('task-draft-done')).toBeVisible();
  expect(world.tasks[0]!.parentId).toBe('T-101');
  expect(world.tasks[0]!.title).toBe('テントを撤去する');
});

test('a failed draft says why and keeps the outline for another try', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installWorld(page, { persona: 'officer' });
  await installDraftFake(page, { fail: '下書きを作れませんでした。概略をもう少し具体的にして、もう一度依頼してください。' });
  await page.goto('/#/tasks?ws=dept-kikaku');
  const form = await openDraftForm(page);
  await form.getByLabel(/^概略/).fill('片付け');
  await form.getByRole('button', { name: 'Bot に下書きしてもらう' }).click();
  const wait = page.getByTestId('task-draft-wait');
  await expect(wait.getByRole('alert')).toHaveText('下書きを作れませんでした。概略をもう少し具体的にして、もう一度依頼してください。');
  await wait.getByRole('button', { name: '概略を直して頼み直す' }).click();
  await expect(page.getByRole('form', { name: 'Bot に下書きを頼む' }).getByLabel(/^概略/)).toHaveValue('片付け');
});

test('the way of creating is remembered, and the switch is absent when the Bot cannot draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installWorld(page, { persona: 'officer' });
  await installDraftFake(page, { available: false });
  await page.goto('/#/tasks?ws=dept-kikaku');
  await taskList(page).getByRole('button', { name: '＋ 新しいタスク' }).click();
  await expect(page.getByRole('form', { name: '新しいタスク' })).toBeVisible();
  await expect(page.getByRole('group', { name: '作り方' })).toHaveCount(0);
});

test('the proposal fits a phone: no sideways scrolling, every control reachable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await installWorld(page, { persona: 'officer', nested: true, helping: true });
  await installDraftFake(page);
  await page.goto('/#/tasks?ws=dept-kikaku');
  const form = await openDraftForm(page);
  await form.getByLabel(/^概略/).fill('11/23 の片付けの段取り');
  await shot(page, 'form-375');
  await form.getByRole('button', { name: 'Bot に下書きしてもらう' }).click();
  const review = page.getByTestId('task-draft-review');
  await expect(review.getByRole('button', { name: '選んだ 4 件を起票する' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, 'review-375');
  // Back to the list and in again: the way of creating is kept.
  await page.getByRole('button', { name: '← 一覧に戻る' }).click();
  await taskList(page).getByRole('button', { name: '＋ 新しいタスク' }).click();
  await expect(page.getByRole('form', { name: 'Bot に下書きを頼む' })).toBeVisible();
});
