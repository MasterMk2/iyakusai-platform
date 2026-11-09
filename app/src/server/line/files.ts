import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LINE_ATTACH_LIMITS, type LineFileView, type LinePublicDays, type LineSentFileView } from '../../shared/line.js';
import { japaneseDay, jstDay } from '../../shared/mailDue.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { canReplyLine } from './access.js';
import type { LineAttachment, LineState, OutboxFile } from './types.js';

// Files sent as links (2026-11-10). LINE's Messaging API has no file message (text, images, video, audio …
// only), so a PDF or an Office file goes as a link at the end of the text. The app keeps the upload under a name
// nobody can guess (32 random bytes) in its own folder (line-files/, apart from the images, so an older app never
// reads or sweeps it), and answers the link without sign-in only after the file was sent, until the date the
// sender chose (1, 7 or 30 days; a later send can make it later, never earlier). Only kinds recognised from the
// file's own first bytes are kept (PDF, Word, Excel, PowerPoint); the declared type is never trusted, and the
// link is always a download in a sandbox (never rendered by the app's origin).

export const FILES_PATH = '/line-files';
export const FILE_MAX_BYTES = LINE_ATTACH_LIMITS.fileMaxBytes;
/** Kept files one person may hold, all together, and their bytes (a bound on the disk the public route serves). */
export const MAX_FILES_PER_USER = 30;
export const MAX_FILES = 300;
export const MAX_FILE_BYTES_TOTAL = 1024 * 1024 * 1024;
/** A file not sent is kept this long (a draft may wait). */
export const FILE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const NAME_MAX = 80;

const KINDS = {
  pdf: { type: 'application/pdf', label: 'PDF' },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel' },
  pptx: { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint' },
  doc: { type: 'application/msword', label: 'Word' },
  xls: { type: 'application/vnd.ms-excel', label: 'Excel' },
  ppt: { type: 'application/vnd.ms-powerpoint', label: 'PowerPoint' },
} as const;
export type FileExtension = keyof typeof KINDS;

/** A stored name: 64 hex characters and the checked extension. */
export const FILE_NAME = /^[0-9a-f]{64}\.(pdf|docx|xlsx|pptx|doc|xls|ppt)$/;

const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
export const kindLabelOf = (type: string) => Object.values(KINDS).find((k) => k.type === type)?.label ?? 'ファイル';

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * The kind from the file's own bytes: a PDF header, an Office Open XML package (a ZIP whose names include
 * [Content_Types].xml and the part folder of the kind), or an older Office compound file. The extension of the
 * name only chooses among kinds the bytes allow (a .docx must also be a Word package). Anything else: null.
 */
export function sniffFile(buf: Buffer, name: string): FileExtension | null {
  const ext = extOf(name);
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length > 30 && buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const text = buf.toString('latin1');
    if (!text.includes('[Content_Types].xml')) return null;
    const parts: Record<string, string> = { docx: 'word/', xlsx: 'xl/', pptx: 'ppt/' };
    if (ext in parts && text.includes(parts[ext]!)) return ext as FileExtension;
    // A package whose name lost its extension: the part folder decides.
    for (const [kind, folder] of Object.entries(parts)) if (!(ext in KINDS) && text.includes(folder)) return kind as FileExtension;
    return null;
  }
  if (buf.length >= 512 && buf.subarray(0, 8).equals(OLE)) return ext === 'doc' || ext === 'xls' || ext === 'ppt' ? ext : null;
  return null;
}

/** The name shown in the text and the download: no control or direction characters, no folders, at most 80 characters, the checked extension. */
export function cleanFileName(raw: string, ext: FileExtension): string {
  const base = raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const stem = (extOf(base) === ext ? base.slice(0, base.length - ext.length - 1) : base).trim() || 'ファイル';
  const room = NAME_MAX - ext.length - 1;
  return `${Array.from(stem).slice(0, room).join('')}.${ext}`;
}

export function fmtBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The files on disk. Names are random; nothing here trusts a name from a request without FILE_NAME. */
export class LineAttachmentFiles {
  constructor(readonly dir: string) {}

  write(buf: Buffer, ext: FileExtension): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const name = `${randomBytes(32).toString('hex')}.${ext}`;
    const tmp = join(this.dir, `${name}.tmp`);
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, join(this.dir, name));
    return name;
  }

  read(name: string): Buffer | null {
    if (!FILE_NAME.test(name)) return null;
    try {
      return readFileSync(join(this.dir, name));
    } catch {
      return null;
    }
  }

  remove(names: string[]): void {
    for (const name of names) if (FILE_NAME.test(name)) rmSync(join(this.dir, name), { force: true });
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
      if (!FILE_NAME.test(base) || known.has(name)) continue;
      try {
        if (nowMs - statSync(join(this.dir, name)).mtimeMs > 3_600_000) rmSync(join(this.dir, name), { force: true });
      } catch {
        // gone already
      }
    }
  }
}

/** The record is kept until the later of "not sent" keeping and the latest send's choice. */
const goneAt = (a: LineAttachment) => Math.max(Date.parse(a.keepUntil), a.sentUntil ? Date.parse(a.sentUntil) : 0);
export const attachmentGone = (a: LineAttachment, nowMs: number) => nowMs >= goneAt(a);
/** The link answers only after a send, until the latest send's date. */
export const attachmentPublic = (a: LineAttachment, nowMs: number) => !!a.sentUntil && nowMs < Date.parse(a.sentUntil);

