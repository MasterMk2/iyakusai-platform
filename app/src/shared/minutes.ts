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

export interface TranscriptSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
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
}

export interface MinutesListResponse {
  items: MinutesListItem[];
}

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
  /** `manage`: change the title, the date and who may read it (the recorder and the access administrators). */
  can: { edit: boolean; confirm: boolean; listen: boolean; delete: boolean; retry: boolean; manage: boolean };
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
