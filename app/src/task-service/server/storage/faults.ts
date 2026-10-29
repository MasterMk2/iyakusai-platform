import type { FaultSettings } from '../../shared/types.js';
import { AppError } from '../domain/errors.js';

/**
 * デモ用の障害注入。読み込み・保存の失敗と応答遅延を、指定回数だけ意図的に起こす。
 * 再試行やキャンセルの画面表示を確認するためのもので、本番機能ではない。
 */
export class FaultInjector {
  private settings: FaultSettings = { failNextLoads: 0, failNextSaves: 0, delayMs: 0 };

  get(): FaultSettings {
    return { ...this.settings };
  }

  set(settings: FaultSettings): FaultSettings {
    this.settings = { ...settings };
    return this.get();
  }

  clear(): void {
    this.settings = { failNextLoads: 0, failNextSaves: 0, delayMs: 0 };
  }

  async beforeLoad(): Promise<void> {
    await this.delay();
    if (this.settings.failNextLoads > 0) {
      this.settings.failNextLoads -= 1;
      throw new AppError('LOAD_FAILED', 'データの読み込みに失敗しました（デモの障害注入）。もう一度お試しください。');
    }
  }

  async beforeSave(): Promise<void> {
    await this.delay();
    if (this.settings.failNextSaves > 0) {
      this.settings.failNextSaves -= 1;
      throw new AppError('SAVE_FAILED', '保存に失敗しました（デモの障害注入）。変更は反映されていません。もう一度お試しください。');
    }
  }

  private async delay(): Promise<void> {
    if (this.settings.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.settings.delayMs));
  }
}
