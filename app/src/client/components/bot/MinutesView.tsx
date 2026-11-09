import { MinutesDecisionPanel } from '../decisions/MinutesDecisionPanel';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  doubtsOf,
  fmtOffset,
  MINUTES_LIMITS,
  MINUTES_PROGRESS_STALE_SEC,
  MINUTES_STAGE_LABELS,
  type MinutesDetail,
  type MinutesEvidence,
  type MinutesListResponse,
  type MinutesMeta,
  type MinutesPerson,
  type MinutesProgress,
  type MinutesSettingsUpdate,
  type MinutesStage,
  type MinutesVisibility,
  sizeLabel,
  type MinutesUploadItem,
  type TranscriptSegment,
} from '../../../shared/minutes';
import { api, fmtDate, toFailure } from '../../api';
import { forgetUpload, pendingUploads, sendRecording, type UploadState } from './minutesUpload';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { MinutesReviewHistory, MinutesSendBack } from './MinutesSendBack';
import { MinutesTranscript, type TranscriptMode, type TranscriptTarget } from './MinutesTranscript';
import { MinutesVersions } from './MinutesVersions';

// Meeting minutes (α, 2026-11-02; _目録/設計/議事録自動化_20261102/設計書.md): record in this browser or pick a
// recording, wait for the server to transcribe and draft it, correct the draft and confirm it. The audio and the
// transcript stay on the committee's server; only the people chosen for a meeting see it.

const PROCESSING: MinutesStage[] = ['transcribe_wait', 'transcribe_run', 'summarize_wait', 'summarize_run'];
const POLL_MS = 15_000;

const stageTone = (stage: MinutesStage) => (stage === 'confirmed' ? 'ok' : stage === 'draft' ? 'warn' : stage === 'failed' ? 'error' : 'info');
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

/** The stage, told more closely while the AI reworks a draft or confirmed minutes are being corrected (2026-11-06). */
function StageTag({ stage, revising = false, reopened = false }: { stage: MinutesStage; revising?: boolean; reopened?: boolean }) {
  if (revising) return <span className="bot-tag bot-tag-info">AI が手直し中</span>;
  if (reopened) return <span className="bot-tag bot-tag-warn">訂正中</span>;
  return <span className={`bot-tag bot-tag-${stageTone(stage)}`}>{MINUTES_STAGE_LABELS[stage]}</span>;
}

/** A length of time as people say it: "45秒", "38分", "3時間13分". */
function spoken(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s === 0) return '0分';
  if (s < 60) return `${s}秒`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}時間${m}分` : `${m}分`;
}

/** How far the running stage has got, as the worker last reported (refreshed with the page every 15 seconds). */
function ProgressLine({ p }: { p: MinutesProgress }) {
  // One part to summarize says nothing a bar could add.
  if (p.stage === 'summarize' && (p.total === null || p.total <= 1)) return null;
  const stale = p.ageSec >= MINUTES_PROGRESS_STALE_SEC;
  // The time left goes by the pace so far; with no word from the worker for long, it says nothing.
  const left = p.remainingSec === null || stale ? '' : p.remainingSec < 60 ? '・残りわずか（目安）' : `・残り約${spoken(Math.ceil(p.remainingSec / 60) * 60)}（目安）`;
  const label = p.stage === 'transcribe' ? '文字起こしの進み具合' : '要約の進み具合';
  const text =
    p.stage === 'transcribe'
      ? p.total === null
        ? `録音の ${spoken(p.done)} まで文字起こししました（全体の長さは分かりません）`
        : `${spoken(p.done)} / ${spoken(p.total)}（${p.percent ?? 0}%）${left}`
      : `全 ${p.total} 部分のうち ${p.done} 部分を要約しました（${p.percent ?? 0}%）${left}`;
  return (
    <div className="minutes-progress" data-testid="minutes-progress">
      {p.total === null ? <progress aria-label={label} /> : <progress aria-label={label} max={100} value={p.percent ?? 0} />}
      <p>{text}</p>
      {stale && (
        <p className="status warning" data-testid="minutes-progress-stale">
          最後の知らせから {spoken(p.ageSec)} たっています。処理が止まっているかもしれません。長く続くときはシステム課に連絡してください。
        </p>
      )}
    </div>
  );
}

export interface MinutesViewProps {
  meetingId: string | null;
  onOpen: (meetingId: string | null) => void;
}

export function MinutesView({ meetingId, onOpen }: MinutesViewProps) {
  const loadMeta = useCallback((signal: AbortSignal) => api<MinutesMeta>('GET', '/api/minutes/meta', undefined, signal), []);
  const meta = useLoader(loadMeta);
  // A recording still going on (or not sent yet) opens its form again.
  const [creating, setCreating] = useState(() => session.rec.state !== 'idle' || session.uploading);
  const [listVersion, setListVersion] = useState(0);
  // Opening a meeting by its address (a link, the back button) leaves the new-meeting form.
  const [shownId, setShownId] = useState(meetingId);
  if (shownId !== meetingId) {
    setShownId(meetingId);
    if (meetingId) setCreating(false);
  }

  if (meta.error) {
    return meta.error.status === 404 ? (
      <p className="status info" data-testid="minutes-off">議事録は、このサーバーではまだ有効になっていません。</p>
    ) : (
      <LoadStatus loader={meta} what="議事録" />
    );
  }
  if (!meta.data) return <LoadStatus loader={meta} what="議事録" />;

  if (creating) {
    return (
      <MinutesNew
        meta={meta.data}
        onCancel={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setListVersion((v) => v + 1);
          onOpen(id);
        }}
      />
    );
  }
  if (meetingId) {
    return (
      <MinutesDetailView
        key={meetingId}
        meetingId={meetingId}
        people={meta.data.people}
        onBack={() => {
          setListVersion((v) => v + 1);
          onOpen(null);
        }}
      />
    );
  }
  return <MinutesList version={listVersion} onOpen={onOpen} onNew={() => setCreating(true)} />;
}

// ---- list

function MinutesList({ version, onOpen, onNew }: { version: number; onOpen: (id: string) => void; onNew: () => void }) {
  const load = useCallback(
    (signal: AbortSignal) => {
      void version;
      return api<MinutesListResponse>('GET', '/api/minutes', undefined, signal);
    },
    [version],
  );
  const list = useLoader(load);
  const recording = useRecordingActive();
  const processing = list.data?.items.some((m) => PROCESSING.includes(m.stage)) ?? false;
  const { retry } = list;
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(retry, POLL_MS);
    return () => clearInterval(timer);
  }, [processing, retry]);

  return (
    <div className="bot-minutes" data-testid="minutes-list">
      <div className="minutes-head">
        <p className="hint">会議を録音すると、サーバーで文字起こしと要約をして議事録の下書きを作ります。下書きは人が直してから確定してください（α版）。</p>
        <button type="button" onClick={onNew} data-testid="minutes-new">
          新しい議事録
        </button>
      </div>
      {recording && (
        <p className="banner banner-error" role="status" data-testid="minutes-unsent">
          録音中か、まだ送っていない録音があります。
          <button type="button" className="secondary" onClick={onNew}>
            録音の画面に戻る
          </button>
        </p>
      )}
      {list.loading && !list.data && <LoadStatus loader={list} what="議事録の一覧" compact />}
      {list.error && <LoadStatus loader={list} what="議事録の一覧" />}
      {list.data && list.data.items.length === 0 && <p className="list-empty">まだ議事録はありません。</p>}
      {list.data && list.data.items.length > 0 && (
        <ul className="rows">
          {list.data.items.map((m) => (
            <li key={m.id}>
              <button type="button" className="row-button" onClick={() => onOpen(m.id)} data-testid="minutes-row">
                <span className="row-main">
                  {m.heldOn} {m.title}
                </span>
                <span className="row-sub">
                  <StageTag stage={m.stage} revising={m.revising} reopened={m.reopened} />
                  {m.progressPercent !== null ? ` ${m.progressPercent}%` : ''} 録音: {m.createdByName}
                  {m.durationSec !== null ? `・${fmtOffset(m.durationSec)}` : ''}
                  {m.confirmedAt ? `・確定 ${fmtDate(m.confirmedAt)}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- recording in the browser

