import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError, notFound, type User } from '../domain/types.js';
import { canReplyLine } from './access.js';
import type { LineMedia, LineState, OutboxImage } from './types.js';

// Images for sending (2026-11-02). LINE fetches an image message from a public HTTPS URL, so the app keeps the
// uploaded file under a name nobody can guess (32 random bytes) and answers it without sign-in for 7 days.
// The browser shrinks the picture first (an original of at most 2048 px and 10 MB, a preview of at most
// 1024 px and 1 MB); the server trusts neither the file name nor the declared type, only the first bytes.

export const MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MEDIA_PATH = '/line-media';
export const ORIGINAL_MAX_BYTES = 10 * 1024 * 1024;
export const PREVIEW_MAX_BYTES = 1024 * 1024;
export const ORIGINAL_MAX_SIDE = 2048;
export const PREVIEW_MAX_SIDE = 1024;
/** Live images one person may hold, and all together (a bound on the disk the public route can serve). */
export const MAX_MEDIA_PER_USER = 50;
export const MAX_MEDIA = 500;
/** A public file name: 64 hex characters (32 random bytes) and the extension of the checked type. */
export const MEDIA_FILE = /^[0-9a-f]{64}\.(jpg|png)$/;

export type ImageType = 'image/jpeg' | 'image/png';

export interface SniffedImage {
  type: ImageType;
  width: number;
  height: number;
}

/** The type and size from the file's own bytes (JPEG: the frame header; PNG: IHDR), or null. */
export function sniffImage(buf: Buffer): SniffedImage | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.subarray(12, 16).toString('latin1') === 'IHDR') {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { type: 'image/png', width, height } : null;
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    let marker = buf[i + 1]!;
    while (marker === 0xff && i + 2 < buf.length) {
      i += 1;
      marker = buf[i + 1]!;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC): precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > buf.length) return null;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { type: 'image/jpeg', width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

const extensionOf = (type: ImageType) => (type === 'image/png' ? 'png' : 'jpg');
export const typeOfFile = (file: string): ImageType => (file.endsWith('.png') ? 'image/png' : 'image/jpeg');

function checkImage(buf: Buffer, what: string, maxBytes: number, maxSide: number): SniffedImage {
  if (buf.length === 0) throw new DomainError('validation', `${what}がありません。`, { field: 'image' });
  if (buf.length > maxBytes) throw new DomainError('validation', `${what}は ${Math.round(maxBytes / 1024 / 1024)} MB 以下にしてください。`, { field: 'image' });
  const image = sniffImage(buf);
  if (!image) throw new DomainError('validation', `${what}は JPEG か PNG の画像にしてください（中身が画像として読めませんでした）。`, { field: 'image' });
  if (Math.max(image.width, image.height) > maxSide) throw new DomainError('validation', `${what}の長い辺は ${maxSide} px 以下にしてください。`, { field: 'image' });
  return image;
}

/** The files on disk. Names are random; nothing here trusts a name from a request without MEDIA_FILE. */
export class LineMediaFiles {
  constructor(readonly dir: string) {}

  write(buf: Buffer, type: ImageType): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const name = `${randomBytes(32).toString('hex')}.${extensionOf(type)}`;
    const tmp = join(this.dir, `${name}.tmp`);
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, join(this.dir, name));
    return name;
  }

  read(name: string): Buffer | null {
    if (!MEDIA_FILE.test(name)) return null;
    try {
      return readFileSync(join(this.dir, name));
    } catch {
      return null;
    }
  }

  remove(names: string[]): void {
    for (const name of names) if (MEDIA_FILE.test(name)) rmSync(join(this.dir, name), { force: true });
  }

  /** Files no record names (an upload whose record was not saved, a record already expired), older than an hour. */
  sweep(known: ReadonlySet<string>, nowMs: number): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const base = name.endsWith('.tmp') ? name.slice(0, -4) : name;
      if (!MEDIA_FILE.test(base) || known.has(name)) continue;
      try {
        if (nowMs - statSync(join(this.dir, name)).mtimeMs > 3_600_000) rmSync(join(this.dir, name), { force: true });
      } catch {
        // gone already
      }
    }
  }
}

