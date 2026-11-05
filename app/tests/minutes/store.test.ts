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
