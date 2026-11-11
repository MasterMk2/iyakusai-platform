import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAIL_APPROVAL_COMMENT_MAX, MAIL_APPROVAL_NOTE_MAX, MAIL_ATTACHMENTS_MAX, MAIL_BODY_MAX, MAIL_SUBJECT_MAX } from '../../shared/mailbox.js';
import { DUE_DATE_PATTERN } from '../../shared/mailDue.js';
import type { User } from '../domain/types.js';
import { attachmentDisposition } from '../http/content-disposition.js';
import type { MailApprovals } from './approval.js';
import type { OutgoingAttachment } from './compose.js';

// Routes of the approval before sending (2026-11-11). They exist only when sending is set up, and pass the same
// gate as the other mail routes (sign-in, the trial list, the idle limit).

export interface ApprovalRouteDeps {
  approvals: MailApprovals;
  /** The mail reader of this request (routes.ts); `use` marks mail as used on this device. */
  reader: (request: FastifyRequest, use: boolean) => User;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
  now: () => number;
  /** The "message" part and the files of a multipart send form (routes.ts). */
  readForm: (request: FastifyRequest) => Promise<{ message: unknown; files: OutgoingAttachment[] }>;
}

const requestParams = z.strictObject({ id: z.string().regex(/^ar_[0-9a-f]{16}$/) });
const attachmentParams = z.strictObject({ id: z.string().regex(/^ar_[0-9a-f]{16}$/), idx: z.coerce.number().int().min(0).max(MAIL_ATTACHMENTS_MAX - 1) });
const recipientList = z.array(z.string().max(400)).max(100);
const mail = {
  to: recipientList,
  cc: recipientList,
  bcc: recipientList,
  subject: z.string().max(MAIL_SUBJECT_MAX * 2),
  body: z.string().max(MAIL_BODY_MAX * 2),
};
const version = z.number().int().min(1);
const submitBody = z.strictObject({
  ...mail,
  clientToken: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  mailboxId: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/),
  replyToReceiptId: z.string().regex(/^rc_[0-9a-f]{16}$/).nullable(),
  markThreadDone: z.boolean(),
  replyTo: z.string().max(400).nullable().optional(),
  replyDue: z.string().regex(DUE_DATE_PATTERN).nullable().optional(),
  note: z.string().max(MAIL_APPROVAL_NOTE_MAX * 2),
  expectedVersion: version.optional(),
  keepAttachments: z.array(z.number().int().min(0).max(MAIL_ATTACHMENTS_MAX - 1)).max(MAIL_ATTACHMENTS_MAX).optional(),
});
const editBody = z.strictObject({ ...mail, expectedVersion: version, replyTo: z.string().max(400).nullable(), replyDue: z.string().regex(DUE_DATE_PATTERN).nullable() });
const versionBody = z.strictObject({ expectedVersion: version });
const returnBody = z.strictObject({ expectedVersion: version, comment: z.string().max(MAIL_APPROVAL_COMMENT_MAX * 2) });

/** The routes with a JSON body or none. */
export function registerApprovalRoutes(app: FastifyInstance, deps: ApprovalRouteDeps): void {
  const { approvals, reader, parse } = deps;
  const at = () => new Date(deps.now());

  app.get('/api/mail/approvals', async (request) => approvals.list(reader(request, true), at()));

  app.get('/api/mail/approvals/:id', async (request) => {
    const user = reader(request, true);
    return approvals.get(user, parse(requestParams, request.params).id, at());
  });

  app.get('/api/mail/approvals/:id/attachments/:idx', async (request, reply) => {
    const user = reader(request, true);
    const { id, idx } = parse(attachmentParams, request.params);
    const file = approvals.attachment(user, id, idx);
    // Always a download, never rendered by the app's origin (as the attachments of received mail).
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', attachmentDisposition(file.filename, 'attachment.bin'));
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.send(file.content);
  });

  app.patch('/api/mail/approvals/:id', async (request) => {
    const user = reader(request, true);
    return approvals.edit(user, parse(requestParams, request.params).id, parse(editBody, request.body), at());
  });

  app.post('/api/mail/approvals/:id/approve', async (request) => {
    const user = reader(request, true);
    return approvals.approve(user, parse(requestParams, request.params).id, parse(versionBody, request.body).expectedVersion, at());
  });

  app.post('/api/mail/approvals/:id/return', async (request) => {
    const user = reader(request, true);
    const body = parse(returnBody, request.body);
    return approvals.returnToAuthor(user, parse(requestParams, request.params).id, body.expectedVersion, body.comment, at());
  });

  app.post('/api/mail/approvals/:id/withdraw', async (request) => {
    const user = reader(request, true);
    return approvals.withdraw(user, parse(requestParams, request.params).id, parse(versionBody, request.body).expectedVersion, at());
  });
}

/** The two routes that carry files: registered in the scope that has the multipart parser (routes.ts). */
export function registerApprovalFormRoutes(scope: FastifyInstance, deps: ApprovalRouteDeps, bodyLimit: number): void {
  const { approvals, reader, parse } = deps;

  scope.post('/api/mail/approvals', { bodyLimit }, async (request, reply) => {
    const user = reader(request, true);
    const { message, files } = await deps.readForm(request);
    return reply.code(201).send(approvals.submit(user, parse(submitBody, message), files, new Date(deps.now())));
  });

  scope.put('/api/mail/approvals/:id', { bodyLimit }, async (request) => {
    const user = reader(request, true);
    const { id } = parse(requestParams, request.params);
    const { message, files } = await deps.readForm(request);
    return approvals.resubmit(user, id, parse(submitBody, message), files, new Date(deps.now()));
  });
}
