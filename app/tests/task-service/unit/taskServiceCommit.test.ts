import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../../../src/task-service/server/domain/state.js';
import { TaskService } from '../../../src/task-service/server/domain/taskService.js';
import { FileStore } from '../../../src/task-service/server/storage/fileStore.js';
import { harness, type Harness } from '../storeOps.js';
import { FIXED_NOW, expectAppError, tempDir, web } from '../helpers.js';

// タスク・版・履歴・操作記録は 1 文書として一緒に確定する。保存の失敗・確定不明・重なった変更・
// 非対応の 2 つ目の書込者のそれぞれで、応答と保存内容がどうなるかを確認する。

const EDITOR_A = 'user-member-a1';
const EDITOR_A2 = 'user-member-a2';
const clock = () => FIXED_NOW;

let dir: string;
let file: string;
let cleanup: (() => Promise<void>) | undefined;

beforeEach(async () => {
  const temp = await tempDir();
  cleanup = temp.cleanup;
  dir = temp.dir;
  file = path.join(dir, 'state.json');
  await TaskService.open({ store: new FileStore(file), clock });
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function open(platform: NodeJS.Platform = 'linux'): Promise<{ service: TaskService; h: Harness }> {
  const h = harness(file, { platform });
  const service = await TaskService.open({ store: new FileStore(file, undefined, h.ops), seedIfMissing: false, clock });
  return { service, h };
}
const persisted = async () => JSON.parse(await readFile(file, 'utf8')) as AppState;
const byOperation = (state: AppState, operationId: string) => ({
  tasks: state.history.filter((entry) => entry.operationId === operationId && entry.action === 'created').length,
  history: state.history.filter((entry) => entry.operationId === operationId).length,
  operations: state.operations.filter((record) => record.operationId === operationId).length,
});

describe('確定したか不明な保存（rename 後のディレクトリ fsync の失敗）', () => {
  it('作成は「反映済みか不明」として 503 になり、次の操作で保存内容を読み直す。同じ操作 ID の再送は重複しない', async () => {
    const { service, h } = await open();
    h.failNext('sync-dir', 'EIO');
    const error = await expectAppError(
      service.createTask(web(EDITOR_A, 'op-uncertain-001'), 'ws-planning', { title: '確定不明の作成' }),
      'SAVE_FAILED',
    );
    expect(error.httpStatus).toBe(503);
    expect(error.message).toContain('確定');
    expect(error.message).not.toContain('反映されていません');
    // 置き換えは済んでいる（巻き戻したとは扱わない）。
    expect(byOperation(await persisted(), 'op-uncertain-001')).toEqual({ tasks: 1, history: 1, operations: 1 });

    const retried = await service.createTask(web(EDITOR_A, 'op-uncertain-001'), 'ws-planning', { title: '確定不明の作成' });
    expect(retried.replayed).toBe(true);
    expect(retried.task.title).toBe('確定不明の作成');
    expect(byOperation(await persisted(), 'op-uncertain-001')).toEqual({ tasks: 1, history: 1, operations: 1 });
    // 読み直しは POSIX ではファイルとディレクトリの fsync を伴う（確定させてから使う）。
    expect(h.calls.slice(-6)).toEqual(['open-data', 'sync-data', 'close-data', 'open-dir', 'sync-dir', 'close-dir']);
  });

  it('確定不明のあとは古いメモリ上の版で変更しない（古い版を前提にした別の更新は VERSION_CONFLICT）', async () => {
    const { service, h } = await open();
    h.failNext('sync-dir', 'EIO');
    await expectAppError(
      service.updateTask(web(EDITOR_A, 'op-uncertain-upd'), 'task-1', { expectedVersion: 1, changes: { title: '更新 A' } }),
      'SAVE_FAILED',
    );
    const conflict = await expectAppError(
      service.updateTask(web(EDITOR_A2, 'op-stale-upd'), 'task-1', { expectedVersion: 1, changes: { title: '古い版からの更新' } }),
      'VERSION_CONFLICT',
    );
    expect(conflict.options.current?.version).toBe(2);
    const state = await persisted();
    const task = state.tasks.find((candidate) => candidate.id === 'task-1')!;
    expect(task).toMatchObject({ version: 2, title: '更新 A' });
    expect(state.history.filter((entry) => entry.taskId === 'task-1')).toHaveLength(2);
    expect(byOperation(state, 'op-stale-upd')).toEqual({ tasks: 0, history: 0, operations: 0 });
  });

  it('読み直しにも失敗する間は読み取り・変更とも 503 で止まり、ファイルを書き換えない。回復後に続行できる', async () => {
    const { service, h } = await open();
    h.failNext('sync-dir', 'EIO', 3);
    await expectAppError(service.createTask(web(EDITOR_A, 'op-stuck-001'), 'ws-planning', { title: '止まる前の作成' }), 'SAVE_FAILED');
    const after = await readFile(file);

    await expectAppError(service.listTasks(EDITOR_A, 'ws-planning'), 'LOAD_FAILED');
    await expectAppError(
      service.updateTask(web(EDITOR_A, 'op-stuck-002'), 'task-1', { expectedVersion: 1, changes: { title: '止まっている間' } }),
      'LOAD_FAILED',
    );
    expect(() => service.getMe(EDITOR_A)).toThrow(expect.objectContaining({ code: 'LOAD_FAILED' }));
    expect(await readFile(file)).toEqual(after);
    expect(h.calls.filter((call) => call.startsWith('open-temp'))).toHaveLength(1);

    const titles = (await service.listTasks(EDITOR_A, 'ws-planning')).map((task) => task.title);
    expect(titles).toContain('止まる前の作成');
    expect(service.getMe(EDITOR_A).user.id).toBe(EDITOR_A);
    const updated = await service.updateTask(web(EDITOR_A, 'op-stuck-002'), 'task-1', {
      expectedVersion: 1,
      changes: { title: '回復後の更新' },
    });
    expect(updated.task.version).toBe(2);
  });

  it('rename 前の失敗は確定していないことが明らかなので、メモリもファイルも変えず、同じ操作 ID の再試行で 1 回だけ適用する', async () => {
    const { service, h } = await open();
    const before = await readFile(file);
    h.failNext('sync-temp', 'EIO');
    const error = await expectAppError(
      service.createTask(web(EDITOR_A, 'op-definite-001'), 'ws-planning', { title: '失敗した作成' }),
      'SAVE_FAILED',
    );
    expect(error.message).toContain('反映されていません');
    expect(await readFile(file)).toEqual(before);
    expect((await service.listTasks(EDITOR_A, 'ws-planning')).map((task) => task.title)).not.toContain('失敗した作成');

    const retried = await service.createTask(web(EDITOR_A, 'op-definite-001'), 'ws-planning', { title: '失敗した作成' });
    expect(retried.replayed).toBe(false);
    expect(byOperation(await persisted(), 'op-definite-001')).toEqual({ tasks: 1, history: 1, operations: 1 });
  });
});

describe('重なった変更と応答の時点', () => {
  it('同じ版への同時更新は 1 件だけ確定し、残りは VERSION_CONFLICT。保存内容・メモリ・新しいストアの読み込みが一致する', async () => {
    const { service, h } = await open();
    h.delays['write-temp'] = [30, 30, 30, 30, 30, 30, 30, 30];
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_unused, i) =>
        service.updateTask(web(EDITOR_A, `op-race-${i}`), 'task-1', { expectedVersion: 1, changes: { title: `同時更新 ${i}` } }),
      ),
    );
    const won = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    expect(won).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'VERSION_CONFLICT' });
    }
    const state = await persisted();
    const task = state.tasks.find((candidate) => candidate.id === 'task-1')!;
    expect(task).toMatchObject({ version: 2, title: won[0]!.task.title });
    expect(state.history.filter((entry) => entry.taskId === 'task-1')).toHaveLength(2);
    expect((await service.getTask(EDITOR_A, 'task-1')).version).toBe(2);
    const reloaded = await new FileStore(file).load();
    expect(reloaded).toEqual(state);
  });

  it('別々の操作 ID による同時作成はすべて 1 回ずつ確定し、同じ操作 ID の同時再送は 1 件だけ作成する', async () => {
    const { service, h } = await open();
    h.delays['write-temp'] = [20, 10, 0, 20, 10, 0];
    const base = await persisted();
    const created = await Promise.all(
      Array.from({ length: 6 }, (_unused, i) => service.createTask(web(EDITOR_A, `op-many-${i}`), 'ws-planning', { title: `並行作成 ${i}` })),
    );
    expect(new Set(created.map((result) => result.task.id)).size).toBe(6);
    const duplicates = await Promise.all(
      Array.from({ length: 4 }, () => service.createTask(web(EDITOR_A, 'op-same'), 'ws-planning', { title: '同じ操作' })),
    );
    expect(duplicates.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(duplicates.map((result) => result.task.id)).size).toBe(1);

    const state = await persisted();
    expect(state.tasks).toHaveLength(base.tasks.length + 7);
    expect(state.counters.task).toBe(base.counters.task + 7);
    expect(state.history).toHaveLength(base.history.length + 7);
    expect(new Set(state.history.map((entry) => entry.id)).size).toBe(state.history.length);
    expect(byOperation(state, 'op-same')).toEqual({ tasks: 1, history: 1, operations: 1 });
  });

  it('保存の完了前の読み取りは、まだ確定していない内容を返さない', async () => {
    const { service, h } = await open();
    const held = h.hold('sync-dir');
    const updating = service.updateTask(web(EDITOR_A, 'op-held-001'), 'task-1', { expectedVersion: 1, changes: { title: '確定待ち' } });
    await held.reached;
    expect((await service.getTask(EDITOR_A, 'task-1')).version).toBe(1);
    held.release();
    expect((await updating).task.version).toBe(2);
    expect((await service.getTask(EDITOR_A, 'task-1')).title).toBe('確定待ち');
  });
});

