import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MinutesDraft } from '../../src/shared/minutes.js';
import { LEASE_MS, MAX_ATTEMPTS, MinutesStore, newMeetingId } from '../../src/server/minutes/store.js';
import { checkedDraft, comparable, draftSchema, verifyEvidence } from '../../src/server/minutes/validate.js';

// The minutes ledger and the checks of what the worker hands back. Synthetic meetings only.

let dir: string;
let store: MinutesStore;
const T0 = Date.parse('2026-11-02T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const meeting = { title: '役員会', heldOn: '2026-11-02', visibility: 'selected' as const, viewers: ['u2'], audioExt: 'webm' as const, audioBytes: 10, audioSha256: 'a'.repeat(64) };
const transcript = {
  segments: [
    { start: 0, end: 4, text: 'それでは定例の役員会を始めます。' },
    { start: 300, end: 306, text: '協賛の依頼文は総務部が十一月二十日までに作る、ということで決定とします。' },
    { start: 900, end: 905, text: '会計の締めについては、次回に持ち越しとします。' },
  ],
  durationSec: 910,
  model: 'large-v3',
};
const emptyDraft: MinutesDraft = { summary: '', topics: [], decisions: [], todos: [], carryOver: [], unclear: [] };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-minutes-store-'));
  store = new MinutesStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the minutes ledger', () => {
  it('changes the settings at any stage, keeping the version and the settings before in the history', () => {
    const id = newMeetingId();
    store.create(id, meeting, 'u1', iso(T0));
    const changed = store.updateSettings(id, { title: '臨時役員会', heldOn: '2026-11-03', visibility: 'members', viewers: [] }, 'admin', iso(T0 + 1000))!;
    expect(changed).toMatchObject({ title: '臨時役員会', heldOn: '2026-11-03', visibility: 'members', viewers: [], version: 1, updatedBy: 'admin', stage: 'transcribe_wait' });
    const last = store.db.prepare("SELECT actor_id, action, before_body FROM meeting_history WHERE meeting_id=? ORDER BY id DESC LIMIT 1").get(id) as { actor_id: string; action: string; before_body: string };
    expect(last).toMatchObject({ actor_id: 'admin', action: 'settings' });
    expect(JSON.parse(last.before_body)).toEqual({ title: '役員会', heldOn: '2026-11-02', visibility: 'selected', viewers: ['u2'] });
    expect(store.updateSettings(newMeetingId(), { title: 't', heldOn: '2026-11-03', visibility: 'members', viewers: [] }, 'admin', iso(T0))).toBeNull();
  });

  it('moves a meeting from the recording to the confirmed minutes, one stage at a time', () => {
    const id = newMeetingId();
    expect(store.create(id, meeting, 'u1', iso(T0))).toMatchObject({ stage: 'transcribe_wait', version: 1, viewers: ['u2'] });
    expect(store.claim(['summarize'], T0, iso(T0))).toBeNull();

    const t = store.claim(['transcribe', 'summarize'], T0, iso(T0))!;
    expect(t).toMatchObject({ stage: 'transcribe', row: { stage: 'transcribe_run', attempts: 1 } });
    expect(store.claim(['transcribe'], T0, iso(T0))).toBeNull();
    // A late answer with another lease changes nothing.
    expect(store.completeTranscript(id, 'not-the-lease', transcript, iso(T0))).toBe(false);
    expect(store.completeTranscript(id, t.leaseToken, transcript, iso(T0))).toBe(true);
    expect(store.completeTranscript(id, t.leaseToken, transcript, iso(T0))).toBe(false);

    const s = store.claim(['summarize'], T0, iso(T0))!;
    expect(s.row.transcript?.segments).toHaveLength(3);
    expect(store.completeDraft(id, s.leaseToken, emptyDraft, '# 役員会\n', iso(T0))).toBe(true);
    const drafted = store.get(id)!;
    expect(drafted).toMatchObject({ stage: 'draft', version: 2, body: '# 役員会\n' });

    expect(store.updateBody(id, 1, 'old', 'u2', iso(T0))).toBe('conflict');
    expect(store.updateBody(id, 2, '# 役員会\n直した\n', 'u2', iso(T0))).toMatchObject({ version: 3, updatedBy: 'u2' });
    expect(store.confirm(id, 3, '', 'u2', iso(T0 + 1000))).toMatchObject({ stage: 'confirmed', confirmedBy: 'u2', version: 4 });
    expect(store.updateBody(id, 4, 'x', 'u2', iso(T0))).toBe('locked');

    expect(store.audioDue(iso(T0))).toHaveLength(0);
    expect(store.audioDue(iso(T0 + 1000)).map((r) => r.id)).toEqual([id]);
    store.markAudioDeleted(id, iso(T0 + 2000));
    expect(store.audioDue(iso(T0 + 9e9))).toHaveLength(0);
    const actions = (store.db.prepare('SELECT action FROM meeting_history WHERE meeting_id=? ORDER BY id').all(id) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['create', 'transcribed', 'drafted', 'edit', 'confirm']);
  });

  it('offers a stage again when its lease runs out, and fails it after the last attempt', () => {
    const id = newMeetingId();
    store.create(id, meeting, 'u1', iso(T0));
    let at = T0;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const job = store.claim(['transcribe'], at, iso(at));
      expect(job?.row.attempts).toBe(i);
      at += LEASE_MS.transcribe + 1;
    }
    expect(store.claim(['transcribe'], at, iso(at))).toBeNull();
    expect(store.get(id)).toMatchObject({ stage: 'failed', failedStage: 'transcribe' });
    expect(store.retry(id, 'u1', iso(at))).toMatchObject({ stage: 'transcribe_wait', attempts: 0 });
  });

  it('retries only the failed summary when the transcript is there, and not a transcription without audio', () => {
    const id = newMeetingId();
    store.create(id, meeting, 'u1', iso(T0));
    const t = store.claim(['transcribe'], T0, iso(T0))!;
    store.completeTranscript(id, t.leaseToken, transcript, iso(T0));
    const s = store.claim(['summarize'], T0, iso(T0))!;
    expect(store.fail(id, s.leaseToken, 'summarize', 'Claude CLI なし', iso(T0))).toBe(true);
    expect(store.retry(id, 'u1', iso(T0))).toMatchObject({ stage: 'summarize_wait' });
    expect(store.retry(id, 'u1', iso(T0))).toBe('not-failed');

    const other = newMeetingId();
    store.create(other, meeting, 'u1', iso(T0 + 1));
    const t2 = store.claim(['transcribe'], T0, iso(T0))!;
    expect(t2.row.id).toBe(other);
    store.fail(other, t2.leaseToken, 'transcribe', '壊れた音声', iso(T0));
    store.markAudioDeleted(other, iso(T0));
    expect(store.retry(other, 'u1', iso(T0))).toBe('no-audio');
  });
});

