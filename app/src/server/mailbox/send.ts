import { randomBytes } from 'node:crypto';
import {
  MAIL_ATTACHMENTS_MAX,
  MAIL_BODY_MAX,
  MAIL_SUBJECT_MAX,
  parseRecipient,
  SEND_DUPLICATE,
  SEND_UNKNOWN,
  splitRecipients,
  type MailSendOptions,
  type MailSendRequest,
  type MailSendResponse,
} from '../../shared/mailbox.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';
import type { CommitteeAddresses } from './addresses.js';
import { buildRawMail, ComposeError, isMessageId, newMessageId, type OutgoingAddress, type OutgoingAttachment } from './compose.js';
import type { MailboxConfig, MailboxDefinition, MailSendConfig } from './config.js';
import { parseRawMail } from './parse.js';
import type { MailboxService } from './service.js';
import { SmtpError, type MailTransport } from './smtp.js';
import type { MailboxStore } from './store.js';

// Sending from the committee mailbox: new mail, replies and attachments,
// From a committee address the person holds a send grant for, through the committee's Gmail account.
// Every message also goes as BCC to the archive address (draftBccAddress), so it reaches the mail record
// as mail sent from personal accounts with that BCC does. A sent message is stored at once (status 完了)
// in its thread; the account's own copy, collected later, has the same Message-ID and only links to it.
// Server logs never get addresses, subjects or text: the audit row has the send's ID, mailbox and count.

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const SENDS_PER_HOUR = 30;
const MAX_REFERENCES = 20;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const validation = (message: string, field: string) => new DomainError('validation', message, { field });

export class MailSender {
  constructor(
    private readonly store: MailboxStore,
    private readonly addresses: CommitteeAddresses,
    private readonly config: MailboxConfig & { send: MailSendConfig },
    private readonly transport: MailTransport,
    private readonly service: MailboxService,
  ) {}

  private get send(): MailSendConfig {
    return this.config.send;
  }

  /** Mailboxes this person may send from: a send grant (theirs or a department's) and the server's list, in mailbox order. */
  private fromMailboxes(user: User): MailboxDefinition[] {
    if (user.disabled) return [];
    const granted = this.service.grantedMailboxes(user, 'send');
    const sendable = new Set(this.send.mailboxIds);
    return this.addresses.mailboxes.filter((m) => sendable.has(m.id) && granted.has(m.id));
  }

  options(user: User): MailSendOptions {
    return {
      enabled: true,
      from: this.fromMailboxes(user).map((m) => ({ mailboxId: m.id, name: m.name, address: m.address })),
      fromName: this.send.fromName,
      bcc: this.config.draftBccAddress,
      maxAttachmentBytes: this.send.maxAttachmentBytes,
      maxRecipients: this.send.maxRecipients,
      senderName: user.displayName,
    };
  }

  private recipients(values: string[], field: 'to' | 'cc' | 'bcc'): OutgoingAddress[] {
    const label = field === 'to' ? '宛先' : field === 'cc' ? 'CC' : 'BCC';
    return values.map((v) => {
      const parsed = parseRecipient(v);
      if (!parsed) throw validation(`${label}の「${v.slice(0, 80)}」はメールアドレスとして読めません。`, field);
      return parsed;
    });
  }

  /** Reply-To: one address answers should go to instead of From. None when empty or From itself. */
  private replyTo(value: string | null | undefined, fromAddress: string): OutgoingAddress | null {
    const v = value?.trim();
    if (!v) return null;
    if (splitRecipients(v).length > 1) throw validation('返信先は 1 件だけ指定できます。', 'replyTo');
    const parsed = parseRecipient(v);
    if (!parsed) throw validation(`返信先の「${v.slice(0, 80)}」はメールアドレスとして読めません。`, 'replyTo');
    return parsed.address.toLowerCase() === fromAddress.toLowerCase() ? null : parsed;
  }

  /** The message answered: its Message-ID (In-Reply-To) and the references of its thread. */
  private replyContext(receiptId: string): { threadId: string; inReplyTo: string | null; references: string[] } {
    const row = this.store.message(receiptId);
    const linked = row ? (this.store.links([row.id]).get(row.id) ?? []) : [];
    const configured = new Set(this.addresses.mailboxes.map((m) => m.id));
    if (!row || !linked.some((id) => configured.has(id))) throw notFound();
    // Messages without a Message-ID are stored under a made-up one ("noid:"), and stored mail may carry IDs
    // that cannot be written back (non-ASCII, too long): neither goes out.
    const own = isMessageId(row.internet_message_id) ? row.internet_message_id : null;
    const earlier = (JSON.parse(row.references_json) as string[]).filter(isMessageId);
    const all = [...new Set([...earlier, ...(own ? [own] : [])])];
    // The first (the thread's root) and the newest ones, as RFC 5322 suggests for long threads.
    const references = all.length > MAX_REFERENCES ? [all[0]!, ...all.slice(-(MAX_REFERENCES - 1))] : all;
    return { threadId: row.thread_id, inReplyTo: own, references };
  }