export const mediaExpired = (m: LineMedia, nowMs: number) => nowMs - Date.parse(m.createdAt) >= MEDIA_TTL_MS;
export const mediaExpiresAt = (m: LineMedia) => new Date(Date.parse(m.createdAt) + MEDIA_TTL_MS).toISOString();

/** Checks both files and keeps them; the caller records the result in the state (registerMedia). */
export function storeUpload(files: LineMediaFiles, original: Buffer, preview: Buffer): { original: LineMedia['original']; preview: LineMedia['preview'] } {
  const o = checkImage(original, '原寸の画像', ORIGINAL_MAX_BYTES, ORIGINAL_MAX_SIDE);
  const p = checkImage(preview, 'プレビューの画像', PREVIEW_MAX_BYTES, PREVIEW_MAX_SIDE);
  const originalFile = files.write(original, o.type);
  const previewFile = files.write(preview, p.type);
  return { original: { file: originalFile, type: o.type, bytes: original.length }, preview: { file: previewFile, type: p.type, bytes: preview.length } };
}

/** The uploader must be able to send from the account; the number of live images is bounded. */
export function checkUploader(state: LineState, user: User, accountId: string, nowMs: number): void {
  const account = state.accounts.find((a) => a.id === accountId && a.kind === 'official_account');
  if (!account || !canReplyLine(state, user, account.id)) throw new DomainError('forbidden', 'この LINE アカウントで送る権限がありません。権限管理者に、LINE の送信権限を依頼してください。');
  const live = (state.media ?? []).filter((m) => !mediaExpired(m, nowMs));
  if (live.filter((m) => m.uploaderId === user.id).length >= MAX_MEDIA_PER_USER) throw new DomainError('conflict', `送信用の画像が多すぎます（1 人 ${MAX_MEDIA_PER_USER} 枚まで・7 日で消えます）。`);
  if (live.length >= MAX_MEDIA) throw new DomainError('conflict', '送信用の画像が多すぎます。しばらくしてからやり直してください。');
}

export function registerMedia(state: LineState, user: User, accountId: string, stored: ReturnType<typeof storeUpload>, now: string): LineMedia {
  checkUploader(state, user, accountId, Date.parse(now));
  const media: LineMedia = { id: `lmd_${randomBytes(8).toString('hex')}`, uploaderId: user.id, accountId, createdAt: now, ...stored };
  state.media = [...(state.media ?? []), media];
  return media;
}

/** An image the user uploaded for this account and that is still public, or a validation error. */
export function usableMedia(state: LineState, user: User, accountId: string, mediaId: string, nowMs: number): LineMedia {
  const media = (state.media ?? []).find((m) => m.id === mediaId && m.uploaderId === user.id && m.accountId === accountId);
  if (!media) throw notFound();
  if (mediaExpired(media, nowMs)) throw new DomainError('validation', '画像の公開期間（7 日）が過ぎています。画像を選び直してください。', { field: 'image' });
  return media;
}

export const publicImage = (media: LineMedia, baseUrl: string): OutboxImage => ({
  mediaId: media.id,
  originalUrl: `${baseUrl}${MEDIA_PATH}/${media.original.file}`,
  previewUrl: `${baseUrl}${MEDIA_PATH}/${media.preview.file}`,
});

/** Removes expired records and returns the files to delete. */
export function expireMedia(state: LineState, nowMs: number): string[] {
  const gone = (state.media ?? []).filter((m) => mediaExpired(m, nowMs));
  if (gone.length === 0) return [];
  state.media = (state.media ?? []).filter((m) => !mediaExpired(m, nowMs));
  return gone.flatMap((m) => [m.original.file, m.preview.file]);
}

/** The record a public file belongs to (original or preview). */
export function mediaOfFile(state: LineState, name: string): LineMedia | null {
  return (state.media ?? []).find((m) => m.original.file === name || m.preview.file === name) ?? null;
}
