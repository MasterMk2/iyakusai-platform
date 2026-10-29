import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HANDLING_STATUSES, LIMITS } from '../../shared/api.js';
import type { InboxResponse } from '../../shared/line.js';
import { MAIL_ATTACHMENTS_MAX, MAIL_BODY_MAX, MAIL_SUBJECT_MAX, REAUTH_REQUIRED, type MailSendOptions, type MailStatusResponse } from '../../shared/mailbox.js';
import { registerContactRoutes } from '../contacts/routes.js';
import { ContactsStore } from '../contacts/store.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';
import { registerLineRoutes } from '../http/line-routes.js';
import { LineFileRefused, openCommitteeLine, type CommitteeLine } from '../line/committee-runtime.js';
import type { LinePushConnector } from '../line/connector.js';
import type { Fetch } from '../line/messaging-api.js';
import { collectLineItems, lineLabelFacets, namesFrom } from '../line/queries.js';
import type { CommitteeAddresses } from './addresses.js';
import type { OutgoingAttachment } from './compose.js';
import type { MailboxConfig, MailSendConfig } from './config.js';
import { attachMailIngest } from './ingest.js';
import { MailSender } from './send.js';
import { MailboxService, type People } from './service.js';
import { smtpTransport, type MailTransport } from './smtp.js';
import type { MailboxStore } from './store.js';

// Browser routes of the committee mailbox (Discord login). The same paths and answers as the synthetic
// inbox, so the existing screens work, plus the status, re-entry and edit-grant routes. Every mail route
// first checks the signed-in account, the trial list and the idle limit: after `idleHours` without mail
// use on a device, mail opens only after the password is typed again on it (POST /api/auth/reauth).
// Sending (2026-10-26) exists only when the configuration has "send"; it needs a send grant on the From mailbox.

export interface MailboxRuntime {
  store: MailboxStore;
  config: MailboxConfig;
  addresses: CommitteeAddresses;
  /** Replaces SMTP (tests). */
  transport?: MailTransport;
  /** Replaces the contacts file next to mail.sqlite3 (tests). */
  contacts?: ContactsStore;
  /** Replace LINE's HTTP (the receiver and the Messaging API) or its push connector (tests). */
  lineFetch?: Fetch;
  lineConnector?: LinePushConnector;
}

/** The sign-in of one request, as the Discord login resolved it (server-side only). */
export interface MailSession {
  sessionKey: string;
  passwordAt: number;
  discordUserId: string;
}

export interface MailboxRouteDeps {
  requireUser: (request: FastifyRequest) => User;
  session: (request: FastifyRequest) => MailSession | null;
  people: People;
  /** Discord ID of an account (the trial list names Discord accounts). */
  discordUserIdOf: (userId: string) => string | null;
  clock: () => string;
  now?: () => number;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
}

/** Mail as a source of committee tasks (the task routes check it before linking or showing a task's origin). */
export interface MailCaseSource {
  readable(user: User, messageId: string): boolean;
  provenance(user: User, messageId: string): { label: string; href: string } | null;
}

const shortId = z.string().min(1).max(40).regex(/^[a-z0-9-]+$/);
const messageParams = z.strictObject({ receiptId: z.string().regex(/^rc_[0-9a-f]{16}$/) });
const threadParams = z.strictObject({ threadId: z.string().regex(/^th_[0-9a-f]{16}$/) });
const attachmentParams = z.strictObject({ receiptId: z.string().regex(/^rc_[0-9a-f]{16}$/), attachmentId: z.string().regex(/^att\d{1,3}$/) });
const page = { page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(20) };
const filters = {
  mailboxId: shortId.optional(),
  q: z.string().max(LIMITS.queryMaxLength).optional(),
  status: z.enum(HANDLING_STATUSES).optional(),
  label: z.string().min(1).max(LIMITS.labelMaxLength).optional(),
  assignee: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).optional(),
};
const threadQuery = z.strictObject({ ...filters, ...page });
const inboxQuery = z.strictObject({ ...filters, ...page, source: z.enum(['all', 'email', 'line']).default('all'), lineAccountId: shortId.optional() });
const labelQuery = z.strictObject({ mailboxId: shortId.optional(), lineAccountId: shortId.optional() });
const triageBody = z
  .strictObject({
    expectedVersion: z.number().int().min(1),
    status: z.enum(HANDLING_STATUSES).optional(),
    assigneeId: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).nullable().optional(),
    labels: z.array(z.string().max(200)).max(50).optional(),
  })
  .refine((b) => b.status !== undefined || b.assigneeId !== undefined || b.labels !== undefined, { message: '変更内容がありません' });
