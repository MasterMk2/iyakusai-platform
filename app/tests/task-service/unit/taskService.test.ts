import { describe, expect, it } from 'vitest';
import { createSeedState } from '../../../src/task-service/server/domain/seed.js';
import { TaskService } from '../../../src/task-service/server/domain/taskService.js';
import { MemoryStore } from '../../../src/task-service/server/storage/memoryStore.js';
import { FIXED_NOW, FailingStore, TODAY, expectAppError, setup, web } from '../helpers.js';

const EDITOR_A = 'user-member-a1';
const EDITOR_A2 = 'user-member-a2';
const VIEWER_A = 'user-observer-a';
const ADMIN_A = 'user-chair-a';
const ADMIN_B = 'user-chair-b';
const EDITOR_B = 'user-member-b1';
const FORMER_A = 'user-former-a3';
const OUTSIDER = 'user-outsider';

describe('サンプルデータ', () => {
  it('2 つ以上の架空の委員会と、予約済みドメインのメールアドレスだけを含む', () => {
    const state = createSeedState(FIXED_NOW);
    expect(state.workspaces.length).toBeGreaterThanOrEqual(2);
    for (const user of state.users) expect(user.email).toMatch(/@[a-z0-9.-]+\.(example|invalid)$/);
    for (const account of state.mockBot.accounts) expect(account.externalUserId).toMatch(/^mock-/);
    for (const channel of state.mockBot.channels) expect(channel.channelId).toMatch(/^mock-/);
  });
});

describe('タスクの作成と一覧', () => {
  it('タイトルだけで未割当・未着手のタスクを作成し、未入力の要件を示す', async () => {
    const { service } = await setup();
    const { task, replayed } = await service.createTask(web(EDITOR_A), 'ws-planning', { title: '  新しい作業  ' });
    expect(replayed).toBe(false);
    expect(task).toMatchObject({ title: '新しい作業', status: 'todo', assigneeId: null, deadline: null, version: 1 });
    expect(task.missingRequirements).toEqual(['purpose', 'deliverable', 'completionCriteria', 'openQuestions']);
    const history = await service.getHistory(EDITOR_A, task.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: 'created', actorId: EDITOR_A, source: 'web', version: 1 });
    const list = await service.listTasks(EDITOR_A, 'ws-planning');
    expect(list.map((item) => item.id)).toContain(task.id);
  });

  it('担当者・期限・要件を指定して作成できる', async () => {
    const { service } = await setup();
    const { task } = await service.createTask(web(EDITOR_A), 'ws-planning', {
      title: '資料を印刷する',
      assigneeId: EDITOR_A2,
      deadline: '2026-10-20',
      requirements: { purpose: '配布のため', completionCriteria: '30 部' },
    });
    expect(task.assignee).toMatchObject({ id: EDITOR_A2, displayName: '委員 A2', active: true });
    expect(task.deadline).toBe('2026-10-20');
    expect(task.missingRequirements).toEqual(['deliverable', 'openQuestions']);
  });

  it.each([
    [{ title: '' }],
    [{ title: '   ' }],
    [{ title: 'x'.repeat(121) }],
    [{ title: '改行\nを含む' }],
    [{ title: '制御\u0007文字' }],
    [{ title: 123 }],
    [{}],
    [{ title: 'ok', unknownField: 1 }],
    [{ title: 'ok', deadline: '2026-02-30' }],
    [{ title: 'ok', deadline: '2026/10/01' }],
    [{ title: 'ok', deadline: '1999-12-31' }],
    [{ title: 'ok', requirements: { purpose: 'x'.repeat(2001) } }],
    [null],
    ['text'],
  ])('不正な入力 %j を拒否し、何も保存しない', async (input) => {
    const store = new MemoryStore();
    const { service } = await setup(store);
    const before = store.saveCount;
    const error = await expectAppError(service.createTask(web(EDITOR_A), 'ws-planning', input), 'VALIDATION');
    expect(error.options.details?.length).toBeGreaterThan(0);
    expect(store.saveCount).toBe(before);
    expect(await service.listTasks(EDITOR_A, 'ws-planning')).toHaveLength(5);
  });

  it('閲覧者・未所属・他委員会の編集者は作成できない', async () => {
    const { service } = await setup();
    await expectAppError(service.createTask(web(VIEWER_A), 'ws-planning', { title: 'x' }), 'FORBIDDEN');
    await expectAppError(service.createTask(web(OUTSIDER), 'ws-planning', { title: 'x' }), 'FORBIDDEN');
    await expectAppError(service.createTask(web(EDITOR_B), 'ws-planning', { title: 'x' }), 'FORBIDDEN');
    await expectAppError(service.createTask(web(EDITOR_A), 'ws-publicity', { title: 'x' }), 'FORBIDDEN');
    await expectAppError(service.createTask(web('user-unknown'), 'ws-planning', { title: 'x' }), 'UNAUTHENTICATED');
  });

  it('一覧を状態・担当者・期限で絞り込める', async () => {
    const { service } = await setup();
    const ids = async (query: unknown) => (await service.listTasks(EDITOR_A, 'ws-planning', query)).map((task) => task.id);
    expect(await ids({ status: 'blocked' })).toEqual(['task-5']);
    expect(await ids({ assignee: 'none' })).toEqual(['task-3']);
    expect(await ids({ assignee: EDITOR_A })).toEqual(['task-1', 'task-5']);
    expect(await ids({ deadline: 'overdue' })).toEqual(['task-2']);
    expect(await ids({ deadline: 'none' })).toEqual(['task-3']);
    expect(await ids({ deadline: 'set', status: 'todo' })).toEqual(['task-2']);
    expect(await ids({ status: 'done', assignee: 'none' })).toEqual([]);
    await expectAppError(service.listTasks(EDITOR_A, 'ws-planning', { status: 'archived' }), 'VALIDATION');
    await expectAppError(service.listTasks(EDITOR_A, 'ws-planning', { sort: 'title' }), 'VALIDATION');
  });
});

