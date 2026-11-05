import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carryOverAttendees, certaintyOf, doubtsOf, draftToMarkdown, lineDiff, type MinutesDraft, type TranscriptSegment } from '../../src/shared/minutes.js';
import { minutesItemToken, minutesTokenPrefix } from '../../src/server/decisions/from-minutes.js';
import { LEASE_MS, MAX_ATTEMPTS, MINUTES_FILE, MinutesStore, newMeetingId } from '../../src/server/minutes/store.js';

// Sending a draft back to the AI, listening again, and corrections after confirmation (2026-11-06). Synthetic meetings only.

let dir: string;
let store: MinutesStore;
const T0 = Date.parse('2026-11-06T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const meeting = { title: '役員会', heldOn: '2026-11-06', visibility: 'members' as const, viewers: [], audioExt: 'webm' as const, audioBytes: 10, audioSha256: 'a'.repeat(64) };
const transcript = {
  segments: [
    { start: 0, end: 4, text: 'それでは定例の役員会を始めます。', confidence: { logprob: -0.1, noSpeech: 0.01, compression: 1.5, weak: [] } },
    { start: 300, end: 306, text: '共産の依頼文は総務部が作ります。', confidence: { logprob: -0.13, noSpeech: 0.48, compression: 1.5, weak: [{ start: 300, end: 300.4, word: '共', p: 0.31 }, { start: 300.4, end: 300.8, word: '産', p: 0.4 }] } },
    { start: 900, end: 905, text: '会計の締めは次回に持ち越します。', confidence: { logprob: -0.1, noSpeech: 0.01, compression: 1.5, weak: [] } },
  ],
  durationSec: 910,
  model: 'large-v3',
};
const draft: MinutesDraft = {
  summary: '定例の役員会。',
  topics: [],
  decisions: [{ text: '依頼文は総務部が作る', evidence: [] }],
  todos: [],
  carryOver: [],
  unclear: [],
};
const revised: MinutesDraft = { ...draft, decisions: [{ text: '協賛の依頼文は総務部が11/20までに作る', evidence: [] }, { text: '会計の締めは次回', evidence: [] }] };

/** A meeting with its AI draft (version 2). */
function drafted(): string {
  const id = newMeetingId();
  store.create(id, meeting, 'u1', iso(T0));
  const t = store.claim(['transcribe'], T0, iso(T0))!;
  store.completeTranscript(id, t.leaseToken, transcript, iso(T0));
  const s = store.claim(['summarize'], T0, iso(T0))!;
  store.completeDraft(id, s.leaseToken, draft, draftToMarkdown('役員会', '2026-11-06', draft), iso(T0));
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-minutes-review-'));
  store = new MinutesStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sending the draft back to the AI', () => {
  it('reworks the draft after a comment and keeps the body before with it', () => {
    const id = drafted();
    expect(store.get(id)).toMatchObject({ version: 2, draftRound: 0 });
    store.updateBody(id, 2, store.get(id)!.body.replace('（記入してください）', '合成 太郎、合成 花子'), 'u2', iso(T0));
    expect(store.sendBack(id, 2, '期限を足して', 10, 'u2', iso(T0))).toBe('conflict');
    const sent = store.sendBack(id, 3, '協賛の期限は11/20と言っていました', 10, 'u2', iso(T0 + 1000));
    expect(sent).toMatchObject({ stage: 'summarize_wait', version: 4 });
    // While the AI works, the body is not open to edits.
    expect(store.updateBody(id, 4, 'x', 'u2', iso(T0))).toBe('locked');

    const job = store.claim(['summarize'], T0, iso(T0))!;
    const pending = store.pendingReview(id)!;
    expect(pending).toMatchObject({ comment: '協賛の期限は11/20と言っていました', status: 'pending' });
    expect(pending.beforeBody).toContain('合成 太郎、合成 花子');
    expect(store.completeRevision(id, job.leaseToken, pending.id + 1, revised, 'x', '直した', iso(T0))).toBe(false);
    const body = carryOverAttendees(store.get(id)!.body, draftToMarkdown('役員会', '2026-11-06', revised));
    expect(store.completeRevision(id, job.leaseToken, pending.id, revised, body, '期限を足しました。', iso(T0 + 2000))).toBe(true);
    const after = store.get(id)!;
    expect(after).toMatchObject({ stage: 'draft', draftRound: 1, version: 5, aiBody: after.body });
    expect(after.body).toContain('- 出席者: 合成 太郎、合成 花子');
    expect(after.body).toContain('11/20');
    expect(store.reviews(id)).toMatchObject([{ status: 'done', reply: '期限を足しました。', actorId: 'u2' }]);
    expect(store.flags().revising.has(id)).toBe(false);
  });

  it('goes back to the draft as it was when the AI fails or runs out of time', () => {
    const id = drafted();
    store.sendBack(id, 2, '一つ目', 10, 'u1', iso(T0));
    const job = store.claim(['summarize'], T0, iso(T0))!;
    expect(store.fail(id, job.leaseToken, 'summarize', 'Claude CLI が異常終了', iso(T0))).toBe(true);
    expect(store.get(id)).toMatchObject({ stage: 'draft', draft: draft, version: 3 });
    expect(store.reviews(id)).toMatchObject([{ status: 'failed', error: 'Claude CLI が異常終了' }]);

    store.sendBack(id, 3, '二つ目', 10, 'u1', iso(T0));
    let at = T0;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      expect(store.claim(['summarize'], at, iso(at))?.row.attempts).toBe(i);
      at += LEASE_MS.summarize + 1;
    }
    expect(store.claim(['summarize'], at, iso(at))).toBeNull();
    expect(store.get(id)).toMatchObject({ stage: 'draft', failedStage: null });
    expect(store.reviews(id).map((r) => r.status)).toEqual(['failed', 'failed']);
  });

  it('takes at most the limit of comments that were not failed', () => {
    const id = drafted();
    let v = 2;
    for (let i = 0; i < 2; i++) {
      store.sendBack(id, v, `コメント${i}`, 2, 'u1', iso(T0));
      const job = store.claim(['summarize'], T0, iso(T0))!;
      store.completeRevision(id, job.leaseToken, store.pendingReview(id)!.id, draft, 'b', 'ok', iso(T0));
      v = store.get(id)!.version;
    }
    expect(store.sendBack(id, v, 'もう一回', 2, 'u1', iso(T0))).toBe('limit');
  });
});