const threadStatusBody = z.strictObject({ status: z.enum(HANDLING_STATUSES) });
const noteBody = z.strictObject({ body: z.string().max(LIMITS.noteMaxLength * 2) });
// eslint-disable-next-line no-control-regex
const department = z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f・]+$/);
// A person (userId) or a department, and one of edit / send.
const grantBody = z
  .strictObject({
    userId: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).optional(),
    department: department.optional(),
    mailboxId: shortId,
    edit: z.boolean().optional(),
    send: z.boolean().optional(),
  })
  .refine((b) => (b.edit === undefined) !== (b.send === undefined), { message: 'edit か send のどちらか 1 つを指定してください' })
  .refine((b) => (b.userId === undefined) !== (b.department === undefined), { message: 'userId か department のどちらか 1 つを指定してください' });
const recipientList = z.array(z.string().max(400)).max(100);
const sendBody = z.strictObject({
  clientToken: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  mailboxId: shortId,
  to: recipientList,
  cc: recipientList,
  bcc: recipientList,
  subject: z.string().max(MAIL_SUBJECT_MAX * 2),
  body: z.string().max(MAIL_BODY_MAX * 2),
  replyToReceiptId: z.string().regex(/^rc_[0-9a-f]{16}$/).nullable(),
  markThreadDone: z.boolean(),
  // Optional: screens opened before 2026-10-26 do not send it.
  replyTo: z.string().max(400).nullable().optional(),
});

// eslint-disable-next-line no-control-regex
const FILENAME_CONTROL = /[\u0000-\u001f\u007f]/g;
const attachmentName = (name: string | undefined) => (name ?? '').replace(FILENAME_CONTROL, '').replace(/[\\/]/g, '_').trim().slice(0, 200) || 'attachment';
const attachmentType = (type: string | undefined) => {
  const t = (type ?? '').toLowerCase().trim();
  return /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(t) ? t : 'application/octet-stream';
};

/** Multipart errors of the send form, as validation answers the screen shows. */
function sendFormError(err: unknown, send: MailSendConfig): never {
  if (err instanceof DomainError || err instanceof HttpError) throw err;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
    throw new DomainError('validation', `添付ファイルは ${MAIL_ATTACHMENTS_MAX} 個・合わせて ${Math.floor(send.maxAttachmentBytes / 1024 / 1024)} MB までです。`, { field: 'attachments' });
  }
  throw new DomainError('validation', '送信データを読み取れませんでした。画面を読み込み直してから、もう一度送ってください。');
}

const USE_RECORD_INTERVAL_MS = 60_000;
const FORGET_USE_AFTER_MS = 15 * 86_400_000;