describe('the ledger, after the review (2026-11-02)', () => {
  it('lets a summarizing worker leave a long transcription alone', () => {
    const id = newMeetingId();
    store.create(id, meeting, 'u1', iso(T0));
    const t = store.claim(['transcribe'], T0, iso(T0))!;
    const late = T0 + LEASE_MS.transcribe + 60_000;
    expect(store.claim(['summarize'], late, iso(late))).toBeNull();
    expect(store.get(id)).toMatchObject({ stage: 'transcribe_run', leaseToken: t.leaseToken });
    expect(store.completeTranscript(id, t.leaseToken, transcript, iso(late))).toBe(true);
  });

  it('forgets the earlier bodies of a deleted meeting', () => {
    const id = newMeetingId();
    store.create(id, meeting, 'u1', iso(T0));
    const t = store.claim(['transcribe'], T0, iso(T0))!;
    store.completeTranscript(id, t.leaseToken, transcript, iso(T0));
    const s2 = store.claim(['summarize'], T0, iso(T0))!;
    store.completeDraft(id, s2.leaseToken, emptyDraft, '秘密の本文', iso(T0));
    store.updateBody(id, 2, '直した本文', 'u1', iso(T0));
    store.delete(id, 'u1', iso(T0));
    const kept = store.db.prepare('SELECT before_body FROM meeting_history WHERE meeting_id=? AND before_body IS NOT NULL').all(id);
    expect(kept).toEqual([]);
  });
});