describe('担当者の割当', () => {
  it('割当と解除を履歴に残す', async () => {
    const { service } = await setup();
    const assigned = await service.updateTask(web(EDITOR_A), 'task-3', { expectedVersion: 1, changes: { assigneeId: EDITOR_A2 } });
    expect(assigned.task.assignee?.displayName).toBe('委員 A2');
    const cleared = await service.updateTask(web(EDITOR_A), 'task-3', { expectedVersion: 2, changes: { assigneeId: null } });
    expect(cleared.task.assignee).toBeNull();
    const history = await service.getHistory(EDITOR_A, 'task-3');
    expect(history[0]?.displayChanges).toEqual([{ field: 'assigneeId', before: '委員 A2', after: null }]);
    expect(history[1]?.displayChanges).toEqual([{ field: 'assigneeId', before: null, after: '委員 A2' }]);
  });

  it('他委員会の人物・無効な所属・存在しない人物は割り当てられない', async () => {
    const { service } = await setup();
    for (const assigneeId of [EDITOR_B, FORMER_A, 'user-nobody', OUTSIDER]) {
      await expectAppError(
        service.updateTask(web(EDITOR_A), 'task-3', { expectedVersion: 1, changes: { assigneeId } }),
        'VALIDATION',
      );
    }
    expect((await service.getTask(EDITOR_A, 'task-3')).version).toBe(1);
  });

  it('割当てられても他委員会の権限は増えない', async () => {
    const { service } = await setup();
    // 委員 A1 は広報委員会では閲覧者。担当者になっても変更はできない。
    await service.updateTask(web(ADMIN_B), 'task-7', { expectedVersion: 1, changes: { assigneeId: EDITOR_A } });
    expect((await service.getTask(EDITOR_A, 'task-7')).assigneeId).toBe(EDITOR_A);
    await expectAppError(
      service.updateTask(web(EDITOR_A), 'task-7', { expectedVersion: 2, changes: { status: 'done' } }),
      'FORBIDDEN',
    );
    // 委員 A2 は広報委員会に所属しないため、存在も分からない。
    await expectAppError(service.getTask(EDITOR_A2, 'task-7'), 'NOT_FOUND');
  });
});

