// Meeting minutes (α, 2026-11-02; _目録/設計/議事録自動化_20261102/設計書.md). A recording is uploaded (or
// recorded in the browser), the minutes worker on the server host transcribes it (faster-whisper) and drafts the
// minutes (Claude, plain text only), and a committee member corrects the draft and confirms it. The audio never
// leaves the server host; it is deleted a fixed number of days after the minutes are confirmed.

export const MINUTES_STAGES = ['transcribe_wait', 'transcribe_run', 'summarize_wait', 'summarize_run', 'draft', 'confirmed', 'failed'] as const;
export type MinutesStage = (typeof MINUTES_STAGES)[number];

export const MINUTES_STAGE_LABELS: Record<MinutesStage, string> = {
  transcribe_wait: '文字起こしの順番待ち',
  transcribe_run: '文字起こし中',
  summarize_wait: '要約の順番待ち',
  summarize_run: '要約中',
  draft: '下書き（確認待ち）',
  confirmed: '確定',
  failed: '失敗',
};

/** Who may read a meeting besides its recorder and the access administrators. */
export const MINUTES_VISIBILITIES = ['selected', 'members'] as const;
export type MinutesVisibility = (typeof MINUTES_VISIBILITIES)[number];

export const MINUTES_LIMITS = {
  title: 100,
  body: 100_000,
  viewers: 100,
  /**
   * One upload: about 3 hours of an uncompressed recording (16-bit stereo WAV at 48 kHz, as IC recorders write).
   * Raised from 300 MB on 2026-11-05; the worker transcribes in 10-minute pieces, so the length does not raise its memory.
   */
  audioBytes: 2 * 1024 * 1024 * 1024,
  segments: 20_000,
  segmentText: 2_000,
  item: 1_000,
  items: 100,
  quote: 200,
  /** A comment sent back to the AI with the draft (2026-11-06). */
  comment: 2_000,
  /** The AI's answer to a comment. */
  reply: 2_000,
  /** What a correction after confirmation changed, written into the history of versions. */
  note: 500,
  /** Comments sent back per meeting (each one runs the AI again). */
  reviews: 10,
} as const;

