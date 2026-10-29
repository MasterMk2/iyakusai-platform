import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addDays, formatDateOnly, isOverdue, isValidDateOnly, todayInTimeZone } from '../../../src/task-service/shared/dates.js';
import { FileStore } from '../../../src/task-service/server/storage/fileStore.js';
import { CorruptStateError } from '../../../src/task-service/server/storage/store.js';
import { setup, tempDir, web } from '../helpers.js';

describe('日付のみの期限', () => {
  it('実在する日付だけを受け付ける', () => {
    expect(isValidDateOnly('2026-02-28')).toBe(true);
    expect(isValidDateOnly('2028-02-29')).toBe(true);
    for (const value of ['2026-02-29', '2026-13-01', '2026-1-1', '20261001', '1999-12-31', '2101-01-01', '']) {
      expect(isValidDateOnly(value)).toBe(false);
    }
  });

  it('日本時間で今日を求め、曜日付きで一貫して表示する', () => {
    expect(todayInTimeZone(new Date('2026-10-08T15:30:00Z'))).toBe('2026-10-09');
    expect(todayInTimeZone(new Date('2026-10-08T14:59:59Z'))).toBe('2026-10-08');
    expect(formatDateOnly('2026-10-09')).toBe('2026/10/09（金）');
    expect(formatDateOnly(null)).toBe('期限なし');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(isOverdue('2026-10-08', 'todo', '2026-10-09')).toBe(true);
    expect(isOverdue('2026-10-09', 'todo', '2026-10-09')).toBe(false);
    expect(isOverdue('2026-10-08', 'done', '2026-10-09')).toBe(false);
    expect(isOverdue(null, 'todo', '2026-10-09')).toBe(false);
  });
});

describe('ローカル JSON 保存', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('再起動後も変更と履歴を保持し、一時ファイルを残さない', async () => {
    const temp = await tempDir();
    cleanup = temp.cleanup;
    const file = path.join(temp.dir, 'state.json');
    const { service } = await setup(new FileStore(file));
    await service.createTask(web('user-member-a1', 'op-persist-001'), 'ws-planning', { title: '保存の確認' });

    const { service: reopened } = await setup(new FileStore(file));
    const tasks = await reopened.listTasks('user-member-a1', 'ws-planning');
    const created = tasks.find((task) => task.title === '保存の確認');
    expect(created).toBeDefined();
    expect(await reopened.getHistory('user-member-a1', created!.id)).toHaveLength(1);
    // 操作 ID の記録も保存されるため、再起動後の再送も重複しない。
    const replay = await reopened.createTask(web('user-member-a1', 'op-persist-001'), 'ws-planning', { title: '保存の確認' });
    expect(replay.replayed).toBe(true);
    expect((await readdir(temp.dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('壊れた保存ファイルを検出し、退避できる', async () => {
    const temp = await tempDir();
    cleanup = temp.cleanup;
    const file = path.join(temp.dir, 'state.json');
    await writeFile(file, '{ not json', 'utf8');
    const store = new FileStore(file);
    await expect(store.load()).rejects.toBeInstanceOf(CorruptStateError);
    await writeFile(file, JSON.stringify({ schemaVersion: 99 }), 'utf8');
    await expect(store.load()).rejects.toBeInstanceOf(CorruptStateError);
    const moved = await store.quarantine(new Date('2026-10-09T00:00:00Z'));
    expect(moved).toMatch(/^state\.json\.corrupt-/);
    expect(await store.load()).toBeNull();
    expect(await readFile(path.join(temp.dir, moved), 'utf8')).toContain('schemaVersion');
  });

  it('保存先の説明に絶対パスを含めない', () => {
    const store = new FileStore(path.resolve('data', 'demo-state.json'), 'data/demo-state.json');
    expect(store.description).toBe('ローカル JSON ファイル（data/demo-state.json）');
  });
});
