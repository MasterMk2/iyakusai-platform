import path from 'node:path';
import { NODE_STORE_OPS, type FileStoreOps, type StoreFileHandle } from '../../src/task-service/server/storage/fileStore.js';

// テスト専用: FileStore に渡すファイル操作を包み、呼び出し順の記録・指定した手順での errno の模擬・
// 手順の一時停止を行う。アプリ側は操作を受け取るだけで、障害注入の経路は持たない。
// platform に POSIX を指定すると、Windows 上でもディレクトリ fsync を含む手順を確認できる（このとき
// Windows では実行できない読み取り専用ハンドル・ディレクトリの fsync は記録だけして実行しない）。

export type Kind = 'temp' | 'data' | 'dir';
export type Step = `${'open' | 'write' | 'sync' | 'close'}-${Kind}` | 'rename' | 'unlink';

export const errno = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });

export interface Harness {
  ops: FileStoreOps;
  /** 記録した手順（open-temp は「open-temp <flags> <mode>」）。 */
  calls: string[];
  /** 作成を試みた一時ファイルのパス。 */
  tempPaths: string[];
  /** step を times 回だけ code で失敗させる（write は半分だけ書いてから失敗する）。 */
  failNext(step: Step, code: string, times?: number): void;
  /** 次に step に達したところで止める。reached は到達、release で再開。 */
  hold(step: Step): { reached: Promise<void>; release: () => void };
  /** step の前に毎回 ms 待つ（重なった保存の順序を崩すため）。 */
  delays: Partial<Record<Step, number[]>>;
  openHandles(): number;
}

export function harness(dataFile: string, options: { platform?: NodeJS.Platform; suffix?: () => string } = {}): Harness {
  const platform = options.platform ?? process.platform;
  const dir = path.dirname(dataFile);
  const calls: string[] = [];
  const tempPaths: string[] = [];
  const failures = new Map<Step, { code: string; remaining: number }>();
  const holds = new Map<Step, { reached: () => void; released: Promise<void> }>();
  const delays: Partial<Record<Step, number[]>> = {};
  let open = 0;

  const kindOf = (target: string): Kind =>
    path.resolve(target) === path.resolve(dataFile) ? 'data' : path.resolve(target) === path.resolve(dir) ? 'dir' : 'temp';
  const before = async (step: Step) => {
    const hold = holds.get(step);
    if (hold) {
      holds.delete(step);
      hold.reached();
      await hold.released;
    }
    const wait = delays[step]?.shift();
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  };
  const failure = (step: Step): Error | null => {
    const entry = failures.get(step);
    if (!entry || entry.remaining <= 0) return null;
    entry.remaining -= 1;
    return errno(entry.code);
  };

  const ops: FileStoreOps = {
    ...NODE_STORE_OPS,
    platform,
    randomSuffix: options.suffix ?? NODE_STORE_OPS.randomSuffix,
    async open(target, flags, mode) {
      const kind = kindOf(target);
      const step: Step = `open-${kind}`;
      if (kind === 'temp') tempPaths.push(target);
      await before(step);
      calls.push(kind === 'temp' ? `${step} ${String(flags)} ${mode?.toString(8)}` : step);
      const injected = failure(step);
      if (injected) throw injected;
      const real = await NODE_STORE_OPS.open(target, flags, mode);
      open += 1;
      // Windows はディレクトリや読み取り専用ハンドルを fsync できない（EPERM）。POSIX を模擬するときは記録だけ。
      const realSync = process.platform !== 'win32' || kind === 'temp';
      const handle: StoreFileHandle = {
        async write(buffer, offset, length, position) {
          await before(`write-${kind}`);
          calls.push(`write-${kind}`);
          const error = failure(`write-${kind}`);
          if (error) {
            await real.write(buffer, offset, Math.floor(length / 2), position);
            throw error;
          }
          return real.write(buffer, offset, length, position);
        },
        async sync() {
          await before(`sync-${kind}`);
          calls.push(`sync-${kind}`);
          const error = failure(`sync-${kind}`);
          if (error) throw error;
          if (realSync) await real.sync();
        },
        async close() {
          await before(`close-${kind}`);
          calls.push(`close-${kind}`);
          // 実際のハンドルは閉じたうえで失敗を返す（close の失敗でも記述子は解放される）。
          await real.close();
          open -= 1;
          const error = failure(`close-${kind}`);
          if (error) throw error;
        },
        stat: (statOptions) => real.stat(statOptions),
        readFile: (encoding) => real.readFile(encoding),
      };
      return handle;
    },
    async rename(from, to) {
      await before('rename');
      calls.push('rename');
      const error = failure('rename');
      if (error) throw error;
      return NODE_STORE_OPS.rename(from, to);
    },
    async unlink(target) {
      await before('unlink');
      calls.push('unlink');
      return NODE_STORE_OPS.unlink(target);
    },
  };

  return {
    ops,
    calls,
    tempPaths,
    delays,
    failNext(step, code, times = 1) {
      failures.set(step, { code, remaining: times });
    },
    hold(step) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reachedResolve!: () => void;
      const reachedPromise = new Promise<void>((resolve) => {
        reachedResolve = resolve;
      });
      holds.set(step, { reached: reachedResolve, released });
      const timeout = new Promise<void>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`step ${step} was not reached`)), 4000).unref(),
      );
      return { reached: Promise.race([reachedPromise, timeout]), release };
    },
    openHandles: () => open,
  };
}