/** A size limit as people read it: "2 GB", "300 MB". */
export function sizeLabel(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${Number(gb.toFixed(1))} GB` : `${Math.floor(bytes / 1024 ** 2)} MB`;
}

/** Accepted recordings: the browser's own (webm/ogg) and what phones and IC recorders write. */
export const MINUTES_AUDIO_EXTENSIONS = ['webm', 'ogg', 'm4a', 'mp4', 'mp3', 'wav', 'aac', 'flac'] as const;
export type MinutesAudioExtension = (typeof MINUTES_AUDIO_EXTENSIONS)[number];

export const MINUTES_AUDIO_TYPES: Record<MinutesAudioExtension, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

/** Shown where a recording starts (decided 2026-11-02: shown on the screen, not read aloud). */
export const MINUTES_CONSENT_TEXT = 'この会議は議事録の作成のために録音します。音声は確定から14日で消します。録音を止めたい議題があれば言ってください。';

/**
 * How sure the speech model was of a segment (2026-11-06; transcripts made before have none). The numbers are
 * faster-whisper's own, kept as they are so the thresholds below can change without transcribing again.
 */
export interface SegmentConfidence {
  /** Mean log-probability of the segment's tokens (avg_logprob): 0 is certain; Whisper itself doubts below -1. */
  logprob: number;
  /** Probability that the stretch is not speech at all (no_speech_prob). */
  noSpeech: number;
  /** How much the text repeats itself (compression_ratio): above 2.4 the model is likely looping. */
  compression: number;
  /** The words the model was least sure of, when the worker took word timings (at most a few per segment). */
  weak?: { start: number; end: number; word: string; p: number }[];
}

/** A person listened again (or read again) and corrected the segment, or confirmed it as it was. */
export interface SegmentCheck {
  /** The text as the speech model heard it (kept from the first correction on). */
  original: string;
  byName: string;
  at: string;
}

export interface TranscriptSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
  confidence?: SegmentConfidence;
  checked?: SegmentCheck;
}

/**
 * When the screen lists a segment to be listened to again. faster-whisper gives logprob, noSpeech and compression per
 * 30-second window of decoding (every segment of a window has the same numbers), so the words tell one segment from
 * the next. Measured on 2026-11-06 with large-v3 on a synthetic meeting with a stretch of noise: the noisy stretch and a
 * misheard 協賛 had a word under 0.2 or two words under 0.5 (the worker keeps the words under 0.5); of the clean
 * segments, 1 in about 40 had one word under 0.2.
 */
export const DOUBT_THRESHOLDS = { logprob: -0.7, noSpeech: 0.6, noSpeechLogprob: -0.4, compression: 2.4, veryWeakWord: 0.2, weakWords: 2 } as const;

/** Why a segment is worth listening to again; empty when nothing points to it. */
export function doubtsOf(segment: TranscriptSegment, aiUnclearAt: number[] = []): string[] {
  const out: string[] = [];
  const c = segment.confidence;
  if (c) {
    if (c.logprob < DOUBT_THRESHOLDS.logprob) out.push('聞き取りの自信が低い');
    if (c.noSpeech > DOUBT_THRESHOLDS.noSpeech && c.logprob < DOUBT_THRESHOLDS.noSpeechLogprob) out.push('雑音・声でない音の疑い');
    if (c.compression > DOUBT_THRESHOLDS.compression) out.push('同じ言葉の繰り返し（誤認識の疑い）');
    const weak = c.weak ?? [];
    if (weak.some((w) => w.p < DOUBT_THRESHOLDS.veryWeakWord) || weak.length >= DOUBT_THRESHOLDS.weakWords) out.push('はっきりしない言葉がある');
  }
  if (aiUnclearAt.some((at) => at >= segment.start - 1 && at <= segment.end + 1)) out.push('AI が要確認とした所');
  return out;
}

/** How sure the model was, 0–100 (the mean probability of a token); null for transcripts made before 2026-11-06. */
export function certaintyOf(segment: TranscriptSegment): number | null {
  const c = segment.confidence;
  if (!c) return null;
  const lowest = Math.min(Math.exp(c.logprob), ...(c.weak ?? []).map((w) => w.p), c.compression > DOUBT_THRESHOLDS.compression ? 0.2 : 1);
  return Math.round(Math.max(0, Math.min(1, lowest)) * 100);
}

export interface Transcript {
  segments: TranscriptSegment[];
  durationSec: number;
  /** The speech model, e.g. "large-v3". */
  model: string;
}

/** Where an item of the draft comes from. `verified`: the quote was found in the transcript near `at`. */
export interface MinutesEvidence {
  at: number;
  quote: string;
  verified: boolean;
}

export interface MinutesItem {
  text: string;
  evidence: MinutesEvidence[];
}

export interface MinutesTodo extends MinutesItem {
  /** Empty when the meeting did not say (never guessed). */
  assignee: string;
  due: string;
  department: string;
}

/** The AI draft as the worker made it (kept as it was; the editable minutes are `body`). */
export interface MinutesDraft {
  summary: string;
  topics: { title: string; points: string[]; evidence: MinutesEvidence[] }[];
  decisions: MinutesItem[];
  todos: MinutesTodo[];
  carryOver: MinutesItem[];
  unclear: { text: string; at: number | null }[];
}

export interface MinutesPerson {
  id: string;
  name: string;
}

export interface MinutesMeta {
  enabled: boolean;
  people: MinutesPerson[];
  canAdminister: boolean;
  audioRetentionDays: number;
  maxAudioBytes: number;
  consentText: string;
}

/**
 * How far the worker has got with the stage it is running (2026-11-05), as it last reported. Kept in the app's
 * memory only: it is gone after a restart of the app until the worker reports again (about every 20 seconds).
 */
export interface MinutesProgress {
  stage: 'transcribe' | 'summarize';
  /** transcribe: seconds of the recording done; summarize: parts of the transcript done. */
  done: number;
  /** The whole (seconds or parts); null when the worker could not tell how long the recording is. */
  total: number | null;
  /** Percent done (0–99 while the stage runs; the total of a recording is sometimes an estimate); null without a total. */
  percent: number | null;
  /** Seconds the stage still needs at its pace so far; null until there is a pace to go by. */
  remainingSec: number | null;
  /** Seconds since the last report (counted on the server, so the viewer's clock does not matter). */
  ageSec: number;
}

/** No report for this long while the stage runs: the screen says the worker may have stopped. */
export const MINUTES_PROGRESS_STALE_SEC = 10 * 60;

export interface MinutesListItem {
  id: string;
  title: string;
  heldOn: string;
  stage: MinutesStage;
  createdByName: string;
  createdAt: string;
  confirmedAt: string | null;
  durationSec: number | null;
  /** Percent done of the running stage, when the worker has reported one. */
  progressPercent: number | null;
  /** The AI is reworking the draft after a comment (the stage is a summarize stage). */
  revising: boolean;
  /** Being corrected after it was confirmed (the stage is "draft"; the last confirmed version still stands). */
  reopened: boolean;
}

/** One comment sent back to the AI with the draft, and what came of it (2026-11-06). */
export interface MinutesReview {
  id: number;
  at: string;
  byName: string;
  comment: string;
  /** pending: the AI is on it; done: the draft was reworked; failed: the draft was left as it was. */
  status: 'pending' | 'done' | 'failed';
  /** What the AI says it changed (done), or why it could not (failed). */
  reply: string | null;
  error: string | null;
  doneAt: string | null;
}

/** One confirmed version of the minutes (2026-11-06). The first confirmation is version 1. */
export interface MinutesVersionInfo {
  no: number;
  confirmedByName: string;
  confirmedAt: string;
  /** What the correction changed (empty for version 1). */
  note: string;
}

export interface MinutesVersionResponse extends MinutesVersionInfo {
  body: string;
  /** The version before it, to show what changed (null for version 1). */
  previousBody: string | null;
}

/** The body as it was when a comment was sent back (the AI then wrote the body anew). */
export interface MinutesReviewBodyResponse {
  id: number;
  body: string;
}

export interface MinutesReviewRequest {
  expectedVersion: number;
  comment: string;
}

/** A segment corrected (or confirmed as it was) after listening again. */
export interface MinutesSegmentUpdate {
  /** The text the person saw, so a correction made meanwhile by someone else is not overwritten. */
  expectedText: string;
  text: string;
}

export interface MinutesListResponse {
  items: MinutesListItem[];
}

/**
 * A recording sent only in part (2026-11-07). The part already sent stays on the server through a restart of the app,
 * until it has had no new piece for a day; choosing the same file again goes on from where it stopped.
 */
export interface MinutesUploadItem {
  uploadId: string;
  filename: string;
  bytes: number;
  received: number;
  openedAt: string;
  /** Dropped at this time unless another piece comes. */
  expiresAt: string;
}

export interface MinutesUploadsResponse {
  items: MinutesUploadItem[];
}

/**
 * Going on with a recording sent in part: the file's size and the SHA-256 of its first `headBytes` bytes (as many as
 * the server holds, up to MINUTES_UPLOAD_HEAD_BYTES), so the rest of another file is never added to it.
 */
export interface MinutesUploadResume {
  bytes: number;
  headBytes: number;
  headSha256: string;
}

export const MINUTES_UPLOAD_HEAD_BYTES = 1024 * 1024;

export interface MinutesDetail {
  id: string;
  title: string;
  heldOn: string;
  stage: MinutesStage;
  /** The stage that failed, while stage is "failed". */
  failedStage: 'transcribe' | 'summarize' | null;
  error: string | null;
  /** While a stage runs and the worker has reported; null otherwise. */
  progress: MinutesProgress | null;
  visibility: MinutesVisibility;
  viewers: MinutesPerson[];
  createdByName: string;
  createdAt: string;
  confirmedByName: string | null;
  confirmedAt: string | null;
  audio: { present: boolean; bytes: number; deletesAt: string | null; deletedAt: string | null };
  transcript: Transcript | null;
  draft: MinutesDraft | null;
  /** The minutes as people corrected them (Markdown); starts as the AI draft written out. */
  body: string;
  version: number;
  /**
   * Items of this meeting already in the decision register (counted for those who may change the meeting's settings:
   * the register shows them to every member, whoever may read the meeting later).
   */
  registeredDecisions: number;
  /** The AI is reworking the draft after a comment. */
  revising: boolean;
  /** Being corrected after it was confirmed; `versions` holds the confirmed versions, the last one still stands. */
  reopened: boolean;
  /** People changed the body since the AI last wrote it (sending it back writes the body anew). */
  bodyEdited: boolean;
  reviews: MinutesReview[];
  versions: MinutesVersionInfo[];
  /**
   * `manage`: change the title, the date and who may read it (the recorder and the access administrators).
   * `review`: send the draft back to the AI with a comment. `check`: correct the transcript. `reopen`: start a
   * correction of the confirmed minutes. `discard`: drop the correction and go back to the last confirmed version.
   */
  can: {
    edit: boolean;
    confirm: boolean;
    listen: boolean;
    delete: boolean;
    retry: boolean;
    manage: boolean;
    review: boolean;
    check: boolean;
    reopen: boolean;
    discard: boolean;
  };
}

/** The title, the date and who may read a meeting, changed after it was made (2026-11-05). */
export interface MinutesSettingsUpdate {
  title: string;
  heldOn: string;
  visibility: MinutesVisibility;
  viewers: string[];
}

export interface MinutesBodyUpdate {
  expectedVersion: number;
  body: string;
}

export interface MinutesConfirmRequest {
  expectedVersion: number;
  /** What the correction changed: required when confirming a correction of confirmed minutes. */
  note?: string;
}

const timeOf = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export const fmtOffset = timeOf;

/** The AI draft written out as the first version of the minutes (the people then correct it). */
export function draftToMarkdown(title: string, heldOn: string, draft: MinutesDraft): string {
  const at = (e: MinutesEvidence[]) => (e[0] ? `（${timeOf(e[0].at)}${e.some((x) => !x.verified) ? '・要確認' : ''}）` : '');
  const lines: string[] = [`# ${title}`, '', `- 日付: ${heldOn}`, '- 出席者: （記入してください）', ''];
  if (draft.summary) lines.push('## 要点', '', draft.summary, '');
  if (draft.topics.length) {
    lines.push('## 議題');
    for (const t of draft.topics) {
      lines.push('', `### ${t.title}${at(t.evidence)}`);
      for (const p of t.points) lines.push(`- ${p}`);
    }
    lines.push('');
  }
  lines.push('## 決定事項', '');
  if (draft.decisions.length) for (const d of draft.decisions) lines.push(`- ${d.text}${at(d.evidence)}`);
  else lines.push('- （なし）');
  lines.push('', '## ToDo', '');
  if (draft.todos.length) {
    for (const t of draft.todos) {
      const who = [t.department, t.assignee].filter(Boolean).join(' ') || '担当未定';
      lines.push(`- [ ] ${t.text}（${who}／期限: ${t.due || '未定'}）${at(t.evidence)}`);
    }
  } else lines.push('- （なし）');
  if (draft.carryOver.length) {
    lines.push('', '## 持ち越し・保留', '');
    for (const c of draft.carryOver) lines.push(`- ${c.text}${at(c.evidence)}`);
  }
  if (draft.unclear.length) {
    lines.push('', '## 要確認（AI が聞き取れなかった・判断できなかった所）', '');
    for (const u of draft.unclear) lines.push(`- ${u.text}${u.at !== null ? `（${timeOf(u.at)}）` : ''}`);
  }
  return lines.join('\n') + '\n';
}

const ATTENDEES_LINE = /^- 出席者: (.*)$/m;
const ATTENDEES_PLACEHOLDER = '（記入してください）';

/**
 * The attendees a person wrote into the body, carried into a body the AI wrote anew (the AI's draft has no
 * attendees: they are not in the recording).
 */
export function carryOverAttendees(before: string, next: string): string {
  const written = ATTENDEES_LINE.exec(before)?.[1]?.trim();
  if (!written || written === ATTENDEES_PLACEHOLDER) return next;
  return ATTENDEES_LINE.test(next) ? next.replace(ATTENDEES_LINE, () => `- 出席者: ${written}`) : next;
}

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** Lines added and removed between two versions (longest common subsequence; null when they are too long to compare). */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 1_000_000) return null;
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: 'del', text: a[i++]! });
    else out.push({ kind: 'add', text: b[j++]! });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++]! });
  while (j < m) out.push({ kind: 'add', text: b[j++]! });
  return out;
}
