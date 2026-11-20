import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  AVAILABILITY_DETAIL_LABELS,
  AVAILABILITY_STATE_LABELS,
  type AvailabilityAudience,
  type AvailabilityDetail,
  type AvailabilityMeResponse,
} from '../../../shared/availability';
import { dateLabel } from '../../../shared/calendar';
import { api, fmtDate, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { forgetAvailability } from './useAvailability';
import './availability.css';

// 設定 › 空き具合の共有 (2026-11-20): the signed-in member connects their own Google calendar, chooses who may see the
// busy periods and how coarse, or stops. Connecting is three steps: share the calendar with the committee's account
// in Google, type the calendar's ID here and get a time, put an event at that time in Google and press 確かめる.
// A server without the feature answers enabled: false: the part leaves the list.

const ME = '/api/availability/me';
const DEFAULT_DEPARTMENT = '役員会';

export function AvailabilityPanel({ onAvailable }: { onAvailable?: (available: boolean) => void }) {
  // A server from before this feature answers 404: the same as one where it is off.
  const load = useCallback(async (signal: AbortSignal) => {
    try {
      return await api<AvailabilityMeResponse>('GET', ME, undefined, signal);
    } catch (error) {
      if (toFailure(error).status === 404) return null;
      throw error;
    }
  }, []);
  const loader = useLoader(load);
  const [latest, setLatest] = useState<AvailabilityMeResponse | null>(null);
  const data = latest ?? loader.data;
  const [notice, setNotice] = useState<string | null>(null);
  const absent = !loader.loading && !loader.error && (!data || !data.enabled);
  useEffect(() => {
    if (!loader.loading) onAvailable?.(!absent);
  }, [loader.loading, absent, onAvailable]);
  if (absent) return null;

  // The done message is kept here: the step that sent it is often replaced by the next one.
  const changed = (next: AvailabilityMeResponse, done: string | null) => {
    setLatest(next);
    setNotice(done);
    forgetAvailability();
  };

  return (
    <section className="admin avail-settings" aria-labelledby="avail-title" data-testid="availability-settings">
      <h3 id="avail-title">空き具合の共有</h3>
      <p className="hint">
        自分の Google カレンダーの「予定あり」の時間だけを、タスクの担当を選ぶ欄とカレンダーに出します。予定の題名・場所・メモは Google から送られてこないので、アプリにも入りません。見せる相手と見せ方は自分で選べ、いつでもやめられます。つなぐかどうかは自由です。
      </p>
      <LoadStatus loader={loader} what="空き具合の設定" compact />
      {notice && (
        <p className="status ok" role="status" data-testid="availability-notice">
          {notice}
        </p>
      )}
      {data && data.enabled && (data.connection ? <Connected key={data.connection.updatedAt} me={data} onChanged={changed} /> : data.challenge ? <Checking me={data} onChanged={changed} /> : <Start me={data} onChanged={changed} />)}
    </section>
  );
}

type Changed = (next: AvailabilityMeResponse, done: string | null) => void;

function useAction(onChanged: Changed) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, done: string | null) {
    setBusy(true);
    setError(null);
    try {
      const next = await api<AvailabilityMeResponse>(method, path, body);
      onChanged(next, done);
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  }
  // The error stays by the button that failed, and what was typed stays in the fields.
  const status = error && (
    <p className="status error" role="alert" data-testid="availability-message">
      {error}
    </p>
  );
  return { busy, run, status };
}

function ShareStep({ account }: { account: string }) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const copy = () => {
    if (!navigator.clipboard) return setCopied('failed');
    navigator.clipboard.writeText(account).then(
      () => setCopied('ok'),
      () => setCopied('failed'),
    );
  };
  return (
    <ol className="avail-steps">
      <li>
        パソコンのブラウザで Google カレンダーを開き、左の「マイカレンダー」で使うカレンダーの「︙」→「設定と共有」を開きます。
      </li>
      <li>
        「特定のユーザーまたはグループと共有する」の「ユーザーやグループを追加」に、委員会のアカウントのアドレスを入れます。
        <div className="avail-account">
          <code data-testid="availability-account">{account}</code>
          <button type="button" className="secondary" onClick={copy}>
            {copied === 'ok' ? 'コピーしました' : 'アドレスをコピー'}
          </button>
        </div>
        {copied === 'failed' && <p className="hint">コピーできませんでした。アドレスを選んで、手でコピーしてください。</p>}
      </li>
      <li>
        権限は<strong>「予定の表示（時間枠のみ、詳細は非表示）」</strong>を選んで送信します。ほかの権限にはしないでください。
      </li>
      <li>同じ設定画面の「カレンダーの統合」にある「カレンダー ID」を、下の欄に入れます（ふだんのカレンダーなら Gmail のアドレスと同じです）。</li>
    </ol>
  );
}

