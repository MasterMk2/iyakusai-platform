import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { addDays } from '../../../shared/calendar';
import { DAYOF_LIMITS, periodProblem, type DayOfAdminResponse } from '../../../shared/dayof';
import { departmentsOfLabel } from '../../../shared/mailbox';
import { fmtDate, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { dayofApi } from './dayofApi';
import './dayof.css';

/**
 * 設定 › 当日（access administrators): the festival days (Japan time) when the home screen shows 当日, the rules of who
 * decides what (plain text, line breaks only), and who may post notices besides the administrators (per department
 * and per person, the same way as the mailbox grants). Each tick saves at once; the period and the rules save together
 * with the version they were read at.
 */
export function DayOfSettingsPanel({ onAvailable }: { onAvailable?: (available: boolean) => void } = {}) {
  const load = useCallback((signal: AbortSignal) => dayofApi.admin(signal), []);
  const loader = useLoader(load);
  const [saved, setSaved] = useState<DayOfAdminResponse | null>(null);
  const [settingsNote, setSettingsNote] = useState(false);
  const data = saved ?? loader.data;
  // A server without the board (404) leaves the panel out.
  const absent = loader.error?.status === 404 && !data;
  useEffect(() => {
    if (!loader.loading) onAvailable?.(!absent);
  }, [loader.loading, absent, onAvailable]);
  if (absent) return null;
  return (
    <section className="admin dayof-settings" aria-labelledby="dayof-settings-title" data-testid="dayof-settings">
      <h3 id="dayof-settings-title">当日の欄</h3>
      <p className="hint">決めた期間（日本時間）のあいだだけ、ホームのいちばん上に「当日」の欄が出ます。本部からの連絡・今日決めたこと・今日の予定・物品の状況をまとめて出します。</p>
      <LoadStatus loader={loader} what="当日の設定" compact />
      {data && (
        <>
          {settingsNote && (
            <p className="status ok" role="status">
              当日の期間と決め方を保存しました。
            </p>
          )}
          <SettingsForm
            key={`${data.settings.version}`}
            data={data}
            onSaved={(next) => {
              setSaved(next);
              setSettingsNote(true);
            }}
            onConflict={() => {
              setSaved(null);
              setSettingsNote(false);
              loader.retry();
            }}
          />
          <Posters data={data} onSaved={setSaved} />
          {data.history.length > 0 && (
            <details className="dayof-history">
              <summary>変更の記録（新しい順に {data.history.length} 件）</summary>
              <ul className="rows">
                {data.history.map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    <span>{h.detail}</span>
                    <span className="row-sub">
                      {fmtDate(h.at)}・{h.actorName}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function SettingsForm({ data, onSaved, onConflict }: { data: DayOfAdminResponse; onSaved: (next: DayOfAdminResponse) => void; onConflict: () => void }) {
  const id = useId();
  const [startDate, setStartDate] = useState(data.settings.startDate ?? '');
  const [endDate, setEndDate] = useState(data.settings.endDate ?? '');
  const [rules, setRules] = useState(data.settings.rules);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean; conflict?: boolean } | null>(null);
  const s = data.settings;
  const length = [...rules].length;
  const active = !!s.startDate && !!s.endDate && data.today >= s.startDate && data.today <= s.endDate;

  async function save(e: FormEvent) {
    e.preventDefault();
    const start = startDate.trim() || null;
    const end = endDate.trim() || null;
    const problem = periodProblem(start, end);
    if (problem) return setMessage({ text: problem, error: true });
    if (length > DAYOF_LIMITS.rules) return setMessage({ text: `決め方の文は ${DAYOF_LIMITS.rules} 字までにしてください。`, error: true });
    setBusy(true);
    setMessage(null);
    try {
      const next = await dayofApi.saveSettings({ startDate: start, endDate: end, rules, expectedVersion: s.version });
      onSaved(next);
    } catch (err) {
      const failure = toFailure(err);
      setMessage({ text: failure.message, error: true, conflict: failure.status === 409 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dayof-form" onSubmit={save} aria-label="当日の期間と決め方">
      <p className={`status ${active ? 'ok' : 'info'}`} data-testid="dayof-settings-state">
        {s.startDate && s.endDate ? `期間：${s.startDate}〜${s.endDate}（${active ? '今日は当日の欄が出ています' : '今日は期間の外です'}）` : '期間は決まっていません（当日の欄は出ません）。'}
      </p>
      <div className="field-row">
        <label htmlFor={`${id}-start`}>
          開始日
          <input id={`${id}-start`} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label htmlFor={`${id}-end`}>
          終了日
          <input id={`${id}-end`} type="date" value={endDate} min={startDate || undefined} max={startDate ? addDays(startDate, DAYOF_LIMITS.periodDays - 1) : undefined} onChange={(e) => setEndDate(e.target.value)} />
        </label>
      </div>
      <p className="hint">日付は日本時間で、両端の日を含みます。期間をやめるときは両方を空にして保存します（連絡や記録は消えません）。</p>
      <label htmlFor={`${id}-rules`}>決め方（誰が何を決めるか。当日の欄のいちばん上に出ます）</label>
      <textarea id={`${id}-rules`} rows={5} value={rules} onChange={(e) => setRules(e.target.value)} aria-describedby={`${id}-rules-hint`} />
      <span id={`${id}-rules-hint`} className={`hint ${length > DAYOF_LIMITS.rules ? 'dayof-over' : ''}`}>
        改行だけが使えます（太字や箇条書きの記号はそのまま文字として出ます）。{length}／{DAYOF_LIMITS.rules} 字
      </span>
      {message && (
        <p className={`status ${message.error ? 'error' : 'ok'}`} role={message.error ? 'alert' : 'status'}>
          {message.text}
          {message.conflict && (
            <button type="button" onClick={onConflict}>
              最新の設定を読み込む
            </button>
          )}
        </p>
      )}
      <div className="dayof-form-actions">
        <button type="submit" disabled={busy}>
          {busy ? '保存しています…' : '期間と決め方を保存'}
        </button>
      </div>
      {s.updatedAt && (
        <p className="hint">
          最後の変更：{fmtDate(s.updatedAt)}・{s.updatedByName ?? ''}
        </p>
      )}
    </form>
  );
}

type Target = { userId: string } | { department: string };
const keyOf = (t: Target) => ('userId' in t ? `u:${t.userId}` : `d:${t.department}`);

function Posters({ data, onSaved }: { data: DayOfAdminResponse; onSaved: (next: DayOfAdminResponse) => void }) {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [filter, setFilter] = useState('');
  const needle = filter.normalize('NFKC').trim().toLowerCase();
  const people = data.people.filter((p) => !needle || `${p.displayName} ${p.roleLabel}`.normalize('NFKC').toLowerCase().includes(needle));

  async function toggle(target: Target, on: boolean, name: string) {
    const key = keyOf(target);
    setPending((p) => ({ ...p, [key]: on }));
    setMessage(null);
    try {
      onSaved(await dayofApi.setPoster({ ...target, on } as { userId: string; on: boolean } | { department: string; on: boolean }));
      setMessage({ text: `${name}を当日の発信者${on ? 'にしました' : 'から外しました'}。`, error: false });
    } catch (err) {
      setMessage({ text: `${name}：${toFailure(err).message}`, error: true });
    } finally {
      setPending((p) => {
        const rest = { ...p };
        delete rest[key];
        return rest;
      });
    }
  }

  const shown = (t: Target, stored: boolean) => pending[keyOf(t)] ?? stored;
  return (
    <section className="grant-section" aria-labelledby="dayof-posters-title">
      <h4 id="dayof-posters-title">当日の発信者（連絡板に書ける人）</h4>
      <p className="hint">権限の管理者はいつも書けます。ほかに書ける人を、部局ごとか委員ごとに選びます。読むのはログインした委員全員です（臨時スタッフは、発信者が「臨時スタッフにも見せる」にした連絡だけを物品貸出の画面で読めます）。</p>
      {message && (
        <p className={`status ${message.error ? 'error' : 'ok'}`} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      {data.departments.length > 0 && (
        <>
          <h4>部局ごと</h4>
          <ul className="rows grant-list" data-testid="dayof-poster-departments">
            {data.departments.map((d) => {
              const t = { department: d };
              return (
                <li key={d} className="grant-row">
                  <span className="grant-person">
                    <span className="row-main">{d}</span>
                  </span>
                  <label className="checkbox">
                    <input type="checkbox" checked={shown(t, data.posters.departments.includes(d))} disabled={pending[keyOf(t)] !== undefined} onChange={(e) => void toggle(t, e.target.checked, `${d}（部局）`)} aria-label={`${d} を当日の発信者にする`} />
                    発信者
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <h4>委員ごと</h4>
      <label className="dayof-filter">
        名前で絞り込み
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      {people.length === 0 ? (
        <p className="empty">{data.people.length === 0 ? '登録済みのアカウントがありません。' : '当てはまる委員がいません。'}</p>
      ) : (
        <ul className="rows grant-list" data-testid="dayof-poster-people">
          {people.map((p) => {
            const t = { userId: p.id };
            const viaDept = departmentsOfLabel(p.roleLabel).some((d) => data.posters.departments.includes(d));
            const own = data.posters.users.includes(p.id);
            if (p.canManageAccess) {
              return (
                <li key={p.id} className="grant-row">
                  <span className="grant-person">
                    <span className="row-main">{p.displayName}</span>
                    <span className="row-sub">{p.roleLabel}</span>
                  </span>
                  <span className="hint">権限の管理者（いつも書けます）</span>
                </li>
              );
            }
            return (
              <li key={p.id} className="grant-row">
                <span className="grant-person">
                  <span className="row-main">{p.displayName}</span>
                  <span className="row-sub">{p.roleLabel}</span>
                </span>
                <label className="checkbox" title={viaDept && !own ? '部局に付けた権限で書けます（外すときは部局ごとの欄で）' : undefined}>
                  <input
                    type="checkbox"
                    checked={shown(t, own) || viaDept}
                    disabled={pending[keyOf(t)] !== undefined || (viaDept && !own)}
                    onChange={(e) => void toggle(t, e.target.checked, `${p.displayName} さん`)}
                    aria-label={`${p.displayName} さんを当日の発信者にする`}
                  />
                  発信者
                  {viaDept && !own && <span className="grant-via">部局</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
