import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HandlingStatus } from '../../shared/api.js';
import { SIGN_IN_MAIL_SUBJECT } from '../mailbox/restricted.js';
import type { MailboxRuntime } from '../mailbox/routes.js';
import type { RentalRuntime } from '../rental/routes.js';
import type { RentalSummary, OverviewItem } from '../rental/store.js';
import { MAX_SKEW_MS, verifySignature } from '../tasks/signing.js';
import type { TaskRuntime } from '../tasks/routes.js';

// Read-only data source of IyakusaiBot (../docs/contracts/bot-datasource.md): the Bot host posts a signed
// request every few minutes and answers /ask from what comes back (the rental ledger, and the handling state of
// the committee mailbox). svc-auth/v1 with a key of its own (client "iyakusai-bot-datasource", no actor), so a
// leak reveals no other secret and can only read. Every failure is the same 401, so a caller learns nothing.
//
//   POST /v1/bot/datasource    {"sources":["rental","mailbox"]}    (1 or 2 distinct sources, 1 KB at most)

export const BOT_DATASOURCE_PATH = '/v1/bot/datasource';
export const BOT_DATASOURCE_CLIENT = 'iyakusai-bot-datasource';
export const MAX_REQUEST_BYTES = 1024;
export const MAX_MESSAGES = 5000;
const MAX_NONCES = 1024;
const SOURCES = ['rental', 'mailbox'] as const;
type Source = (typeof SOURCES)[number];
const UNKNOWN_PERSON = '（不明）';
const REJECTED = { error: 'rejected' };

export interface BotDatasourceRuntime {
  key: Buffer;
  rental: RentalRuntime | null;
  mailbox: MailboxRuntime | null;
  tasks: TaskRuntime | null;
  /** Roster name of an account, or null (never a student ID or login ID). */
  displayName: (userId: string) => string | null;
  now?: () => number;
}

export interface BotMailMessage {
  id: string;
  threadId: string;
  mailboxIds: string[];
  subject: string;
  fromName: string | null;
  sentAt: string;
  receivedAt: string;
  status: HandlingStatus;
  assignee: string | null;
  labels: string[];
  attachments: number;
  notes: { author: string; at: string; body: string }[];
  taskIds: string[];
}

export interface BotDatasourceResponse {
  version: 1;
  generatedAt: string;
  rental: { summary: RentalSummary; items: OverviewItem[] } | null;
  mailbox: { mailboxes: { id: string; name: string; threads: number; unhandled: number }[]; messages: BotMailMessage[] } | null;
}

/** The sender's display name only: none when it is absent or is itself an address (no address is handed over). */
const senderName = (name: string | null): string | null => (name && !/\S@\S/.test(name) ? name : null);

/** Task IDs made from each mail message (the Task service numbers are the Bot's own). */
function mailTaskIds(tasks: TaskRuntime | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const link of tasks?.links.current.links ?? []) {
    if (link.source.kind !== 'mail') continue;
    const ids = out.get(link.source.id) ?? [];
    if (!ids.includes(link.taskId)) ids.push(link.taskId);
    out.set(link.source.id, ids);
  }
  return out;
}

function mailboxView(rt: BotDatasourceRuntime, mail: MailboxRuntime): NonNullable<BotDatasourceResponse['mailbox']> {
  const configured = mail.config.mailboxes.map((m) => m.id);
  const counts = mail.store.mailboxCounts();
  const taskIds = mailTaskIds(rt.tasks);
  const names = new Map<string, string>();
  const personName = (userId: string) => {
    let name = names.get(userId);
    if (name === undefined) {
      name = rt.displayName(userId) ?? UNKNOWN_PERSON;
      names.set(userId, name);
    }
    return name;
  };
  const { messages, notes, links } = mail.store.handlingOverview(configured, MAX_MESSAGES);
  return {
    mailboxes: mail.config.mailboxes.map((m) => ({ id: m.id, name: m.name, threads: counts.get(m.id)?.threads ?? 0, unhandled: counts.get(m.id)?.unhandled ?? 0 })),
    messages: messages.map((m) => {
      const linked = new Set(links.get(m.id));
      return {
        id: m.id,
        threadId: m.thread_id,
        mailboxIds: configured.filter((id) => linked.has(id)),
        // The Bot answers in the open: sign-in mail never gives its subject (restricted.ts).
        subject: m.sign_in ? SIGN_IN_MAIL_SUBJECT : m.subject,
        fromName: senderName(m.from_name),
        sentAt: m.sent_at,
        receivedAt: m.received_at,
        status: m.status,
        assignee: m.assignee_id ? personName(m.assignee_id) : null,
        labels: JSON.parse(m.labels_json) as string[],
        attachments: m.attachments,
        notes: (notes.get(m.id) ?? []).map((n) => ({ author: personName(n.author_id), at: n.created_at, body: n.body })),
        taskIds: taskIds.get(m.id) ?? [],
      };
    }),
  };
}