/** Checks the bytes and keeps the file; the caller records it in the state (registerAttachment). */
export function storeAttachment(files: LineAttachmentFiles, buf: Buffer, rawName: string): { file: string; name: string; type: string; bytes: number } {
  if (buf.length === 0) throw new DomainError('validation', 'ファイルが空です。', { field: 'file' });
  if (buf.length > FILE_MAX_BYTES) throw new DomainError('validation', `ファイルは ${Math.round(FILE_MAX_BYTES / 1024 / 1024)} MB 以下にしてください。`, { field: 'file' });
  const ext = sniffFile(buf, rawName);
  if (!ext) throw new DomainError('validation', '送れるファイルは PDF・Word・Excel・PowerPoint だけです（中身から種類を確かめられませんでした）。', { field: 'file' });
  const file = files.write(buf, ext);
  return { file, name: cleanFileName(rawName, ext), type: KINDS[ext].type, bytes: buf.length };
}

/** The uploader must be able to send from the account; the number and bytes of kept files are bounded. */
export function checkFileUploader(state: LineState, user: User, accountId: string, nowMs: number, adding = 0): void {
  const account = state.accounts.find((a) => a.id === accountId && a.kind === 'official_account');
  if (!account || !canReplyLine(state, user, account.id)) throw new DomainError('forbidden', 'この LINE アカウントで送る権限がありません。権限管理者に、LINE の送信権限を依頼してください。');
  const kept = (state.attachments ?? []).filter((a) => !attachmentGone(a, nowMs));
  if (kept.filter((a) => a.uploaderId === user.id).length >= MAX_FILES_PER_USER) throw new DomainError('conflict', `送信用のファイルが多すぎます（1 人 ${MAX_FILES_PER_USER} 個まで・公開期間が過ぎると消えます）。`);
  if (kept.length >= MAX_FILES || kept.reduce((n, a) => n + a.bytes, 0) + adding > MAX_FILE_BYTES_TOTAL) {
    throw new DomainError('conflict', '送信用のファイルが多すぎます。しばらくしてからやり直してください。');
  }
}

export function registerAttachment(state: LineState, user: User, accountId: string, stored: ReturnType<typeof storeAttachment>, now: string): LineAttachment {
  checkFileUploader(state, user, accountId, Date.parse(now), stored.bytes);
  const attachment: LineAttachment = {
    id: `lfl_${randomBytes(8).toString('hex')}`,
    uploaderId: user.id,
    accountId,
    createdAt: now,
    ...stored,
    keepUntil: new Date(Date.parse(now) + FILE_KEEP_MS).toISOString(),
  };
  state.attachments = [...(state.attachments ?? []), attachment];
  return attachment;
}

/** A file the user uploaded for this account and that is still kept, or an error. */
export function usableAttachment(state: LineState, user: User, accountId: string, fileId: string, nowMs: number): LineAttachment {
  const a = (state.attachments ?? []).find((x) => x.id === fileId && x.uploaderId === user.id && x.accountId === accountId);
  if (!a) throw notFound();
  if (attachmentGone(a, nowMs)) throw new DomainError('validation', `「${a.name}」の保管期間が過ぎています。ファイルを選び直してください。`, { field: 'file' });
  return a;
}

export const fileView = (a: LineAttachment): LineFileView => ({ id: a.id, name: a.name, bytes: a.bytes, kindLabel: kindLabelOf(a.type) });

export const publicFile = (a: LineAttachment, baseUrl: string): OutboxFile => ({ fileId: a.id, name: a.name, bytes: a.bytes, type: a.type, url: `${baseUrl}${FILES_PATH}/${a.file}` });

export const sentFileView = (f: OutboxFile): LineSentFileView => ({ name: f.name, bytes: f.bytes, kindLabel: kindLabelOf(f.type), url: f.url });

/** A send makes its files answer until `until` (never shortens an earlier send's choice). */
export function markFilesSent(state: LineState, ids: readonly string[], until: string): void {
  for (const a of state.attachments ?? []) {
    if (ids.includes(a.id) && (!a.sentUntil || Date.parse(until) > Date.parse(a.sentUntil))) a.sentUntil = until;
  }
}

/** Removes records past keeping and returns the files to delete. */
export function expireAttachments(state: LineState, nowMs: number): string[] {
  const gone = (state.attachments ?? []).filter((a) => attachmentGone(a, nowMs));
  if (gone.length === 0) return [];
  state.attachments = (state.attachments ?? []).filter((a) => !attachmentGone(a, nowMs));
  return gone.map((a) => a.file);
}

export function attachmentOfFile(state: LineState, name: string): LineAttachment | null {
  return (state.attachments ?? []).find((a) => a.file === name) ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_MS = 9 * 60 * 60 * 1000;

/** The end of the Japanese calendar day `days` after now: the links answer through that whole day. */
export function publicUntil(nowMs: number, days: LinePublicDays): string {
  const day = jstDay(nowMs + days * DAY_MS);
  return new Date(Date.parse(`${day}T00:00:00Z`) - JST_MS + DAY_MS - 1).toISOString();
}

/** The text as sent: the person's text, then the file links with until when they open. */
export function composeText(body: string, files: readonly OutboxFile[], until: string | null, nowMs: number): string {
  if (files.length === 0 || !until) return body;
  const lines = files.map((f) => `${f.name}（${kindLabelOf(f.type)}・${fmtBytes(f.bytes)}）\n${f.url}`);
  return `${body}\n\n📎 添付ファイル（${japaneseDay(jstDay(until), jstDay(nowMs))}まで開けます）\n${lines.join('\n')}`;
}
