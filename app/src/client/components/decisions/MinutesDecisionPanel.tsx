import { useCallback, useMemo, useState } from 'react';
import { api, toFailure } from '../../api';
import { LoadStatus } from '../LoadStatus';
import { useLoader } from '../../useLoader';
import { departmentsOf } from '../tasks/common';
import type { TaskContextResponse } from '../../../shared/tasks';
import { DECISION_VENUE_LABELS, DECISION_VENUES, isDecisionDate, type DecisionVenue, type MinutesRegisterResponse } from '../../../shared/decisions';
import type { MinutesItem } from '../../../shared/minutes';
import { forgetDecisionMeta, useDecisionMeta } from './decisionsApi';
import { decisionHref, departmentLabel } from './decisionLinks';

// The decision items of a confirmed meeting's AI draft, registered into the decision register (2026-11-03). The
// server reads the items and builds the text (the title, and the part beyond the title limit in the body); the screen
// only names the items and the departments and place. A registered item is one decision: registering it again answers
// the decision already made, and the screen links to it.

interface Props {
  meetingId: string;
  heldOn: string;
  /** The meeting's visibility: only "members" (everyone in the committee) can be registered. */
  visibility: 'selected' | 'members';
  items: MinutesItem[];
}

type Result = { kind: 'created' | 'replayed'; id: string };

export function MinutesDecisionPanel({ meetingId, heldOn, visibility, items }: Props) {
  const meta = useDecisionMeta();
  const context = useLoader(useCallback((signal: AbortSignal) => api<TaskContextResponse>('GET', '/api/tasks/context', undefined, signal), []));
  const departments = useMemo(() => {
    const named = departmentsOf(context.data).map((d) => ({ key: d.key, label: d.label }));
    const extra = (meta?.departments ?? []).filter((k) => !named.some((d) => d.key === k)).map((key) => ({ key, label: key }));
    return [...named, ...extra];
  }, [context.data, meta]);
  // Nothing is chosen at first: the items are the AI's, and each one is registered only when someone picks it.
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [depts, setDepts] = useState<string[]>([]);
  const [venue, setVenue] = useState<DecisionVenue>('regular');
  const [results, setResults] = useState<Record<number, Result>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!meta?.canRegister) return null;

  const dayOk = isDecisionDate(heldOn);
  const toggle = (set: string[], key: string) => (set.includes(key) ? set.filter((k) => k !== key) : [...set, key]);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const body = { items: [...picked].sort((a, b) => a - b), departments: depts, venue };
      const res = await api<MinutesRegisterResponse>('POST', `/api/minutes/${encodeURIComponent(meetingId)}/decisions`, body);
      const next: Record<number, Result> = {};
      for (const r of res.results) next[r.index] = { kind: r.replayed ? 'replayed' : 'created', id: r.decisionId };
      setResults((prev) => ({ ...prev, ...next }));
      setPicked(new Set());
      forgetDecisionMeta();
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  }

  if (visibility !== 'members') {
    return (
      <section className="panel minutes-decisions" aria-labelledby="minutes-decisions-title">
        <h3 id="minutes-decisions-title" className="section-label">
          決定事項を台帳に登録
        </h3>
        <p className="hint">この議事録は一部の人にだけ見せているため、決定事項の台帳には登録できません。</p>
      </section>
    );
  }

  return (
    <section className="panel minutes-decisions" aria-labelledby="minutes-decisions-title" data-testid="minutes-decisions">
      <h3 id="minutes-decisions-title" className="section-label">
        決定事項を台帳に登録
      </h3>
      <p className="hint">
        選んだ項目を決定事項の台帳に登録します。項目の文は AI が拾ったもののまま登録されます。直すときは、登録のあとで決定の「内容を直す」を使ってください。同じ項目をもう一度登録しても一件のままで、既にある決定を示します。
      </p>
      {!dayOk && (
        <p className="status error" role="alert">
          会議の日が実在する日付ではないため、この議事録からは登録できません。
        </p>
      )}

      <LoadStatus loader={context} what="部局の一覧" />
      <fieldset className="field decision-depts">
        <legend>関係する部局（一つ以上）</legend>
        {context.data !== null && departments.length === 0 && <p className="hint">部局の一覧がまだありません。決定事項の画面で、部局の名前を入れて登録してください。</p>}
        <div className="chip-row">
          {departments.map((d) => (
            <label key={d.key} className="chip-check">
              <input type="checkbox" checked={depts.includes(d.key)} onChange={() => setDepts((s) => toggle(s, d.key))} /> {d.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field-row">
        <div className="field">
          <label htmlFor="minutes-decision-venue">決めた場</label>
          <select id="minutes-decision-venue" value={venue} onChange={(e) => setVenue(e.target.value as DecisionVenue)}>
            {DECISION_VENUES.filter((v) => v !== 'other').map((v) => (
              <option key={v} value={v}>
                {DECISION_VENUE_LABELS[v]}
              </option>
            ))}
          </select>
        </div>
        <p className="hint">決めた日：{dayOk ? heldOn : '不明'}（会議の日）</p>
      </div>

      <ul className="rows minutes-decision-items">
        {items.map((x, i) => {
          const r = results[i];
          return (
            <li key={i}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.has(i)}
                  disabled={r !== undefined}
                  onChange={() =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (n.has(i)) n.delete(i);
                      else n.add(i);
                      return n;
                    })
                  }
                />{' '}
                {x.text}
              </label>
              {r?.kind === 'created' && (
                <span className="status ok">
                  {' '}
                  登録しました：<a href={decisionHref(r.id)}>決定を見る</a>
                </span>
              )}
              {r?.kind === 'replayed' && (
                <span className="status info">
                  {' '}
                  登録済み：<a href={decisionHref(r.id)}>決定を見る</a>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="button" disabled={busy || !dayOk || picked.size === 0 || depts.length === 0} onClick={() => void register()} data-testid="minutes-decisions-register">
          {busy ? '登録しています…' : '選んだ項目を登録'}
        </button>
        {depts.length > 0 && <span className="hint">部局：{depts.map((k) => departmentLabel(k, departments)).join('・')}</span>}
      </div>
    </section>
  );
}