describe('the checks of the AI draft', () => {
  it('compares letters and digits only', () => {
    expect(comparable('協賛の依頼文は、 総務部が！')).toBe('協賛の依頼文は総務部が');
    expect(comparable('ＡＢＣ１２３')).toBe('abc123');
  });

  it('verifies a quote near its time, moves one found elsewhere, and marks the rest', () => {
    const out = verifyEvidence(transcript, [
      { at: 310, quote: '総務部が十一月二十日までに作る' },
      { at: 10, quote: '次回に持ち越し' },
      { at: 300, quote: '体育館の利用は中止' },
      { at: 0, quote: 'は' },
    ]);
    expect(out).toEqual([
      { at: 310, quote: '総務部が十一月二十日までに作る', verified: true },
      { at: 900, quote: '次回に持ち越し', verified: true },
      { at: 300, quote: '体育館の利用は中止', verified: false },
      { at: 0, quote: 'は', verified: false },
    ]);
  });

  it('fills the missing lists and checks every item', () => {
    const raw = draftSchema.parse({ summary: '要点', decisions: [{ text: '依頼文は総務部', evidence: [{ at: 300, quote: '協賛の依頼文は総務部が' }] }] });
    const draft = checkedDraft(transcript, raw);
    expect(draft.decisions[0]!.evidence[0]!.verified).toBe(true);
    expect(draft.todos).toEqual([]);
    expect(() => draftSchema.parse({ decisions: [{ text: '' }] })).toThrow();
    expect(() => draftSchema.parse({ unknown: 1 })).toThrow();
  });
});

