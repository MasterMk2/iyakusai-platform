import { existsSync } from 'node:fs';
import { readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSeedState } from '../../../src/task-service/server/domain/seed.js';
import type { AppState } from '../../../src/task-service/server/domain/state.js';
import { FileStore } from '../../../src/task-service/server/storage/fileStore.js';
import { harness, type Step } from '../storeOps.js';
import { FIXED_NOW, tempDir } from '../helpers.js';

// 保存の確定手順と、各手順が失敗したときの結果。ファイル操作の失敗は注入した操作で模擬する
// （実際のディスク障害や電源断は再現しない。電源断に関わる確認は fsync の順序と応答の時点までで、
// POSIX の手順は Windows 上でも platform を指定した記録で確認する）。

const variant = (n: number): AppState => {
  const state = createSeedState(FIXED_NOW);
  state.tasks[0]!.title = `版 ${n}`;
  state.counters.task += n;
  return state;
};

const UNRELATED: Record<string, string> = {
  'notes.txt': '運用メモ',
  'state.json.bak': '手動バックアップ',
  // 別のプロセスが残した（または無関係な）一時ファイル名。保存処理は自分が作ったもの以外を消さない。
  '.state.json.4242.deadbeef.tmp': '他のプロセスの一時ファイル',
};

let dir: string;
let file: string;
let cleanup: (() => Promise<void>) | undefined;

