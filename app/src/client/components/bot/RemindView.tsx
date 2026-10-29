import { useCallback, useRef, useState, type FormEvent } from 'react';
import { ASSISTANT_LIMITS, cleanText, REMINDER_REPEATS, type AssistantJob, type AssistantMeta, type AssistantReminder, type ReminderRepeat } from '../../../shared/assistant';
import { api, fmtDate, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { dueToIso, ErrorLine, FeatureOff, isActive, jstDateOf, jstToday, operationFor, type OperationSlots, type Outcome, OutcomeLine, settleOperation } from './common';
import { useJobPoll } from './useJobPoll';

const REPEAT_LABELS: Record<ReminderRepeat, string> = { none: '繰り返さない', daily: '毎日', weekly: '毎週', monthly: '毎月' };
/** The list comes from the Bot's snapshot (every 30 seconds); older than this, the screen says so. */
const STALE_MS = 3 * 60_000;

interface RemindersPage {
  reminders: AssistantReminder[];
  snapshotAt: string | null;
  /** When this page was read (the screen's "now"; keeps the clock out of rendering). */
  readAt: number;
}

type DueTone = 'overdue' | 'today' | 'later';

function dueTone(reminder: AssistantReminder, now: number): DueTone {
  if (Date.parse(reminder.due) < now) return 'overdue';
  if (jstDateOf(reminder.due) === jstToday(now)) return 'today';
  return 'later';
}

const TONE_TAGS: Record<DueTone, { label: string; tone: 'error' | 'warn' | 'none' }> = {
  overdue: { label: '期限超過', tone: 'error' },
  today: { label: '今日まで', tone: 'warn' },
  later: { label: '', tone: 'none' },
};

/**
 * My reminders: the list (overdue and today marked with text as well as colour), the add form, and
 * done and delete. Delete asks once, inline, with words for the two answers. Jobs still running are
 * watched until they finish, then the list is read again.
 */
export function RemindView({ meta }: { meta: AssistantMeta }) {
  const [version, setVersion] = useState(0);
  const [watchId, setWatchId] = useState<string | null>(null);
  const watch = useJobPoll(watchId);
  const watchDone = watch.job && !isActive(watch.job) ? watch.job.id : '';
  const load = useCallback(
    (signal: AbortSignal) => {
      void version;
      void watchDone;
      return api<Omit<RemindersPage, 'readAt'>>('GET', '/api/assistant/reminders?scope=mine', undefined, signal).then((page) => ({ ...page, readAt: Date.now() }));
    },
    [version, watchDone],
  );
  const list = useLoader(load);
  const [formOpen, setFormOpen] = useState(false);
  const loadMembers = useCallback(
    (signal: AbortSignal) => {
      if (!formOpen) return Promise.resolve(null);
      return api<{ members: { id: string; name: string }[] }>('GET', '/api/assistant/members', undefined, signal);
    },
    [formOpen],
  );
  const members = useLoader(loadMembers);

  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [target, setTarget] = useState('');
  const [repeat, setRepeat] = useState<ReminderRepeat>('none');
  const [channel, setChannel] = useState(meta.reminderChannels[0]?.id ?? '');
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  // Only the reminder being handled waits, and its result shows on its row, or above the list once the row has
  // left it (2026-10-26: every row's buttons stopped while one was handled, and the result was above the list).
  // Results are by the reminder's id, or 'add' for the add form (always above the list).
  const [busy, setBusy] = useState<Record<number, true>>({});
  const [results, setResults] = useState<Record<string, Outcome>>({});
  const [last, setLast] = useState<string | null>(null);
  const [watching, setWatching] = useState<string | null>(null);
  const operations = useRef<OperationSlots>({});

  const enabled = meta.features.remind;
  const page = list.data;
  const now = page?.readAt ?? 0;
  const watched = watch.job && !isActive(watch.job) ? (watch.job.result?.message ?? watch.job.error?.message ?? null) : null;
  const outcome = (key: string): Outcome | undefined => (key === watching && watched !== null ? { text: watched } : results[key]);
  const put = (key: string, value: Outcome) => setResults((r) => ({ ...r, [key]: value }));
  /** A new action: the results of rows still listed stay; the rest were already read. */
  function begin(key: string) {
    const listed = new Set((page?.reminders ?? []).map((r) => String(r.id)));
    setResults((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key && listed.has(k))));
    if (watching === key) setWatching(null);
    setLast(key);
  }

  /** A job the Bot answered: finished now, or still queued/running and watched. */
  function take(key: string, job: AssistantJob) {
    if (isActive(job)) {
      setWatchId(job.id);
      setWatching(key);
      put(key, { text: 'Bot が処理しています。終わると一覧に反映されます。' });
      return;
    }
    put(key, { text: job.result?.message ?? job.error?.message ?? '' });
    setVersion((n) => n + 1);
  }

  /** Done or delete of one reminder. `slot` keeps its operation ID for a retry of the same action. */
  async function send(id: number, slot: string, path: string) {
    const clientOperationId = operationFor(operations.current, slot, slot);
    setBusy((b) => ({ ...b, [id]: true }));
    begin(String(id));
    try {
      const answer = await api<{ job: AssistantJob }>('POST', path, { clientOperationId });
      operations.current[slot] = null;
      take(String(id), answer.job);
    } catch (err) {
      settleOperation(operations.current, slot, err);
      put(String(id), { error: toFailure(err) });
    } finally {
      setBusy((b) => {
        const rest = { ...b };
        delete rest[id];
        return rest;
      });
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = cleanText(text);
    const dueAt = dueToIso(due);
    if (!body) {
      setFormMessage('リマインドの内容を入力してください。');
      return;
    }
    if (body.length > ASSISTANT_LIMITS.reminderTextMax) {
      setFormMessage(`内容は ${ASSISTANT_LIMITS.reminderTextMax} 字までです。`);
      return;
    }
    if (!dueAt) {
      setFormMessage('期限を日付と時刻で入力してください。');
      return;
    }
    setFormMessage(null);
    setSubmitting(true);
    begin('add');
    const input = { text: body, due: dueAt, repeat, ...(target ? { targetId: target } : {}), ...(channel ? { channelId: channel } : {}) };
    const clientOperationId = operationFor(operations.current, 'add', JSON.stringify(input));
    try {
      const answer = await api<{ job: AssistantJob }>('POST', '/api/assistant/reminders', { clientOperationId, ...input });
      operations.current.add = null;
      setText('');
      setDue('');
      setTarget('');
      setRepeat('none');
      setFormOpen(false);
      take('add', answer.job);
    } catch (err) {
      settleOperation(operations.current, 'add', err);
      put('add', { error: toFailure(err) });
    } finally {
      setSubmitting(false);
    }
  }

  const reminderChannel = meta.reminderChannels.find((c) => c.id === channel);
  const snapshotAge = page?.snapshotAt ? page.readAt - Date.parse(page.snapshotAt) : null;
  // The add form's result, or the latest result whose row has left the list (done, deleted), shows above it.
  const away = last !== null && !(page?.reminders ?? []).some((r) => String(r.id) === last) ? outcome(last) : undefined;

  return (
    <div className="bot-remind">
      {!enabled && <FeatureOff reason="リマインドは、いまこの Bot では使えません。Bot の設定が済むまでお待ちください。" />}
      <section className="panel" aria-labelledby="remind-list-title">
        <div className="panel-head">
          <h2 id="remind-list-title">自分のリマインド</h2>
          <button type="button" className="secondary" onClick={() => setFormOpen((open) => !open)} aria-expanded={formOpen} disabled={!enabled}>
            {formOpen ? '追加を閉じる' : 'リマインドを追加'}
          </button>
        </div>
        {page && snapshotAge === null && <p className="hint">一覧の情報がまだありません。Bot が起動すると表示されます。</p>}
        {page && snapshotAge !== null && snapshotAge > STALE_MS && (
          <p className="hint" data-testid="reminder-stale">
            {Math.round(snapshotAge / 60_000)}分前の情報です。Bot が 30 秒ごとに更新します。
          </p>
        )}
        {list.loading && <p className="status loading" role="status">読み込み中…</p>}
        {list.error && <ErrorLine error={list.error} what="リマインドの一覧を読み込み" onRetry={list.retry} />}
        {away && <OutcomeLine outcome={away} testId="remind-notice" what="リマインドの操作" />}
        {page && page.reminders.length === 0 && <p className="empty">未完了のリマインドはありません。</p>}
        {page && page.reminders.length > 0 && (
          <ul className="bot-reminders">
            {page.reminders.map((r) => {
              const tone = dueTone(r, now);
              const tag = TONE_TAGS[tone];
              return (
                <li key={r.id} className={`bot-reminder bot-reminder-${tone}`} data-testid="reminder-row" data-tone={tone}>
                  <div className="bot-reminder-head">
                    {tag.label && <span className={`bot-tag bot-tag-${tag.tone}`}>{tag.label}</span>}
                    <strong>{r.text}</strong>
                  </div>
                  <p className="row-sub">
                    期限 {fmtDate(r.due)}・{REPEAT_LABELS[r.repeat]}
                  </p>
                  <p className="row-sub">
                    登録 {r.creator.name}・対象 {r.target.name}
                    {r.channel ? `・通知先 #${r.channel.name}` : ''}
                  </p>
                  {confirming === r.id ? (
                    <div className="bot-confirm" role="group" aria-label="削除の確認">
                      <p>「{r.text}」を削除します。削除すると元に戻せません。</p>
                      <button type="button" className="danger" disabled={!!busy[r.id]} onClick={() => send(r.id, `delete:${r.id}`, `/api/assistant/reminders/${r.id}/delete`)}>
                        {busy[r.id] ? '処理中…' : '削除する'}
                      </button>
                      <button type="button" className="secondary" onClick={() => setConfirming(null)}>
                        やめる
                      </button>
                    </div>
                  ) : (
                    <div className="bot-actions">
                      {r.canComplete && (
                        <button type="button" className="secondary" disabled={!!busy[r.id]} onClick={() => send(r.id, `done:${r.id}`, `/api/assistant/reminders/${r.id}/done`)}>
                          {busy[r.id] ? '処理中…' : '完了にする'}
                        </button>
                      )}
                      {r.canDelete && (
                        <button type="button" className="secondary" disabled={!!busy[r.id]} onClick={() => setConfirming(r.id)}>
                          削除
                        </button>
                      )}
                    </div>
                  )}
                  {outcome(String(r.id)) && <OutcomeLine outcome={outcome(String(r.id))!} testId="reminder-result" what="リマインドの操作" />}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {formOpen && (
        <section className="panel" aria-labelledby="remind-form-title">
          <h2 id="remind-form-title">リマインドを追加</h2>
          <form className="bot-form" onSubmit={add} noValidate>
            <fieldset disabled={!enabled || submitting}>
              <label htmlFor="remind-text">内容</label>
              <input id="remind-text" type="text" maxLength={ASSISTANT_LIMITS.reminderTextMax} value={text} onChange={(e) => setText(e.target.value)} data-testid="remind-text" />
              <label htmlFor="remind-due">期限（日付と時刻）</label>
              <input id="remind-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} data-testid="remind-due" />
              <label htmlFor="remind-target">対象（だれに知らせるか）</label>
              <select id="remind-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">自分</option>
                {(members.data?.members ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {members.loading && <p className="hint">委員の一覧を読み込み中…</p>}
              {members.error && <ErrorLine error={members.error} what="委員の一覧を読み込み" onRetry={members.retry} />}
              <label htmlFor="remind-repeat">繰り返し</label>
              <select id="remind-repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as ReminderRepeat)}>
                {REMINDER_REPEATS.map((r) => (
                  <option key={r} value={r}>
                    {REPEAT_LABELS[r]}
                  </option>
                ))}
              </select>
              <label htmlFor="remind-channel">通知先</label>
              <select id="remind-channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
                {meta.reminderChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
              {reminderChannel && <p className="hint">通知は Discord の #{reminderChannel.name} に届きます。</p>}
              {formMessage && (
                <p className="status error" role="alert">
                  {formMessage}
                </p>
              )}
              <button type="submit" className="primary" data-testid="remind-submit">
                {submitting ? '登録しています…' : 'リマインドを登録'}
              </button>
            </fieldset>
          </form>
        </section>
      )}
    </div>
  );
}
