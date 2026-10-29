import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { verifyBytesSignature } from '../tasks/signing.js';
import type { CommitteeAddresses } from './addresses.js';
import type { MailboxConfig, MailboxDefinition } from './config.js';
import { MAX_RAW_BYTES, MailParseError, parseRawMail, type ParsedMail } from './parse.js';
import type { MailboxStore, MailSource } from './store.js';

// The only way mail enters the mailbox: the collector (Google Apps Script on the committee's own
// accounts) posts one raw message per request, signed with svc-auth/v1 (client "mail-collector") over
// the path with its query and the SHA-256 of the raw bytes. Read-only towards Gmail by contract: the app
// never sends, moves, deletes or marks mail.
//
//   POST /v1/mail/ingest?source=collector|backfill&id=<Gmail message ID>&at=<received, epoch ms>
//   Content-Type: message/rfc822
//
// source=collector: the collector account (iyakusai@) - everything it received is shown; mail that names
//   no committee address goes to that account's own mailbox.
// source=backfill: past mail from one member's account (once) - shown only when a committee address is in
//   To, Cc or From, or it came through a committee group (List-Id or the group's leading subject tag);
//   anything else is answered "skipped" and not stored.
// Either way, a mailbox that forwards to others (a group inside a group) brings them in too.

export const INGEST_PATH = '/v1/mail/ingest';
const CLIENT = 'mail-collector';
const MAX_SKEW_MS = 5 * 60_000;

export function routeMailboxes(addresses: CommitteeAddresses, config: MailboxConfig, source: MailSource, p: ParsedMail): MailboxDefinition[] {
  const named = [p.from.address, ...p.to.map((a) => a.address), ...p.cc.map((a) => a.address)];
  if (source === 'collector') {
    // Delivered-To names the collector account itself for every message, so it never decides alone.
    const delivered = p.deliveredTo.filter((a) => addresses.ofAddress(a)?.id !== addresses.catchAll.id);
    const found = addresses.withForwards([...addresses.matching([...named, ...delivered], p.listIds), ...addresses.ofSubject(p.subject)]);
    return found.length > 0 ? found : [addresses.catchAll];
  }
  const groups = config.backfillUseGroupDelivery ? [...addresses.matching([], p.listIds), ...addresses.ofSubject(p.subject)] : [];
  return addresses.withForwards([...addresses.matching(named), ...groups]);
}

export interface IngestRuntime {
  store: MailboxStore;
  config: MailboxConfig;
  addresses: CommitteeAddresses;
  now?: () => number;
}

export function attachMailIngest(app: FastifyInstance, rt: IngestRuntime): void {
  const now = rt.now ?? Date.now;
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('message/rfc822', { parseAs: 'buffer', bodyLimit: MAX_RAW_BYTES }, (_request, body, done) => done(null, body));
    scope.post(INGEST_PATH, { bodyLimit: MAX_RAW_BYTES }, async (request, reply) => {
      const rejected = () => reply.code(401).send({ error: 'rejected', message: 'Mail ingest request rejected' });
      const body = request.body;
      const url = request.url;
      const query = /^\/v1\/mail\/ingest\?source=(collector|backfill)&id=([A-Za-z0-9_-]{1,64})&at=(\d{13})$/.exec(url);
      if (request.headers.origin !== undefined || !query || !Buffer.isBuffer(body)) return rejected();
      const raw = request.raw.rawHeaders;
      const seen = new Set<string>();
      for (let i = 0; i < raw.length; i += 2) {
        const k = raw[i]!.toLowerCase();
        if (!k.startsWith('x-svc-')) continue;
        if (seen.has(k)) return rejected();
        seen.add(k);
      }
      const header = (name: string) => (typeof request.headers[name] === 'string' ? (request.headers[name] as string) : null);
      const client = header('x-svc-client');
      const timestamp = header('x-svc-timestamp');
      const nonce = header('x-svc-nonce');
      const signature = header('x-svc-signature');
      const actor = header('x-svc-actor') ?? '';
      const allowed = ['x-svc-client', 'x-svc-timestamp', 'x-svc-nonce', 'x-svc-actor', 'x-svc-signature'];
      if (client !== CLIENT || actor !== '' || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > MAX_SKEW_MS || !nonce || !/^[-_A-Za-z0-9]{24,128}$/.test(nonce) || !signature || [...seen].some((k) => !allowed.includes(k))) {
        return rejected();
      }
      if (!verifyBytesSignature(rt.config.ingestKey, { client, method: 'POST', path: url, timestamp, nonce, actor: '' }, body, signature)) return rejected();
      // A nonce is accepted once (durably), so a captured request cannot be replayed.
      const digest = createHmac('sha256', rt.config.ingestKey).update(JSON.stringify(['mail-ingest-replay', client, nonce])).digest('hex');
      if (!rt.store.acceptNonce(digest, Math.max(now(), Number(timestamp)) + MAX_SKEW_MS + 1000, now())) return rejected();

      const source = query[1] as MailSource;
      const providerId = query[2]!;
      const receivedAt = new Date(Number(query[3])).toISOString();
      const known = rt.store.sourceMessage(source, providerId);
      if (known) return { status: 'duplicate', mailboxes: [] };
      let parsed: ParsedMail;
      try {
        parsed = await parseRawMail(body);
      } catch (err) {
        // The collector records the message as not taken and moves on; nothing about the content is logged.
        if (err instanceof MailParseError) return reply.code(422).send({ error: 'unparseable', message: 'メールを解析できませんでした。' });
        throw err;
      }
      const mailboxes = routeMailboxes(rt.addresses, rt.config, source, parsed);
      if (mailboxes.length === 0) return { status: 'skipped', mailboxes: [] };
      const outcome = rt.store.store({ source, providerId, receivedAt, parsed, mailboxIds: mailboxes.map((m) => m.id), now: new Date(now()).toISOString() });
      return { status: outcome.status, mailboxes: mailboxes.map((m) => m.id) };
    });
  });
}