type Recording = { state: 'idle' } | { state: 'recording' | 'paused'; startedAt: number; pausedMs: number; pausedAt: number | null } | { state: 'done'; file: File; url: string; seconds: number };

function pickMime(): { mime: string; ext: string } {
  const choices: [string, string][] = [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/mp4', 'm4a'],
  ];
  for (const [mime, ext] of choices) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  return { mime: '', ext: 'webm' };
}

// The recording lives outside the screens (2026-11-02 review): moving to another Bot section, another tab of the
// app or a meeting's address must not drop it. Leaving the page asks first while anything is unsent.

interface RecorderParts {
  recorder: MediaRecorder;
  streams: MediaStream[];
  context: AudioContext;
  chunks: Blob[];
  ext: string;
  mime: string;
}
interface RecorderSession {
  rec: Recording;
  error: string | null;
  uploading: boolean;
}
let session: RecorderSession = { rec: { state: 'idle' }, error: null, uploading: false };
let parts: RecorderParts | null = null;
const listeners = new Set<() => void>();
const warnOnLeave = (e: BeforeUnloadEvent) => e.preventDefault();
let guarded = false;

function setSession(patch: Partial<RecorderSession>) {
  session = { ...session, ...patch };
  const unsent = session.rec.state !== 'idle' || session.uploading;
  if (unsent && !guarded) window.addEventListener('beforeunload', warnOnLeave);
  if (!unsent && guarded) window.removeEventListener('beforeunload', warnOnLeave);
  guarded = unsent;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** A recording is going on or waits to be sent (the Bot screen shows a way back to it). */
export function useRecordingActive(): boolean {
  return useSyncExternalStore(subscribe, () => session.rec.state !== 'idle' || session.uploading);
}

function releaseParts() {
  if (!parts) return;
  for (const st of parts.streams) for (const t of st.getTracks()) t.stop();
  void parts.context.close().catch(() => undefined);
  parts = null;
}

function useRecorder() {
  const current = useSyncExternalStore(subscribe, () => session);
  const { rec } = current;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (rec.state !== 'recording' && rec.state !== 'paused') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [rec.state]);

  const start = async (withTab: boolean) => {
    setSession({ error: null });
    const streams: MediaStream[] = [];
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('このブラウザでは録音できません。録音ファイルを選んで取り込んでください。');
      streams.push(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }));
      if (withTab) {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        streams.push(display);
        if (display.getAudioTracks().length === 0) throw new Error('会議のタブの音声が選ばれていません。共有する画面で会議のタブを選び、「タブの音声も共有する」に印を付けてください。');
      }
      const context = new AudioContext();
      // Some browsers start it suspended, which would record silence.
      await context.resume();
      const mix = context.createMediaStreamDestination();
      for (const st of streams) if (st.getAudioTracks().length) context.createMediaStreamSource(new MediaStream(st.getAudioTracks())).connect(mix);
      const { mime, ext } = pickMime();
      const recorder = new MediaRecorder(mix.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      parts = { recorder, streams, context, chunks, ext, mime: recorder.mimeType || mime };
      recorder.start(10_000);
      setSession({ rec: { state: 'recording', startedAt: Date.now(), pausedMs: 0, pausedAt: null } });
    } catch (err) {
      for (const st of streams) for (const t of st.getTracks()) t.stop();
      const name = (err as { name?: string }).name;
      setSession({
        error:
          name === 'NotAllowedError'
            ? 'マイク（または画面の共有）が許可されませんでした。ブラウザのアドレス欄の左のマークから許可してから、もう一度始めてください。'
            : (err as Error).message || '録音を始められませんでした。',
      });
    }
  };

  const pause = () => {
    if (session.rec.state !== 'recording' || !parts) return;
    parts.recorder.pause();
    setSession({ rec: { ...session.rec, state: 'paused', pausedAt: Date.now() } });
  };
  const resume = () => {
    if (session.rec.state !== 'paused' || !parts) return;
    parts.recorder.resume();
    const r = session.rec;
    setSession({ rec: { ...r, state: 'recording', pausedMs: r.pausedMs + (Date.now() - (r.pausedAt ?? Date.now())), pausedAt: null } });
  };
  const elapsed = rec.state === 'recording' || rec.state === 'paused' ? Math.max(0, ((rec.pausedAt ?? now) - rec.startedAt - rec.pausedMs) / 1000) : 0;

  const stop = () => {
    const p = parts;
    const r = session.rec;
    if (!p || (r.state !== 'recording' && r.state !== 'paused')) return;
    const seconds = Math.max(0, ((r.pausedAt ?? Date.now()) - r.startedAt - r.pausedMs) / 1000);
    p.recorder.onstop = () => {
      const type = p.mime.split(';')[0] || 'audio/webm';
      const file = new File(p.chunks, `recording.${p.ext}`, { type });
      releaseParts();
      setSession({ rec: { state: 'done', file, url: URL.createObjectURL(file), seconds } });
    };
    p.recorder.stop();
  };
  const discard = () => {
    if (session.rec.state === 'done') URL.revokeObjectURL(session.rec.url);
    releaseParts();
    setSession({ rec: { state: 'idle' }, error: null });
  };
  const setUploading = (uploading: boolean) => setSession({ uploading });
  return { rec, error: current.error, elapsed, start, pause, resume, stop, discard, setUploading };
}

