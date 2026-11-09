import { describe, expect, it } from 'vitest';
import { ASSISTANT_LIMITS } from '../../src/shared/assistant.js';
import { composeLineReviewRequest } from '../../src/shared/lineReview.js';
import { screenLine, type LineScreenInput } from '../../src/shared/lineScreen.js';

// Checks before sending an official LINE message and the Bot's proofreading request (2026-11-09). Synthetic text only.

const NOW = new Date('2026-11-09T03:00:00Z');
const base: LineScreenInput = {
  body: '医薬祭実行委員会です。\n11月13日（金）の搬入は 9 時からです。よろしくお願いします。',
  recipients: [{ title: '合成サンプル1', friend: true }],
  hasImage: false,
  now: NOW,
};
const texts = (i: Partial<LineScreenInput>) => screenLine({ ...base, ...i }).map((f) => `${f.level}:${f.text}`);
const many = [
  { title: '合成サンプル1', friend: true },
  { title: '合成サンプル2', friend: true },
  { title: '合成サンプル3', friend: true },
];

describe('checks before sending an official LINE message', () => {
  it('finds nothing in a complete message, and asks for no signature or addressee', () => {
    expect(texts({})).toEqual([]);
    expect(texts({ body: '承知しました。' })).toEqual([]);
  });

  it('finds half-written places and a wrong weekday, as the mail checks do', () => {
    expect(texts({ body: '【日時】11月13日（木）\n【場所】○○会議室\n【 】までにご返信ください。' })).toEqual([
      'warning:書きかけの箇所が残っているようです：○○、【 】',
      'warning:「11月13日(木)」の曜日が違います（2026年11月13日は金曜日）。',
    ]);
  });

  it('says when an image is named but not attached', () => {
    expect(texts({ body: '当日の地図を画像で送ります。' })).toEqual(['warning:本文に「画像」「写真」「添付」とありますが、画像が付いていません。']);
    expect(texts({ body: '当日の地図を画像で送ります。', hasImage: true })).toEqual([]);
  });

  it('points out one person’s name or a personal greeting in a message to several people', () => {
    expect(texts({ recipients: many, body: '合成サンプル2さん、ありがとうございます。\n明日の集合は 9 時です。' })).toEqual([
      'warning:3 人に同じ文が届きます。本文にある「合成サンプル2」の名前は、ほかの相手にも見えます。',
    ]);
    expect(texts({ recipients: many, body: '山田様\n明日の集合は 9 時です。' })).toEqual(['info:3 人に同じ文が届きます。冒頭の「山田様」は全員に同じように見えます。']);
    // A greeting for everyone, or a name in a message to one person, is fine.
    expect(texts({ recipients: many, body: '委員の皆さん\n明日の集合は 9 時です。' })).toEqual([]);
    expect(texts({ recipients: many, body: 'お疲れ様です。\n明日の集合は 9 時です。' })).toEqual([]);
    expect(texts({ body: '合成サンプル1さん、ありがとうございます。' })).toEqual([]);
  });

  it('counts the people whose friendship is not confirmed', () => {
    expect(texts({ recipients: [...many, { title: '合成サンプル4', friend: false }] })).toEqual(['info:友だち登録が確認できない相手が 1 人います。友だち解除・ブロックされていると届きません。']);
  });
});

describe('the Bot proofreading request for an official LINE message', () => {
  it('carries the account, how many people and the text, never names or IDs', () => {
    const { content, cut } = composeLineReviewRequest({ accountName: '合成 公式LINE', audience: '1:1 の相手 3 人（同じ文を 1 人ずつ）', body: '明日の集合は 9 時です。' });
    expect(cut).toBe(false);
    expect(content).toContain('【送信元】合成 公式LINE（公式LINE）');
    expect(content).toContain('【相手】1:1 の相手 3 人（同じ文を 1 人ずつ）');
    expect(content).toContain('【本文】\n明日の集合は 9 時です。');
    expect(content).toContain('最初の 2 行で用件が分かるか');
  });

  it('cuts a long text to the doc limit and says so', () => {
    const { content, cut } = composeLineReviewRequest({ accountName: '合成', audience: '1:1 の相手 1 人', body: 'あ'.repeat(5000) });
    expect(cut).toBe(true);
    expect(content.length).toBeLessThanOrEqual(ASSISTANT_LIMITS.docContentMax);
    expect(content).toContain('（長いので、ここから後は省きました）');
  });
});