export function registerMailboxRoutes(app: FastifyInstance, rt: MailboxRuntime, deps: MailboxRouteDeps): { service: MailboxService; cases: MailCaseSource } {
  const service = new MailboxService(rt.store, rt.addresses, deps.people, rt.config.send?.mailboxIds ?? null);
  const sendConfig = rt.config.send;
  const sender = sendConfig ? new MailSender(rt.store, rt.addresses, { ...rt.config, send: sendConfig }, rt.transport ?? smtpTransport(sendConfig.smtp), service) : null;
  const now = deps.now ?? Date.now;
  const idleMs = rt.config.idleHours * 3_600_000;
  const preview = new Set(rt.config.previewDiscordUserIds);
  const opens = (discordUserId: string) => preview.size === 0 || preview.has(discordUserId);

  attachMailIngest(app, { store: rt.store, config: rt.config, addresses: rt.addresses, now });

  // Committee contacts (2026-10-26): their own file in the mail folder, with the same people and sign-in. They
  // start here because the Discord login hands the mailbox its people and sessions; the shared server files
  // (http/app.ts, runtime.ts) stay as they are deployed.
  // A contacts file that cannot be opened turns off the contacts only (503), never the mailbox.
  let contacts: ContactsStore | null = rt.contacts ?? null;
  if (!contacts) {
    try {
      const opened = new ContactsStore(rt.config.dataDir);
      contacts = opened;
      app.addHook('onClose', async () => opened.close());
    } catch {
      contacts = null;
    }
  }
  registerContactRoutes(app, contacts, { requireUser: deps.requireUser, session: deps.session, people: deps.people, discordUserIdOf: deps.discordUserIdOf, clock: deps.clock, parse: deps.parse });

  // The official LINE account (2026-10-28), when line.json is next to the mail configuration. It shares the mail
  // screens' sign-in, trial list and idle limit, and shows in the same inbox. A state file that cannot be read
  // turns off LINE only, never the mailbox.
  let line: CommitteeLine | null = null;
  if (rt.config.line) {
    try {
      line = openCommitteeLine(rt.config.line, { ...(rt.lineFetch ? { fetch: rt.lineFetch } : {}), ...(rt.lineConnector ? { connector: rt.lineConnector } : {}), now });
    } catch (err) {
      if (!(err instanceof LineFileRefused)) throw err;
      console.error(err.message);
    }
  }
  if (line) {
    const opened = line;
    registerLineRoutes(app, {
      line: { store: opened.store, connector: opened.connector, seed: () => opened.store.current },
      mail: {
        get current() {
          return { users: deps.people.list() };
        },
      },
      clock: deps.clock,
      demo: false,
      parse: deps.parse,
      requireUser: (request) => reader(request, true),
      requireDemoAdmin: () => {
        throw notFound();
      },
      committee: { people: () => deps.people.list() },
    });
    opened.feed.start();
    app.addHook('onClose', async () => opened.feed.stop());
  }
  const lineNames = () => namesFrom({ users: deps.people.list() });

  function signedIn(request: FastifyRequest): { user: User; session: MailSession } {
    const user = deps.requireUser(request);
    const session = deps.session(request);
    if (!session || user.disabled) throw new DomainError('unauthenticated', 'ログインしてください。');
    return { user, session };
  }

  const idle = (session: MailSession, at: number) => at - Math.max(session.passwordAt, rt.store.lastUse(session.sessionKey) ?? 0) > idleMs;

  /** The mail reader of this request. `use` marks mail as used on this device (lists, mail, edits). */
  function reader(request: FastifyRequest, use: boolean): User {
    const { user, session } = signedIn(request);
    if (!opens(session.discordUserId)) throw notFound();
    const at = now();
    if (idle(session, at)) {
      throw new HttpError(401, { error: REAUTH_REQUIRED, message: `メールを開くには、パスワードをもう一度入力してください（この端末で ${rt.config.idleHours} 時間メールを使っていなかったため）。` });
    }
    if (use && at - (rt.store.lastUse(session.sessionKey) ?? 0) > USE_RECORD_INTERVAL_MS) rt.store.recordUse(session.sessionKey, at, at - FORGET_USE_AFTER_MS);
    return user;
  }

  function administrator(request: FastifyRequest): User {
    const { user } = signedIn(request);
    if (!user.canManageAccess) throw new DomainError('forbidden', '受信箱の権限を扱えるのは権限管理者だけです。');
    return user;
  }

  app.get('/api/mail/status', async (request): Promise<MailStatusResponse> => {
    const { session } = signedIn(request);
    const canOpen = opens(session.discordUserId);
    const reauthRequired = canOpen && idle(session, now());
    return { enabled: true, canOpen, reauthRequired, idleHours: rt.config.idleHours, unhandledTotal: canOpen && !reauthRequired ? service.unhandledTotal() : null };
  });

  // Mailbox names and counts (home screen and side bar): needs the idle limit, but is not mail use.
  app.get('/api/mailboxes', async (request) => {
    const { session } = signedIn(request);
    if (!opens(session.discordUserId)) return [];
    return service.mailboxSummaries(reader(request, false));
  });

  app.get('/api/threads', async (request) => {
    const user = reader(request, true);
    return service.listThreads(user, deps.parse(threadQuery, request.query));
  });

  app.get('/api/inbox', async (request): Promise<InboxResponse> => {
    const user = reader(request, true);
    const q = deps.parse(inboxQuery, request.query);
    if (q.mailboxId !== undefined && q.lineAccountId !== undefined) throw new DomainError('validation', '受信箱と LINE アカウントは同時に指定できません');
    if (q.lineAccountId !== undefined && !line) throw notFound();
    const withMail = q.source !== 'line' && q.lineAccountId === undefined;
    const lineItems =
      line && q.source !== 'email' && q.mailboxId === undefined
        ? collectLineItems(line.store.current, lineNames(), user, { accountId: q.lineAccountId, q: q.q, status: q.status, label: q.label, assignee: q.assignee })
        : [];
    if (lineItems.length === 0) {
      const list = withMail ? service.listThreads(user, q) : { items: [], total: 0 };
      return { items: list.items.map((t) => ({ source: 'email' as const, ...t })), total: list.total, page: q.page, pageSize: q.pageSize, counts: { email: list.total, line: 0 }, lineEnabled: !!line };
    }
    // Both, newest first: the page is cut from the mail that can reach it (the first page x size threads) and LINE.
    const start = (q.page - 1) * q.pageSize;
    const mail = withMail ? service.listThreads(user, { ...q, page: 1, pageSize: start + q.pageSize }) : { items: [], total: 0 };
    const merged: InboxResponse['items'] = [...mail.items.map((t) => ({ source: 'email' as const, ...t })), ...lineItems];
    const latest = (i: InboxResponse['items'][number]) => (i.source === 'email' ? i.latestReceivedAt : i.latestAt);
    merged.sort((a, b) => latest(b).localeCompare(latest(a)));
    return { items: merged.slice(start, start + q.pageSize), total: mail.total + lineItems.length, page: q.page, pageSize: q.pageSize, counts: { email: mail.total, line: lineItems.length }, lineEnabled: true };
  });

  app.get('/api/inbox/labels', async (request) => {
    const user = reader(request, false);
    const q = deps.parse(labelQuery, request.query);
    if (q.lineAccountId !== undefined && !line) throw notFound();
    const mail = q.lineAccountId === undefined ? service.labelFacets(user, q.mailboxId) : [];
    if (!line || q.mailboxId !== undefined) return mail;
    const counts = new Map(mail.map((f) => [f.label, f.count]));
    for (const f of lineLabelFacets(line.store.current, user, q.lineAccountId)) counts.set(f.label, (counts.get(f.label) ?? 0) + f.count);
    return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label, 'ja'));
  });

  app.get('/api/labels', async (request) => {
    const user = reader(request, false);
    const { mailboxId } = deps.parse(z.strictObject({ mailboxId: shortId.optional() }), request.query);
    return service.labelFacets(user, mailboxId);
  });

  app.get('/api/threads/:threadId', async (request) => {
    const user = reader(request, true);
    const { threadId } = deps.parse(threadParams, request.params);
    return service.getThread(user, threadId);
  });

  app.patch('/api/threads/:threadId/status', async (request) => {
    const user = reader(request, true);
    const { threadId } = deps.parse(threadParams, request.params);
    const { status } = deps.parse(threadStatusBody, request.body);
    return service.setThreadStatus(user, threadId, status, deps.clock());
  });

  app.get('/api/receipts/:receiptId', async (request) => {
    const user = reader(request, true);
    const { receiptId } = deps.parse(messageParams, request.params);
    return service.getReceipt(user, receiptId);
  });

  app.get('/api/receipts/:receiptId/attachments/:attachmentId', async (request, reply) => {
    const user = reader(request, true);
    const { receiptId, attachmentId } = deps.parse(attachmentParams, request.params);
    const attachment = service.attachment(user, receiptId, attachmentId);
    // Always a download, never rendered by the app's origin.
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="attachment.bin"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.send(attachment.content);
  });

  app.get('/api/receipts/:receiptId/assignees', async (request) => {
    const user = reader(request, true);
    const { receiptId } = deps.parse(messageParams, request.params);
    return service.assigneeCandidates(user, receiptId);
  });

  app.patch('/api/receipts/:receiptId/triage', async (request) => {
    const user = reader(request, true);
    const { receiptId } = deps.parse(messageParams, request.params);
    return service.updateTriage(user, receiptId, deps.parse(triageBody, request.body), deps.clock());
  });

  app.post('/api/receipts/:receiptId/notes', async (request, reply) => {
    const user = reader(request, true);
    const { receiptId } = deps.parse(messageParams, request.params);
    const { body } = deps.parse(noteBody, request.body);
    return reply.code(201).send(service.addNote(user, receiptId, body, deps.clock()));
  });

  // ---- edit grants (access administrators). Names and grants only, no mail content.
  app.get('/api/mail/admin/access', async (request) => {
    administrator(request);
    return service.accessMatrix();
  });

  app.put('/api/mail/admin/access', async (request) => {
    const user = administrator(request);
    const body = deps.parse(grantBody, request.body);
    if (body.department !== undefined) {
      const kind = body.send !== undefined ? 'send' : 'edit';
      return service.setDepartmentGrant(user, body.department, body.mailboxId, kind, (body.send ?? body.edit)!, deps.clock());
    }
    if (body.send !== undefined) return service.setSendGrant(user, body.userId!, body.mailboxId, body.send, deps.clock());
    return service.setGrant(user, body.userId!, body.mailboxId, body.edit!, deps.clock());
  });

  // ---- sending (only with "send" in the configuration)

  // What this person can send: names and addresses only, so it is not mail use (like the mailbox list).
  app.get('/api/mail/send/options', async (request): Promise<MailSendOptions> => {
    const user = reader(request, false);
    if (!sender) return { enabled: false, from: [], fromName: '', bcc: null, maxAttachmentBytes: 0, maxRecipients: 0, senderName: user.displayName };
    return sender.options(user);
  });

  // One message: the "message" part (JSON, MailSendRequest) and up to ten "attachments" files.
  if (sender && sendConfig) {
    void app.register(async (scope) => {
      await scope.register(multipart, {
        limits: { fileSize: sendConfig.maxAttachmentBytes, files: MAIL_ATTACHMENTS_MAX, fields: 1, fieldSize: 512 * 1024, parts: MAIL_ATTACHMENTS_MAX + 1 },
      });
      scope.post('/api/mail/send', { bodyLimit: sendConfig.maxAttachmentBytes + 1024 * 1024 }, async (request) => {
        const user = reader(request, true);
        if (!request.isMultipart()) throw new DomainError('validation', 'multipart/form-data 形式で送信してください。');
        let message: unknown;
        const files: OutgoingAttachment[] = [];
        let total = 0;
        try {
          for await (const part of request.parts()) {
            if (part.fieldname === 'message' && part.type === 'field' && message === undefined && !part.valueTruncated) {
              try {
                message = JSON.parse(String(part.value));
              } catch {
                throw new DomainError('validation', '送信データを読み取れませんでした。');
              }
            } else if (part.fieldname === 'attachments' && part.type === 'file') {
              const content = await part.toBuffer();
              total += content.length;
              if (total > sendConfig.maxAttachmentBytes) throw new DomainError('validation', `添付ファイルは合わせて ${Math.floor(sendConfig.maxAttachmentBytes / 1024 / 1024)} MB までです。`, { field: 'attachments' });
              files.push({ filename: attachmentName(part.filename), contentType: attachmentType(part.mimetype), content });
            } else {
              throw new DomainError('validation', '送信フィールドを確認してください。');
            }
          }
        } catch (err) {
          sendFormError(err, sendConfig);
        }
        if (message === undefined) throw new DomainError('validation', '送信データ（message）がありません。');
        return sender.sendMail(user, deps.parse(sendBody, message), files, new Date(now()));
      });
    });
  }

  // Task links show a message's subject; the trial list applies, the idle limit does not (no session here).
  const caseReader = (user: User) => {
    const discordUserId = user.disabled ? null : deps.discordUserIdOf(user.id);
    return !!discordUserId && opens(discordUserId);
  };
  const cases: MailCaseSource = {
    readable: (user, messageId) => caseReader(user) && service.provenance(user, messageId) !== null,
    provenance: (user, messageId) => (caseReader(user) ? service.provenance(user, messageId) : null),
  };
  return { service, cases };
}
