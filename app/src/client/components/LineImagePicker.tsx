import { useRef, useState } from 'react';
import { LINE_IMAGE_LIMITS, type LineMediaResponse } from '../../shared/line';
import { apiForm, toFailure } from '../api';

// One image for a LINE send (2026-11-02). The browser shrinks it before uploading: an original of at most
// 2048 px on the long side and 10 MB, and a preview of at most 1024 px and 1 MB, both JPEG. The server checks
// the bytes again and publishes them for 7 days under names nobody can guess (LINE fetches them from there).

export interface PickedImage {
  id: string;
  previewUrl: string;
  expiresAt: string;
}

async function jpegOf(bitmap: ImageBitmap, maxSide: number, maxBytes: number): Promise<Blob> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas');
  // A transparent PNG becomes white rather than black in JPEG.
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, width, height);
  g.drawImage(bitmap, 0, 0, width, height);
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= maxBytes) return blob;
  }
  throw new Error('too large');
}

/** Shrinks the file in the browser and uploads the original and the preview. */
export async function uploadLineImage(accountId: string, file: File): Promise<PickedImage> {
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') throw new Error('JPEG か PNG の画像を選んでください。');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('画像として読み込めませんでした。別の画像を選んでください。');
  }
  let original: Blob;
  let preview: Blob;
  try {
    original = await jpegOf(bitmap, LINE_IMAGE_LIMITS.originalMaxSide, LINE_IMAGE_LIMITS.originalMaxBytes);
    preview = await jpegOf(bitmap, LINE_IMAGE_LIMITS.previewMaxSide, LINE_IMAGE_LIMITS.previewMaxBytes);
  } catch {
    throw new Error('画像を縮められませんでした。別の画像を選んでください。');
  } finally {
    bitmap.close();
  }
  const form = new FormData();
  form.append('accountId', accountId);
  form.append('original', original, 'original.jpg');
  form.append('preview', preview, 'preview.jpg');
  const res = await apiForm<LineMediaResponse>('/api/line/media', form);
  return { id: res.id, previewUrl: res.previewUrl, expiresAt: res.expiresAt };
}

export function LineImagePicker({
  accountId,
  image,
  onChange,
  disabled,
}: {
  accountId: string;
  image: PickedImage | null;
  onChange: (image: PickedImage | null) => void;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await uploadLineImage(accountId, file));
    } catch (err) {
      setError(err instanceof Error && !(err as { status?: unknown }).status ? err.message : toFailure(err).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="line-image-picker">
      {image ? (
        <figure className="line-image" data-testid="line-image-chosen">
          <img src={image.previewUrl} alt="送る画像のプレビュー" />
          <figcaption>
            <button type="button" className="secondary" onClick={() => onChange(null)} disabled={disabled || busy}>
              画像を外す
            </button>
          </figcaption>
        </figure>
      ) : (
        <label className="secondary button-like">
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png"
            onChange={(e) => void pick(e.target.files?.[0])}
            disabled={disabled || busy}
            data-testid="line-image-input"
            aria-label="画像を 1 枚添える（JPEG・PNG）"
          />
          {busy ? '画像を縮めて送っています…' : '画像を 1 枚添える（JPEG・PNG）'}
        </label>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
