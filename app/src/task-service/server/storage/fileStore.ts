import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isAppState, type AppState } from '../domain/state.js';
import { CommitUncertainError, CorruptStateError, StaleStateError, type Store } from './store.js';

// 状態全体を JSON ファイル 1 つに置き換え保存する。保存の手順:
//  1. 同じディレクトリに一意な名前の一時ファイルを排他作成する（'wx': 既存のファイルやリンクを再利用・追従しない。
//     POSIX では所有者のみの権限 600）。
//  2. 全体を書き込み、fsync してから閉じる。
//  3. rename で保存ファイルを原子的に置き換える。
//  4. POSIX では親ディレクトリを fsync し、rename 自体を確定させる。ここまで終わってから保存を完了とする。
//     Windows では Node からディレクトリを fsync できない（EPERM）ため 4 を行わず、電源断に対する永続性は表明しない。
// 3 より前の失敗では、この呼び出しが作った一時ファイルだけを消し、前の保存内容を残してエラーにする。
// 3 の後に 4 が失敗した場合は CommitUncertainError（新しい内容は見えているが確定は不明）。
// 単一書込者が前提。最後に読み込み・保存したファイル（デバイス・i ノード・サイズ）と現在のファイルが
// 違えば、上書きせずに StaleStateError にする（同じプロセス内では同じパスへの読み書きを 1 件ずつ行う）。
// 他のプロセスとの間の排他ではなく、検出も確実ではない。

/** 保存に使うファイルハンドルの操作。 */
export interface StoreFileHandle {
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
  stat(options: { bigint: true }): Promise<BigIntStats>;
  readFile(encoding: 'utf8'): Promise<string>;
}

/** ファイル操作。テストで失敗や中断を模擬するために差し替えられる（アプリは既定の Node の操作だけを使う）。 */
export interface FileStoreOps {
  platform: NodeJS.Platform;
  open(target: string, flags: string | number, mode?: number): Promise<StoreFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
  lstat(target: string): Promise<BigIntStats>;
  mkdir(target: string, mode: number): Promise<void>;
  randomSuffix(): string;
}

export const NODE_STORE_OPS: FileStoreOps = {
  platform: process.platform,
  open: (target, flags, mode) => open(target, flags, mode),
  rename,
  unlink,
  lstat: (target) => lstat(target, { bigint: true }),
  mkdir: async (target, mode) => {
    // 無いディレクトリだけを所有者のみの権限で作る。既存のディレクトリの権限は変えない。
    await mkdir(target, { recursive: true, mode });
  },
  randomSuffix: () => randomUUID(),
};

// 保存ファイルがシンボリックリンクに置き換えられていても追従しない（O_NOFOLLOW は POSIX のみ）。
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
}

const identityOf = (stats: BigIntStats): FileIdentity => ({ dev: stats.dev, ino: stats.ino, size: stats.size });
const sameIdentity = (a: FileIdentity | 'absent', b: FileIdentity | 'absent') =>
  a === 'absent' || b === 'absent' ? a === b : a.dev === b.dev && a.ino === b.ino && a.size === b.size;

// 同じプロセス内で同じ保存ファイルを扱う読み書きを 1 件ずつ行う（ストアのインスタンスが別でも）。
const pathQueues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (pathQueues.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  pathQueues.set(key, tail);
  void tail.then(() => {
    if (pathQueues.get(key) === tail) pathQueues.delete(key);
  });
  return run;
}

/** work の成否にかかわらずハンドルを閉じる。work が成功したときだけ close の失敗を返す。 */
async function closing<T>(handle: StoreFileHandle, work: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
  return result;
}

const errnoOf = (error: unknown) => (error as NodeJS.ErrnoException).code;

export class FileStore implements Store {
  readonly description: string;
  /** 保存の完了前にファイルとディレクトリの両方を fsync するか（Windows 以外）。 */
  readonly powerLossDurable: boolean;
  private readonly key: string;
  /** 最後に読み込み・保存したファイル。undefined は読み込み前（保存しない）。 */
  private expected: FileIdentity | 'absent' | undefined;

