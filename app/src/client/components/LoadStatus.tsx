import type { ApiFailure } from '../api';

interface LoaderLike {
  loading: boolean;
  error: ApiFailure | null;
  cancelled: boolean;
  retry: () => void;
  cancel: () => void;
  /** Data from an earlier answer (reloads keep it on screen). */
  data?: unknown;
}

/**
 * Shared loading / failure / cancelled UI with retry and cancel actions. A reload over data that is
 * already on screen floats its status over the top corner of the pane (outside the flow), so nothing
 * below it moves; a failure then keeps that data and says it may be old.
 */
export function LoadStatus({ loader, what, compact = false }: { loader: LoaderLike; what: string; compact?: boolean }) {
  const shown = loader.data !== undefined && loader.data !== null;
  if (loader.loading) {
    if (shown) {
      return (
        <div className="status loading status-reloading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {what}を読み込み中…
          <button type="button" className="secondary" onClick={loader.cancel}>
            キャンセル
          </button>
        </div>
      );
    }
    return (
      <div className={`status loading ${compact ? 'compact' : ''}`} role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        {what}を読み込み中…
        <button type="button" className="secondary" onClick={loader.cancel}>
          キャンセル
        </button>
      </div>
    );
  }
  if (loader.error) {
    return (
      <div className={`status error ${compact ? 'compact' : ''}`} role="alert">
        {what}を読み込めませんでした: {loader.error.message}
        {shown && '（前回の内容を表示しています）'}
        <button type="button" onClick={loader.retry}>
          再試行
        </button>
      </div>
    );
  }
  if (loader.cancelled) {
    return (
      <div className={`status cancelled ${compact ? 'compact' : ''}`} role="status">
        {what}の読み込みを取り消しました。前回の表示内容を保持しています。
        <button type="button" onClick={loader.retry}>
          再読み込み
        </button>
      </div>
    );
  }
  return null;
}