function AudienceFields({ me, audience, onAudience, detail, onDetail }: { me: AvailabilityMeResponse; audience: AvailabilityAudience; onAudience: (a: AvailabilityAudience) => void; detail: AvailabilityDetail; onDetail: (d: AvailabilityDetail) => void }) {
  const id = useId();
  const toggle = (list: string[], value: string, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((v) => v !== value));
  const chosenPeople = audience.people.length;
  return (
    <>
      <fieldset className="avail-fieldset">
        <legend>見せる相手（自分はいつでも見られます）</legend>
        <label className="status-option">
          <input type="checkbox" checked={audience.everyone} onChange={(e) => onAudience({ ...audience, everyone: e.target.checked })} data-testid="availability-everyone" />
          委員全員
        </label>
        {!audience.everyone && (
          <>
            <p className="hint" id={`${id}-dept-hint`}>
              部局を選ぶと、その部局の委員が見られます。
            </p>
            <div className="avail-options" role="group" aria-describedby={`${id}-dept-hint`}>
              {me.choices.departments.map((d) => (
                <label key={d} className="status-option">
                  <input type="checkbox" checked={audience.departments.includes(d)} onChange={(e) => onAudience({ ...audience, departments: toggle(audience.departments, d, e.target.checked) })} />
                  {d}
                </label>
              ))}
            </div>
            <details className="avail-people">
              <summary>人を選ぶ（{chosenPeople} 人を選択中）</summary>
              <div className="avail-options">
                {me.choices.people.map((p) => (
                  <label key={p.id} className="status-option">
                    <input type="checkbox" checked={audience.people.includes(p.id)} onChange={(e) => onAudience({ ...audience, people: toggle(audience.people, p.id, e.target.checked) })} />
                    {p.displayName}
                  </label>
                ))}
              </div>
            </details>
            {!audience.everyone && audience.departments.length === 0 && audience.people.length === 0 && <p className="status warning">相手を選んでいません。このままだと自分だけが見られます。</p>}
          </>
        )}
      </fieldset>
      <fieldset className="avail-fieldset">
        <legend>見せ方</legend>
        {(['parts', 'blocks'] as const).map((d) => (
          <label key={d} className="avail-radio">
            <input type="radio" name={`${id}-detail`} checked={detail === d} onChange={() => onDetail(d)} />
            {AVAILABILITY_DETAIL_LABELS[d]}
          </label>
        ))}
      </fieldset>
    </>
  );
}

function Start({ me, onChanged }: { me: AvailabilityMeResponse; onChanged: Changed }) {
  const id = useId();
  const [calendarId, setCalendarId] = useState('');
  const [audience, setAudience] = useState<AvailabilityAudience>(() => ({ everyone: false, departments: me.choices.departments.includes(DEFAULT_DEPARTMENT) ? [DEFAULT_DEPARTMENT] : [], people: [] }));
  const [detail, setDetail] = useState<AvailabilityDetail>('parts');
  const { busy, run, status } = useAction(onChanged);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run('POST', `${ME}/challenge`, { calendarId, audience, detail }, null);
  };
  return (
    <form className="avail-form" onSubmit={submit} aria-label="Google カレンダーをつなぐ">
      <h4>1. Google カレンダーで委員会のアカウントに共有する</h4>
      <ShareStep account={me.serviceAccount ?? ''} />
      <h4>2. カレンダー ID と見せる相手を選ぶ</h4>
      <label htmlFor={`${id}-cal`}>カレンダー ID</label>
      <input id={`${id}-cal`} type="email" inputMode="email" autoComplete="email" value={calendarId} required onChange={(e) => setCalendarId(e.target.value)} aria-describedby={`${id}-cal-hint`} data-testid="availability-calendar-id" />
      <p className="hint" id={`${id}-cal-hint`}>
        例：○○@gmail.com。このアドレスは自分にだけ表示され、ほかの委員には見えません。
      </p>
      <AudienceFields me={me} audience={audience} onAudience={setAudience} detail={detail} onDetail={setDetail} />
      {status}
      <div className="actions">
        <button type="submit" disabled={busy || !calendarId.trim()} data-testid="availability-challenge">
          {busy ? 'Google に確かめています…' : '次へ（確かめる時間を出す）'}
        </button>
      </div>
      <p className="hint">次の画面で出る時間に Google カレンダーで予定を 1 つ入れると、自分のカレンダーだと確かめられます。</p>
    </form>
  );
}