// The AI's guesses for the segments to listen to again (2026-11-10).
describe("the AI's guesses, a part at a time beside the draft", () => {
  const segs = Array.from({ length: 5 }, (_, i) => ({ start: i * 10, end: i * 10 + 5, text: `合成の発言その${i + 1}です。` }));

  /** A meeting through its first draft, with the guesses queued for `targets`. */
  function toDraft(targets: number[]): string {
    const id = newMeetingId();
    store.create(id, meeting, 'u1', iso(T0));
    const t = store.claim(['transcribe'], T0, iso(T0))!;
    store.completeTranscript(id, t.leaseToken, { segments: segs, durationSec: 60, model: 'large-v3' }, iso(T0));
    const s = store.claim(['summarize'], T0, iso(T0))!;
    expect(store.completeDraft(id, s.leaseToken, emptyDraft, '本文', iso(T0), targets)).toBe(true);
    return id;
  }

  it('gives a part at a time, skips what people checked meanwhile, keeps each part as it comes, and marks a guess confirmed as it was', () => {
    const id = toDraft([0, 1, 2, 3, 4]);
    expect(store.suggestion(id)).toMatchObject({ status: 'wait', targets: [0, 1, 2, 3, 4], done: 0, requestedBy: 'worker', items: {} });
    const p1 = store.claimSuggestion(T0, iso(T0), 2)!;
    expect(p1).toMatchObject({ targets: [0, 1], done: 0, total: 5 });
    // One part of a meeting at a time.
    expect(store.claimSuggestion(T0, iso(T0), 2)).toBeNull();
    expect(store.completeSuggestions(id, 'not-the-lease', [], iso(T0))).toBe(false);
    // A guess for a text that is not the segment's is dropped.
    expect(store.completeSuggestions(id, p1.leaseToken, [{ index: 0, heard: segs[0]!.text, text: '合成の案その1です。' }, { index: 1, heard: '別の文', text: '案' }], iso(T0))).toBe(true);
    expect(store.completeSuggestions(id, p1.leaseToken, [], iso(T0))).toBe(false);
    expect(store.suggestion(id)).toMatchObject({ status: 'wait', done: 2, items: { 0: { heard: segs[0]!.text, text: '合成の案その1です。' } } });
    expect(store.suggestion(id)!.items[1]).toBeUndefined();

    // People check segments 2 and 3 meanwhile: the next part starts at 4.
    store.checkSegment(id, 2, segs[2]!.text, segs[2]!.text, 'u2', iso(T0));
    store.checkSegment(id, 3, segs[3]!.text, '人が直した文。', 'u2', iso(T0));
    const p2 = store.claimSuggestion(T0, iso(T0), 2)!;
    expect(p2).toMatchObject({ targets: [4], done: 4, total: 5 });
    expect(store.completeSuggestions(id, p2.leaseToken, [{ index: 4, heard: segs[4]!.text, text: segs[4]!.text }], iso(T0 + 1000))).toBe(true);
    expect(store.suggestion(id)).toMatchObject({ status: 'done', done: 5, doneAt: iso(T0 + 1000), leaseToken: null });
    expect(store.claimSuggestion(T0, iso(T0), 2)).toBeNull();

    // Confirmed as the AI guessed it: marked. Typed by a person, or confirmed as heard: not.
    store.checkSegment(id, 0, segs[0]!.text, '合成の案その1です。', 'u2', iso(T0));
    const after = store.get(id)!.transcript!.segments;
    expect(after[0]!.checked).toMatchObject({ original: segs[0]!.text, by: 'u2', ai: true });
    expect(after[2]!.checked!.ai).toBeUndefined();
    expect(after[3]!.checked!.ai).toBeUndefined();
    // Asked again with nothing left to guess for.
    expect(store.requestSuggestions(id, [], 'u2', iso(T0))).toBe('none');
  });

  it('puts a part held too long back, fails after the last attempt, and goes on from where it stopped when asked', () => {
    const id = toDraft([0, 1, 2]);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const at = T0 + i * (LEASE_MS.suggest + 1);
      expect(store.claimSuggestion(at, iso(at), 2)).toMatchObject({ targets: [0, 1], done: 0 });
    }
    const late = T0 + MAX_ATTEMPTS * (LEASE_MS.suggest + 1);
    expect(store.claimSuggestion(late, iso(late), 2)).toBeNull();
    expect(store.suggestion(id)).toMatchObject({ status: 'failed', done: 0, leaseToken: null });
    expect(store.suggestion(id)!.error).toContain('時間内に終わりませんでした');

    // Asked again after a failure: on from where it stopped, over the segments queued before.
    expect(store.requestSuggestions(id, [2], 'u2', iso(late))).toMatchObject({ id });
    expect(store.suggestion(id)).toMatchObject({ status: 'wait', targets: [0, 1, 2], attempts: 0, error: null, requestedBy: 'u2' });
    expect(store.requestSuggestions(id, [2], 'u2', iso(late))).toBe('busy');
    const p = store.claimSuggestion(late, iso(late), 2)!;
    // A report of the worker pushes the lease out.
    expect(store.renewSuggestionLease(id, p.leaseToken, late + 10 * LEASE_MS.suggest)).toBe(true);
    expect(store.claimSuggestion(late + 2 * LEASE_MS.suggest, iso(late), 2)).toBeNull();
    expect(store.failSuggestions(id, 'not-the-lease', '失敗', iso(late))).toBe(false);
    // A part the AI failed on is tried again, and stops the guessing only after the last attempt.
    expect(store.failSuggestions(id, p.leaseToken, 'Claude CLI が異常終了しました', iso(late))).toBe(true);
    expect(store.suggestion(id)).toMatchObject({ status: 'wait', attempts: 1 });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const again = store.claimSuggestion(late, iso(late), 2)!;
      expect(again).toMatchObject({ targets: [0, 1], done: 0 });
      store.failSuggestions(id, again.leaseToken, 'Claude CLI が異常終了しました', iso(late));
    }
    expect(store.suggestion(id)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, error: 'Claude CLI が異常終了しました' });
    expect(store.claimSuggestion(late, iso(late), 2)).toBeNull();
    // On from where it stopped again; once all are done, asking again starts over the segments still to be checked.
    store.requestSuggestions(id, [1], 'u2', iso(late));
    for (let part = store.claimSuggestion(late, iso(late), 2); part; part = store.claimSuggestion(late, iso(late), 2)) store.completeSuggestions(id, part.leaseToken, [], iso(late));
    expect(store.suggestion(id)).toMatchObject({ status: 'done', done: 3, targets: [0, 1, 2] });
    store.requestSuggestions(id, [1], 'u2', iso(late));
    expect(store.suggestion(id)).toMatchObject({ status: 'wait', targets: [1], done: 0 });
  });

  it('waits while the draft is reworked, and forgets the guesses with a new transcript or the meeting', () => {
    const id = toDraft([0]);
    expect(store.sendBack(id, store.get(id)!.version, '要点を短く', 10, 'u1', iso(T0))).toMatchObject({ stage: 'summarize_wait' });
    expect(store.claimSuggestion(T0, iso(T0))).toBeNull();
    expect(store.requestSuggestions(id, [0], 'u1', iso(T0))).toBe('locked');
    expect(store.suggestion(id)).toMatchObject({ status: 'wait' });
    store.delete(id, 'u1', iso(T0));
    expect(store.suggestion(id)).toBeNull();
    // A draft with nothing to listen to again queues nothing.
    expect(store.suggestion(toDraft([]))).toBeNull();
  });
});
