import { useState } from 'react';
import type { RolloverRunView, RolloverUndoResponse } from '../../../shared/rollover';
import { fmtDate, toFailure } from '../../api';
import { rolloverApi } from './rolloverApi';

// Small pieces the rollover steps share: one run's line, and taking a copy back.

export const RUN_STATUS: Record<RolloverRunView['status'], string> = { done: '済み', undone: '取り消した', running: '途中' };

/** One line of a run: what, when, who. */
export function RunLine({ run }: { run: RolloverRunView }) {
  const at = run.undoneAt ?? run.finishedAt ?? run.startedAt;
  return (
    <span>
      <strong>{RUN_STATUS[run.status]}</strong>：{run.summary}（{fmtDate(at)}・{run.status === 'undone' ? `${run.undoneByName ?? '不明'}さんが取り消し` : `${run.actorName}さん`}）
    </span>
  );
}

/** Takes a copy back, and says what was removed and what was kept. */
export function UndoButton({ run, onUndone }: { run: RolloverRunView; onUndone: (result: RolloverUndoResponse) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      onUndone(await rolloverApi.undo(run.id));
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="secondary" onClick={() => void undo()} disabled={busy}>
        {busy ? '取り消し中…' : 'この写しを取り消す'}
      </button>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** What an undo did, for the place it was pressed. */
export function UndoResult({ result }: { result: RolloverUndoResponse }) {
  return (
    <div className="status ok" role="status">
      <span>
        取り消しました（消したもの {result.removed.length} 件{result.kept.length > 0 ? `・残したもの ${result.kept.length} 件` : ''}）。
      </span>
      {result.kept.length > 0 && (
        <ul className="rollover-reasons">
          {result.kept.map((k, i) => (
            <li key={`${k.name}-${i}`}>
              {k.name}：{k.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
