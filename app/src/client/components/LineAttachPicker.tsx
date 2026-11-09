import { useId, useRef, useState } from 'react';
import { LINE_ATTACH_LIMITS, type LineFileResponse, type LineFileView, type LinePublicDays } from '../../shared/line';
import { japaneseDay, jstDay } from '../../shared/mailDue';
import { apiForm, toFailure } from '../api';
import { uploadLineImage, type PickedImage } from './LineImagePicker';

// Images and files for an official LINE message (2026-11-10), shaped like the mail form's attachments. Images go
// to LINE as images (up to four: LINE takes the text and four images in one request). LINE cannot carry a file,
// so a PDF or an Office file goes as a link at the end of the text; the sender chooses how long the links open.

export type PickedFile = LineFileView;

const FILE_ACCEPT = '.pdf,.docx,.xlsx,.pptx,.doc,.xls,.ppt,application/pdf';
const fmtSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** The last day the links open when sent now (the server counts the same way: through the end of that day in Japan). */
export function publicDayLabel(days: LinePublicDays, now = Date.now()): string {
  return japaneseDay(jstDay(now + days * 86_400_000), jstDay(now));
}

async function uploadFile(accountId: string, file: File): Promise<PickedFile> {
  if (file.size > LINE_ATTACH_LIMITS.fileMaxBytes) throw new Error(`「${file.name}」は大きすぎます（1 個 ${Math.round(LINE_ATTACH_LIMITS.fileMaxBytes / 1024 / 1024)} MB まで）。`);
  const form = new FormData();
  form.append('accountId', accountId);
  form.append('file', file, file.name);
  const res = await apiForm<LineFileResponse>('/api/line/files', form);
  return { id: res.id, name: res.name, bytes: res.bytes, kindLabel: res.kindLabel };
}

