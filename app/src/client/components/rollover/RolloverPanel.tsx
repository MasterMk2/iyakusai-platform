import { useCallback, useState } from 'react';
import type { RolloverStep, RolloverStepState } from '../../../shared/rollover';
import { fmtDate } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { CalendarStep, OrganizationsStep } from './CopySteps';
import { GrantsStep, HandoverStep, TasksStep } from './ReviewSteps';
import { rolloverApi } from './rolloverApi';
import { RUN_STATUS, RunLine } from './RunParts';
import './rollover.css';

// 年度の切り替え (settings, access administrators only): what the officers do once a year. Closed by default; open,
// it shows one source year and the five steps as a list with where each one stands, and opens one step at a time in
// place. Every step goes preview → confirm; a copy can be taken back while its copies are unchanged.

function stepState(state: RolloverStepState): string {
  if (!state.available) return '使えません';
  if (!state.last) return state.step === 'organizations' || state.step === 'calendar' ? 'まだ写していません' : 'まだ使っていません';
  return `${RUN_STATUS[state.last.status]}・${fmtDate(state.last.undoneAt ?? state.last.finishedAt ?? state.last.startedAt)}`;
}

export function RolloverPanel() {
  const [year, setYear] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return rolloverApi.meta(year, signal);
    },
    [year, refresh],
  );
  const meta = useLoader(load);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<RolloverStep | null>(null);
  const changed = useCallback(() => setRefresh((n) => n + 1), []);

  // Shown once the server has answered: not on this server (no rollover file) or not for this account, nothing at all.
  if (!meta.data && !meta.error) return null;
  if (!meta.data && meta.error && (meta.error.status === 404 || meta.error.status === 403)) return null;
  const data = meta.data;
  const sourceYear = data?.sourceYear ?? null;

  return (
    <section className="admin rollover" aria-labelledby="rollover-title" data-testid="rollover">
      <div className="rollover-head">
        <h3 id="rollover-title">年度の切り替え</h3>
        <button type="button" className="secondary" aria-expanded={expanded} aria-controls="rollover-body" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '閉じる' : '開く'}
        </button>
      </div>
      <p className="hint">役員が替わるときに、年に一度使います。団体の台帳と毎年の予定を次の年度に写し、未完了のタスク・権限・引き継ぎの資料を確かめます。どの手順も、下見で中身を確かめてから確定します。</p>
      {expanded && (
        <div id="rollover-body" className="rollover-body">
          <LoadStatus loader={meta} what="年度の切り替え" compact />
          {data && sourceYear !== null && (
            <>
              <div className="rollover-year">
                <label htmlFor="rollover-year">写す元の年度</label>
                <select
                  id="rollover-year"
                  value={sourceYear}
                  onChange={(e) => {
                    setYear(Number(e.target.value));
                    setOpen(null);
                  }}
                >
                  {data.years.map((y) => (
                    <option key={y} value={y}>
                      {y}年度 → {y + 1}年度
                    </option>
                  ))}
                </select>
                <p className="hint">年度は医薬祭の年です（{sourceYear}年度は{sourceYear}年の医薬祭）。カレンダーでは、その年の1月から12月をその年度として扱います。</p>
              </div>
              <ol className="rollover-steps">
                {data.steps.map((state, i) => {
                  const isOpen = open === state.step && state.available;
                  return (
                    <li key={state.step} className={`rollover-step ${isOpen ? 'is-open' : ''}`} data-step={state.step}>
                      <div className="rollover-step-head">
                        <span className="rollover-step-no" aria-hidden="true">
                          {i + 1}
                        </span>
                        <div className="rollover-step-text">
                          <h4 id={`rollover-step-${state.step}`}>{state.label}</h4>
                          <p className={`rollover-step-state ${state.last?.status === 'done' ? 'is-done' : ''}`}>{stepState(state)}</p>
                        </div>
                        {state.available && (
                          <button
                            type="button"
                            className="secondary"
                            aria-expanded={isOpen}
                            aria-controls={`rollover-step-body-${state.step}`}
                            aria-describedby={`rollover-step-${state.step}`}
                            onClick={() => setOpen(isOpen ? null : state.step)}
                          >
                            {isOpen ? '閉じる' : '開く'}
                          </button>
                        )}
                      </div>
                      {!state.available && state.reason && <p className="hint">{state.reason}</p>}
                      {isOpen && (
                        <div id={`rollover-step-body-${state.step}`} className="rollover-step-body">
                          {state.step === 'organizations' && <OrganizationsStep key={sourceYear} sourceYear={sourceYear} onChanged={changed} />}
                          {state.step === 'calendar' && <CalendarStep key={sourceYear} sourceYear={sourceYear} onChanged={changed} />}
                          {state.step === 'tasks' && <TasksStep sourceYear={sourceYear} onChanged={changed} />}
                          {state.step === 'grants' && <GrantsStep sourceYear={sourceYear} onChanged={changed} />}
                          {state.step === 'handover' && <HandoverStep key={sourceYear} sourceYear={sourceYear} onChanged={changed} />}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
              <details className="rollover-runs">
                <summary>実行の記録（{data.runs.length} 件）</summary>
                {data.runs.length === 0 ? (
                  <p className="hint">まだ記録はありません。</p>
                ) : (
                  <ul>
                    {data.runs.map((run) => (
                      <li key={run.id}>
                        <span className="rollover-run-step">
                          {run.sourceYear}年度 → {run.targetYear}年度・{data.steps.find((s) => s.step === run.step)?.label ?? run.step}
                        </span>
                        <RunLine run={run} />
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </>
          )}
        </div>
      )}
    </section>
  );
}
