import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { certaintyOf, doubtsOf, fmtOffset, textDiff, unclearTimes, type MinutesDetail, type MinutesSegmentUpdate, type TranscriptSegment } from '../../../shared/minutes';
import { api, fmtDate, toFailure } from '../../api';

// The transcript of a meeting, and listening again to the parts the speech model was unsure of (2026-11-06). In the
// "聞き直す所" view only the doubtful segments are listed: each plays just its own stretch of the recording, and the
// person corrects the text or confirms it as it is. The text as the model heard it is kept on the server. Those who may
// not listen to the audio (only the recorder and the access administrators may) can still correct the text by reading.
//
// 2026-11-10: the AI's guess of what was said (from the context; it does not hear the recording) fills the box at
// first, with what it changes marked above it. The person still listens and confirms; a guess confirmed as it was is
// recorded as such.

export type TranscriptMode = 'doubt' | 'all';

/** A segment to show in the full transcript and scroll to (from the evidence of an AI item). */
export interface TranscriptTarget {
  index: number;
  seq: number;
}

interface Props {
  m: MinutesDetail;
  /** The segment whose stretch of the recording is playing (the meeting's player is on the meeting's screen). */
  playing: number | null;
  /** Plays a segment's stretch, or stops it when it is the one playing. */
  onPlay: (index: number, segment: TranscriptSegment) => void;
  mode: TranscriptMode;
  onMode: (mode: TranscriptMode) => void;
  target: TranscriptTarget | null;
  onSaved: (next: MinutesDetail) => void;
}

/** The AI guessed something other than what was heard. */
const changedByGuess = (s: TranscriptSegment) => s.suggestion !== undefined && s.suggestion !== s.text;

/** The text with the words the model was least sure of marked (searched in order, as the model gave them). */
function MarkedText({ segment }: { segment: TranscriptSegment }) {
  const text = segment.text;
  if (!text) return <span className="minutes-empty-text">（発言なし）</span>;
  const weak = segment.checked ? [] : (segment.confidence?.weak ?? []);
  const out: ReactNode[] = [];
  let at = 0;
  weak.forEach((w, i) => {
    const found = text.indexOf(w.word, at);
    if (found < 0) return;
    if (found > at) out.push(text.slice(at, found));
    out.push(
      <mark key={i} className="minutes-weak" title={`確からしさ ${Math.round(w.p * 100)}%`}>
        {w.word}
      </mark>,
    );
    at = found + w.word.length;
  });
  out.push(text.slice(at));
  return <>{out}</>;
}

function CheckedNote({ segment }: { segment: TranscriptSegment }) {
  const c = segment.checked;
  if (!c) return null;
  const changed = c.original !== segment.text;
  return (
    <p className="minutes-checked" data-testid="minutes-segment-checked">
      ✓ {c.ai ? 'AI の案で直しました' : changed ? '直しました' : 'このままで正しいと確かめました'}（{c.byName}・{fmtDate(c.at)}）
      {changed && <span className="minutes-original">AI が聞いた文字: {c.original || '（なし）'}</span>}
    </p>
  );
}

/** What the AI's guess changes in the text as heard: struck out what goes, marked what comes. */
function GuessDiff({ heard, guess }: { heard: string; guess: string }) {
  return (
    <p className="minutes-guess" data-testid="minutes-guess">
      <span className="minutes-guess-label">AI の案</span>{' '}
      {textDiff(heard, guess).map((p, i) =>
        p.kind === 'same' ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === 'del' ? (
          <del key={i} className="minutes-guess-del" title="AI が消した文字">
            {p.text}
          </del>
        ) : (
          <ins key={i} className="minutes-guess-ins" title="AI が入れた文字">
            {p.text}
          </ins>
        ),
      )}
    </p>
  );
}

