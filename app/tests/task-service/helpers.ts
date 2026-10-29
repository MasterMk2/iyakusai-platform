import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import { AppError } from '../../src/task-service/server/domain/errors.js';
import type { ActorContext } from '../../src/task-service/server/domain/taskService.js';
import { TaskService } from '../../src/task-service/server/domain/taskService.js';
import type { AppState } from '../../src/task-service/server/domain/state.js';
import { MemoryStore } from '../../src/task-service/server/storage/memoryStore.js';
import type { Store } from '../../src/task-service/server/storage/store.js';

/** 2026-10-09 12:00（日本時間）。期限超過の判定を固定するための時計。 */
export const FIXED_NOW = new Date('2026-10-09T03:00:00.000Z');
export const TODAY = '2026-10-09';

export const web = (actorId: string, operationId?: string): ActorContext => ({
  actorId,
  source: 'web',
  ...(operationId ? { operationId } : {}),
});

export async function setup(store: Store = new MemoryStore()) {
  const service = await TaskService.open({ store, clock: () => FIXED_NOW });
  return { service, store };
}

/** 保存に失敗する保存先。指定回数だけ失敗させる。 */
export class FailingStore extends MemoryStore {
  failures = 0;

  constructor(initial: AppState | null = null) {
    super(initial);
  }

  override async save(state: AppState): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('disk full (simulated)');
    }
    await super.save(state);
  }
}

export async function expectAppError(promise: Promise<unknown>, code: AppError['code']): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`Expected AppError ${code}, but the operation succeeded`);
}

/** テスト用の一時ディレクトリ。リポジトリ内の無視対象 data/ 配下に作る。 */
export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = path.resolve('data', 'test-runs', randomUUID());
  await mkdir(dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