function parseSources(text: string): Set<Source> {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).join() !== 'sources') throw new Error('REJECTED');
  const sources = (value as { sources: unknown }).sources;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > SOURCES.length || sources.some((s) => !SOURCES.includes(s as Source)) || new Set(sources).size !== sources.length) {
    throw new Error('REJECTED');
  }
  return new Set(sources as Source[]);
}

/**
 * Registers the signed, read-only `POST /v1/bot/datasource`. Nonces are remembered in this process only
 * (a restart forgets them; the route changes nothing), for as long as their timestamp is still accepted.
 */
export function attachBotDatasource(app: FastifyInstance, rt: BotDatasourceRuntime): void {
  const now = rt.now ?? Date.now;
  const nonces = new Map<string, number>();

  /** Spends a nonce once; false when it was seen or the memory is full. */
  function spend(nonce: string, timestamp: number, at: number): boolean {
    for (const [seen, expires] of nonces) if (expires <= at) nonces.delete(seen);
    if (nonces.has(nonce) || nonces.size >= MAX_NONCES) return false;
    nonces.set(nonce, Math.max(at + 60_001, timestamp + MAX_SKEW_MS + 1));
    return true;
  }

  /** Checks the svc-auth/v1 signature and the body, then spends the nonce. Throws on anything else. */
  function verified(request: FastifyRequest): Set<Source> {
    if (request.headers.origin !== undefined || request.url !== BOT_DATASOURCE_PATH || !Buffer.isBuffer(request.body)) throw new Error('REJECTED');
    const raw = request.raw.rawHeaders;
    const seen = new Set<string>();
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i]!.toLowerCase();
      if (k.startsWith('x-svc-')) {
        if (seen.has(k)) throw new Error('REJECTED');
        seen.add(k);
      }
    }
    const read = (name: string) => {
      const v = request.headers[name];
      if (typeof v !== 'string') throw new Error('REJECTED');
      return v;
    };
    const client = read('x-svc-client');
    const timestamp = read('x-svc-timestamp');
    const nonce = read('x-svc-nonce');
    const signature = read('x-svc-signature');
    const actor = request.headers['x-svc-actor'] ?? '';
    const allowed = ['x-svc-client', 'x-svc-timestamp', 'x-svc-nonce', 'x-svc-actor', 'x-svc-signature'];
    const at = now();
    if (client !== BOT_DATASOURCE_CLIENT || actor !== '' || !/^\d{13}$/.test(timestamp) || Math.abs(at - Number(timestamp)) > MAX_SKEW_MS || !/^[-_A-Za-z0-9]{24,128}$/.test(nonce) || [...seen].some((k) => !allowed.includes(k))) {
      throw new Error('REJECTED');
    }
    const body = request.body;
    const text = body.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(body) || !verifySignature(rt.key, { client, method: 'POST', path: BOT_DATASOURCE_PATH, timestamp, nonce, actor: '', body: text }, signature)) throw new Error('REJECTED');
    const sources = parseSources(text);
    // Only a signed request reaches the nonce table, so strangers cannot fill it.
    if (!spend(nonce, Number(timestamp), at)) throw new Error('REJECTED');
    return sources;
  }

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: MAX_REQUEST_BYTES }, (_request, body, done) => done(null, body));
    // A body over the limit, another content type or a broken body is refused like any other bad request.
    scope.setErrorHandler((error, _request, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== undefined && status >= 400 && status < 500) return reply.code(401).send(REJECTED);
      return reply.code(500).send({ error: 'internal', message: 'サーバー内部でエラーが発生しました。' });
    });
    scope.post(BOT_DATASOURCE_PATH, { bodyLimit: MAX_REQUEST_BYTES }, async (request, reply) => {
      let sources: Set<Source>;
      try {
        sources = verified(request);
      } catch {
        return reply.code(401).send(REJECTED);
      }
      const response: BotDatasourceResponse = {
        version: 1,
        generatedAt: new Date(now()).toISOString(),
        rental: sources.has('rental') && rt.rental ? { summary: rt.rental.store.summary(), items: rt.rental.store.overview().items } : null,
        mailbox: sources.has('mailbox') && rt.mailbox ? mailboxView(rt, rt.mailbox) : null,
      };
      // The path is not under /api/, so the app's no-store rule does not cover it.
      return reply.header('Cache-Control', 'no-store').send(response);
    });
  });
}
