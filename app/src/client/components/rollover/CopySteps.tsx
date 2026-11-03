import { useCallback, useState } from 'react';
import { dateLabel } from '../../../shared/calendar';
import type { OrgKind } from '../../../shared/organizations';
import type { OrgPlanItem, OrgPreviewResponse, RolloverApplyResponse, RolloverRunView, RolloverUndoResponse } from '../../../shared/rollover';
import { toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { RunLine, UndoButton, UndoResult } from './RunParts';
import { errorCode, rolloverApi, runOf } from './rolloverApi';

// Steps 1 and 2: copying the organizations and the yearly schedule to the next year. Each shows what a confirm would
// do (the preview), confirms once, and can take the copy back.

interface Notice {
  kind: 'error' | 'warning';
  text: string;
  run: RolloverRunView | null;
  /** The preview is out of date: make it again. */
  stale: boolean;
}

function noticeOf(err: unknown): Notice {
  const failure = toFailure(err);
  const code = errorCode(err);
  return { kind: code === 'plan_changed' || code === 'already_done' ? 'warning' : 'error', text: failure.message, run: runOf(err), stale: code === 'plan_changed' };
}

const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;

/** A run being taken back: it is finished only by the undo (a confirm does not take it over). */
const undoing = (run: RolloverRunView) => run.status === 'running' && run.undoneAt !== null;

interface StandingProps {
  run: RolloverRunView;
  targetLabel: string;
  /** What to do to copy more, said under a completed run. */
  again: string;
  /** How to go on from a run cut off half way. */
  resume: string;
  onUndone: (r: RolloverUndoResponse) => void;
  /** Closes the record of a run cut off half way with what it made (absent: the confirm below does it). */
  onClose?: () => void;
  busy: boolean;
}

/**
 * A run of this year that stands. A completed one stops a second copy (the step shows only this while it stands); one
 * cut off half way is taken over by the next confirm, closed with what it made, or taken back.
 */
function StandingRun({ run, targetLabel, again, resume, onUndone, onClose, busy }: StandingProps) {
  const takingBack = undoing(run);
  return (
    <div className="status warning rollover-standing" role="status">
      <span>
        {takingBack
          ? run.stale
            ? `${targetLabel}への写しの取り消しが途中で止まっています。「この写しを取り消す」で続きを取り消してください。取り消しが終わると、もう一度写せます。`
            : `${targetLabel}への写しを、ほかの管理者が取り消している途中です。終わってから、この手順を開き直してください。`
          : run.stale
            ? `${targetLabel}への写しが途中で止まっています。${resume}写した分だけで終えるときは「ここまでで記録を閉じる」、やめるときは「この写しを取り消す」を押してください。`
            : run.status === 'running'
              ? `${targetLabel}への写しを、ほかの管理者が実行中です。終わってから、この手順を開き直してください。`
              : `${targetLabel}への写しは済んでいます。この年度へは一度だけ写せます。${again}`}
      </span>
      <RunLine run={run} />
      <div className="admin-actions">
        {run.stale && !takingBack && onClose && (
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            ここまでで記録を閉じる
          </button>
        )}
        {run.canUndo && <UndoButton run={run} onUndone={onUndone} />}
      </div>
    </div>
  );
}

function NoticeBox({ notice, onRetry }: { notice: Notice; onRetry: () => void }) {
  return (
    <div className={`status ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      {notice.stale && (
        <button type="button" className="secondary" onClick={onRetry}>
          下見を作り直す
        </button>
      )}
    </div>
  );
}

/** What a confirm made and left out, with its undo. */
function Applied({ result, what, onUndone }: { result: RolloverApplyResponse; what: string; onUndone: (r: RolloverUndoResponse) => void }) {
  return (
    <div className="rollover-result">
      <div className="status ok" role="status">
        <span>{result.run.summary}。</span>
      </div>
      {result.made.length > 0 && (
        <details>
          <summary>
            写した{what}（{result.made.length} 件）
          </summary>
          <ul className="rollover-reasons">
            {result.made.map((name, i) => (
              <li key={`${name}-${i}`}>{name}</li>
            ))}
          </ul>
        </details>
      )}
      {result.skipped.length > 0 && (
        <details open>
          <summary>
            写さなかった{what}（{result.skipped.length} 件）
          </summary>
          <ul className="rollover-reasons">
            {result.skipped.map((s, i) => (
              <li key={`${s.name}-${i}`}>
                {s.name}：{s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="admin-actions">
        <UndoButton run={result.run} onUndone={onUndone} />
        <span className="hint">取り消すと、写したあとに変えていないものを消し、元に戻します。</span>
      </div>
    </div>
  );
}

const ACTION_LABEL: Record<OrgPlanItem['action'], string> = { copy: '写す', skip: '写さない', excluded: '外した' };

export function OrganizationsStep({ sourceYear, onChanged }: { sourceYear: number; onChanged: () => void }) {
  const targetYear = sourceYear + 1;
  const [reload, setReload] = useState(0);
  const loadChoices = useCallback(
    (signal: AbortSignal) => {
      void reload;
      return rolloverApi.orgPreview({ sourceYear, selection: [], excludeIds: [] }, signal);
    },
    [sourceYear, reload],
  );
  const base = useLoader(loadChoices);
  const [selection, setSelection] = useState<Partial<Record<OrgKind, string[]>>>({});
  const [excluded, setExcluded] = useState<string[]>([]);
  const [preview, setPreview] = useState<OrgPreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [result, setResult] = useState<RolloverApplyResponse | null>(null);
  const [undone, setUndone] = useState<RolloverUndoResponse | null>(null);

  const chosen = (Object.entries(selection) as [OrgKind, string[]][]).filter(([, statuses]) => statuses.length > 0).map(([kind, statuses]) => ({ kind, statuses }));
  const request = (excludeIds: string[]) => ({ sourceYear, selection: chosen, excludeIds });

  const makePreview = async (excludeIds = excluded) => {
    setBusy(true);
    setNotice(null);
    try {
      setPreview(await rolloverApi.orgPreview(request(excludeIds)));
    } catch (err) {
      setNotice(noticeOf(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = (kind: OrgKind, status: string) => {
    const now = selection[kind] ?? [];
    setSelection({ ...selection, [kind]: now.includes(status) ? now.filter((s) => s !== status) : [...now, status] });
    setPreview(null);
    setNotice(null);
  };

  const toggleItem = (id: string) => {
    const next = excluded.includes(id) ? excluded.filter((x) => x !== id) : [...excluded, id];
    setExcluded(next);
    void makePreview(next);
  };

  const send = async (body: Parameters<typeof rolloverApi.orgApply>[0]) => {
    setBusy(true);
    setNotice(null);
    try {
      const done = await rolloverApi.orgApply(body);
      setResult(done);
      setUndone(null);
      setPreview(null);
      onChanged();
    } catch (err) {
      setNotice(noticeOf(err));
    } finally {
      setBusy(false);
    }
  };
  const apply = () => (preview ? send({ ...request(excluded), planToken: preview.planToken }) : Promise.resolve());

  const afterUndo = (r: RolloverUndoResponse) => {
    setUndone(r);
    setResult(null);
    setPreview(null);
    setNotice(null);
    setReload((n) => n + 1);
    onChanged();
  };

  const data = base.data;
  // The run a refused confirm named counts too (another administrator copied meanwhile).
  const standing = result ? null : (notice?.run ?? preview?.done ?? data?.done ?? null);
  // A completed copy stands: the year takes one copy, so the step shows only that run and its undo.
  const blocked = standing !== null && (!standing.stale || undoing(standing));
  // Closing a run cut off half way: the empty selection copies nothing, so the confirm only closes its record.
  const close = data ? () => void send({ sourceYear, selection: [], excludeIds: [], planToken: data.planToken }) : undefined;
  return (
    <div className="rollover-step-inner">
      <LoadStatus loader={base} what="団体の台帳" compact />
      {undone && <UndoResult result={undone} />}
      {standing && (
        <StandingRun
          run={standing}
          targetLabel={`${targetYear}年度`}
          again="写し足すときは、この写しを取り消してから、写す種別・段階をまとめて選び直して写してください（写したあとに変えた団体とメールを送った団体は、取り消しても残ります）。"
          resume="続けて写すときは、下で種別と段階を選んで下見を作り、確定してください（前回に写した団体は二重になりません）。"
          onUndone={afterUndo}
          onClose={close}
          busy={busy}
        />
      )}
      {notice && blocked && <NoticeBox notice={notice} onRetry={() => setReload((n) => n + 1)} />}
      {result && <Applied result={result} what="団体" onUndone={afterUndo} />}
      {data && data.choices.length === 0 && !standing && !result && <p className="empty">{sourceYear}年度の団体はありません。団体の台帳で年度を確かめてください。</p>}
      {data && data.choices.length > 0 && !blocked && !result && (
        <>
          <fieldset className="rollover-choices">
            <legend>写す団体（種別と、{sourceYear}年度の最後の段階）</legend>
            {data.choices.map((c) => (
              <div key={c.kind} className="rollover-choice">
                <span className="rollover-choice-kind">{c.label}</span>
                <div className="rollover-chips">
                  {c.statuses.map((s) => (
                    <label key={s.status} className="status-option">
                      <input type="checkbox" checked={(selection[c.kind] ?? []).includes(s.status)} onChange={() => toggleStatus(c.kind, s.status)} />
                      {s.status}（{s.count} 件）
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>
          <p className="hint">
            写した団体は、段階が最初（協賛は「依頼前」、出展団体は「申込」）に戻り、金額・内容・次にすること・委員会側の担当は空になります。{sourceYear}年度の段階・金額・内容・担当は、メモの「前年度の実績」に残します。相手の担当者（連絡先）は結んだままです。{sourceYear}年度の団体は変わりません。
          </p>
          <div className="admin-actions">
            <button type="button" className={preview ? 'secondary' : undefined} onClick={() => void makePreview()} disabled={busy || chosen.length === 0}>
              {preview ? '下見を作り直す' : '下見を作る'}
            </button>
            {chosen.length === 0 && <span className="hint">種別と段階を一つ以上選んでください。</span>}
          </div>
          {notice && <NoticeBox notice={notice} onRetry={() => void makePreview()} />}
          {preview && (
            <div className="rollover-preview" aria-live="polite">
              <p className="rollover-counts">
                写す <strong>{preview.counts.copy}</strong> 件・写さない {preview.counts.skip} 件・外した {preview.counts.excluded} 件
              </p>
              {preview.items.length === 0 ? (
                <p className="empty">選んだ段階の団体はありません。</p>
              ) : (
                <ul className="rollover-items">
                  {preview.items.map((item) => (
                    <li key={item.sourceId} className={`rollover-item is-${item.action}`}>
                      {item.action === 'skip' ? (
                        <span className="rollover-item-name">{item.name}</span>
                      ) : (
                        <label className="rollover-item-check">
                          <input type="checkbox" checked={item.action === 'copy'} onChange={() => toggleItem(item.sourceId)} disabled={busy} />
                          <span className="rollover-item-name">{item.name}</span>
                        </label>
                      )}
                      <span className="rollover-item-meta">
                        {ACTION_LABEL[item.action]}・{item.kindLabel}・{item.fromStatus} → {item.toStatus}
                        {item.amountYen !== null ? `・前年度 ${yen(item.amountYen)}` : ''}
                        {item.hasContact ? '・連絡先を結んだまま' : ''}
                      </span>
                      {item.action === 'skip' && item.reason && <span className="rollover-item-reason">{item.reason}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <p className="hint">{targetYear}年度への写しは一度だけです。写す種別・段階をまとめて選んでから確定してください（あとから写し足すには、この写しを取り消してから写し直します）。</p>
              <div className="admin-actions">
                <button type="button" onClick={() => void apply()} disabled={busy || preview.counts.copy === 0}>
                  {busy ? '処理中…' : `${preview.counts.copy} 件を ${targetYear}年度に写す${standing?.stale && !undoing(standing) ? '（途中から続ける）' : ''}`}
                </button>
                {preview.counts.copy === 0 && <span className="hint">写す団体がないため、確定できません。種別と段階を選び直してください。</span>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function CalendarStep({ sourceYear, onChanged }: { sourceYear: number; onChanged: () => void }) {
  const targetYear = sourceYear + 1;
  const [weekday, setWeekday] = useState<string[]>([]);
  const [skip, setSkip] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void reload;
      return rolloverApi.calendarPreview({ sourceYear, weekdayIds: weekday, skipIds: skip }, signal);
    },
    [sourceYear, weekday, skip, reload],
  );
  const plan = useLoader(load);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [result, setResult] = useState<RolloverApplyResponse | null>(null);
  const [undone, setUndone] = useState<RolloverUndoResponse | null>(null);

  const toggle = (list: string[], set: (next: string[]) => void, id: string) => {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
    setNotice(null);
  };

  const apply = async () => {
    if (!plan.data || !plan.dataIsCurrent) return;
    setBusy(true);
    setNotice(null);
    try {
      setResult(await rolloverApi.calendarApply({ sourceYear, weekdayIds: weekday, skipIds: skip, planToken: plan.data.planToken }));
      setUndone(null);
      setReload((n) => n + 1);
      onChanged();
    } catch (err) {
      setNotice(noticeOf(err));
    } finally {
      setBusy(false);
    }
  };

  const afterUndo = (r: RolloverUndoResponse) => {
    setUndone(r);
    setResult(null);
    setNotice(null);
    setReload((n) => n + 1);
    onChanged();
  };

  const data = plan.data;
  const standing = result ? null : (notice?.run ?? data?.done ?? null);
  // A completed copy stands: the year takes one copy, so the step shows only that run and its undo.
  const blocked = standing !== null && (!standing.stale || undoing(standing));
  return (
    <div className="rollover-step-inner">
      <LoadStatus loader={plan} what="毎年の予定" compact />
      {undone && <UndoResult result={undone} />}
      {result && <Applied result={result} what="予定" onUndone={afterUndo} />}
      {standing && (
        <StandingRun
          run={standing}
          targetLabel={`${targetYear}年`}
          again="やり直すときは、この写しを取り消してから、写さない予定と日付の決め方をまとめて選び直して写してください（写したあとに変えた予定は、取り消しても残ります）。"
          resume="続けて写すときは、下の一覧を確かめて確定してください（前回に写した予定は二重になりません）。"
          onUndone={afterUndo}
          // With nothing left to copy, the confirm only closes the record of the cut-off run.
          onClose={data && data.counts.copy === 0 ? () => void apply() : undefined}
          busy={busy || plan.loading}
        />
      )}
      {notice && (blocked || !data || data.items.length === 0) && <NoticeBox notice={notice} onRetry={() => setReload((n) => n + 1)} />}
      {data && data.items.length === 0 && !result && !standing && <p className="empty">{sourceYear}年の毎年の予定はありません。カレンダーで予定に「毎年」の印を付けると、ここに出ます。</p>}
      {data && data.items.length > 0 && !result && !blocked && (
        <>
          <p className="hint">
            「毎年」の予定を{targetYear}年の同じ月日（2月29日は2月28日）に写します。日付が曜日で決まる予定は「同じ週・同じ曜日」を選んでください。写した予定のメモの先頭には「日付を確かめる」の印が付きます。カレンダーで日付を確かめたら、その行を消してください。元の予定は日付・題名・メモを変えず、「毎年」の印だけを写した予定へ移します。
          </p>
          <p className="rollover-counts">
            写す <strong>{data.counts.copy}</strong> 件・写さない {data.counts.skip} 件・外した {data.counts.excluded} 件
          </p>
          <ul className="rollover-items">
            {data.items.map((item) => (
              <li key={item.eventId} className={`rollover-item is-${item.action}`}>
                {item.action === 'skip' ? (
                  <span className="rollover-item-name">{item.title}</span>
                ) : (
                  <label className="rollover-item-check">
                    <input type="checkbox" checked={item.action === 'copy'} onChange={() => toggle(skip, setSkip, item.eventId)} disabled={busy} />
                    <span className="rollover-item-name">{item.title}</span>
                  </label>
                )}
                <span className="rollover-item-meta">
                  {item.kindLabel}
                  {item.departments.length > 0 ? `・${item.departments.join('・')}` : ''}
                </span>
                {item.action === 'skip' ? (
                  item.reason && <span className="rollover-item-reason">{item.reason}</span>
                ) : (
                  <>
                    <span className="rollover-item-dates">
                      {dateLabel(item.fromDate)} → <strong>{dateLabel(item.toDate)}</strong>
                    </span>
                    {item.action === 'copy' && (
                      <label className="rollover-rule">
                        <span>日付の決め方</span>
                        <select
                          value={item.rule}
                          onChange={(e) => {
                            const wantWeekday = e.target.value === 'same-weekday';
                            if (wantWeekday !== weekday.includes(item.eventId)) toggle(weekday, setWeekday, item.eventId);
                          }}
                          disabled={busy}
                        >
                          <option value="same-date">同じ月日</option>
                          <option value="same-weekday">同じ週・同じ曜日（{item.weekdayLabel}）</option>
                        </select>
                      </label>
                    )}
                  </>
                )}
                {item.notes.map((n) => (
                  <span key={n} className="rollover-item-note">
                    {n}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {notice && !blocked && <NoticeBox notice={notice} onRetry={() => setReload((n) => n + 1)} />}
          <p className="hint">{targetYear}年への写しは一度だけです。写さない予定と日付の決め方をまとめて選んでから確定してください。</p>
          <div className="admin-actions">
            <button type="button" onClick={() => void apply()} disabled={busy || plan.loading || data.counts.copy === 0}>
              {busy ? '処理中…' : `${data.counts.copy} 件を ${targetYear}年に写す${standing?.stale && !undoing(standing) ? '（途中から続ける）' : ''}`}
            </button>
            {data.counts.copy === 0 && <span className="hint">写す予定がないため、確定できません。</span>}
            {data.counts.copy > 0 && plan.loading && <span className="hint">一覧を読み込み中です。</span>}
          </div>
        </>
      )}
    </div>
  );
}
