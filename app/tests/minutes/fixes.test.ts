import { describe, expect, it } from 'vitest';
import { fixedSegment, fixTranscriptText } from '../../src/server/minutes/fixes.js';

// The committee words the speech model writes with the wrong characters (2026-11-07). The wrong spellings are the
// ones large-v3 and large-v3-turbo wrote for a read-out meeting.

describe('fixes of the committee words in a transcript', () => {
  it('fixes the words the speech model writes wrong', () => {
    expect(fixTranscriptText('今年は共産を42社にお願いして、共産金の合計は87万円です。')).toBe('今年は協賛を42社にお願いして、協賛金の合計は87万円です。');
    expect(fixTranscriptText('はい、障害課です。')).toBe('はい、渉外課です。');
    expect(fixTranscriptText('シロパスの確認と、しろパスの受付')).toBe('白パスの確認と、白パスの受付');
    expect(fixTranscriptText('富田祭と総おのれ祭りの実行委員会')).toBe('富大祭と創己祭の実行委員会');
    expect(fixTranscriptText('富田井祭と総大野れ祭り、富田衣裁')).toBe('富大祭と創己祭、富大祭');
    expect(fixTranscriptText('来年度の医薬祭りに向けた引き継ぎ')).toBe('来年度の医薬祭に向けた引き継ぎ');
  });

  it('leaves the words this committee uses as they are', () => {
    for (const text of ['模擬店の出店団体に説明します。', '受付の端末でシステム障害が起きました。', '共産党と共産主義', '協賛の依頼文', '富大祭と創己祭', '物品貸し出し']) {
      expect(fixTranscriptText(text)).toBe(text);
    }
  });

  it('fixes the words the model was unsure of, and drops those no longer in the text', () => {
    const segment = {
      start: 0,
      end: 4,
      text: '共産の依頼は障害課から',
      confidence: { logprob: -0.2, noSpeech: 0.1, compression: 1.4, weak: [{ start: 0, end: 0.3, word: '共', p: 0.3 }, { start: 0.3, end: 0.6, word: '産', p: 0.4 }, { start: 2, end: 2.6, word: '障害課', p: 0.2 }, { start: 1, end: 1.3, word: '依頼', p: 0.4 }] },
    };
    expect(fixedSegment(segment)).toEqual({
      ...segment,
      text: '協賛の依頼は渉外課から',
      confidence: { ...segment.confidence, weak: [{ start: 2, end: 2.6, word: '渉外課', p: 0.2 }, { start: 1, end: 1.3, word: '依頼', p: 0.4 }] },
    });
    const plain = { start: 0, end: 1, text: '協賛の依頼' };
    expect(fixedSegment(plain)).toBe(plain);
    expect(fixedSegment({ start: 0, end: 1, text: '共産の依頼' })).toEqual({ start: 0, end: 1, text: '協賛の依頼' });
  });
});