beforeEach(async () => {
  const temp = await tempDir();
  cleanup = temp.cleanup;
  dir = temp.dir;
  file = path.join(dir, 'state.json');
  const initial = new FileStore(file);
  await initial.load();
  await initial.save(variant(0));
  for (const [name, content] of Object.entries(UNRELATED)) await writeFile(path.join(dir, name), content, 'utf8');
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const ownTemps = async () => (await readdir(dir)).filter((name) => name.endsWith('.tmp') && !(name in UNRELATED));
const persisted = async () => JSON.parse(await readFile(file, 'utf8')) as AppState;
async function expectUnrelatedIntact() {
  for (const [name, content] of Object.entries(UNRELATED)) expect(await readFile(path.join(dir, name), 'utf8')).toBe(content);
}

describe('ローカル JSON 保存: 確定の手順と応答の境界', () => {
  it('POSIX では一時ファイルを排他・所有者のみで作り、全書込 → fsync → close → rename → ディレクトリ fsync を終えてから保存が完了する', async () => {
    const h = harness(file, { platform: 'linux' });
    const store = new FileStore(file, undefined, h.ops);
    await store.load();
    h.calls.length = 0;

    const directorySync = h.hold('sync-dir');
    let acknowledged = false;
    const saving = store.save(variant(1)).then(() => {
      acknowledged = true;
    });
    await directorySync.reached;
    // rename は済んで新しい内容は見えているが、ディレクトリの fsync が終わるまで保存は完了扱いにならない。
    expect(await persisted()).toEqual(variant(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acknowledged).toBe(false);
    directorySync.release();
    await saving;
    expect(acknowledged).toBe(true);

    expect(h.calls).toEqual(['open-temp wx 600', 'write-temp', 'sync-temp', 'close-temp', 'rename', 'open-dir', 'sync-dir', 'close-dir']);
    expect(path.dirname(h.tempPaths[0]!)).toBe(dir);
    expect(path.basename(h.tempPaths[0]!)).toMatch(new RegExp(`^\\.state\\.json\\.${process.pid}\\.[0-9a-f-]+\\.tmp$`));
    expect(h.openHandles()).toBe(0);
    expect(store.powerLossDurable).toBe(true);
    expect(await ownTemps()).toEqual([]);
  });

  it('Windows ではディレクトリの fsync を行わず、電源断に対する永続性を表明しない', async () => {
    const h = harness(file, { platform: 'win32' });
    const store = new FileStore(file, undefined, h.ops);
    await store.load();
    h.calls.length = 0;
    await store.save(variant(1));
    expect(h.calls).toEqual(['open-temp wx 600', 'write-temp', 'sync-temp', 'close-temp', 'rename']);
    expect(store.powerLossDurable).toBe(false);
    expect(new FileStore(file, undefined, harness(file, { platform: 'linux' }).ops).powerLossDurable).toBe(true);
    expect(await persisted()).toEqual(variant(1));
  });

  it('POSIX で読み込むときは、内容を返す前にファイルとディレクトリを fsync する（前回の未確定の rename を確定させる）', async () => {
    const h = harness(file, { platform: 'linux' });
    const store = new FileStore(file, undefined, h.ops);
    expect(await store.load()).toEqual(variant(0));
    expect(h.calls).toEqual(['open-data', 'sync-data', 'close-data', 'open-dir', 'sync-dir', 'close-dir']);
    expect(h.openHandles()).toBe(0);
  });

  it('一時ファイル名は保存ごとに一意で、同じ名前のファイルが既にあれば再利用・削除せずに失敗する', async () => {
    const unique = harness(file);
    const store = new FileStore(file, undefined, unique.ops);
    await store.load();
    await store.save(variant(1));
    await store.save(variant(2));
    expect(new Set(unique.tempPaths).size).toBe(2);
    expect(await ownTemps()).toEqual([]);

    const fixed = harness(file, { suffix: () => 'fixed' });
    const planted = path.join(dir, `.state.json.${process.pid}.fixed.tmp`);
    await writeFile(planted, '置かれていたファイル', 'utf8');
    const before = await readFile(file);
    const collide = new FileStore(file, undefined, fixed.ops);
    await collide.load();
    await expect(collide.save(variant(3))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(planted, 'utf8')).toBe('置かれていたファイル');
    expect(await readFile(file)).toEqual(before);
    expect(fixed.calls).not.toContain('unlink');
    await expectUnrelatedIntact();
  });

  it.skipIf(process.platform === 'win32')('POSIX の実ファイルでは、保存後のファイルの権限が所有者のみ（600）になる', async () => {
    const store = new FileStore(file);
    await store.load();
    await store.save(variant(1));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe('ローカル JSON 保存: 失敗したときの結果', () => {
  it.each([
    ['一時ファイルの作成', 'open-temp', 'EACCES'],
    ['一時ファイルの書込（途中まで書いて失敗）', 'write-temp', 'ENOSPC'],
    ['一時ファイルの fsync', 'sync-temp', 'EIO'],
    ['一時ファイルの close', 'close-temp', 'EIO'],
    ['rename（再試行しない失敗）', 'rename', 'EIO'],
    ['rename（再試行後も失敗）', 'rename', 'EPERM'],
  ] as Array<[string, Step, string]>)('%s が失敗すると確定前の失敗として拒否し、前の内容が残り、自分の一時ファイルだけを消す', async (_label, step, code) => {
    const h = harness(file, { platform: 'linux' });
    const store = new FileStore(file, undefined, h.ops);
    await store.load();
    h.calls.length = 0;
    const before = await readFile(file);
    // EPERM は再試行の対象。5 回とも失敗させる（6 回目を試すなら成功してしまい、このテストは失敗する）。
    h.failNext(step, code, step === 'rename' && code === 'EPERM' ? 5 : 1);

    const error = await store.save(variant(1)).then(
      () => null,
      (caught: unknown) => caught as Error & { code?: string },
    );
    expect(error).toMatchObject({ code });
    expect(error?.name).not.toBe('CommitUncertainError');

    expect(await readFile(file)).toEqual(before);
    expect(await new FileStore(file).load()).toEqual(variant(0));
    expect(await ownTemps()).toEqual([]);
    await expectUnrelatedIntact();
    expect(h.openHandles()).toBe(0);
    expect(h.calls).not.toContain('open-dir');
    if (step === 'rename' && code === 'EPERM') expect(h.calls.filter((call) => call === 'rename')).toHaveLength(5);
    if (step === 'rename' && code === 'EIO') expect(h.calls.filter((call) => call === 'rename')).toHaveLength(1);
    expect(h.calls.includes('unlink')).toBe(step !== 'open-temp');

    // 前の内容のままなので、同じストアで続けて保存できる。
    await store.save(variant(2));
    expect(await persisted()).toEqual(variant(2));
  });

  it.each([
    ['ディレクトリを開く', 'open-dir', 'EACCES'],
    ['ディレクトリの fsync', 'sync-dir', 'EIO'],
    ['ディレクトリの close', 'close-dir', 'EIO'],
  ] as Array<[string, Step, string]>)('POSIX: rename 後に%sことが失敗すると「確定したか不明」として拒否し、巻き戻したとは扱わない', async (_label, step, code) => {
    const h = harness(file, { platform: 'linux' });
    const store = new FileStore(file, undefined, h.ops);
    await store.load();
    h.failNext(step, code);

    const error = await store.save(variant(1)).then(
      () => null,
      (caught: unknown) => caught as Error & { cause?: { code?: string } },
    );
    expect(error?.name).toBe('CommitUncertainError');
    expect(error?.cause?.code).toBe(code);
    // 新しい内容は既に置き換わっている（元に戻したとは報告しない）。
    expect(await persisted()).toEqual(variant(1));
    expect(await ownTemps()).toEqual([]);
    await expectUnrelatedIntact();
    expect(h.openHandles()).toBe(0);
  });
});

describe('ローカル JSON 保存: 単一書込者と重なった保存', () => {
  it('同じストアへの重なった保存は呼び出し順に 1 件ずつ確定し、古い内容が新しい内容を上書きしない', async () => {
    const h = harness(file, { platform: 'linux' });
    // 先に呼んだ保存ほど書込を遅らせる。直列化していなければ後の保存が先に確定する。
    h.delays['write-temp'] = [60, 40, 20, 0, 0];
    const store = new FileStore(file, undefined, h.ops);
    await store.load();
    h.calls.length = 0;
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.save(variant(n))));
    expect(await persisted()).toEqual(variant(5));
    const pattern = ['open-temp wx 600', 'write-temp', 'sync-temp', 'close-temp', 'rename', 'open-dir', 'sync-dir', 'close-dir'];
    expect(h.calls).toEqual([...pattern, ...pattern, ...pattern, ...pattern, ...pattern]);
    expect(await ownTemps()).toEqual([]);
  });

  it('別のストアが先に保存したファイルには、古い読み込みに基づく保存をしない（読み直せば保存できる）', async () => {
    const first = new FileStore(file);
    const second = new FileStore(file);
    await first.load();
    await second.load();
    await first.save(variant(1));
    await expect(second.save(variant(2))).rejects.toMatchObject({ name: 'StaleStateError' });
    expect(await persisted()).toEqual(variant(1));
    expect(await second.load()).toEqual(variant(1));
    await second.save(variant(2));
    expect(await persisted()).toEqual(variant(2));
  });

  it('同時に保存した 2 つのストアは一方だけが確定し、他方は拒否される', async () => {
    const first = new FileStore(file);
    const second = new FileStore(file);
    await first.load();
    await second.load();
    const results = await Promise.allSettled([first.save(variant(1)), second.save(variant(2))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ name: 'StaleStateError' });
    expect(await persisted()).toEqual(results[0]!.status === 'fulfilled' ? variant(1) : variant(2));
  });

  it('読み込み後にファイルが外部で置き換えられていれば上書きしない', async () => {
    const store = new FileStore(file);
    await store.load();
    const outside = path.join(dir, 'outside.json');
    await writeFile(outside, `${JSON.stringify(variant(7), null, 2)}\n`, 'utf8');
    await rename(outside, file);
    await expect(store.save(variant(1))).rejects.toMatchObject({ name: 'StaleStateError' });
    expect(await persisted()).toEqual(variant(7));
  });

  it('読み込む前の保存は拒否し、既存のファイルを上書きせず、無いファイルも作らない', async () => {
    const before = await readFile(file);
    await expect(new FileStore(file).save(variant(9))).rejects.toMatchObject({ name: 'StaleStateError' });
    expect(await readFile(file)).toEqual(before);
    const fresh = path.join(dir, 'fresh.json');
    await expect(new FileStore(fresh).save(variant(9))).rejects.toMatchObject({ name: 'StaleStateError' });
    expect(existsSync(fresh)).toBe(false);
  });
});

describe('ローカル JSON 保存: 壊れた・不完全な・通常でないファイル', () => {
  it.each([
    ['空のファイル', () => ''],
    ['途中で切れた JSON（書込途中の状態）', () => JSON.stringify(variant(1)).slice(0, 200)],
    ['形式の異なる JSON', () => '{"schemaVersion":99}'],
  ])('%s は読み込みで拒否し、ファイルを変えず、その後の保存もしない', async (_label, content) => {
    await writeFile(file, content(), 'utf8');
    const before = await readFile(file);
    const store = new FileStore(file);
    await expect(store.load()).rejects.toMatchObject({ name: 'CorruptStateError' });
    await expect(store.save(variant(1))).rejects.toMatchObject({ name: 'StaleStateError' });
    expect(await readFile(file)).toEqual(before);
    expect(await ownTemps()).toEqual([]);
  });

  it('保存ファイルがシンボリックリンクなら読み込み・保存とも拒否し、リンク先を変えない', async (ctx) => {
    const real = path.join(dir, 'real.json');
    await writeFile(real, `${JSON.stringify(variant(4))}\n`, 'utf8');
    const link = path.join(dir, 'link.json');
    try {
      await symlink(real, link, 'file');
    } catch {
      ctx.skip(); // このホストではシンボリックリンクを作成する権限がない。
    }
    const before = await readFile(real);
    const store = new FileStore(link);
    await expect(store.load()).rejects.toMatchObject({ name: 'CorruptStateError' });
    await expect(store.save(variant(1))).rejects.toMatchObject({ name: 'StaleStateError' });
    expect(await readFile(real)).toEqual(before);
  });
});
