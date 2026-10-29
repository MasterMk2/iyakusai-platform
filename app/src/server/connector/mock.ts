import type { FetchResult, InboundConnector } from './types.js';
import { MOCK_FEED, type MockFeedEntry } from './fixtures.js';

export interface MockConnectorOptions {
  /** Highest fixture batch currently "visible at the provider". */
  releasedBatch(): number;
  /** Source key whose fetch should fail (demo fault injection), or null. */
  failingSourceKey(): string | null;
}

/**
 * Explicit mock inbound connector. It serves only the in-repository synthetic
 * fixture feed and never touches the network, file system, real accounts,
 * browser state or credentials. It has no write operations of any kind.
 */
export class MockInboundConnector implements InboundConnector {
  readonly id = 'mock-inbound';
  readonly kind = 'mock' as const;
  private readonly feed: MockFeedEntry[];
  private readonly options: MockConnectorOptions;

  constructor(options: MockConnectorOptions, feed: MockFeedEntry[] = MOCK_FEED) {
    this.options = options;
    this.feed = feed;
  }

  async fetchSince(sourceMailboxKey: string, cursor: number): Promise<FetchResult> {
    await Promise.resolve();
    if (this.options.failingSourceKey() === sourceMailboxKey) {
      throw new Error('模擬接続エラー: モックコネクターがこの受信箱の取得に失敗しました。');
    }
    const released = this.options.releasedBatch();
    const visible = this.feed.filter((e) => e.sourceKey === sourceMailboxKey && e.batch <= released);
    return { items: visible.slice(cursor).map((e) => structuredClone(e.raw)), nextCursor: visible.length };
  }
}