describe('listening again', () => {
  it('corrects a segment, keeps what the model heard, and refuses a stale correction', () => {
    const id = drafted();
    const r = store.checkSegment(id, 1, '共産の依頼文は総務部が作ります。', '協賛の依頼文は総務部が作ります。', 'u2', iso(T0));
    expect(r).not.toBeTypeOf('string');
    const seg = store.get(id)!.transcript!.segments[1]!;
    expect(seg).toMatchObject({ text: '協賛の依頼文は総務部が作ります。', checked: { original: '共産の依頼文は総務部が作ります。', by: 'u2' } });
    // The version guards the body only: the editor of someone else is not refused.
    expect(store.get(id)!.version).toBe(2);
    expect(store.checkSegment(id, 1, '共産の依頼文は総務部が作ります。', '別の直し', 'u3', iso(T0))).toBe('conflict');
    // A second correction keeps the first original.
    store.checkSegment(id, 1, '協賛の依頼文は総務部が作ります。', '協賛の依頼文は総務部が作る。', 'u3', iso(T0));
    expect(store.get(id)!.transcript!.segments[1]!.checked).toMatchObject({ original: '共産の依頼文は総務部が作ります。', by: 'u3' });
    expect(store.checkSegment(id, 9, 'x', 'y', 'u2', iso(T0))).toBe('no-segment');
    const last = store.db.prepare("SELECT before_body FROM meeting_history WHERE meeting_id=? AND action='segment' ORDER BY id DESC LIMIT 1").get(id) as { before_body: string };
    expect(JSON.parse(last.before_body)).toEqual({ index: 1, text: '協賛の依頼文は総務部が作ります。' });
  });

  it('lists the segments the model was unsure of, and those the AI asked about', () => {
    const [clean, unsure, later] = transcript.segments as TranscriptSegment[];
    expect(doubtsOf(clean!)).toEqual([]);
    expect(doubtsOf(unsure!)).toEqual(['はっきりしない言葉がある']);
    expect(doubtsOf(later!, [902])).toEqual(['AI が要確認とした所']);
    expect(doubtsOf({ start: 0, end: 1, text: 'x', confidence: { logprob: -0.43, noSpeech: 0.79, compression: 1.7 } })).toEqual(['雑音・声でない音の疑い']);
    expect(doubtsOf({ start: 0, end: 1, text: 'x', confidence: { logprob: -0.1, noSpeech: 0, compression: 1, weak: [{ start: 0, end: 1, word: 'x', p: 0.14 }] } })).toEqual(['はっきりしない言葉がある']);
    // One word under 0.5 alone is not enough.
    expect(doubtsOf({ start: 0, end: 1, text: 'x', confidence: { logprob: -0.1, noSpeech: 0, compression: 1, weak: [{ start: 0, end: 1, word: 'x', p: 0.45 }] } })).toEqual([]);
    expect(certaintyOf(unsure!)).toBe(31);
    expect(certaintyOf({ start: 0, end: 1, text: 'x' })).toBeNull();
  });
});