describe('期限・状態・要件', () => {
  it('期限を設定・変更・解除し、期限超過を判定する', async () => {
    const { service } = await setup();
    let result = await service.updateTask(web(EDITOR_A), 'task-3', { expectedVersion: 1, changes: { deadline: '2026-10-08' } });
    expect(result.task.overdue).toBe(true);
    result = await service.updateTask(web(EDITOR_A), 'task-3', { expectedVersion: 2, changes: { deadline: TODAY } });
    expect(result.task.overdue).toBe(false);
    result = await service.updateTask(web(EDITOR_A), 'task-3', { expectedVersion: 3, changes: { deadline: null } });
    expect(result.task.deadline).toBeNull();
    const history = await service.getHistory(EDITOR_A, 'task-3');
    expect(history.slice(0, 3).map((entry) => entry.changes[0])).toEqual([
      { field: 'deadline', before: TODAY, after: null },
      { field: 'deadline', before: '2026-10-08', after: TODAY },
      { field: 'deadline', before: null, after: '2026-10-08' },
    ]);
  });

  it('完了したタスクは期限を過ぎても期限超過にしない', async () => {
    const { service } = await setup();
    const done = await service.getTask(ADMIN_A, 'task-4');
    expect(done.deadline! < TODAY).toBe(true);
    expect(done.overdue).toBe(false);
  });

  it('状態を変更し、完了からは再開操作でだけ戻せる', async () => {
    const { service } = await setup();
    let version = 1;
    for (const status of ['in_progress', 'blocked', 'todo', 'done'] as const) {
      const result = await service.updateTask(web(EDITOR_A), 'task-3', { expectedVersion: version, changes: { status } });
      expect(result.task.status).toBe(status);
      version = result.task.version;
    }
    await expectAppError(
      service.updateTask(web(EDITOR_A), 'task-3', { expectedVersion: version, changes: { status: 'in_progress' } }),
      'INVALID_TRANSITION',
    );
    const reopened = await service.reopenTask(web(EDITOR_A), 'task-3', { expectedVersion: version });
    expect(reopened.task.status).toBe('todo');
    const history = await service.getHistory(EDITOR_A, 'task-3');
    expect(history[0]).toMatchObject({ action: 'reopened', changes: [{ field: 'status', before: 'done', after: 'todo' }] });
    await expectAppError(service.reopenTask(web(EDITOR_A), 'task-3', { expectedVersion: version + 1 }), 'INVALID_TRANSITION');
  });

  it('要件の 4 項目を個別に保存し、空に戻すと未入力になる', async () => {
    const { service } = await setup();
    let version = 1;
    const values = {
      purpose: '目的の説明',
      deliverable: '成果物の説明',
      completionCriteria: '完了条件の説明',
      openQuestions: '不明点の説明',
    } as const;
    for (const [field, value] of Object.entries(values)) {
      const result = await service.updateTask(web(EDITOR_A), 'task-3', { expectedVersion: version, changes: { [field]: value } });
      expect(result.task.requirements[field as keyof typeof values]).toBe(value);
      version = result.task.version;
    }
    let task = await service.getTask(EDITOR_A, 'task-3');
    expect(task.missingRequirements).toEqual([]);
    const result = await service.updateTask(web(EDITOR_A), 'task-3', { expectedVersion: version, changes: { deliverable: '   ' } });
    expect(result.task.missingRequirements).toEqual(['deliverable']);
    task = await service.getTask(EDITOR_A, 'task-3');
    expect(task.requirements).toMatchObject({ purpose: '目的の説明', deliverable: '' });
    const history = await service.getHistory(EDITOR_A, 'task-3');
    expect(history).toHaveLength(6);
    expect(history.slice(0, 5).map((entry) => entry.changes.map((change) => change.field))).toEqual([
      ['deliverable'],
      ['openQuestions'],
      ['completionCriteria'],
      ['deliverable'],
      ['purpose'],
    ]);
  });

  it('変更点のない更新と空の変更を拒否する', async () => {
    const { service } = await setup();
    await expectAppError(
      service.updateTask(web(EDITOR_A), 'task-1', { expectedVersion: 1, changes: { status: 'in_progress' } }),
      'NO_CHANGE',
    );
    await expectAppError(service.updateTask(web(EDITOR_A), 'task-1', { expectedVersion: 1, changes: {} }), 'VALIDATION');
    await expectAppError(service.updateTask(web(EDITOR_A), 'task-1', { changes: { title: 'x' } }), 'VALIDATION');
    expect(await service.getHistory(EDITOR_A, 'task-1')).toHaveLength(1);
  });
});

