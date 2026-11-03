import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { sanitizeMailHtml } from '../../src/server/domain/sanitize.js';
import { syntheticPng } from '../../src/server/line/inbound-media.js';
import { contentIdOf, fetchPublicImage, imageSources, isPublicAddress, remoteImageUrl, sniffMailImage } from '../../src/server/mailbox/images.js';

describe('images in mail HTML', () => {
  it('reads the type from the bytes only, and never takes SVG or HTML', () => {
    expect(sniffMailImage(syntheticPng(4, 4))).toBe('image/png');
    expect(sniffMailImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffMailImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffMailImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMailImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffMailImage(Buffer.from('<html>'))).toBeNull();
  });

  it('finds image sources and reads cid: and http(s) addresses', () => {
    expect(imageSources('<p><img src=" cid:a@x "><IMG SRC="https://e.example/a.png?x=1&amp;y=2"><img alt="no src"></p>')).toEqual(['cid:a@x', 'https://e.example/a.png?x=1&y=2']);
    expect(contentIdOf('cid:<Logo@Partner.example>')).toBe('logo@partner.example');
    expect(contentIdOf('cid:logo%40partner.example')).toBe('logo@partner.example');
    expect(contentIdOf('https://e.example/a.png')).toBeNull();
    expect(remoteImageUrl('https://e.example/a.png')?.href).toBe('https://e.example/a.png');
    for (const src of ['ftp://e.example/a.png', 'https://u:p@e.example/a.png', 'https://e.example:8443/a.png', 'data:image/png;base64,AA', 'javascript:alert(1)', '//e.example/a.png']) {
      expect(remoteImageUrl(src), src).toBeNull();
    }
  });

  it('fetches only from public addresses: never this host, the LAN, Docker networks or special ranges', () => {
    for (const a of ['8.8.8.8', '203.0.112.1', '2606:4700:4700::1111']) expect(isPublicAddress(a), a).toBe(true);
    for (const a of ['127.0.0.1', '10.1.2.3', '172.17.0.2', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:c0a8:1', '64:ff9b::a00:1', '2002:c0a8:1::1', 'localhost', '']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it('refuses a server on this host by address and by name, without sending it anything', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.end(syntheticPng(4, 4));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // The address check comes first; the port check of remoteImageUrl is bypassed here on purpose.
      expect(await fetchPublicImage(new URL(`http://127.0.0.1:${port}/a.png`))).toBeNull();
      expect(await fetchPublicImage(new URL(`http://localhost:${port}/a.png`))).toBeNull();
      expect(await fetchPublicImage(new URL(`http://[::1]:${port}/a.png`))).toBeNull();
      expect(requests).toBe(0);
    } finally {
      server.close();
    }
  });

  it('puts in only the data: URIs it was given, for the source as written', () => {
    const uri = `data:image/png;base64,${syntheticPng(2, 2).toString('base64')}`;
    const html = '<img src="cid:a@x" alt="&quot;x&quot;" width="10" height="100%" style="x"><img src="cid:b@x"><img src="data:text/html,<script>">';
    const { html: out } = sanitizeMailHtml(html, new Map([['cid:a@x', uri]]));
    expect(out).toBe(`<img src="${uri}" alt="&quot;x&quot;" width="10" /><span class="blocked-image"></span><span class="blocked-image"></span>`);
    // Without images, nothing changes from before.
    expect(sanitizeMailHtml(html).html).toBe('<span class="blocked-image"></span>'.repeat(3));
  });
});