function Checking({ me, onChanged }: { me: AvailabilityMeResponse; onChanged: Changed }) {
  const ch = me.challenge!;
  const { busy, run, status } = useAction(onChanged);
  return (
    <div className="avail-form" data-testid="availability-checking">
      <h4>3. この時間に予定を 1 つ入れてください</h4>
      <p className="avail-slot" data-testid="availability-slot">
        {dateLabel(ch.date)} {ch.start}〜{ch.end}
      </p>
      <p className="hint">
        Google カレンダー（{ch.calendarId}）のこの時間に、題名は何でもよいので予定を入れ、「予定あり」のまま保存します。入れたら下の「確かめる」を押してください。確かめたあとは、その予定を消してかまいません。カレンダーに書き込める本人だけが確かめられるようにするための手順です。
      </p>
      {status}
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void run('POST', `${ME}/verify`, {}, 'つなぎました。担当を選ぶ欄とカレンダーに出ます。')} data-testid="availability-verify">
          {busy ? '確かめています…' : '確かめる'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void run('DELETE', `${ME}/challenge`, undefined, null)}>
          最初からやり直す
        </button>
      </div>
      <p className="hint">始めた日時：{fmtDate(ch.createdAt)}（7 日たつと、やり直しになります）</p>
    </div>
  );
}

function Connected({ me, onChanged }: { me: AvailabilityMeResponse; onChanged: Changed }) {
  const c = me.connection!;
  const [audience, setAudience] = useState(c.audience);
  const [detail, setDetail] = useState(c.detail);
  const [confirming, setConfirming] = useState(false);
  const { busy, run, status } = useAction(onChanged);
  const dirty = JSON.stringify(audience) !== JSON.stringify(c.audience) || detail !== c.detail;
  const stateText = c.state === 'ok' ? `${c.fetchedAt ? fmtDate(c.fetchedAt) : ''} に Google から読みました。` : AVAILABILITY_STATE_LABELS[c.state];
  return (
    <div className="avail-form" data-testid="availability-connected">
      <p className={`status ${c.state === 'ok' ? 'ok' : c.state === 'pending' || c.state === 'stale' ? 'info' : 'warning'}`} data-testid="availability-state">
        つないでいるカレンダー：{c.calendarId}。{stateText}
        {c.state === 'not_shared' && ` 委員会のアカウント（${me.serviceAccount}）への共有を、Google カレンダーで確かめてください。`}
      </p>
      <p className="hint">
        {me.horizonDays} 日先までを、{me.refreshMinutes} 分ごとに読みます。終日の予定は、Google で「予定あり」にしたものだけが入ります（終日の予定は最初「予定なし」になっています）。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run('PUT', ME, { audience, detail }, '保存しました。');
        }}
        aria-label="見せる相手と見せ方"
      >
        <AudienceFields me={me} audience={audience} onAudience={setAudience} detail={detail} onDetail={setDetail} />
        {status}
        <div className="actions">
          <button type="submit" disabled={busy || !dirty} data-testid="availability-save">
            保存
          </button>
          <span className="hint">つないだ日時：{fmtDate(c.connectedAt)}</span>
        </div>
      </form>
      <h4>やめる</h4>
      {confirming ? (
        <div className="actions">
          <p className="hint">アプリから空き具合が消えます。もう一度つなぐときは、確かめる手順からやり直しです。Google カレンダーの共有も外してください。</p>
          <button type="button" className="danger" disabled={busy} onClick={() => void run('DELETE', ME, undefined, 'やめました。Google カレンダーの共有も外してください。')} data-testid="availability-disconnect">
            空き具合の共有をやめる
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>
            続ける
          </button>
        </div>
      ) : (
        <button type="button" className="secondary" onClick={() => setConfirming(true)}>
          空き具合の共有をやめる…
        </button>
      )}
    </div>
  );
}
