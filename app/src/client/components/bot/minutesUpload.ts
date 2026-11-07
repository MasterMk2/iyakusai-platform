// With extensions, so that the unit tests (Node's module resolution) can import this file too.
import { MINUTES_UPLOAD_HEAD_BYTES, type MinutesUploadItem, type MinutesUploadsResponse } from '../../../shared/minutes.js';
import { ApiFailure } from '../../api.js';

// Sending a recording in pieces (the server takes 8 MB at a time). 2026-11-07: a dropped connection, or a server that
// answers 5xx for a moment (while it restarts), is waited out for up to WAIT_MS without a piece getting through; and
// a recording sent in part is gone on with — after waiting longer than that, after reloading the page, or after a
// restart of the app — by sending the same file again: the server checks that it is the same file before going on.

/** How long a send waits for the connection (or the server) to come back before it stops. */
export const WAIT_MS = 10 * 60_000;
/** The longest pause between two tries. */
const MAX_PAUSE_MS = 30_000;
/** Answers that mean "not now" rather than "no": tried again. 0 is no answer at all (the connection). */
const RETRY_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export interface UploadState {
  sent: number;
  total: number;
  /** While waiting for the connection: the time (ms) the send gives up at. */
  waitingUntil: number | null;
}

export interface UploadDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Lowercase hex SHA-256. */
  sha256: (data: ArrayBuffer) => Promise<string>;
}

const browserDeps: UploadDeps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  sha256: async (data) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join(''),
};

/** The upload each file was last sent to on this page, so pressing "取り込む" again goes on with it. */
const sentTo = new WeakMap<Blob, string>();

export function forgetUpload(file: Blob): void {
  sentTo.delete(file);
}

interface Answer {
  status: number;
  json: { received?: number; message?: string; error?: string; uploadId?: string; chunkBytes?: number; items?: MinutesUploadItem[] } | null;
}

async function request(deps: UploadDeps, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, bytes?: Blob): Promise<Answer> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(method !== 'GET' ? { 'X-SMM-CSRF': '1' } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : bytes ? { 'Content-Type': 'application/octet-stream' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : bytes,
    });
  } catch {
    return { status: 0, json: null };
  }
  const json = (await res.json().catch(() => null)) as Answer['json'];
  return { status: res.status, json };
}

const failure = (a: Answer) => new ApiFailure(a.status, null, a.json?.message ?? `サーバーがエラーを返しました（${a.status}）。`);

/** The sender's own recordings sent in part (empty when the server cannot be asked). */
export async function pendingUploads(deps: UploadDeps = browserDeps): Promise<MinutesUploadItem[]> {
  const a = await request(deps, 'GET', '/api/minutes/uploads');
  return a.status === 200 ? ((a.json as MinutesUploadsResponse | null)?.items ?? []) : [];
}

/**
 * Sends `file` and answers the upload's id once the server holds all of it. It goes on with an upload of the same
 * file when there is one (sent from this page before, or one of `candidates`, the ids of uploads sent in part).
 */
export async function sendRecording(file: File, onState: (s: UploadState) => void, candidates: string[] = [], deps: UploadDeps = browserDeps): Promise<string> {
  let lastGood = deps.now();
  let tries = 0;
  /** One request, tried again while the connection or the server is away (up to WAIT_MS since the last success). */
  const patient = async (send: () => Promise<Answer>, sent: number): Promise<Answer> => {
    for (;;) {
      const a = await send();
      if (!RETRY_STATUSES.has(a.status)) {
        if (tries > 0) onState({ sent, total: file.size, waitingUntil: null });
        tries = 0;
        if (a.status >= 200 && a.status < 500) lastGood = deps.now();
        return a;
      }
      if (deps.now() - lastGood >= WAIT_MS) {
        throw new ApiFailure(
          a.status,
          null,
          sent > 0
            ? `通信が ${WAIT_MS / 60_000} 分つながらなかったので、送るのを止めました。送った分（${mb(sent)} / ${mb(file.size)}）はサーバーに残っています。つながってから、同じファイルでもう一度「取り込む」を押すと続きから送ります。`
            : '通信がつながらないため、録音ファイルを送れませんでした。通信状態を確かめてから、もう一度「取り込む」を押してください。',
        );
      }
      tries += 1;
      onState({ sent, total: file.size, waitingUntil: lastGood + WAIT_MS });
      await deps.sleep(Math.min(MAX_PAUSE_MS, 2000 * 2 ** (tries - 1)));
    }
  };

  // Going on with an upload of the same file, if the server still holds one.
  let opened: { uploadId: string; chunkBytes: number; received: number } | null = null;
  const remembered = sentTo.get(file);
  const ids = [...new Set([...(remembered ? [remembered] : []), ...candidates])];
  if (ids.length > 0) {
    const listed = await patient(() => request(deps, 'GET', '/api/minutes/uploads'), 0);
    const items = listed.status === 200 ? ((listed.json as MinutesUploadsResponse | null)?.items ?? []) : [];
    for (const id of ids) {
      const item = items.find((i) => i.uploadId === id && i.bytes === file.size);
      if (!item) continue;
      let received = item.received;
      for (let attempt = 0; attempt < 3 && !opened; attempt++) {
        const headBytes = Math.min(received, MINUTES_UPLOAD_HEAD_BYTES);
        const headSha256 = await deps.sha256(await file.slice(0, headBytes).arrayBuffer());
        const a = await patient(() => request(deps, 'POST', `/api/minutes/uploads/${id}/resume`, { bytes: file.size, headBytes, headSha256 }), 0);
        if (a.status === 200 && a.json?.uploadId && a.json.chunkBytes && typeof a.json.received === 'number') {
          opened = { uploadId: a.json.uploadId, chunkBytes: a.json.chunkBytes, received: a.json.received };
        } else if (a.status === 409 && a.json?.error === 'offset' && typeof a.json.received === 'number') {
          received = a.json.received;
        } else {
          break;
        }
      }
      if (opened) break;
    }
  }
  if (!opened) {
    const a = await patient(() => request(deps, 'POST', '/api/minutes/uploads', { filename: file.name, type: file.type, bytes: file.size }), 0);
    if (a.status !== 201 || !a.json?.uploadId || !a.json.chunkBytes) throw failure(a);
    opened = { uploadId: a.json.uploadId, chunkBytes: a.json.chunkBytes, received: 0 };
  }
  const { uploadId, chunkBytes } = opened;
  sentTo.set(file, uploadId);

  let offset = opened.received;
  onState({ sent: offset, total: file.size, waitingUntil: null });
  while (offset < file.size) {
    const piece = file.slice(offset, offset + chunkBytes);
    const at = offset;
    const a = await patient(() => request(deps, 'PUT', `/api/minutes/uploads/${uploadId}?offset=${at}`, undefined, piece), offset);
    if (a.status === 409 && typeof a.json?.received === 'number') {
      offset = a.json.received;
      continue;
    }
    if (a.status !== 200) {
      // Gone (dropped after a day without pieces, or deleted): there is nothing to go on with.
      if (a.status === 404) forgetUpload(file);
      throw failure(a);
    }
    offset = a.json?.received ?? offset + piece.size;
    onState({ sent: offset, total: file.size, waitingUntil: null });
  }
  return uploadId;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