export function LineAttachPicker({
  accountId,
  images,
  onImages,
  files,
  onFiles,
  publicDays,
  onPublicDays,
  imagesEnabled,
  filesEnabled,
  disabled,
}: {
  accountId: string;
  images: PickedImage[];
  onImages: (images: PickedImage[]) => void;
  files: PickedFile[];
  onFiles: (files: PickedFile[]) => void;
  publicDays: LinePublicDays;
  onPublicDays: (days: LinePublicDays) => void;
  imagesEnabled: boolean;
  filesEnabled: boolean;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState<'image' | 'file' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const daysId = useId();
  const { imagesMax, filesMax } = LINE_ATTACH_LIMITS;

  async function addImages(list: FileList | null) {
    // Copied first: clearing the input below empties the live FileList.
    const picked = Array.from(list ?? []).slice(0, imagesMax - images.length);
    if (imageInput.current) imageInput.current.value = '';
    if (picked.length === 0) return;
    setBusy('image');
    setError(null);
    let next = images;
    let failed = false;
    try {
      for (const f of picked) {
        next = [...next, await uploadLineImage(accountId, f)];
        onImages(next);
      }
    } catch (err) {
      failed = true;
      setError(err instanceof Error && !(err as { status?: unknown }).status ? err.message : toFailure(err).message);
    } finally {
      setBusy(null);
    }
    if (!failed && (list?.length ?? 0) > picked.length) setError(`画像は ${imagesMax} 枚までです。多い分は付けていません。`);
  }

  async function addFiles(list: FileList | null) {
    const picked = Array.from(list ?? []).slice(0, filesMax - files.length);
    if (fileInput.current) fileInput.current.value = '';
    if (picked.length === 0) return;
    setBusy('file');
    setError(null);
    let next = files;
    let failed = false;
    try {
      for (const f of picked) {
        next = [...next, await uploadFile(accountId, f)];
        onFiles(next);
      }
    } catch (err) {
      failed = true;
      setError(err instanceof Error && !(err as { status?: unknown }).status ? err.message : toFailure(err).message);
    } finally {
      setBusy(null);
    }
    if (!failed && (list?.length ?? 0) > picked.length) setError(`ファイルは ${filesMax} 個までです。多い分は付けていません。`);
  }

  const off = disabled || busy !== null;
  return (
    <>
      <div className="compose-files" data-testid="line-attach-images">
        <span className="compose-files-label">画像（任意・{imagesMax} 枚まで）</span>
        {imagesEnabled ? (
          <>
            {images.length > 0 && (
              <ul className="line-attach-images">
                {images.map((img, i) => (
                  <li key={img.id}>
                    <img className="line-image-thumb" src={img.previewUrl} alt={`添える画像 ${i + 1}`} />
                    <button type="button" className="quiet" onClick={() => onImages(images.filter((x) => x.id !== img.id))} disabled={off} aria-label={`画像 ${i + 1} を外す`}>
                      外す
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {images.length < imagesMax && (
              <label className={`button secondary compose-file-button ${off ? 'disabled' : ''}`}>
                {busy === 'image' ? '画像を縮めて送っています…' : '画像を選ぶ'}
                <input ref={imageInput} type="file" accept="image/jpeg,image/png" multiple className="sr-only" onChange={(e) => void addImages(e.target.files)} disabled={off} data-testid="line-image-input" />
              </label>
            )}
            <p className="hint">JPEG・PNG。文のあとに LINE の画像として届きます。</p>
          </>
        ) : (
          <p className="hint">このサーバーでは画像を送れません（公開 URL が設定されていません）。</p>
        )}
      </div>
      {filesEnabled && (
        <div className="compose-files" data-testid="line-attach-files">
          <span className="compose-files-label">ファイル（任意・{filesMax} 個まで）</span>
          {files.length > 0 && (
            <ul>
              {files.map((f) => (
                <li key={f.id}>
                  <span className="compose-file-name">{f.name}</span> <span className="hint">{f.kindLabel}・{fmtSize(f.bytes)}</span>
                  <button type="button" className="quiet" onClick={() => onFiles(files.filter((x) => x.id !== f.id))} disabled={off} aria-label={`${f.name} を外す`}>
                    外す
                  </button>
                </li>
              ))}
            </ul>
          )}
          {files.length < filesMax && (
            <label className={`button secondary compose-file-button ${off ? 'disabled' : ''}`}>
              {busy === 'file' ? 'ファイルを送っています…' : 'ファイルを選ぶ'}
              <input ref={fileInput} type="file" accept={FILE_ACCEPT} multiple className="sr-only" onChange={(e) => void addFiles(e.target.files)} disabled={off} data-testid="line-file-input" />
            </label>
          )}
          <p className="hint">PDF・Word・Excel・PowerPoint、1 個 {Math.round(LINE_ATTACH_LIMITS.fileMaxBytes / 1024 / 1024)} MB まで。LINE はファイルをそのまま送れないため、本文の末尾にリンクを付けます。リンクを知っている人は誰でも開けます。</p>
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {(images.length > 0 || files.length > 0) && (
        <div className="line-attach-days">
          <label htmlFor={daysId}>公開期間</label>
          <select id={daysId} value={publicDays} onChange={(e) => onPublicDays(Number(e.target.value) as LinePublicDays)} disabled={disabled} data-testid="line-public-days">
            {LINE_ATTACH_LIMITS.publicDays.map((d) => (
              <option key={d} value={d}>
                {d} 日（{publicDayLabel(d)}まで）
              </option>
            ))}
          </select>
          <p className="hint">画像とファイルのリンクを開ける期間です。過ぎると開けなくなります（画像はアップロードから 7 日より短くはなりません）。</p>
        </div>
      )}
    </>
  );
}

/** The images, files and public period on a confirmation (rows of its <dl>). */
export function PreviewAttachments({ images, files, publicUntil }: { images: { previewUrl: string }[]; files: { name: string; bytes: number; kindLabel: string }[]; publicUntil: string | null }) {
  return (
    <>
      {images.length > 0 && (
        <>
          <dt>画像</dt>
          <dd>
            <ul className="line-attach-images" data-testid="preview-images">
              {images.map((img, i) => (
                <li key={img.previewUrl}>
                  <img className="line-image-thumb" src={img.previewUrl} alt={`送る画像 ${i + 1}`} />
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
      {files.length > 0 && (
        <>
          <dt>ファイル</dt>
          <dd data-testid="preview-files">
            {files.map((f) => `${f.name}（${f.kindLabel}・${fmtSize(f.bytes)}）`).join('、')}
            <span className="hint">（本文の末尾のリンクで開きます）</span>
          </dd>
        </>
      )}
      {publicUntil && (
        <>
          <dt>公開</dt>
          <dd data-testid="preview-public-until">{japaneseDay(jstDay(publicUntil), jstDay(publicUntil))}まで開けます</dd>
        </>
      )}
    </>
  );
}