describe('同時編集と再送', () => {
  it('古い版に対する変更を拒否し、成功済みの内容を保つ', async () => {
    const { service } = await setup();
    await service.updateTask(web(EDITOR_A), 'task-1', { expectedVersion: 1, changes: { title: '先に保存された題名' } });
    const error = await expectAppError(
      service.updateTask(web(EDITOR_A2), 'task-1', { expectedVersion: 1, changes: { title: '後から保存した題名' } }),
      'VERSION_CONFLICT',
    );
    expect(error.options.current).toMatchObject({ title: '先に保存された題名', version: 2 });
    expect((await service.getTask(EDITOR_A, 'task-1')).title).toBe('先に保存された題名');
    expect(await service.getHistory(EDITOR_A, 'task-1')).toHaveLength(2);
  });

  it('同時に届いた同じ版への変更は 1 件だけ成功する', async () => {
    const { service } = await setup();
    const results = await Promise.allSettled([
      service.updateTask(web(EDITOR_A), 'task-3', { expectedVersion: 1, changes: { status: 'in_progress' } }),
      service.updateTask(web(EDITOR_A2), 'task-3', { expectedVersion: 1, changes: { status: 'blocked' } }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await service.getTask(EDITOR_A, 'task-3')).version).toBe(2);
  });

  it('同じ操作 ID の再送は一度だけ適用し、内容の異なる再利用は拒否する', async () => {
    const { service } = await setup();
    const first = await service.createTask(web(EDITOR_A, 'op-create-0001'), 'ws-planning', { title: '一度だけ作る' });
    const second = await service.createTask(web(EDITOR_A, 'op-create-0001'), 'ws-planning', { title: '一度だけ作る' });
    expect(second.replayed).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    const tasks = await service.listTasks(EDITOR_A, 'ws-planning');
    expect(tasks.filter((task) => task.title === '一度だけ作る')).toHaveLength(1);
    await expectAppError(
      service.createTask(web(EDITOR_A, 'op-create-0001'), 'ws-planning', { title: '別の内容' }),
      'IDEMPOTENCY_CONFLICT',
    );
    // 別の人物の同じ ID は別の操作として扱う。
    const other = await service.createTask(web(EDITOR_A2, 'op-create-0001'), 'ws-planning', { title: '一度だけ作る' });
    expect(other.replayed).toBe(false);
  });

  it('再送時も現在の権限を確認する', async () => {
    const { service } = await setup();
    await service.updateTask(web(EDITOR_A2, 'op-update-0001'), 'task-3', { expectedVersion: 1, changes: { title: '更新' } });
    await service.updateMember(web(ADMIN_A), 'ws-planning', EDITOR_A2, { active: false });
    await expectAppError(
      service.updateTask(web(EDITOR_A2, 'op-update-0001'), 'task-3', { expectedVersion: 1, changes: { title: '更新' } }),
      'NOT_FOUND',
    );
  });
});

describe('保存と読み込みの失敗', () => {
  it('保存に失敗した変更はタスクにも履歴にも残らず、同じ操作 ID で再試行できる', async () => {
    const store = new FailingStore();
    const { service } = await setup(store);
    store.failures = 1;
    await expectAppError(
      service.updateTask(web(EDITOR_A, 'op-retry-0001'), 'task-1', { expectedVersion: 1, changes: { status: 'blocked' } }),
      'SAVE_FAILED',
    );
    expect((await service.getTask(EDITOR_A, 'task-1')).status).toBe('in_progress');
    expect(await service.getHistory(EDITOR_A, 'task-1')).toHaveLength(1);
    expect(store.peek()?.tasks.find((task) => task.id === 'task-1')?.status).toBe('in_progress');

    const retried = await service.updateTask(web(EDITOR_A, 'op-retry-0001'), 'task-1', {
      expectedVersion: 1,
      changes: { status: 'blocked' },
    });
    expect(retried.replayed).toBe(false);
    expect(retried.task.status).toBe('blocked');
    expect(await service.getHistory(EDITOR_A, 'task-1')).toHaveLength(2);
  });

  it('障害注入で保存・読み込みを失敗させ、次の試行で回復する', async () => {
    const { service } = await setup();
    service.faults.set({ failNextLoads: 1, failNextSaves: 1, delayMs: 0 });
    await expectAppError(service.listTasks(EDITOR_A, 'ws-planning'), 'LOAD_FAILED');
    expect(await service.listTasks(EDITOR_A, 'ws-planning')).toHaveLength(5);
    await expectAppError(service.createTask(web(EDITOR_A), 'ws-planning', { title: '失敗する作成' }), 'SAVE_FAILED');
    expect(await service.listTasks(EDITOR_A, 'ws-planning')).toHaveLength(5);
    await service.createTask(web(EDITOR_A), 'ws-planning', { title: '成功する作成' });
    expect(await service.listTasks(EDITOR_A, 'ws-planning')).toHaveLength(6);
  });

  it('初回起動で保存に失敗した場合は開始しない', async () => {
    const store = new FailingStore();
    store.failures = 1;
    await expect(TaskService.open({ store, clock: () => FIXED_NOW })).rejects.toThrow('disk full');
  });
});

describe('閲覧範囲と役割', () => {
  it('所属外のタスクは直接 ID を指定しても詳細・履歴・変更を返さない', async () => {
    const { service } = await setup();
    await expectAppError(service.getTask(EDITOR_B, 'task-1'), 'NOT_FOUND');
    await expectAppError(service.getHistory(EDITOR_B, 'task-1'), 'NOT_FOUND');
    await expectAppError(
      service.updateTask(web(EDITOR_B), 'task-1', { expectedVersion: 1, changes: { title: '乗っ取り' } }),
      'NOT_FOUND',
    );
    await expectAppError(service.reopenTask(web(EDITOR_B), 'task-4', { expectedVersion: 1 }), 'NOT_FOUND');
    await expectAppError(service.listTasks(EDITOR_B, 'ws-planning'), 'FORBIDDEN');
    await expectAppError(service.listMembers(OUTSIDER, 'ws-planning'), 'FORBIDDEN');
    await expectAppError(service.getTask(OUTSIDER, 'task-1'), 'NOT_FOUND');
    await expectAppError(service.getTask(EDITOR_A, 'task-999'), 'NOT_FOUND');
  });

  it('閲覧者は一覧・詳細・履歴を読めるが変更できない', async () => {
    const { service } = await setup();
    expect(await service.listTasks(VIEWER_A, 'ws-planning')).toHaveLength(5);
    expect((await service.getTask(VIEWER_A, 'task-1')).id).toBe('task-1');
    expect(await service.getHistory(VIEWER_A, 'task-1')).toHaveLength(1);
    await expectAppError(
      service.updateTask(web(VIEWER_A), 'task-1', { expectedVersion: 1, changes: { title: 'x' } }),
      'FORBIDDEN',
    );
    await expectAppError(service.reopenTask(web(VIEWER_A), 'task-4', { expectedVersion: 1 }), 'FORBIDDEN');
  });

  it('管理者は役割と所属の有効・無効を変更でき、変更は次の操作から効く', async () => {
    const { service } = await setup();
    await service.updateMember(web(ADMIN_A), 'ws-planning', VIEWER_A, { role: 'editor' });
    await service.updateTask(web(VIEWER_A), 'task-3', { expectedVersion: 1, changes: { title: '昇格後の変更' } });

    await service.updateMember(web(ADMIN_A), 'ws-planning', EDITOR_A2, { active: false });
    await expectAppError(service.listTasks(EDITOR_A2, 'ws-planning'), 'FORBIDDEN');
    await expectAppError(service.getTask(EDITOR_A2, 'task-2'), 'NOT_FOUND');
    // 担当は残し、所属が無効であることを示す。
    expect((await service.getTask(ADMIN_A, 'task-2')).assignee).toMatchObject({ id: EDITOR_A2, active: false });
    expect(service.getMe(EDITOR_A2).memberships).toEqual([]);

    const audit = await service.listMembershipAudit(ADMIN_A, 'ws-planning');
    expect(audit.map((entry) => entry.changes)).toEqual([
      [{ field: 'active', before: 'true', after: 'false' }],
      [{ field: 'role', before: 'viewer', after: 'editor' }],
    ]);
  });

  it('管理者以外は役割を変更できず、管理者も自分自身や他委員会は変更できない', async () => {
    const { service } = await setup();
    await expectAppError(service.updateMember(web(EDITOR_A), 'ws-planning', VIEWER_A, { role: 'admin' }), 'FORBIDDEN');
    await expectAppError(service.updateMember(web(ADMIN_A), 'ws-planning', ADMIN_A, { role: 'viewer' }), 'FORBIDDEN');
    await expectAppError(service.updateMember(web(ADMIN_A), 'ws-publicity', EDITOR_B, { role: 'viewer' }), 'FORBIDDEN');
    await expectAppError(service.updateMember(web(ADMIN_A), 'ws-planning', EDITOR_B, { role: 'viewer' }), 'NOT_FOUND');
    await expectAppError(service.updateMember(web(ADMIN_A), 'ws-planning', VIEWER_A, { role: 'viewer' }), 'NO_CHANGE');
    await expectAppError(service.updateMember(web(ADMIN_A), 'ws-planning', VIEWER_A, { role: 'owner' }), 'VALIDATION');
    await expectAppError(service.listMembershipAudit(EDITOR_A, 'ws-planning'), 'FORBIDDEN');
  });
});

describe('サンプルデータの初期化', () => {
  it('変更を破棄してサンプルに戻し、障害注入も解除する', async () => {
    const { service } = await setup();
    await service.createTask(web(EDITOR_A), 'ws-planning', { title: '消える作業' });
    service.faults.set({ failNextLoads: 2, failNextSaves: 0, delayMs: 0 });
    await service.resetDemoData();
    expect(service.faults.get()).toEqual({ failNextLoads: 0, failNextSaves: 0, delayMs: 0 });
    expect(await service.listTasks(EDITOR_A, 'ws-planning')).toHaveLength(5);
  });
});
