// Orderly, bounded shutdown of the common Web server (SIGTERM / SIGINT).
//  1. Stop accepting: the HTTP server closes its listener and waits for in-flight requests.
//  2. Drain the login DM dispatch queue (each delivery is itself bounded by the delivery timeout).
//     A code becomes usable only after the transport acknowledged it; anything still unacknowledged
//     when the deadline passes stays unusable, and a restart never revives it.
//  3. Flush the login state (last-seen times are otherwise written lazily). Mail, LINE and task-link
//     files and the audit log are written synchronously on every change, so nothing else is pending.
//  4. Report the exit code: 0 when every step finished in time, 1 otherwise.
// Messages are fixed, sanitized strings: never error text, paths, identities or secrets.

export interface ShutdownTarget {
  app: { close(): Promise<unknown> };
  account: { service: { idle(): Promise<void>; flush(): boolean } } | null;
}

export interface ShutdownOptions {
  /** Upper bound for the whole sequence. */
  timeoutMs?: number;
  log?: (message: string) => void;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

export function createShutdown(target: ShutdownTarget, options: ShutdownOptions = {}): (reason: string) => Promise<number> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const log = options.log ?? ((message: string) => console.error(message));
  let running: Promise<number> | null = null;

  async function sequence(): Promise<number> {
    let ok = true;
    try {
      await target.app.close();
    } catch {
      ok = false;
      log('終了処理: 受付の停止中に問題が発生しました。');
    }
    if (target.account) {
      try {
        await target.account.service.idle();
      } catch {
        ok = false;
      }
    }
    return ok ? 0 : 1;
  }

  return (reason: string) => {
    if (running) return running;
    log(`終了処理を開始しました（${reason === 'SIGINT' || reason === 'SIGTERM' ? reason : '要求'}）。新しい要求の受付を停止します。`);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref();
    });
    running = Promise.race([sequence(), deadline]).then((result) => {
      clearTimeout(timer);
      let code = result === 'timeout' ? 1 : result;
      if (result === 'timeout') log('終了処理: 期限内に完了しなかった処理があります。未確認の DM コードは使えないまま残ります。');
      // Flush whatever state exists now, also after a timeout (fail closed: never claims success).
      if (target.account && !target.account.service.flush()) {
        code = 1;
        log('終了処理: ログイン状態を保存できませんでした。');
      }
      log(code === 0 ? '終了処理が完了しました。' : '終了処理を終えました（一部未完了）。');
      return code;
    });
    return running;
  };
}

/** Wires SIGTERM/SIGINT to one shutdown; repeated signals do not start a second one. */
export function installSignalHandlers(
  emitter: { on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown },
  shutdown: (reason: string) => Promise<number>,
  exit: (code: number) => void,
): void {
  let started = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    emitter.on(signal, () => {
      if (started) return;
      started = true;
      void shutdown(signal).then(exit, () => exit(1));
    });
  }
}
