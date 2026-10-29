import { describe, expect, it } from 'vitest';
import { parseBotText, parseInline } from '../../src/client/components/bot/markdown.js';

describe('Discord Markdown subset of the Bot answers', () => {
  it('keeps bold, small lines, bullets and paragraphs apart', () => {
    const blocks = parseBotText('**結論**: 当日は雨です。\n二行目\n\n-# 参照: 資料A\n- 一つ目\n* 二つ目\n最後');
    expect(blocks).toEqual([
      { kind: 'paragraph', lines: [[{ kind: 'bold', text: '結論' }, { kind: 'text', text: ': 当日は雨です。' }], [{ kind: 'text', text: '二行目' }]] },
      { kind: 'small', inline: [{ kind: 'text', text: '参照: 資料A' }] },
      { kind: 'list', items: [[{ kind: 'text', text: '一つ目' }], [{ kind: 'text', text: '二つ目' }]] },
      { kind: 'paragraph', lines: [[{ kind: 'text', text: '最後' }]] },
    ]);
  });

  it('makes links only of http and https addresses; a bare URL loses the sentence punctuation', () => {
    expect(parseInline('[資料](https://example.org/a)')).toEqual([{ kind: 'link', text: '資料', href: 'https://example.org/a' }]);
    expect(parseInline('詳しくは https://example.org/b。')).toEqual([
      { kind: 'text', text: '詳しくは ' },
      { kind: 'link', text: 'https://example.org/b', href: 'https://example.org/b' },
      { kind: 'text', text: '。' },
    ]);
    expect(parseInline('[悪い](javascript:alert(1))')).toEqual([{ kind: 'text', text: '[悪い](javascript:alert(1))' }]);
    expect(parseInline('x [h](ftp://example.org/x)')).toEqual([{ kind: 'text', text: 'x [h](ftp://example.org/x)' }]);
  });

  it('never turns HTML or script text into anything but text', () => {
    const blocks = parseBotText('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(blocks).toEqual([{ kind: 'paragraph', lines: [[{ kind: 'text', text: '<script>alert(1)</script> <img src=x onerror=alert(1)>' }]] }]);
  });

  it('treats CRLF and empty input safely', () => {
    expect(parseBotText('')).toEqual([]);
    expect(parseBotText('a\r\nb')).toEqual([{ kind: 'paragraph', lines: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]] }]);
  });
});
