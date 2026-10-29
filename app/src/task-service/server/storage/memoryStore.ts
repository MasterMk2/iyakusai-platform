import type { AppState } from '../domain/state.js';
import type { Store } from './store.js';

/** テスト用の保存先。保存内容は複製して保持し、呼び出し側の変更の影響を受けない。 */
export class MemoryStore implements Store {
  readonly description = 'メモリ内（プロセス終了で消える）';
  saveCount = 0;
  private snapshot: string | null;

  constructor(initial: AppState | null = null) {
    this.snapshot = initial === null ? null : JSON.stringify(initial);
  }

  async load(): Promise<AppState | null> {
    return this.snapshot === null ? null : (JSON.parse(this.snapshot) as AppState);
  }

  async save(state: AppState): Promise<void> {
    this.snapshot = JSON.stringify(state);
    this.saveCount += 1;
  }

  peek(): AppState | null {
    return this.snapshot === null ? null : (JSON.parse(this.snapshot) as AppState);
  }
}