describe('corrections after confirmation', () => {
  it('keeps every confirmed version, needs a note for a correction, and goes back on discard', () => {
    const id = drafted();
    expect(store.confirm(id, 2, '', 'u1', iso(T0 + 1000))).toMatchObject({ stage: 'confirmed', firstConfirmedAt: iso(T0 + 1000), version: 3 });
    expect(store.versions(id)).toMatchObject([{ no: 1, confirmedBy: 'u1', note: '', draftRound: 0 }]);
    expect(store.reopen(id, 2, 'u2', iso(T0))).toBe('conflict');
    expect(store.reopen(id, 3, 'u2', iso(T0 + 2000))).toMatchObject({ stage: 'draft', version: 4, confirmedBy: 'u1' });
    expect(store.flags().versioned.has(id)).toBe(true);

    // AI and listening again work during the correction.
    store.sendBack(id, 4, '期限を足して', 10, 'u2', iso(T0));
    const job = store.claim(['summarize'], T0, iso(T0))!;
    store.completeRevision(id, job.leaseToken, store.pendingReview(id)!.id, revised, '# 直した\n', '足しました', iso(T0));
    expect(store.get(id)).toMatchObject({ stage: 'draft', draftRound: 1, version: 6 });

    // Dropping the correction: the body, the AI's items and their round go back to version 1.
    expect(store.discard(id, 6, 'u2', iso(T0 + 3000))).toMatchObject({ stage: 'confirmed', draftRound: 0, draft, confirmedBy: 'u1', confirmedAt: iso(T0 + 1000) });
    expect(store.discard(id, 7, 'u2', iso(T0))).toBe('locked');

    store.reopen(id, 7, 'u2', iso(T0));
    store.updateBody(id, 8, '# 役員会\n訂正した本文\n', 'u2', iso(T0));
    expect(store.confirm(id, 9, '', 'u2', iso(T0))).toBe('note');
    expect(store.confirm(id, 9, '決定事項の期限を直した', 'u2', iso(T0 + 9000))).toMatchObject({ stage: 'confirmed', confirmedBy: 'u2', firstConfirmedAt: iso(T0 + 1000) });
    expect(store.versions(id)).toMatchObject([
      { no: 1, note: '' },
      { no: 2, note: '決定事項の期限を直した', body: '# 役員会\n訂正した本文\n', confirmedBy: 'u2' },
    ]);
    const actions = (store.db.prepare("SELECT action FROM meeting_history WHERE meeting_id=? AND actor_id<>'worker' ORDER BY id").all(id) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['create', 'confirm', 'reopen', 'review', 'discard', 'reopen', 'edit', 'confirm']);
  });

  it('deletes the audio by the first confirmation, also while a correction goes on', () => {
    const id = drafted();
    store.confirm(id, 2, '', 'u1', iso(T0));
    store.reopen(id, 3, 'u1', iso(T0 + 5000));
    expect(store.audioDue(iso(T0)).map((r) => r.id)).toEqual([id]);
  });

  it('deletes the comments and the versions with the meeting', () => {
    const id = drafted();
    store.sendBack(id, 2, 'c', 10, 'u1', iso(T0));
    const job = store.claim(['summarize'], T0, iso(T0))!;
    store.fail(id, job.leaseToken, 'summarize', 'x', iso(T0));
    store.confirm(id, 3, '', 'u1', iso(T0));
    store.delete(id, 'u1', iso(T0));
    expect(store.reviews(id)).toEqual([]);
    expect(store.versions(id)).toEqual([]);
  });
});

