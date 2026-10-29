import type { AppState } from '../domain/state.js';

/**
 * 状態の保存先。1 プロセスが状態全体を 1 文書として読み書きする（単一書込者）。
 * 複数プロセス・複数台からの同時書込には対応しない。
 */
export interface Store {
  /** 保存済みの状態。まだ保存されていなければ null。 */
  load(): Promise<AppState | null>;
  /**
   * 状態全体を置き換える。解決したら確定済み。CommitUncertainError 以外で失敗した場合は、
   * 以前の保存内容が残っている。
   */
  save(state: AppState): Promise<void>;
  /** 利用者向けの保存先の説明（絶対パスは含めない）。 */
  readonly description: string;
}

export class CorruptStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptStateError';
  }
}

/**
 * 新しい内容への置き換え（rename）は済んだが、確定（ディレクトリの fsync）を確認できなかった。
 * 新しい内容は見えているが、電源断の後に残るかは分からない。成功とも、元に戻したとも扱わない。
 */
export class CommitUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CommitUncertainError';
  }
}

/**
 * 最後に読み込み・保存した後で保存ファイルが変わっている（または読み込む前）ため、上書きせずに拒否した。
 * ファイルには何も書いていない。
 */
export class StaleStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleStateError';
  }
}
