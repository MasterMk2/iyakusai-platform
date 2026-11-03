import { z } from 'zod';
import { MINUTES_LIMITS, type MinutesDraft, type MinutesEvidence, type Transcript } from '../../shared/minutes.js';

// What the minutes worker hands back is checked here, not trusted: sizes, shapes, and that every quote the AI
// gives as evidence is really in the transcript near the time it names (else it is marked unverified and the
// screen shows 要確認). The worker checks the same, but this side decides.

// Over-long text is cut, not refused (the worker counts characters differently from JavaScript's UTF-16); only
// absurd sizes are refused.
const text = (max: number) => z.string().max(max * 4).transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, max));
const seconds = z.number().finite().min(0).max(24 * 3600);

export const transcriptSchema = z.strictObject({
  segments: z
    .array(z.strictObject({ start: seconds, end: seconds, text: z.string().max(MINUTES_LIMITS.segmentText) }))
    .max(MINUTES_LIMITS.segments),
  durationSec: seconds,
  model: z.string().min(1).max(60),
});

const evidenceIn = z.strictObject({ at: seconds, quote: z.string().max(MINUTES_LIMITS.quote * 2) });
const evidenceList = z.array(evidenceIn).max(5).default([]);
const item = z.strictObject({ text: text(MINUTES_LIMITS.item).pipe(z.string().min(1)), evidence: evidenceList });

export const draftSchema = z.strictObject({
  summary: text(4_000).default(''),
  topics: z
    .array(z.strictObject({ title: text(200).pipe(z.string().min(1)), points: z.array(text(MINUTES_LIMITS.item)).max(30).default([]), evidence: evidenceList }))
    .max(MINUTES_LIMITS.items)
    .default([]),
  decisions: z.array(item).max(MINUTES_LIMITS.items).default([]),
  todos: z
    .array(item.extend({ assignee: text(100).default(''), due: text(40).default(''), department: text(60).default('') }))
    .max(MINUTES_LIMITS.items)
    .default([]),
  carryOver: z.array(item).max(MINUTES_LIMITS.items).default([]),
  unclear: z.array(z.strictObject({ text: text(MINUTES_LIMITS.item).pipe(z.string().min(1)), at: seconds.nullable().default(null) })).max(MINUTES_LIMITS.items).default([]),
});

/** Letters and digits only, full-width folded: what a quote and the transcript are compared on. */
export function comparable(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Seconds around the named time searched for the quote. */
const WINDOW_SEC = 120;
const MIN_QUOTE_CHARS = 4;

/**
 * Marks a quote verified when it is found in the transcript within WINDOW_SEC of `at`. A quote found elsewhere
 * is verified with its time moved to where it was found; one found nowhere (or too short) is unverified.
 */
export function verifyEvidence(transcript: Transcript, evidence: { at: number; quote: string }[]): MinutesEvidence[] {
  return evidence.map(({ at, quote }) => {
    const shown = quote.replace(/\s+/g, ' ').trim().slice(0, MINUTES_LIMITS.quote);
    const want = comparable(shown);
    if (want.length < MIN_QUOTE_CHARS) return { at, quote: shown, verified: false };
    const near = transcript.segments.filter((s) => s.end >= at - WINDOW_SEC && s.start <= at + WINDOW_SEC);
    if (comparable(near.map((s) => s.text).join('')).includes(want)) return { at, quote: shown, verified: true };
    // Elsewhere: the segment where the quote starts (a quote may run over two or three segments). The first window
    // that holds it may start a segment or two early, so move on while the next window still holds it.
    const segs = transcript.segments;
    const holds = (i: number) => comparable(segs.slice(i, i + 3).map((s) => s.text).join('')).includes(want);
    for (let i = 0; i < segs.length; i++) {
      if (!holds(i)) continue;
      while (i + 1 < segs.length && holds(i + 1)) i++;
      return { at: segs[i]!.start, quote: shown, verified: true };
    }
    return { at, quote: shown, verified: false };
  });
}

export function checkedDraft(transcript: Transcript, raw: z.infer<typeof draftSchema>): MinutesDraft {
  const ev = (list: { at: number; quote: string }[]) => verifyEvidence(transcript, list);
  return {
    summary: raw.summary,
    topics: raw.topics.map((t) => ({ title: t.title, points: t.points.filter(Boolean), evidence: ev(t.evidence) })),
    decisions: raw.decisions.map((d) => ({ text: d.text, evidence: ev(d.evidence) })),
    todos: raw.todos.map((t) => ({ text: t.text, assignee: t.assignee, due: t.due, department: t.department, evidence: ev(t.evidence) })),
    carryOver: raw.carryOver.map((c) => ({ text: c.text, evidence: ev(c.evidence) })),
    unclear: raw.unclear,
  };
}
