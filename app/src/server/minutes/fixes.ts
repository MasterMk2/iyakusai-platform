// Words the speech model writes with the wrong characters for this committee: the reading is right, the kanji are
// not (協賛 as 共産, 渉外課 as 障害課). They are fixed in the transcript as it comes from the worker, so the text
// people read, the quotes the AI gives as evidence and the summary all have the committee's words. A fix that only
// the summary made would leave the wrong word in the transcript, and the quote checked against it.
//
// Only spellings this committee has no other use for: 出店団体 stays (the food stalls use it), 障害 alone stays
// (システム障害), and 共産 stays before 党・主義 and the like. Found by transcribing read-out meetings with large-v3
// and large-v3-turbo (2026-11-07); add a pair when the same wrong word keeps coming back in real minutes.

/** Pattern (global) and the committee's spelling. */
export const TRANSCRIPT_FIXES: readonly (readonly [RegExp, string])[] = [
  [/共産(?![党主圏国化])/g, '協賛'],
  [/障害課/g, '渉外課'],
  [/(?:シロ|しろ)パス/g, '白パス'],
  [/総(?:おのれ|大野れ|己)祭り?/g, '創己祭'],
  [/富田[井衣]?[祭裁]り?/g, '富大祭'],
  [/医薬祭り/g, '医薬祭'],
];

export function fixTranscriptText(text: string): string {
  return TRANSCRIPT_FIXES.reduce((t, [pattern, to]) => t.replace(pattern, to), text);
}

interface FixableSegment {
  text: string;
  confidence?: { weak?: { word: string }[] };
}

/**
 * The segment with its text fixed. The words the model was unsure of are fixed the same way, and a word that is no
 * longer in the text (a fix across two of the model's pieces, 共 and 産) is dropped, as the screen could not mark it.
 */
export function fixedSegment<T extends FixableSegment>(segment: T): T {
  const text = fixTranscriptText(segment.text);
  if (text === segment.text) return segment;
  const weak = segment.confidence?.weak;
  if (!segment.confidence || !weak) return { ...segment, text };
  return {
    ...segment,
    text,
    confidence: { ...segment.confidence, weak: weak.map((w) => ({ ...w, word: fixTranscriptText(w.word) })).filter((w) => text.includes(w.word)) },
  };
}
