import { describe, expect, it } from 'vitest';
import { suggestTargets, textDiff, unclearTimes, type TranscriptSegment } from '../../src/shared/minutes.js';

// What the AI is asked to guess for, and how its guess is shown against the text as heard (2026-11-10). Synthetic text.

const sure = { logprob: -0.1, noSpeech: 0.01, compression: 1.5, weak: [] };
const unsure = { logprob: -0.1, noSpeech: 0.01, compression: 1.5, weak: [{ start: 0, end: 1, word: '強酸', p: 0.1 }] };

describe('the segments the AI guesses for', () => {
  it('are those worth listening to again that no one checked, by the model or by the AI draft', () => {
    const segments: TranscriptSegment[] = [
      { start: 0, end: 4, text: '始めます。', confidence: sure },
      { start: 5, end: 9, text: '強酸の件です。', confidence: unsure },
      { start: 10, end: 14, text: '強酸の件、直しました。', confidence: unsure, checked: { original: 'x', byName: '合成 太郎', at: '2026-11-10T00:00:00Z' } },
      { start: 15, end: 19, text: '数字の件です。', confidence: sure },
      { start: 20, end: 24, text: '   ', confidence: unsure },
    ];
    const at = unclearTimes({ unclear: [{ text: '数字が食い違う', at: 16 }, { text: '時刻なし', at: null }] });
    expect(at).toEqual([16]);
    expect(suggestTargets(segments, at)).toEqual([1, 3]);
    expect(suggestTargets(segments)).toEqual([1]);
  });
});

describe('the difference a guess makes', () => {
  it('shows what goes before what comes, keeping the common text around it', () => {
    expect(textDiff('合成の模疑店で', '合成の模擬店で')).toEqual([
      { kind: 'same', text: '合成の模' },
      { kind: 'del', text: '疑' },
      { kind: 'ins', text: '擬' },
      { kind: 'same', text: '店で' },
    ]);
    expect(textDiff('強酸の依頼文', '協賛の依頼文')).toEqual([
      { kind: 'del', text: '強酸' },
      { kind: 'ins', text: '協賛' },
      { kind: 'same', text: 'の依頼文' },
    ]);
    expect(textDiff('あの、えーと決まりです', 'あの、えーと決まりです')).toEqual([{ kind: 'same', text: 'あの、えーと決まりです' }]);
    expect(textDiff('', '')).toEqual([]);
    expect(textDiff('', '足した')).toEqual([{ kind: 'ins', text: '足した' }]);
    expect(textDiff('消した文', '消文')).toEqual([
      { kind: 'same', text: '消' },
      { kind: 'del', text: 'した' },
      { kind: 'same', text: '文' },
    ]);
  });

  it('puts the parts back together into both texts, and gives up on very long ones', () => {
    const from = '来週の水曜に会計課と渉外課で打ち合わせ、見積もりは三件。';
    const to = '来週の水曜日に会計課と渉外課で打ち合わせ、見積もりは三件です。';
    const parts = textDiff(from, to);
    expect(parts.filter((p) => p.kind !== 'ins').map((p) => p.text).join('')).toBe(from);
    expect(parts.filter((p) => p.kind !== 'del').map((p) => p.text).join('')).toBe(to);
    const long = 'あ'.repeat(700);
    expect(textDiff(long, `${long}い`)).toEqual([{ kind: 'same', text: long }, { kind: 'ins', text: 'い' }]);
    expect(textDiff(`${'う'.repeat(700)}`, `${'え'.repeat(700)}`)).toEqual([
      { kind: 'del', text: 'う'.repeat(700) },
      { kind: 'ins', text: 'え'.repeat(700) },
    ]);
  });
});
