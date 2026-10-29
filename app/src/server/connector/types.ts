// Inbound connector boundary. Implementations are read-only by contract:
// there is intentionally no send, reply, move, delete or mark-read operation.
// The only implementation in this test version is MockInboundConnector.

export interface RawAddress {
  name?: string | null;
  address: string;
}

export interface RawInboundMessage {
  providerMessageId: string;
  receivedAt: string;
  deliveredTo: string;
  headers: {
    messageId?: string;
    subject?: string;
    from?: RawAddress;
    to?: RawAddress[];
    cc?: RawAddress[];
    bcc?: RawAddress[];
    date?: string;
    inReplyTo?: string;
    references?: string[];
  };
  rawHeaders?: Record<string, string>;
  text?: string;
  html?: string;
  attachments?: { filename: string; contentType: string; content: string }[];
}

export interface FetchResult {
  items: unknown[];
  nextCursor: number;
}

export interface InboundConnector {
  readonly id: string;
  readonly kind: 'mock';
  /** Fetch messages after `cursor` for one source mailbox. Read-only. */
  fetchSince(sourceMailboxKey: string, cursor: number): Promise<FetchResult>;
}
