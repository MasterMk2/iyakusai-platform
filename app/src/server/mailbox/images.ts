import { lookup, type LookupAddress, type LookupOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Parser } from 'htmlparser2';

// Images in a received mail's HTML (2026-11-04). Images the mail carries itself (src="cid:…") come from its own
// attachments; images on other servers only when the reader asks, fetched by the server (the reader's browser never
// contacts the sender's server) and only from public addresses. Both reach the sandboxed frame as data: URIs, so the
// frame's CSP still blocks every other load.

export type MailImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
export const MAIL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MAIL_IMAGES_TOTAL_BYTES = 15 * 1024 * 1024;
export const MAIL_REMOTE_IMAGES_MAX = 30;
const REMOTE_TIMEOUT_MS = 10_000;
const REMOTE_REDIRECTS = 3;

/** The type from the first bytes, never from a name or a header. SVG is not an image here (it can carry scripts). */
export function sniffMailImage(data: Buffer): MailImageType | null {
  const head = data.subarray(0, 12).toString('latin1');
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (/^GIF8[79]a/.test(head)) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** The src of every <img>, decoded and trimmed, in document order. */
export function imageSources(html: string): string[] {
  const out: string[] = [];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === 'img' && attribs.src) out.push(attribs.src.trim());
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  return out;
}

/** "cid:<abc@x>" → "abc@x" (lower case), or null for any other source. */
export function contentIdOf(src: string): string | null {
  if (!/^cid:/i.test(src)) return null;
  let id = src.slice(4).trim();
  try {
    id = decodeURIComponent(id);
  } catch {
    // Kept as written.
  }
  return id.replace(/^<|>$/g, '').toLowerCase() || null;
}

/** An http(s) image address the server may fetch: no credentials, default ports only. */
export function remoteImageUrl(src: string): URL | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port !== '') return null;
  return url;
}

// Two lists: Node also checks an IPv4 address against IPv4-mapped IPv6 rules, so ::ffff:0:0/96 would block all of IPv4.
const BLOCKED4 = new BlockList();
const BLOCKED6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED4.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED6.addSubnet(net, prefix, 'ipv6');

/** Only addresses on the public internet: never this host, the LAN, the Docker networks or other special ranges. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4 ? !BLOCKED4.check(address, 'ipv4') : !BLOCKED6.check(address, 'ipv6');
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS for the connection itself, so a name cannot point at a private address between a check and the connect. */
function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  lookup(hostname, { family: options.family ?? 0, all: true }, (err, list) => {
    if (err) return callback(err, '');
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      return callback(Object.assign(new Error('not a public address'), { code: 'ENOTPUBLIC' }), '');
    }
    if (options.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
}

export type RemoteImageFetch = (url: URL) => Promise<Buffer | null>;

/** GET an image from a public server: no cookies or referrer, at most 5 MB, 10 seconds and 3 redirects. */
export const fetchPublicImage: RemoteImageFetch = (url) => get(url, REMOTE_REDIRECTS, Date.now() + REMOTE_TIMEOUT_MS);

function get(url: URL, redirects: number, deadline: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && !isPublicAddress(host)) return resolve(null);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { agent: false, lookup: publicLookup, headers: { accept: 'image/*', 'user-agent': 'iyakusai-mail-images' } }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && redirects > 0) {
        res.resume();
        let next: URL | null;
        try {
          next = remoteImageUrl(new URL(location, url).href);
        } catch {
          next = null;
        }
        resolve(next ? get(next, redirects - 1, deadline) : null);
        return;
      }
      if (status !== 200 || Number(res.headers['content-length'] ?? 0) > MAIL_IMAGE_MAX_BYTES) {
        req.destroy();
        return resolve(null);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAIL_IMAGE_MAX_BYTES) {
          req.destroy();
          resolve(null);
        } else chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('close', () => resolve(null));
    });
    const timer = setTimeout(() => req.destroy(), Math.max(1, deadline - Date.now()));
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => resolve(null));
  });
}

/** Runs `work` over `items`, at most `limit` at a time. */
export async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(runners);
}
