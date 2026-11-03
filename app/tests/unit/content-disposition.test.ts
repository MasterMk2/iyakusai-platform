import { describe, expect, it } from 'vitest';
import { attachmentDisposition } from '../../src/server/http/content-disposition.js';

// 2026-11-03 review L2: one Content-Disposition for every download, RFC 5987 safe.
describe('attachmentDisposition', () => {
  it('escapes the characters encodeURIComponent leaves (RFC 5987 attr-char) and gives an ASCII fallback', () => {
    const header = attachmentDisposition("見積 (改)' *final!.pdf", 'attachment.bin');
    expect(header).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    const ext = header.slice(header.indexOf("UTF-8''") + 7);
    expect(ext).not.toMatch(/['()*!]/);
    expect(decodeURIComponent(ext)).toBe("見積 (改)' *final!.pdf");
    expect(header).toContain('filename="__ (_)\' *final!.pdf"');
  });

  it('never lets a quote, backslash, semicolon or line break into the ASCII name', () => {
    const header = attachmentDisposition('a"b\\c;d\r\ne.txt');
    const ascii = /filename="([^"]*)"/.exec(header)![1]!;
    expect(ascii).not.toMatch(/["\\;\r\n]/);
    expect(header).not.toMatch(/[\r\n]/);
  });

  it('uses the fallback when nothing printable is left', () => {
    expect(attachmentDisposition('議事録', 'minutes.md')).toContain('filename="minutes.md"');
    expect(attachmentDisposition('')).toContain('filename="attachment"');
  });
});