/** Where the AI's guesses stand, and the button to ask for them (again, or on from where they stopped). */
function GuessStatus({ m, onSaved }: { m: MinutesDetail; onSaved: (next: MinutesDetail) => void }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const s = m.suggest;
  const ask = async () => {
    setBusy(true);
    setFailure(null);
    try {
      onSaved(await api<MinutesDetail>('POST', `/api/minutes/${m.id}/suggest`, {}));
    } catch (err) {
      setFailure(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  };
  const count = s && s.total > 0 ? `${s.done}/${s.total} 文` : '';
  const text = !s
    ? 'AI の案はまだありません。'
    : s.status === 'wait'
      ? `AI の案：順番待ち（${fmtDate(s.requestedAt)}・${s.requestedByName}${s.done > 0 ? `・${count}済み` : ''}）。処理役が取りに来ると始まります。`
      : s.status === 'run'
        ? `AI の案を作っています（${count}済み）。できた所から下の欄に入ります。`
        : s.status === 'done'
          ? `AI の案：${s.changed} 文に直す案、${s.unchanged} 文は直す所なし（${s.doneAt ? fmtDate(s.doneAt) : ''}）。`
          : `AI の案づくりが途中で止まりました（${count}済み）：${s.error ?? '理由は不明'}`;
  const label = s?.status === 'failed' ? '続きから作る' : s ? '作り直す' : 'AI の案を作る';
  return (
    <div className="minutes-guess-status" data-testid="minutes-guess-status">
      <p className={`status ${s?.status === 'failed' ? 'error' : 'info'}`} role={s?.status === 'failed' ? 'alert' : 'status'}>
        {text}
        {m.can.suggest && (
          <button type="button" className="secondary" onClick={() => void ask()} disabled={busy} data-testid="minutes-guess-ask">
            {label}
          </button>
        )}
      </p>
      {failure && (
        <p className="status error" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

export function MinutesTranscript({ m, playing, onPlay, mode, onMode, target, onSaved }: Props) {
  const transcript = m.transcript;
  const segments = useMemo(() => transcript?.segments ?? [], [transcript]);
  const unclearAt = useMemo(() => unclearTimes(m.draft), [m.draft]);
  const measured = segments.some((s) => s.confidence);
  const [order, setOrder] = useState<'time' | 'certainty' | 'guess'>('time');
  const [showChecked, setShowChecked] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [failure, setFailure] = useState<{ index: number; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useRef<HTMLOListElement | null>(null);
  const canPlay = m.can.listen && m.audio.present;

  const doubtful = useMemo(() => {
    const rows = segments.map((s, index) => ({ s, index, reasons: doubtsOf(s, unclearAt), certainty: certaintyOf(s) })).filter((r) => r.reasons.length > 0);
    if (order === 'certainty') return rows.slice().sort((a, b) => (a.certainty ?? 101) - (b.certainty ?? 101) || a.index - b.index);
    // The segments the AI would change first (in time order), then the rest.
    if (order === 'guess') return rows.slice().sort((a, b) => Number(changedByGuess(b.s)) - Number(changedByGuess(a.s)) || a.index - b.index);
    return rows;
  }, [segments, unclearAt, order]);
  const open = doubtful.filter((r) => !r.s.checked);
  const shown = showChecked ? doubtful : open;

  // An AI item's time: the full transcript, scrolled to the segment (once per jump: switching back to the doubtful
  // segments afterwards stays there).
  const handled = useRef(0);
  useEffect(() => {
    if (!target || target.seq === handled.current) return;
    if (mode !== 'all') {
      onMode('all');
      return;
    }
    handled.current = target.seq;
    list.current?.querySelector<HTMLElement>(`[data-index="${target.index}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [target, mode, onMode]);

  if (!transcript) return null;

  // What the box shows: what the person typed, else the AI's guess, else the text as heard.
  const textOf = (index: number) => texts[index] ?? segments[index]!.suggestion ?? segments[index]!.text;

  const save = async (index: number, nextFocus: number | null) => {
    const segment = segments[index]!;
    const text = textOf(index).replace(/\s+/g, ' ').trim();
    setSaving(index);
    setFailure(null);
    try {
      const body: MinutesSegmentUpdate = { expectedText: segment.text, text };
      const next = await api<MinutesDetail>('PUT', `/api/minutes/${m.id}/segments/${index}`, body);
      setTexts((t) => {
        const rest = { ...t };
        delete rest[index];
        return rest;
      });
      setEditing(null);
      setNotice(`${fmtOffset(segment.start)} を${text === segment.text ? '確かめました' : '直しました'}。`);
      onSaved(next);
      // The next segment to listen to takes the place of this one: the cursor goes on there.
      if (nextFocus !== null) requestAnimationFrame(() => list.current?.querySelector<HTMLInputElement>(`[data-input="${nextFocus}"]`)?.focus());
    } catch (err) {
      setFailure({ index, text: toFailure(err).message });
    } finally {
      setSaving(null);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>, index: number, nextFocus: number | null) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void save(index, nextFocus);
    } else if (event.key === 'Escape') {
      setTexts((t) => ({ ...t, [index]: segments[index]!.text }));
      if (mode === 'all') setEditing(null);
    }
  };

  const playButton = (index: number, s: TranscriptSegment) =>
    canPlay ? (
      <button
        type="button"
        className="minutes-play"
        onClick={() => onPlay(index, s)}
        aria-label={`${fmtOffset(s.start)} から再生`}
        aria-pressed={playing === index}
        data-testid="minutes-play"
      >
        {playing === index ? '■ 止める' : `▶ ${fmtOffset(s.start)}`}
      </button>
    ) : (
      <span className="minutes-time">{fmtOffset(s.start)}</span>
    );

  const editor = (index: number, nextFocus: number | null) => {
    const s = segments[index]!;
    const value = textOf(index);
    const typed = value.replace(/\s+/g, ' ').trim();
    const guess = changedByGuess(s) ? s.suggestion! : null;
    return (
      <div className="minutes-check-edit">
        <input
          type="text"
          value={value}
          onChange={(e) => setTexts((t) => ({ ...t, [index]: e.target.value }))}
          onKeyDown={(e) => onKey(e, index, nextFocus)}
          aria-label={`${fmtOffset(s.start)} の発言`}
          data-input={index}
          disabled={saving === index}
        />
        <button type="button" onClick={() => void save(index, nextFocus)} disabled={saving === index} data-testid="minutes-segment-save">
          {typed === s.text ? 'このままで正しい' : guess !== null && typed === guess ? 'AI の案で確定' : '直して確定'}
        </button>
        {guess !== null && typed !== guess && (
          <button
            type="button"
            className="quiet"
            onClick={() => {
              setTexts((t) => ({ ...t, [index]: guess }));
              // The button goes once the box holds the guess again: the cursor goes back to the box, not lost.
              requestAnimationFrame(() => list.current?.querySelector<HTMLInputElement>(`[data-input="${index}"]`)?.focus());
            }}
            data-testid="minutes-guess-restore"
          >
            AI の案に戻す
          </button>
        )}
        {failure?.index === index && (
          <p className="status error" role="alert">
            {failure.text}
          </p>
        )}
      </div>
    );
  };

  return (
    <section className="panel minutes-transcript" aria-labelledby="minutes-transcript-title" data-testid="minutes-transcript">
      <div className="minutes-transcript-head">
        <h3 id="minutes-transcript-title">
          文字起こし（{segments.length} 文・{fmtOffset(transcript.durationSec)}・{transcript.model}）
        </h3>
        <div className="view-switch" role="group" aria-label="文字起こしの見せ方">
          <button type="button" aria-pressed={mode === 'doubt'} onClick={() => onMode('doubt')} data-testid="minutes-mode-doubt">
            聞き直す所（{open.length}）
          </button>
          <button type="button" aria-pressed={mode === 'all'} onClick={() => onMode('all')} data-testid="minutes-mode-all">
            全文
          </button>
        </div>
      </div>
      {notice && (
        <p className="status ok" role="status">
          {notice}
        </p>
      )}

      {mode === 'doubt' && (
        <>
          <p className="hint">
            {measured
              ? '音声認識の自信が低い文と、AI が要確認とした所だけを並べています。'
              : 'この文字起こしは確からしさを記録する前に作られたため、AI が要確認とした所だけを並べています。'}
            {canPlay ? '▶ でその文だけを再生します。' : m.audio.present ? '（音声を聞けるのは、録音した人と権限管理者だけです。文字は読んで直せます）' : '（音声は消去済みです。文字は読んで直せます）'}
            {m.can.check ? '直したら Enter（直さないときもそのまま Enter で「正しい」と記録）。' : ''}
            {m.can.check
              ? 'AI の案は前後の発言と用語集からの推測で、AI は音声を聞いていません。欄に入っていても、聞いて確かめてから確定してください（Esc で聞いたままの文に戻ります）。'
              : ''}
          </p>
          {(m.can.check || m.suggest) && <GuessStatus m={m} onSaved={onSaved} />}
          <div className="minutes-check-tools">
            <label>
              並び
              <select value={order} onChange={(e) => setOrder(e.target.value as 'time' | 'certainty' | 'guess')}>
                <option value="time">時刻順</option>
                <option value="certainty">自信の低い順</option>
                <option value="guess">AI が直した文を先に</option>
              </select>
            </label>
            <label className="bot-check">
              <input type="checkbox" checked={showChecked} onChange={(e) => setShowChecked(e.target.checked)} />
              確かめた文も出す（{doubtful.length - open.length}）
            </label>
          </div>
          {doubtful.length === 0 && <p className="list-empty">聞き直す所はありません。</p>}
          {doubtful.length > 0 && shown.length === 0 && <p className="list-empty">聞き直す所はすべて確かめました。</p>}
          <ol ref={list} className="minutes-check-list">
            {shown.map((r, i) => (
              <li key={r.index} className={`minutes-check-row${r.s.checked ? ' is-checked' : ''}`} data-testid="minutes-doubt-row">
                <div className="minutes-check-head">
                  {playButton(r.index, r.s)}
                  <span className="minutes-reasons">
                    {r.reasons.map((reason) => (
                      <span key={reason} className="bot-tag bot-tag-warn">
                        {reason}
                      </span>
                    ))}
                    {r.certainty !== null && <span className="minutes-certainty">確からしさ {r.certainty}%</span>}
                    {!r.s.checked && r.s.suggestion !== undefined && !changedByGuess(r.s) && <span className="minutes-guess-same">AI: 直す所なし</span>}
                  </span>
                </div>
                <p className="minutes-heard">
                  <MarkedText segment={r.s} />
                </p>
                {!r.s.checked && changedByGuess(r.s) && <GuessDiff heard={r.s.text} guess={r.s.suggestion!} />}
                {m.can.check && !r.s.checked && editor(r.index, shown[i + 1]?.index ?? null)}
                <CheckedNote segment={r.s} />
              </li>
            ))}
          </ol>
        </>
      )}

      {mode === 'all' && (
        <ol ref={list} className="minutes-segments">
          {segments.map((s, i) => (
            <li key={i} data-index={i} className={s.checked ? 'is-checked' : undefined}>
              {playButton(i, s)}{' '}
              {editing === i ? (
                editor(i, null)
              ) : (
                <>
                  <MarkedText segment={s} />
                  {s.checked && (
                    <span className="minutes-checked-mark" title={s.checked.original !== s.text ? `${s.checked.ai ? 'AI の案で直した。' : ''}直す前: ${s.checked.original}` : '確かめた文'}>
                      {' '}
                      ✓
                    </span>
                  )}
                  {m.can.check && (
                    <button type="button" className="quiet minutes-fix" onClick={() => setEditing(i)} aria-label={`${fmtOffset(s.start)} の発言を直す`}>
                      直す
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
