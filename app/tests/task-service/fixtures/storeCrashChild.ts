import { AppError } from '../../../src/task-service/server/domain/errors.js';
import { TaskService } from '../../../src/task-service/server/domain/taskService.js';
import { FileStore, NODE_STORE_OPS, type FileStoreOps } from '../../../src/task-service/server/storage/fileStore.js';

// テスト専用の子プロセス（tests/unit/fileStoreCrash.test.ts から起動する。アプリからは使わない）。
// 架空データの状態ファイルを開き、指定した操作を順に実行して結果を 1 行ずつ出力する。pauseAt を
// 指定すると、その確定段階で「PAUSED <段階>」を出して止まり、親プロセスがそこで強制終了する。

type Point = 'temp-partial' | 'temp-synced' | 'renamed' | 'acked';
type Operation =
  | { kind: 'create'; operationId: string; title: string }
  | { kind: 'update'; operationId: string; taskId: string; expectedVersion: number; title: string };

const { file, pauseAt, operations } = JSON.parse(process.argv[2] ?? '{}') as {
  file: string;
  pauseAt?: Point;
  operations: Operation[];
};

const keepAlive = setInterval(() => undefined, 60_000);
const pause = (point: Point): Promise<never> => {
  process.stdout.write(`PAUSED ${point}\n`);
  return new Promise<never>(() => undefined);
};

const ops: FileStoreOps = {
  ...NODE_STORE_OPS,
  async open(target, flags, mode) {
    const handle = await NODE_STORE_OPS.open(target, flags, mode);
    if (pauseAt !== 'temp-partial' || !target.endsWith('.tmp')) return handle;
    return {
      // 半分だけ書いてディスクへ送り、そこで止まる（書込途中の一時ファイル）。
      async write(buffer, offset, length, position) {
        await handle.write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
        await handle.sync();
        return pause('temp-partial');
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
      stat: (options) => handle.stat(options),
      readFile: (encoding) => handle.readFile(encoding),
    };
  },
  async rename(from, to) {
    if (pauseAt === 'temp-synced') await pause('temp-synced');
    await NODE_STORE_OPS.rename(from, to);
    if (pauseAt === 'renamed') await pause('renamed');
  },
};

const service = await TaskService.open({ store: new FileStore(file, undefined, ops), seedIfMissing: false });
for (const operation of operations) {
  const ctx = { actorId: 'user-member-a1', source: 'web' as const, operationId: operation.operationId };
  try {
    const result =
      operation.kind === 'create'
        ? await service.createTask(ctx, 'ws-planning', { title: operation.title })
        : await service.updateTask(ctx, operation.taskId, { expectedVersion: operation.expectedVersion, changes: { title: operation.title } });
    process.stdout.write(`RESULT ${JSON.stringify({ ok: true, replayed: result.replayed, taskId: result.task.id, version: result.task.version })}\n`);
  } catch (error) {
    process.stdout.write(`RESULT ${JSON.stringify({ ok: false, code: error instanceof AppError ? error.code : 'UNEXPECTED' })}\n`);
  }
}
if (pauseAt === 'acked') await pause('acked');
clearInterval(keepAlive);
process.stdout.write('DONE\n');