const clockOf = (ms: number) => new Date(ms).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

// ---- who may read a meeting (the new-meeting form and the settings of a meeting)

function ViewerFields(props: {
  idPrefix: string;
  people: MinutesPerson[];
  visibility: MinutesVisibility;
  viewers: Set<string>;
  onVisibility: (v: MinutesVisibility) => void;
  onViewers: (v: Set<string>) => void;
  hint?: string;
}) {
  const { idPrefix, people, visibility, viewers, onVisibility, onViewers, hint } = props;
  return (
    <fieldset>
      <legend className="minutes-legend">見られる人（録音した人と権限管理者はいつでも見られます）</legend>
      {hint && <p className="field-hint">{hint}</p>}
      <div className="bot-check">
        <input id={`${idPrefix}-vis-selected`} type="radio" name={`${idPrefix}-visibility`} checked={visibility === 'selected'} onChange={() => onVisibility('selected')} />
        <label htmlFor={`${idPrefix}-vis-selected`}>選んだ人だけ（役員会など）</label>
      </div>
      <div className="bot-check">
        <input id={`${idPrefix}-vis-members`} type="radio" name={`${idPrefix}-visibility`} checked={visibility === 'members'} onChange={() => onVisibility('members')} />
        <label htmlFor={`${idPrefix}-vis-members`}>委員全員</label>
      </div>
      {visibility === 'selected' && (
        <div className="minutes-people" data-testid={`${idPrefix}-people`}>
          {people.map((p) => (
            <label key={p.id} className="minutes-person">
              <input
                type="checkbox"
                checked={viewers.has(p.id)}
                onChange={(e) => {
                  const next = new Set(viewers);
                  if (e.target.checked) next.add(p.id);
                  else next.delete(p.id);
                  onViewers(next);
                }}
              />
              {p.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

// ---- a new meeting

function MinutesNew({ meta, onCancel, onCreated }: { meta: MinutesMeta; onCancel: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('役員会');
  const [heldOn, setHeldOn] = useState(today);
  const [visibility, setVisibility] = useState<MinutesVisibility>('selected');
  const [viewers, setViewers] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<'record' | 'file'>('record');
  const [withTab, setWithTab] = useState(false);
  const [picked, setPicked] = useState<File | null>(null);
  const [sending, setSending] = useState<UploadState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Recordings this person sent only in part (2026-11-07): choosing the same file goes on from where it stopped.
  const [pending, setPending] = useState<MinutesUploadItem[]>([]);
  const recorder = useRecorder();
  const recording = recorder.rec.state === 'recording' || recorder.rec.state === 'paused';
  const file = source === 'file' ? picked : recorder.rec.state === 'done' ? recorder.rec.file : null;

  const refreshPending = useCallback(() => {
    void pendingUploads().then(setPending);
  }, []);
  useEffect(() => {
    refreshPending();
  }, [refreshPending]);

  const dropPending = async (uploadId: string) => {
    try {
      await api('DELETE', `/api/minutes/uploads/${uploadId}`);
    } catch (err) {
      setFailure(toFailure(err).message);
    }
    refreshPending();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || sending) return;
    setFailure(null);
    if (file.size > meta.maxAudioBytes) {
      setFailure(`録音ファイルは ${sizeLabel(meta.maxAudioBytes)} までです（このファイルは ${mb(file.size)}）。`);
      return;
    }
    setSending({ sent: 0, total: file.size, waitingUntil: null });
    recorder.setUploading(true);
    try {
      const candidates = pending.filter((p) => p.bytes === file.size).map((p) => p.uploadId);
      const uploadId = await sendRecording(file, setSending, candidates);
      const created = await api<MinutesDetail>('POST', '/api/minutes', { uploadId, title, heldOn, visibility, viewers: [...viewers] });
      forgetUpload(file);
      if (recorder.rec.state === 'done') recorder.discard();
      onCreated(created.id);
    } catch (err) {
      setFailure(toFailure(err).message);
      refreshPending();
    } finally {
      recorder.setUploading(false);
      setSending(null);
    }
  };

  return (
    <form className="bot-form bot-minutes" onSubmit={(e) => void submit(e)} data-testid="minutes-form">
      <h2 className="pane-title">新しい議事録</h2>
      <p className="status info" data-testid="minutes-consent">
        {meta.consentText}
      </p>
      <label htmlFor="minutes-title">会議名</label>
      <input id="minutes-title" type="text" value={title} maxLength={MINUTES_LIMITS.title} onChange={(e) => setTitle(e.target.value)} required />
      <label htmlFor="minutes-date">日付</label>
      <input id="minutes-date" type="date" value={heldOn} onChange={(e) => setHeldOn(e.target.value)} required />

      <ViewerFields idPrefix="minutes" people={meta.people} visibility={visibility} viewers={viewers} onVisibility={setVisibility} onViewers={setViewers} hint="作ったあとでも、録音した人と権限管理者が変えられます。" />

      {pending.length > 0 && !sending && (
        <div className="banner banner-warning" role="status" data-testid="minutes-pending">
          <p>送りかけの録音があります。同じファイルを選んで「取り込む」を押すと、続きから送ります。</p>
          <ul className="minutes-pending">
            {pending.map((p) => (
              <li key={p.uploadId}>
                {p.filename || '名前のない録音'}（{mb(p.received)} / {mb(p.bytes)}。{fmtDate(p.expiresAt)} まで残します）
                <button type="button" className="quiet" onClick={() => void dropPending(p.uploadId)}>
                  捨てる
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <fieldset disabled={recording || !!sending}>
        <legend className="minutes-legend">録音</legend>
        <div className="bot-check">
          <input id="minutes-src-record" type="radio" name="source" checked={source === 'record'} onChange={() => setSource('record')} />
          <label htmlFor="minutes-src-record">この端末で録音する</label>
        </div>
        <div className="bot-check">
          <input id="minutes-src-file" type="radio" name="source" checked={source === 'file'} onChange={() => setSource('file')} />
          <label htmlFor="minutes-src-file">録音ファイルを選ぶ（IC レコーダー・スマホで録ったもの）</label>
        </div>
      </fieldset>

      {source === 'file' && (
        <>
          <label htmlFor="minutes-file">録音ファイル（webm・m4a・mp3・wav など。{sizeLabel(meta.maxAudioBytes)} まで）</label>
          <input id="minutes-file" type="file" accept="audio/*,.m4a,.webm" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} disabled={!!sending} />
        </>
      )}

      {source === 'record' && (
        <div className="minutes-recorder">
          {recorder.rec.state === 'idle' && (
            <>
              <div className="bot-check">
                <input id="minutes-tab" type="checkbox" checked={withTab} onChange={(e) => setWithTab(e.target.checked)} />
                <label htmlFor="minutes-tab">オンライン会議（Google Meet など）のタブの音声も録る（Chrome・Edge の PC）</label>
              </div>
              <p className="field-hint">録音中はこの画面を閉じないでください。秘匿の議題の間は「一時停止」を押してください。</p>
              <button type="button" onClick={() => void recorder.start(withTab)} data-testid="minutes-record-start">
                録音を始める
              </button>
            </>
          )}
          {recording && (
            <div className={`banner ${recorder.rec.state === 'paused' ? 'banner-warning' : 'banner-error'} minutes-live`} role="status" data-testid="minutes-recording">
              <strong>{recorder.rec.state === 'paused' ? '一時停止中（録音していません）' : '● 録音中'}</strong>
              <span>{fmtOffset(recorder.elapsed)}</span>
              {recorder.rec.state === 'recording' ? (
                <button type="button" className="secondary" onClick={recorder.pause}>
                  一時停止
                </button>
              ) : (
                <button type="button" className="secondary" onClick={recorder.resume}>
                  再開
                </button>
              )}
              <button type="button" onClick={recorder.stop} data-testid="minutes-record-stop">
                録音を終える
              </button>
            </div>
          )}
          {recorder.rec.state === 'done' && (
            <div className="minutes-done">
              <p>
                録音しました（{fmtOffset(recorder.rec.seconds)}・{mb(recorder.rec.file.size)}）。下の「取り込む」でサーバーに送ります。
              </p>
              <audio controls src={recorder.rec.url} preload="metadata" />
              <p className="field-hint">
                送れなかったときのために、
                <a href={recorder.rec.url} download={`議事録の録音_${heldOn}.${recorder.rec.file.name.split('.').pop()}`}>
                  この端末に保存
                </a>
                もできます。
              </p>
              <button type="button" className="quiet" onClick={recorder.discard} disabled={!!sending}>
                この録音を捨てる
              </button>
            </div>
          )}
          {recorder.error && (
            <p className="status error" role="alert">
              {recorder.error}
            </p>
          )}
        </div>
      )}

      {sending && (
        <p className={`status ${sending.waitingUntil ? 'warning' : 'loading'}`} role="status" data-testid="minutes-sending">
          {sending.waitingUntil
            ? `通信が切れています。つながれば続きから送ります（${clockOf(sending.waitingUntil)} まで待ちます）。送った分: ${mb(sending.sent)} / ${mb(sending.total)}`
            : `送信中… ${mb(sending.sent)} / ${mb(sending.total)}`}
        </p>
      )}
      {failure && (
        <p className="status error" role="alert" data-testid="minutes-failure">
          {failure}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={!file || !!sending || recording || !title.trim()} data-testid="minutes-submit">
          取り込む
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={!!sending || recording}>
          やめる
        </button>
      </div>
    </form>
  );
}

// ---- one meeting

function EvidenceLinks({ evidence, onJump }: { evidence: MinutesEvidence[]; onJump: (at: number) => void }) {
  if (evidence.length === 0) return null;
  return (
    <span className="minutes-evidence">
      {evidence.map((e, i) => (
        <button
          key={i}
          type="button"
          className={`minutes-at ${e.verified ? '' : 'minutes-unverified'}`}
          title={e.verified ? `「${e.quote}」` : `要確認: 文字起こしに見つからない抜粋「${e.quote}」`}
          onClick={() => onJump(e.at)}
        >
          {fmtOffset(e.at)}
          {e.verified ? '' : ' 要確認'}
        </button>
      ))}
    </span>
  );
}

/**
 * The title, the date and who may read the meeting, changed in place (2026-11-05; the recorder and the access
 * administrators). Saving leaves the body being corrected as it is.
 */
function MinutesSettings({ m, people, onSaved, onCancel }: { m: MinutesDetail; people: MinutesPerson[]; onSaved: (next: MinutesDetail) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(m.title);
  const [heldOn, setHeldOn] = useState(m.heldOn);
  const [visibility, setVisibility] = useState<MinutesVisibility>(m.visibility);
  const [viewers, setViewers] = useState(() => new Set(m.viewers.map((v) => v.id)));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The button that opened it is gone: keyboard users go on from the form (without raising a phone's keyboard).
  const form = useRef<HTMLFormElement | null>(null);
  useEffect(() => form.current?.focus(), []);
  // People chosen earlier who are no longer listed as members stay on the list, so they can be taken off.
  const listed = [...people, ...m.viewers.filter((v) => !people.some((p) => p.id === v.id)).map((v) => ({ id: v.id, name: `${v.name}（いまは委員の一覧にいません）` }))];
  const narrowed = m.visibility === 'members' && visibility === 'selected';
  const renamed = (title.trim() !== m.title || heldOn !== m.heldOn) && m.body.trim() !== '';

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFailure(null);
    try {
      const body: MinutesSettingsUpdate = { title, heldOn, visibility, viewers: [...viewers] };
      onSaved(await api<MinutesDetail>('PUT', `/api/minutes/${m.id}/settings`, body));
    } catch (err) {
      setFailure(toFailure(err).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form ref={form} tabIndex={-1} className="bot-form panel minutes-settings" onSubmit={(e) => void save(e)} aria-label="会議名・日付・見られる人" data-testid="minutes-settings">
      <label htmlFor="minutes-set-title">会議名</label>
      <input id="minutes-set-title" type="text" value={title} maxLength={MINUTES_LIMITS.title} onChange={(e) => setTitle(e.target.value)} required />
      <label htmlFor="minutes-set-date">日付</label>
      <input id="minutes-set-date" type="date" value={heldOn} onChange={(e) => setHeldOn(e.target.value)} required />
      {renamed && <p className="field-hint">本文の中の会議名・日付は変わりません。{m.stage === 'draft' ? '必要なら本文で直してください。' : ''}</p>}
      <ViewerFields idPrefix="minutes-set" people={listed} visibility={visibility} viewers={viewers} onVisibility={setVisibility} onViewers={setViewers} />
      {narrowed && m.registeredDecisions > 0 && (
        <p className="status warning" role="status" data-testid="minutes-settings-registered">
          この議事録から決定事項の台帳に {m.registeredDecisions} 件登録しています。見られる人を絞っても、台帳の項目は委員全員に見えたまま残ります。必要なら台帳で取り消してください。
        </p>
      )}
      {failure && (
        <p className="status error" role="alert">
          {failure}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || !title.trim()} data-testid="minutes-settings-save">
          {saving ? '変更しています…' : 'この内容に変更する'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
          やめる
        </button>
      </div>
    </form>
  );
}

function MinutesDetailView({ meetingId, people, onBack }: { meetingId: string; people: MinutesPerson[]; onBack: () => void }) {
  const [version, setVersion] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void version;
      return api<MinutesDetail>('GET', `/api/minutes/${meetingId}`, undefined, signal);
    },
    [meetingId, version],
  );
  const loader = useLoader(load);
  // What an action answered is shown at once (the list reloads only while the server is working).
  const [latest, setLatest] = useState<MinutesDetail | null>(null);
  const [seen, setSeen] = useState(loader.data);
  if (loader.data !== seen) {
    setSeen(loader.data);
    setLatest(null);
  }
  const m = latest ?? loader.data;
  const [body, setBody] = useState<{ text: string; base: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<TranscriptMode | null>(null);
  const [target, setTarget] = useState<TranscriptTarget | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  // One segment's stretch plays and stops by itself at its end (listening again, 2026-11-06).
  const stopAt = useRef<number | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const commentBox = useRef<HTMLTextAreaElement | null>(null);
  const transcriptSection = useRef<HTMLDivElement | null>(null);
  const processing = m ? PROCESSING.includes(m.stage) : false;
  const { retry } = loader;

  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(retry, POLL_MS);
    return () => clearInterval(timer);
  }, [processing, retry]);

  // The editor starts from the saved minutes, and follows them when nothing was typed since.
  const editing = body && m && body.base === m.version ? body.text : (m?.body ?? '');
  const dirty = !!m && editing !== m.body;
  if (m && body && body.base !== m.version && body.text === m.body) setBody(null);

  const unclearAt = useMemo(() => (m?.draft?.unclear ?? []).flatMap((u) => (u.at === null ? [] : [u.at])), [m?.draft]);
  const toListen = useMemo(() => (m?.transcript?.segments ?? []).filter((s) => !s.checked && doubtsOf(s, unclearAt).length > 0).length, [m?.transcript, unclearAt]);

  const run = async (fn: () => Promise<MinutesDetail | null>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await fn();
      setBody(null);
      setMessage({ tone: 'ok', text: done });
      if (next) {
        setLatest(next);
        if (PROCESSING.includes(next.stage)) setVersion((v) => v + 1);
      }
    } catch (err) {
      setMessage({ tone: 'error', text: toFailure(err).message });
    } finally {
      setBusy(false);
    }
  };

  /** Plays the recording from `from`, stopping at `until` (null: plays on). False without a player. */
  const startAudio = (from: number, until: number | null) => {
    const el = audio.current;
    if (!el) return false;
    stopAt.current = until;
    el.currentTime = Math.max(0, from);
    void el.play().catch(() => setPlaying(null));
    return true;
  };
  const playStretch = (index: number, s: TranscriptSegment) => {
    if (playing === index) {
      audio.current?.pause();
      return;
    }
    // A little before and after: the first and the last sound of a segment are often cut by its timing.
    if (startAudio(s.start - 0.3, s.end + 0.4)) setPlaying(index);
  };
  // Paused by hand (or at the end): the player's own controls play on freely afterwards.
  const audioStopped = () => {
    stopAt.current = null;
    setPlaying(null);
  };

  const jump = (at: number) => {
    setPlaying(null);
    startAudio(at, null);
    const segments = m?.transcript?.segments ?? [];
    let index = segments.findIndex((s) => s.end >= at);
    if (index < 0) index = segments.length - 1;
    if (index >= 0) setTarget((t) => ({ index, seq: (t?.seq ?? 0) + 1 }));
  };

  /** Quotes an AI item into the comment to send back, and puts the cursor after it. */
  const quote = (label: string, text: string) => {
    const short = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    const next = `${comment ? `${comment.replace(/\s+$/, '')}\n` : ''}${label}「${short}」について: `;
    setComment(next);
    requestAnimationFrame(() => {
      const el = commentBox.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  };

  if (!m) return <LoadStatus loader={loader} what="議事録" />;
  const d = m.draft;
  const shownMode: TranscriptMode = mode ?? (m.can.check && toListen > 0 ? 'doubt' : 'all');
  const lastVersion = m.versions.at(-1) ?? null;
  const lastReview = m.reviews.at(-1) ?? null;
  const commentButton = (label: string, text: string) =>
    m.can.review && !m.revising ? (
      <button type="button" className="quiet minutes-quote" onClick={() => quote(label, text)} aria-label={`${label}「${text}」についてコメントする`}>
        コメント
      </button>
    ) : null;

  return (
    <div className="bot-minutes" data-testid="minutes-detail">
      <div className="minutes-head">
        <button type="button" className="quiet" onClick={onBack}>
          ← 一覧へ
        </button>
        <a className="button secondary" href={`/api/minutes/${m.id}/export.md`} download>
          Markdown で書き出す
        </a>
      </div>
      <h2 className="pane-title">
        {m.heldOn} {m.title}
      </h2>
      <p className="row-sub">
        <StageTag stage={m.stage} revising={m.revising} reopened={m.reopened} /> 録音: {m.createdByName}（{fmtDate(m.createdAt)}）
        {m.confirmedByName && m.confirmedAt ? `・確定: ${m.confirmedByName}（${fmtDate(m.confirmedAt)}${lastVersion ? `・第${lastVersion.no}版` : ''}）` : ''}・見られる人:{' '}
        {m.visibility === 'members' ? '委員全員' : m.viewers.map((v) => v.name).join('、') || '録音した人だけ'}
      </p>
      {m.can.manage && !settingsOpen && (
        <div>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setMessage(null);
              setSettingsOpen(true);
            }}
            data-testid="minutes-settings-open"
          >
            会議名・日付・見られる人を変える
          </button>
        </div>
      )}
      {m.can.manage && settingsOpen && (
        <MinutesSettings
          m={m}
          people={people}
          onCancel={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setLatest(next);
            setSettingsOpen(false);
            setMessage({ tone: 'ok', text: '会議名・日付・見られる人を変更しました。' });
          }}
        />
      )}
      {loader.error && <LoadStatus loader={loader} what="議事録" />}
      {m.reopened && lastVersion && (
        <div className="banner banner-warning minutes-reopened" role="status" data-testid="minutes-reopened">
          <p>
            確定した第{lastVersion.no}版を訂正しています。訂正を確定すると第{lastVersion.no + 1}版になり、第{lastVersion.no}版は履歴に残ります。それまでは第{lastVersion.no}版が正式な議事録です。
            {m.registeredDecisions > 0 ? ` この議事録から決定事項の台帳に ${m.registeredDecisions} 件登録しています。訂正しても台帳の項目は変わらないので、必要なら台帳で直してください。` : ''}
          </p>
          {m.can.discard && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`訂正をやめて、本文と AI の項目を第${lastVersion.no}版に戻します（今の本文は記録に残ります。文字起こしの直しはそのままです）。戻しますか？`)) return;
                void run(() => api<MinutesDetail>('POST', `/api/minutes/${m.id}/discard`, { expectedVersion: m.version }), `訂正をやめて第${lastVersion.no}版に戻しました。`);
              }}
              data-testid="minutes-discard"
            >
              訂正をやめて第{lastVersion.no}版に戻す
            </button>
          )}
        </div>
      )}
      {processing && (
        <p className="status loading" role="status" data-testid="minutes-processing">
          {m.revising
            ? 'AI がコメントに沿って下書きを直しています。終わるとこの画面が自動で変わります（数分かかることがあります）。'
            : `${MINUTES_STAGE_LABELS[m.stage]}です。終わるとこの画面が自動で変わります（1 時間の会議で数十分かかることがあります）。`}
        </p>
      )}
      {processing && m.progress && <ProgressLine p={m.progress} />}
      {m.stage === 'failed' && (
        <p className="status error" role="alert">
          {m.error ?? '処理に失敗しました。'}
          {m.can.retry && (
            <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => api<MinutesDetail>('POST', `/api/minutes/${m.id}/retry`), 'やり直しを受け付けました。')}>
              やり直す
            </button>
          )}
        </p>
      )}
      {m.stage === 'draft' && lastReview?.status === 'failed' && (
        <p className="status error" role="alert" data-testid="minutes-review-failed">
          最後の差し戻しは AI が直せませんでした（{lastReview.error ?? '理由は不明'}）。下書きは差し戻す前のままです。もう一度差し戻すか、本文を直接直してください。
        </p>
      )}
      {message && (
        <p className={`status ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}

      {m.can.listen && m.audio.present && (
        <audio
          ref={audio}
          controls
          preload="metadata"
          src={`/api/minutes/${m.id}/audio`}
          className="minutes-audio"
          onTimeUpdate={(e) => {
            if (stopAt.current !== null && e.currentTarget.currentTime >= stopAt.current) {
              stopAt.current = null;
              e.currentTarget.pause();
            }
          }}
          onPause={audioStopped}
          onEnded={audioStopped}
        />
      )}
      <p className="hint">
        {m.audio.deletedAt ? `音声は ${fmtDate(m.audio.deletedAt)} に消去しました。` : m.audio.deletesAt ? `音声は ${fmtDate(m.audio.deletesAt)} ごろ消去します（最初の確定から数えます）。` : '音声は確定してから決まった日数で消去します。'}
        {!m.can.listen && !m.audio.deletedAt ? '（音声を聞けるのは、録音した人と権限管理者だけです）' : ''}
      </p>
      {m.can.check && toListen > 0 && (
        <p className="status info minutes-listen-call" data-testid="minutes-listen-call">
          音声認識の自信が低い所が {toListen} 件あります。
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setMode('doubt');
              requestAnimationFrame(() => transcriptSection.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
            }}
          >
            聞き直す
          </button>
        </p>
      )}

      {(m.stage === 'draft' || m.stage === 'confirmed' || m.revising) && (
        <div className="minutes-columns">
          <section className="panel minutes-editor" aria-label="議事録">
            <h3>
              {m.revising
                ? '議事録（AI が手直し中）'
                : m.stage === 'confirmed'
                  ? `議事録（確定${lastVersion ? `・第${lastVersion.no}版` : ''}）`
                  : m.reopened
                    ? '議事録（訂正中。直してから訂正を確定してください）'
                    : '議事録（AI の下書き。直してから確定してください）'}
            </h3>
            {m.can.edit ? (
              <>
                <textarea
                  value={editing}
                  rows={24}
                  maxLength={MINUTES_LIMITS.body}
                  onChange={(e) => setBody({ text: e.target.value, base: m.version })}
                  aria-label="議事録の本文"
                  data-testid="minutes-body"
                />
                {m.reopened && (
                  <div className="minutes-note">
                    <label htmlFor="minutes-note">訂正した内容（確定の履歴に残ります）</label>
                    <input
                      id="minutes-note"
                      type="text"
                      value={note}
                      maxLength={MINUTES_LIMITS.note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="例: 内務部の ToDo の期限を 11/27 に直した"
                      data-testid="minutes-note"
                    />
                  </div>
                )}
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={!dirty || busy}
                    onClick={() => void run(() => api<MinutesDetail>('PUT', `/api/minutes/${m.id}/body`, { expectedVersion: m.version, body: editing }), '保存しました。')}
                    data-testid="minutes-save"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    disabled={dirty || busy || (m.reopened && !note.trim())}
                    title={dirty ? '先に保存してください' : m.reopened && !note.trim() ? '訂正した内容を書いてください' : undefined}
                    onClick={() => {
                      const ask = m.reopened
                        ? `この内容を第${(lastVersion?.no ?? 0) + 1}版として確定します。第${lastVersion?.no ?? 1}版は履歴に残ります。確定しますか？`
                        : 'この内容で確定します。確定したあとも「訂正する」で直せます（確定した版は履歴に残ります）。音声は確定から決まった日数のあとに消去されます。確定しますか？';
                      if (!window.confirm(ask)) return;
                      void run(async () => {
                        const next = await api<MinutesDetail>('POST', `/api/minutes/${m.id}/confirm`, { expectedVersion: m.version, ...(m.reopened ? { note } : {}) });
                        setNote('');
                        return next;
                      }, m.reopened ? '訂正を確定しました。' : '確定しました。');
                    }}
                    data-testid="minutes-confirm"
                  >
                    {m.reopened ? '訂正を確定する' : '確定する'}
                  </button>
                  {dirty && <span className="hint">未保存の変更があります</span>}
                  {!dirty && m.reopened && !note.trim() && <span className="hint">確定するには、訂正した内容を書いてください</span>}
                </div>
              </>
            ) : (
              <>
                <pre className="minutes-body" data-testid="minutes-final">
                  {m.body}
                </pre>
                {m.can.reopen && (
                  <div className="actions minutes-reopen">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void run(() => api<MinutesDetail>('POST', `/api/minutes/${m.id}/reopen`, { expectedVersion: m.version }), '訂正を始めました。直したら「訂正を確定する」を押してください。')}
                      data-testid="minutes-reopen"
                    >
                      訂正する
                    </button>
                    <span className="hint">確定した版は履歴に残ります。訂正中も AI への差し戻しと聞き直しを使えます。</span>
                  </div>
                )}
              </>
            )}
          </section>
          {d && (
            <section className="panel minutes-ai" aria-label="AI が拾った根拠">
              <h3>AI が拾った項目と根拠</h3>
              <MinutesSendBack
                m={m}
                comment={comment}
                onComment={setComment}
                box={commentBox}
                dirty={dirty}
                onSent={(next) => {
                  setLatest(next);
                  setVersion((v) => v + 1);
                  setMessage({ tone: 'ok', text: 'AI に差し戻しました。' });
                }}
              />
              <p className="hint">時刻を押すと、その発言の位置へ移ります。「要確認」は、AI の挙げた抜粋が文字起こしに見つからなかったものです。</p>
              {d.decisions.length > 0 && <h4>決定事項</h4>}
              <ul className="rows">
                {d.decisions.map((x, i) => (
                  <li key={`d${i}`}>
                    {x.text} <EvidenceLinks evidence={x.evidence} onJump={jump} />
                    {commentButton('決定事項', x.text)}
                  </li>
                ))}
              </ul>
              {/* Registered after the minutes are confirmed (the text the people confirmed), never from the AI draft. */}
              {m.stage === 'confirmed' && d.decisions.length > 0 && <MinutesDecisionPanel meetingId={m.id} heldOn={m.heldOn} visibility={m.visibility} items={d.decisions} />}
              {d.todos.length > 0 && <h4>ToDo</h4>}
              <ul className="rows">
                {d.todos.map((x, i) => (
                  <li key={`t${i}`}>
                    {x.text}（{[x.department, x.assignee].filter(Boolean).join(' ') || '担当未定'}／期限: {x.due || '未定'}） <EvidenceLinks evidence={x.evidence} onJump={jump} />
                    {commentButton('ToDo', x.text)}
                  </li>
                ))}
              </ul>
              {d.unclear.length > 0 && <h4>要確認</h4>}
              <ul className="rows">
                {d.unclear.map((x, i) => (
                  <li key={`u${i}`}>
                    {x.text}{' '}
                    {x.at !== null && (
                      <button type="button" className="minutes-at" onClick={() => jump(x.at!)}>
                        {fmtOffset(x.at)}
                      </button>
                    )}
                    {commentButton('要確認', x.text)}
                  </li>
                ))}
              </ul>
              <MinutesReviewHistory m={m} />
            </section>
          )}
        </div>
      )}

      {m.transcript && (
        <div ref={transcriptSection}>
          <MinutesTranscript m={m} playing={playing} onPlay={playStretch} mode={shownMode} onMode={setMode} target={target} onSaved={(next) => setLatest(next)} />
        </div>
      )}

      <MinutesVersions m={m} />

      {m.can.delete && (
        <div className="actions minutes-danger">
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('この議事録（音声・文字起こし・本文・確定の履歴）を消します。元に戻せません。消しますか？')) return;
              void run(async () => {
                await api<null>('DELETE', `/api/minutes/${m.id}?expectedVersion=${m.version}`);
                onBack();
                return null;
              }, '消しました。');
            }}
          >
            この議事録を消す
          </button>
        </div>
      )}
    </div>
  );
}