  constructor(
    private readonly filePath: string,
    displayPath = path.basename(filePath),
    private readonly ops: FileStoreOps = NODE_STORE_OPS,
  ) {
    this.description = `ローカル JSON ファイル（${displayPath}）`;
    this.powerLossDurable = ops.platform !== 'win32';
    const resolved = path.resolve(filePath);
    this.key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  load(): Promise<AppState | null> {
    return serialized(this.key, () => this.loadNow());
  }

  save(state: AppState): Promise<void> {
    return serialized(this.key, () => this.saveNow(state));
  }

  /** 読めない保存ファイルを退避する（デモ用）。退避先は同じディレクトリ内。 */
  quarantine(now: Date): Promise<string> {
    return serialized(this.key, async () => {
      const target = `${this.filePath}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`;
      await this.ops.rename(this.filePath, target);
      this.expected = 'absent';
      return path.basename(target);
    });
  }

  private async loadNow(): Promise<AppState | null> {
    this.expected = undefined;
    let link: BigIntStats;
    try {
      link = await this.ops.lstat(this.filePath);
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') throw error;
      this.expected = 'absent';
      return null;
    }
    if (!link.isFile()) throw new CorruptStateError('保存ファイルが通常のファイルではありません（シンボリックリンクなどは使えません）。');

    const handle = await this.ops.open(this.filePath, READ_FLAGS);
    const { identity, text } = await closing(handle, async () => {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.dev !== link.dev || info.ino !== link.ino) {
        throw new CorruptStateError('保存ファイルが読み込みの途中で置き換えられました。');
      }
      const content = await handle.readFile('utf8');
      // 前回のプロセスが rename の確定前に止まっていても、ここで内容を確定させてから使う。
      if (this.powerLossDurable) await handle.sync();
      return { identity: identityOf(info), text: content };
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CorruptStateError('保存ファイルを JSON として読み込めません。');
    }
    if (!isAppState(parsed)) throw new CorruptStateError('保存ファイルの形式が想定と異なります。');
    if (this.powerLossDurable) await this.syncDirectory();
    this.expected = identity;
    return parsed;
  }

  private async saveNow(state: AppState): Promise<void> {
    if (this.expected === undefined) {
      throw new StaleStateError('保存ファイルを読み込む前には保存しません（既存の内容を上書きしないため）。');
    }
    if (!sameIdentity(await this.currentIdentity(), this.expected)) {
      throw new StaleStateError('保存ファイルが、最後の読み込み・保存の後に変更されています。');
    }
    const dir = path.dirname(this.filePath);
    await this.ops.mkdir(dir, 0o700);
    const data = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    const temp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${this.ops.randomSuffix()}.tmp`);

    // 排他作成に失敗した場合（同名のファイルがある等）は、自分のファイルではないので消さない。
    const handle = await this.ops.open(temp, 'wx', 0o600);
    let identity: FileIdentity;
    try {
      identity = await closing(handle, async () => {
        for (let offset = 0; offset < data.length; ) {
          const { bytesWritten } = await handle.write(data, offset, data.length - offset, offset);
          if (bytesWritten <= 0) throw Object.assign(new Error('一時ファイルへの書込が進みません。'), { code: 'EIO' });
          offset += bytesWritten;
        }
        await handle.sync();
        return identityOf(await handle.stat({ bigint: true }));
      });
      await this.renameWithRetry(temp);
    } catch (error) {
      await this.ops.unlink(temp).catch(() => undefined);
      throw error;
    }

    // ここから先は新しい内容が保存ファイルとして見えている。
    this.expected = identity;
    if (!this.powerLossDurable) return;
    try {
      await this.syncDirectory();
    } catch (error) {
      throw new CommitUncertainError('保存ファイルを置き換えましたが、確定（ディレクトリの fsync）を確認できませんでした。', { cause: error });
    }
  }

  private async currentIdentity(): Promise<FileIdentity | 'absent'> {
    let stats: BigIntStats;
    try {
      stats = await this.ops.lstat(this.filePath);
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return 'absent';
      throw error;
    }
    if (!stats.isFile()) throw new StaleStateError('保存ファイルが通常のファイルではありません。');
    return identityOf(stats);
  }

  private async syncDirectory(): Promise<void> {
    const handle = await this.ops.open(path.dirname(this.filePath), 'r');
    await closing(handle, () => handle.sync());
  }

  private async renameWithRetry(from: string): Promise<void> {
    // Windows ではウイルス対策ソフトなどが一時的にファイルを開いていると置き換えに失敗することがある。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.ops.rename(from, this.filePath);
        return;
      } catch (error) {
        const code = errnoOf(error);
        if (attempt >= 4 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
}