  async sendMail(user: User, request: MailSendRequest, attachments: OutgoingAttachment[], now: Date): Promise<MailSendResponse> {
    if (user.disabled) throw new DomainError('forbidden', 'このアカウントは利用できません。');
    if (!TOKEN.test(request.clientToken)) throw validation('送信の識別子が正しくありません。画面を読み込み直してください。', 'clientToken');
    // The same message again (an answer lost on the way): the earlier result first, before any check that
    // could now refuse it (the hourly limit counts that very message).
    const known = this.store.outgoingByToken(request.clientToken);
    if (known && known.status !== 'failed') return this.answerKnown(user, request.clientToken, now);
    const from = this.fromMailboxes(user).find((m) => m.id === request.mailboxId);
    if (!from) throw new DomainError('forbidden', 'この受信箱のアドレスから送る権限がありません。権限管理者に、受信箱の送信権限を依頼してください。');

    const to = this.recipients(request.to, 'to');
    const cc = this.recipients(request.cc, 'cc');
    const bcc = this.recipients(request.bcc, 'bcc');
    if (to.length === 0) throw validation('宛先を 1 件以上入力してください。', 'to');
    const replyTo = this.replyTo(request.replyTo, from.address);
    // The same address twice is sent once, in the first field it appears in.
    const seen = new Set<string>();
    const once = (list: OutgoingAddress[]) =>
      list.filter((a) => {
        const k = a.address.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    const toOnce = once(to);
    const ccOnce = once(cc);
    const bccOnce = once(bcc);
    const count = toOnce.length + ccOnce.length + bccOnce.length;
    if (count > this.send.maxRecipients) throw validation(`宛先・CC・BCC は合わせて ${this.send.maxRecipients} 件までです。`, 'to');

    const subject = request.subject.trim();
    if (!subject) throw validation('件名を入力してください。', 'subject');
    if (subject.length > MAIL_SUBJECT_MAX || CONTROL.test(subject)) throw validation(`件名は改行なしの ${MAIL_SUBJECT_MAX} 文字以内にしてください。`, 'subject');
    if (request.body.length > MAIL_BODY_MAX) throw validation(`本文は ${MAIL_BODY_MAX.toLocaleString('ja-JP')} 文字以内にしてください。`, 'body');
    if (BODY_CONTROL.test(request.body)) throw validation('本文に使えない制御文字があります。', 'body');
    if (!request.body.trim() && attachments.length === 0) throw validation('本文を入力してください。', 'body');
    if (attachments.length > MAIL_ATTACHMENTS_MAX) throw validation(`添付ファイルは ${MAIL_ATTACHMENTS_MAX} 個までです。`, 'attachments');
    const size = attachments.reduce((n, a) => n + a.content.length, 0);
    if (size > this.send.maxAttachmentBytes) throw validation(`添付ファイルは合わせて ${Math.floor(this.send.maxAttachmentBytes / 1024 / 1024)} MB までです。`, 'attachments');

    const reply = request.replyToReceiptId ? this.replyContext(request.replyToReceiptId) : null;
    if (this.store.sendsSince(user.id, new Date(now.getTime() - 3_600_000).toISOString()) >= SENDS_PER_HOUR) {
      throw new HttpError(429, { error: 'too_many_sends', message: `送信は 1 時間に ${SENDS_PER_HOUR} 通までです。時間をおいてから送ってください。` });
    }

    const messageId = newMessageId(from.address);
    let raw: Buffer;
    try {
      raw = buildRawMail({
        from: { name: this.send.fromName, address: from.address },
        replyTo,
        to: toOnce,
        cc: ccOnce,
        subject,
        text: request.body,
        messageId,
        inReplyTo: reply?.inReplyTo ?? null,
        references: reply?.references ?? [],
        date: now,
        attachments,
      });
    } catch (err) {
      if (err instanceof ComposeError) throw validation(err.message, 'body');
      throw err;
    }

    const nowIso = now.toISOString();
    const archive = this.config.draftBccAddress;
    // The configuration requires it with "send"; never send without the record.
    if (!archive) throw new HttpError(503, { error: 'send_unavailable', message: '送ったメールの記録先（BCC）が設定されていないため、送れません。システム課に連絡してください。' });
    const claim = this.store.claimOutgoing({
      id: `og_${randomBytes(8).toString('hex')}`,
      client_token: request.clientToken,
      user_id: user.id,
      mailbox_id: from.id,
      internet_message_id: messageId,
      reply_to_id: request.replyToReceiptId,
      recipients: count,
      bcc_json: JSON.stringify([...bccOnce.map((a) => a.address), ...(archive ? [archive] : [])]),
      size: raw.length,
      created_at: nowIso,
    });
    if (!claim) return this.answerKnown(user, request.clientToken, now);

    const envelope = [...new Set([...toOnce, ...ccOnce, ...bccOnce].map((a) => a.address).concat(archive ? [archive] : []))];
    try {
      await this.transport.send({ from: this.send.smtp.user, to: envelope }, raw);
    } catch (err) {
      const smtp = err instanceof SmtpError ? err : new SmtpError('connect', null, 'no', 'メールを送れませんでした。');
      if (smtp.delivered === 'unknown') {
        this.store.finishOutgoing(claim.id, { status: 'unknown', error: `${smtp.step}:${smtp.code ?? '-'}` }, user.id, nowIso);
        throw new HttpError(502, { error: SEND_UNKNOWN, message: '送信できたか確認できませんでした（送信の途中で接続が切れました）。届いている可能性があるので、もう一度は送らず、委員会の Gmail の送信済みか、相手への確認で確かめてください。' });
      }
      this.store.finishOutgoing(claim.id, { status: 'failed', error: `${smtp.step}:${smtp.code ?? '-'}` }, user.id, nowIso);
      throw new HttpError(502, { error: 'send_failed', message: `${smtp.message} メールは送られていません。入力はそのまま残っているので、もう一度送れます。` });
    }

    // Accepted by the mail server: from here on the answer is "sent", whatever happens to the copy here.
    let receiptId: string | null = null;
    let threadId: string | null = reply?.threadId ?? null;
    try {
      const parsed = await parseRawMail(raw);
      const stored = this.store.store({ source: 'sent', providerId: claim.id, receivedAt: nowIso, parsed, mailboxIds: this.addresses.withForwards([from]).map((m) => m.id), now: nowIso, status: 'done' });
      receiptId = stored.id;
      threadId = this.store.message(stored.id)?.thread_id ?? threadId;
    } catch {
      // The account's own copy is collected within minutes and shows the message then.
    }
    try {
      this.store.finishOutgoing(claim.id, { status: 'sent', messageId: receiptId }, user.id, nowIso);
    } catch {
      // The message is sent: the answer says so (the row stays "sending", which a later look reads as "may have gone out").
    }
    let threadDone = false;
    if (reply && request.markThreadDone) {
      try {
        this.service.setThreadStatus(user, reply.threadId, 'done', nowIso);
        threadDone = true;
      } catch {
        // The message is sent; the status stays as it was and can be set on the screen.
      }
    }
    return { status: 'sent', receiptId, threadId, threadDone };
  }

  /** The same message (clientToken) again: the earlier result, or why it cannot be sent now. */
  private answerKnown(user: User, token: string, now: Date): MailSendResponse {
    const known = this.store.outgoingByToken(token);
    if (!known || known.user_id !== user.id) throw new HttpError(409, { error: SEND_DUPLICATE, message: 'このメールは送信の受付が重なりました。画面を読み込み直してください。' });
    if (known.status === 'sent') {
      const row = known.message_id ? this.store.message(known.message_id) : null;
      return { status: 'sent', receiptId: row?.id ?? null, threadId: row?.thread_id ?? null, threadDone: false };
    }
    // A send still "sending" after ten minutes was cut off (the app stopped): it may have gone out.
    if (known.status === 'unknown' || now.getTime() - Date.parse(known.created_at) > 10 * 60_000) {
      throw new HttpError(409, { error: SEND_UNKNOWN, message: '前回の送信が届いたか確認できていません。もう一度は送らず、委員会の Gmail の送信済みか、相手への確認で確かめてください。' });
    }
    throw new HttpError(409, { error: SEND_DUPLICATE, message: 'このメールはいま送信中です。少し待ってから画面を確かめてください。' });
  }
}
