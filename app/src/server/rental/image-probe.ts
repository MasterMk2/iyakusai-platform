import { createHash } from 'node:crypto';
import { MAX_PHOTO_BYTES, MAX_PIXELS, RentalError } from './validate.js';

// Photo checks without an image library. The Python server decoded each photo with Pillow; here the
// container structure is read instead: the format must be a still JPEG, PNG or WebP, its dimensions must
// be readable from its own headers and within the pixel limit. Photos are stored as received and never
// served back by the app, so a file that passes these checks but is damaged further in cannot reach a
// browser through this server. Phones send JPEG they compressed themselves (long side 1600 px).

export interface CheckedPhoto {
  data: Buffer;
  sha256: string;
  md5: string;
  size: number;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  ext: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
}

const unreadable = () => new RentalError(400, '写真データを読み取れません。');

function jpegSize(b: Buffer): { width: number; height: number } {
  // SOI, then marker segments up to the first start-of-frame.
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw unreadable();
    let marker = b[i + 1]!;
    while (marker === 0xff && i + 2 < b.length) {
      i += 1;
      marker = b[i + 1]!;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = b.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > b.length) throw unreadable();
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (length < 7) throw unreadable();
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  throw unreadable();
}

function pngSize(b: Buffer): { width: number; height: number } {
  if (b.length < 33 || b.toString('latin1', 12, 16) !== 'IHDR') throw unreadable();
  const size = { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  // Walk the chunks: an animation control chunk (APNG) means more than one frame.
  let i = 8;
  while (i + 8 <= b.length) {
    const length = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    if (type === 'acTL') throw new RentalError(400, '写真は静止画の JPEG / PNG / WebP のみ使えます。');
    if (type === 'IEND') return size;
    if (i + 12 + length > b.length) throw unreadable();
    i += 12 + length;
  }
  throw unreadable();
}

function webpSize(b: Buffer): { width: number; height: number } {
  if (b.length < 30) throw unreadable();
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    if (b[20]! & 0x02) throw new RentalError(400, '写真は静止画の JPEG / PNG / WebP のみ使えます。');
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) throw unreadable();
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) throw unreadable();
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw unreadable();
}

export function checkPhoto(data: Buffer): CheckedPhoto {
  if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_PHOTO_BYTES) throw new RentalError(413, '各写真は 2 MB 以下にしてください。');
  let kind: Pick<CheckedPhoto, 'mime' | 'ext'>;
  let size: { width: number; height: number };
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    kind = { mime: 'image/jpeg', ext: 'jpg' };
    size = jpegSize(data);
  } else if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    kind = { mime: 'image/png', ext: 'png' };
    size = pngSize(data);
  } else if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    kind = { mime: 'image/webp', ext: 'webp' };
    size = webpSize(data);
  } else {
    throw unreadable();
  }
  if (size.width <= 0 || size.height <= 0 || size.width * size.height > MAX_PIXELS) throw new RentalError(400, '写真の画素数が上限を超えています。');
  return {
    data,
    sha256: createHash('sha256').update(data).digest('hex'),
    md5: createHash('md5').update(data).digest('hex'),
    size: data.length,
    ...kind,
    ...size,
  };
}
