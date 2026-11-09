import { committeeLineState } from './committee.js';
import type { LinePushConnector } from './connector.js';
import { LineFeed } from './feed.js';
import { LineHistoryImporter } from './history.js';
import { ReceiverImages, type InboundImageSource } from './inbound-media.js';
import { LineAttachmentFiles } from './files.js';
import { LineMediaFiles } from './media.js';
import { MessagingApiConnector, type Fetch } from './messaging-api.js';
import type { LineOaConfig } from './oa-config.js';
import { LineStore } from './store.js';

// Opens the committee's official LINE account for the mail routes (2026-10-28): its state file, the push
// adapter when line.json has "send", and the feed from the existing receiver.

export interface CommitteeLine {
  store: LineStore;
  connector: LinePushConnector;
  feed: LineFeed;
  /** The official account's history file (2026-11-02), when line.json has "history". */
  history: LineHistoryImporter | null;
  /** Images for sending (2026-11-02). */
  media: LineMediaFiles;
  files: LineAttachmentFiles;
  /** Received images, read from the receiver (2026-11-04). */
  inboundImages: InboundImageSource;
}

/** A connector that never sends: LINE is read-only without a channel access token. */
const readOnly: LinePushConnector = {
  kind: 'messaging_api',
  push: async () => ({ kind: 'rejected', httpStatus: 401, reason: 'not_configured' }),
};

export class LineFileRefused extends Error {}

/** Never rewrites a file it cannot read: LINE stays off until the file is restored. */
export function openCommitteeLine(cfg: LineOaConfig, opts: { fetch?: Fetch; connector?: LinePushConnector; now?: () => number } = {}): CommitteeLine {
  const stored = LineStore.inspect(cfg.dataFile);
  if (stored.kind === 'invalid') throw new LineFileRefused('LINE の保存ファイル（line-state.json）を読み込めないため、LINE は無効のまま起動しました。ファイルは変更していません。');
  const state = committeeLineState(stored.kind === 'ok' ? stored.state : null, cfg);
  const store = new LineStore(state, cfg.dataFile);
  try {
    store.replace(state);
  } catch {
    throw new LineFileRefused('LINE の保存ファイル（line-state.json）を書き込めないため、LINE は無効のまま起動しました。');
  }
  const connector = opts.connector ?? (cfg.send ? new MessagingApiConnector(cfg.send.accessToken, cfg.send.apiBase, opts.fetch) : readOnly);
  const account = state.accounts.find((a) => a.id === cfg.account.id)!;
  const feed = new LineFeed({
    store,
    account: { id: account.id, destination: account.destination! },
    receiver: cfg.receiver,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const history = cfg.history
    ? new LineHistoryImporter({ store, accountId: account.id, file: cfg.history.file, pollSeconds: cfg.receiver.pollSeconds, ...(opts.now ? { now: opts.now } : {}) })
    : null;
  const inboundImages = new ReceiverImages(cfg.receiver, cfg.inboundMediaDir, opts.fetch, opts.now);
  return { store, connector, feed, history, media: new LineMediaFiles(cfg.mediaDir), files: new LineAttachmentFiles(cfg.filesDir), inboundImages };
}
