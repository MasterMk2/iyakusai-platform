import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../../../src/task-service/server/domain/state.js';
import { TaskService } from '../../../src/task-service/server/domain/taskService.js';
import { FileStore } from '../../../src/task-service/server/storage/fileStore.js';
import { FIXED_NOW, tempDir } from '../helpers.js';

// 確定の各段階でプロセスを強制終了し、新しいプロセス・新しいストアで読み直す。
// 強制終了するのはこのテストが起動した子プロセスだけ。プロセスの強制終了は電源断を再現しない
// （OS のページキャッシュは残る）。電源断に対する保証は fsync の順序（fileStoreFaults.test.ts）による。

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CHILD = path.join(ROOT, 'tests', 'task-service', 'fixtures', 'storeCrashChild.ts');
const CREATE = { kind: 'create', operationId: 'op-crash-create', title: '中断試験の作成' } as const;
const UPDATE = { kind: 'update', operationId: 'op-crash-update', taskId: 'task-1', expectedVersion: 1, title: '中断試験の更新' } as const;

type Result = { ok: true; replayed: boolean; taskId: string; version: number } | { ok: false; code: string };
type Point = 'temp-partial' | 'temp-synced' | 'renamed' | 'acked';

const children = new Set<ChildProcess>();
let dir: string;
let file: string;
let cleanup: (() => Promise<void>) | undefined;

beforeEach(async () => {
  const temp = await tempDir();
  cleanup = temp.cleanup;
  dir = temp.dir;
  file = path.join(dir, 'state.json');
  await TaskService.open({ store: new FileStore(file), clock: () => FIXED_NOW });
});

afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear();
  await cleanup?.();
  cleanup = undefined;
});

/** 子プロセスで操作を実行する。pauseAt を指定したら、その段階で止まったところを強制終了する。 */
function runChild(operations: object[], pauseAt?: Point): Promise<Result[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, JSON.stringify({ file, pauseAt, operations })], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.add(child);
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (pauseAt && !killed && out.includes(`PAUSED ${pauseAt}\n`)) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      children.delete(child);
      const results = out
        .split('\n')
        .filter((line) => line.startsWith('RESULT '))
        .map((line) => JSON.parse(line.slice('RESULT '.length)) as Result);
      if (pauseAt ? killed : code === 0 && out.includes('DONE\n')) resolve(results);
      else reject(new Error(`child did not ${pauseAt ? `pause at ${pauseAt}` : 'finish'} (exit ${code}): ${out}${err}`));
    });
  });
}

const load = async () => (await new FileStore(file).load())!;
const created = (state: AppState) => ({
  tasks: state.tasks.filter((task) => task.title === CREATE.title).length,
  history: state.history.filter((entry) => entry.operationId === CREATE.operationId).length,
  operations: state.operations.filter((record) => record.operationId === CREATE.operationId).length,
});
const temps = async () => (await readdir(dir)).filter((name) => name.endsWith('.tmp'));

describe('確定の途中での強制終了と再起動', () => {
  it.each(['temp-partial', 'temp-synced'] as const)(
    '%s で強制終了: 元のファイルはそのまま、再起動後の再送で 1 回だけ作成され、残った一時ファイルは消さない',
    async (point) => {
      const before = await readFile(file);
      await runChild([CREATE], point);

      expect(await readFile(file)).toEqual(before);
      const leftovers = await temps();
      expect(leftovers).toHaveLength(1);
      const leftover = await readFile(path.join(dir, leftovers[0]!), 'utf8');
      if (point === 'temp-partial') expect(() => JSON.parse(leftover)).toThrow();
      else expect(created(JSON.parse(leftover) as AppState).tasks).toBe(1);
      expect(created(await load())).toEqual({ tasks: 0, history: 0, operations: 0 });

      expect(await runChild([CREATE])).toEqual([{ ok: true, replayed: false, taskId: expect.stringMatching(/^task-/), version: 1 }]);
      expect(created(await load())).toEqual({ tasks: 1, history: 1, operations: 1 });
      // 終了したプロセスの一時ファイルは自分のものではないため、再起動後の保存でも消さない。
      expect(await readFile(path.join(dir, leftovers[0]!), 'utf8')).toBe(leftover);
    },
    60_000,
  );

  it('rename 直後（応答前）で強制終了: 旧版か新版の有効な状態が残り、再送は新版なら再送扱い・旧版なら 1 回だけ作成する', async () => {
    await runChild([CREATE], 'renamed');
    const state = created(await load());
    expect([
      { tasks: 0, history: 0, operations: 0 },
      { tasks: 1, history: 1, operations: 1 },
    ]).toContainEqual(state);
    expect(await temps()).toEqual([]);

    const [retry] = await runChild([CREATE]);
    expect(retry).toMatchObject({ ok: true, replayed: state.tasks === 1 });
    expect(created(await load())).toEqual({ tasks: 1, history: 1, operations: 1 });
  }, 60_000);

  it('応答後に強制終了: 再起動後は最新の状態・版・履歴・操作記録があり、応答を受け取れなかった再送は重複しない', async () => {
    const first = await runChild([CREATE, UPDATE], 'acked');
    expect(first).toEqual([
      { ok: true, replayed: false, taskId: expect.stringMatching(/^task-/), version: 1 },
      { ok: true, replayed: false, taskId: 'task-1', version: 2 },
    ]);
    const createdId = (first[0] as { taskId: string }).taskId;
    let state = await load();
    expect(created(state)).toEqual({ tasks: 1, history: 1, operations: 1 });
    expect(state.tasks.find((task) => task.id === 'task-1')).toMatchObject({ version: 2, title: UPDATE.title });
    expect(state.history.filter((entry) => entry.operationId === UPDATE.operationId)).toHaveLength(1);
    expect(state.operations.filter((record) => record.operationId === UPDATE.operationId)).toHaveLength(1);

    const retry = await runChild([CREATE, UPDATE, { ...UPDATE, operationId: 'op-crash-stale', title: '古い版' }]);
    expect(retry).toEqual([
      { ok: true, replayed: true, taskId: createdId, version: 1 },
      { ok: true, replayed: true, taskId: 'task-1', version: 2 },
      { ok: false, code: 'VERSION_CONFLICT' },
    ]);
    state = await load();
    expect(created(state)).toEqual({ tasks: 1, history: 1, operations: 1 });
    expect(state.history.filter((entry) => entry.taskId === 'task-1').map((entry) => entry.version)).toEqual([1, 2]);
    expect(await temps()).toEqual([]);
  }, 60_000);
});