describe('非対応の 2 つ目の書込者', () => {
  it('同じファイルを別のサービスが先に更新していれば古い状態で上書きせず 503。読み直した後は版で判断する', async () => {
    const first = await TaskService.open({ store: new FileStore(file), seedIfMissing: false, clock });
    const second = await TaskService.open({ store: new FileStore(file), seedIfMissing: false, clock });
    await first.updateTask(web(EDITOR_A, 'op-first-001'), 'task-1', { expectedVersion: 1, changes: { title: '先の更新' } });

    const refused = await expectAppError(
      second.updateTask(web(EDITOR_A2, 'op-second-001'), 'task-1', { expectedVersion: 1, changes: { title: '古い状態からの更新' } }),
      'SAVE_FAILED',
    );
    expect(refused.message).not.toContain('反映されていません');
    let state = await persisted();
    expect(state.tasks.find((task) => task.id === 'task-1')).toMatchObject({ version: 2, title: '先の更新' });
    expect(byOperation(state, 'op-first-001').history).toBe(1);

    await expectAppError(
      second.updateTask(web(EDITOR_A2, 'op-second-002'), 'task-1', { expectedVersion: 1, changes: { title: '古い版のまま' } }),
      'VERSION_CONFLICT',
    );
    const ok = await second.updateTask(web(EDITOR_A2, 'op-second-003'), 'task-1', { expectedVersion: 2, changes: { title: '読み直し後の更新' } });
    expect(ok.task.version).toBe(3);
    state = await persisted();
    expect(state.history.filter((entry) => entry.taskId === 'task-1').map((entry) => entry.version)).toEqual([1, 2, 3]);
  });
});