describe('a file made before 2026-11-06', () => {
  it('gets the new columns, the first confirmation and version 1 of its confirmed meetings', () => {
    const old = mkdtempSync(path.join(tmpdir(), 'iyakusai-minutes-old-'));
    try {
      // The schema of 2026-11-02 to 11-05, with one confirmed and one drafted meeting.
      const raw = new DatabaseSync(path.join(old, MINUTES_FILE));
      raw.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta VALUES('schema','1');
        CREATE TABLE meetings(id TEXT PRIMARY KEY, title TEXT NOT NULL, held_on TEXT NOT NULL, visibility TEXT NOT NULL, viewers_json TEXT NOT NULL, stage TEXT NOT NULL, failed_stage TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER, audio_ext TEXT NOT NULL, audio_bytes INTEGER NOT NULL, audio_sha256 TEXT NOT NULL, audio_deleted_at TEXT, transcript_json TEXT, draft_json TEXT, body TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT);
        CREATE TABLE meeting_history(id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, before_body TEXT);
        INSERT INTO meetings(id,title,held_on,visibility,viewers_json,stage,audio_ext,audio_bytes,audio_sha256,body,version,created_by,created_at,updated_by,updated_at,confirmed_by,confirmed_at)
          VALUES('mt_0000000000000001','役員会','2026-11-03','members','[]','confirmed','webm',1,'x','確定した本文',4,'u1','2026-11-03T00:00:00Z','u1','2026-11-03T01:00:00Z','u1','2026-11-03T01:00:00Z'),
                ('mt_0000000000000002','定例','2026-11-04','members','[]','draft','webm',1,'x','下書き',2,'u1','2026-11-04T00:00:00Z','u1','2026-11-04T00:00:00Z',NULL,NULL);`);
      raw.close();
      const opened = new MinutesStore(old);
      try {
        expect(opened.get('mt_0000000000000001')).toMatchObject({ firstConfirmedAt: '2026-11-03T01:00:00Z', draftRound: 0, aiBody: null });
        expect(opened.versions('mt_0000000000000001')).toMatchObject([{ no: 1, body: '確定した本文', confirmedBy: 'u1', note: '' }]);
        expect(opened.versions('mt_0000000000000002')).toEqual([]);
        // An older app confirmed again after a correction began: that confirmation becomes the next version.
        opened.db.prepare("UPDATE meetings SET body='古い版の訂正', confirmed_at='2026-11-07T00:00:00Z' WHERE id='mt_0000000000000001'").run();
        // A comment sent before an older app wrote a new draft without it.
        opened.db.prepare("INSERT INTO meeting_reviews(meeting_id,at,actor_id,comment,status,before_body) VALUES('mt_0000000000000002','2026-11-06T00:00:00Z','u1','c','pending','b')").run();
      } finally {
        opened.close();
      }
      const again = new MinutesStore(old);
      try {
        expect(again.versions('mt_0000000000000001').map((v) => [v.no, v.body])).toEqual([
          [1, '確定した本文'],
          [2, '古い版の訂正'],
        ]);
        expect(again.reviews('mt_0000000000000002')).toMatchObject([{ status: 'failed', doneAt: '2026-11-06T00:00:00Z' }]);
      } finally {
        again.close();
      }
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });
});

describe('the helpers', () => {
  it('carries the attendees a person wrote into a body the AI wrote anew', () => {
    const ai = draftToMarkdown('役員会', '2026-11-06', draft);
    expect(carryOverAttendees(ai, ai)).toBe(ai);
    const written = ai.replace('（記入してください）', '合成 太郎、合成 花子（$1）');
    expect(carryOverAttendees(written, ai)).toContain('- 出席者: 合成 太郎、合成 花子（$1）');
  });

  it('numbers the decision items of a reworked draft apart from the first draft', () => {
    expect(minutesItemToken('mt_0123456789abcdef', 2)).toBe('minutes-mt_0123456789abcdef-2');
    expect(minutesItemToken('mt_0123456789abcdef', 2, 1)).toBe('minutes-mt_0123456789abcdef-r1-2');
    expect(minutesItemToken('mt_0123456789abcdef', 2, 1).startsWith(minutesTokenPrefix('mt_0123456789abcdef'))).toBe(true);
  });

  it('shows the lines added and removed between two versions', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
  });
});
