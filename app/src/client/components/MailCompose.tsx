import { useRef, useState } from 'react';
import type { Address, ReceiptView } from '../../shared/api';
import {
  MAIL_APPROVAL_NOTE_MAX,
  MAIL_ATTACHMENTS_MAX,
  MAIL_BODY_MAX,
  MAIL_SUBJECT_MAX,
  parseRecipient,
  SEND_UNKNOWN,
  splitRecipients,
  type MailApprovalDetail,
  type MailApprovalSubmitRequest,
  type MailSendOptions,
  type MailSendRequest,
  type MailSendResponse,
} from '../../shared/mailbox';
import { isDueDate, japaneseDay, jstDay, replyDueSentence } from '../../shared/mailDue';
import { screenMail } from '../../shared/mailScreen';
import { mailSignature, replaceDraftSignature } from '../../shared/signature';
import { apiForm, fmtDate, toFailure } from '../api';
import { MailReview } from './MailReview';
import { RecipientInput } from './RecipientInput';

// Writing and sending mail from a committee address (2026-10-26): a reply, a reply to all, or new mail.
// Write → check what will be sent (with a confirmation tick) → send once. The browser makes one token per
// message, so pressing again after a lost answer never sends it twice. Mail also goes as BCC to the archive.
// A reply-to address other than From can be given.
// Approval before sending (2026-11-11): from a mailbox where this person's mail needs an approval, the same form
// asks a reviewer instead of sending ("承認を依頼する"); a returned mail opens here again with its files (`resubmit`).

export type ComposeMode = 'new' | 'reply' | 'replyAll';

export interface ComposeDraft {
  mailboxId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  replyToReceiptId: string | null;
  /** 返信先 (Reply-To) as typed; empty: answers go to From. */
  replyTo?: string;
}

const fmtAddress = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);

function fmtSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The signature the body starts with (it can be changed like the rest of the text): the committee's shape, made from
 * what the server says (2026-11-10; each person sets their title and address in the settings). An older server sends
 * no parts: the earlier signature, which names the From mailbox.
 */
export function signature(options: MailSendOptions, mailboxId: string): string {
  if (options.signature) return mailSignature(options.signature);
  const box = options.from.find((f) => f.mailboxId === mailboxId);
  return ['--', options.fromName, box ? `${box.name}（${box.address}）` : '', options.senderName].filter(Boolean).join('\n');
}

/**
 * A Bot draft's body with the committee's signature: the Bot's own signature block is replaced by it, and a draft
 * without one gets it after the text unless the Bot already wrote the committee's name.
 */
function withSignature(options: MailSendOptions, mailboxId: string, body: string): string {
  const text = body.replace(/\r\n/g, '\n').trimEnd();
  const sig = signature(options, mailboxId);
  const replaced = options.signature ? replaceDraftSignature(text, sig, options.fromName) : null;
  if (replaced !== null) return `${replaced}\n`;
  return text.includes(options.fromName) ? `${text}\n` : `${text}\n\n${sig}\n`;
}

/** New mail; `to` is set when it is written from a contact. */
export function newDraft(options: MailSendOptions, mailboxId?: string, fromBot?: { subject: string; body: string }, to = ''): ComposeDraft {
  const from = options.from.find((f) => f.mailboxId === mailboxId)?.mailboxId ?? options.from[0]?.mailboxId ?? '';
  return {
    mailboxId: from,
    to,
    cc: '',
    bcc: '',
    subject: fromBot?.subject.slice(0, MAIL_SUBJECT_MAX) ?? '',
    body: fromBot ? withSignature(options, from, fromBot.body) : `\n\n${signature(options, from)}\n`,
    replyToReceiptId: null,
  };
}

/**
 * A reply to one message: to its sender (or, for the committee's own mail, to whom it was sent), quoting it.
 * With a Bot draft, its subject and body replace the empty start.
 */
export function replyDraft(options: MailSendOptions, receipt: ReceiptView, mode: 'reply' | 'replyAll', fromBot?: { subject: string; body: string }): ComposeDraft {
  const inMailbox = new Set((receipt.mailboxes ?? [receipt.mailbox]).map((m) => m.id));
  const from = options.from.find((f) => inMailbox.has(f.mailboxId)) ?? options.from[0];
  const lower = (a: Address) => a.address.toLowerCase();
  const sender = from?.address.toLowerCase() ?? '';
  // Never written back: the addresses this person sends from (one account's aliases) and the archive BCC.
  const skip = new Set([sender, ...options.from.map((f) => f.address.toLowerCase()), ...(options.bcc ? [options.bcc.toLowerCase()] : [])]);
  // A reply to the committee's own message from the same address goes to whom it was sent; any other, to its sender.
  const back = receipt.from.address.toLowerCase() === sender ? receipt.to.filter((a) => !skip.has(lower(a))) : [];
  const to = back.length > 0 ? back : [receipt.from];
  const toKeys = new Set(to.map(lower));
  const cc =
    mode === 'replyAll'
      ? [...receipt.to, ...receipt.cc].filter((a, i, all) => {
          const k = lower(a);
          return !skip.has(k) && !toKeys.has(k) && all.findIndex((b) => lower(b) === k) === i;
        })
      : [];
  const subject = /^\s*re\s*[:：]/i.test(receipt.subject) ? receipt.subject : `Re: ${receipt.subject}`;
  const quoted = receipt.text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(0, 300)
    .map((l) => `> ${l}`)
    .join('\n');
  const mailboxId = from?.mailboxId ?? '';
  const quote = `${fmtDate(receipt.receivedAt)} ${fmtAddress(receipt.from)}:\n${quoted}\n`;
  return {
    mailboxId,
    to: to.map(fmtAddress).join(', '),
    cc: cc.map(fmtAddress).join(', '),
    bcc: '',
    subject: (fromBot?.subject.trim() || subject).slice(0, MAIL_SUBJECT_MAX),
    body: fromBot ? `${withSignature(options, mailboxId, fromBot.body)}\n${quote}` : `\n\n${signature(options, mailboxId)}\n\n${quote}`,
    replyToReceiptId: receipt.receiptId,
  };
}

interface Checked {
  to: string[];
  cc: string[];
  bcc: string[];
  /** Null when none is needed (empty, or From itself). */
  replyTo: string | null;
  /** The body as it will be sent: with the reply deadline sentence when it is asked for. */
  body: string;
  /** The reply deadline (YYYY-MM-DD), or null: the sent message then waits for the reply (2026-11-03). */
  replyDue: string | null;
}

/** The deadline sentence goes at the end of what the sender wrote: before the signature when there is one. */
export function withDueSentence(options: MailSendOptions, mailboxId: string, body: string, sentence: string): string {
  const sig = signature(options, mailboxId);
  if (body.includes(sig)) return body.replace(sig, () => `${sentence}\n\n${sig}`);
  return `${body.replace(/\s+$/, '')}\n\n${sentence}`;
}

const TITLES: Record<ComposeMode, string> = { new: '新しいメール', reply: '返信', replyAll: '全員に返信' };

/** A returned request opened in the form again: what it was, and the files kept with it. */
export interface ComposeResubmit {
  id: string;
  version: number;
  note: string;
  returnComment: string | null;
  attachments: { idx: number; filename: string; size: number }[];
}

/** The form of a returned request, to change and ask again. */
export function resubmitDraft(detail: MailApprovalDetail): { initial: ComposeDraft; resubmit: ComposeResubmit; mode: ComposeMode; replyDue: string; markDone: boolean } {
  const m = detail.message;
  return {
    initial: { mailboxId: detail.mailbox.id, to: m.to.join(', '), cc: m.cc.join(', '), bcc: m.bcc.join(', '), subject: m.subject, body: m.body, replyToReceiptId: m.replyToReceiptId, replyTo: m.replyTo ?? '' },
    resubmit: { id: detail.id, version: detail.version, note: detail.note, returnComment: detail.returnComment, attachments: detail.attachments },
    mode: m.replyToReceiptId ? 'reply' : 'new',
    replyDue: m.replyDue ?? '',
    markDone: m.markThreadDone,
  };
}

/** The line shown after an approval was asked for. */
export const SUBMITTED_NOTE = '承認を依頼しました。校閲者が承認すると送信されます。状況は「承認待ち」で確かめられます。';

/** The line shown after a send: that it went, and whether its reply deadline was kept (the thread and the app use it). */
export function sentNoteText(result: MailSendResponse): string {
  const base = result.threadDone ? '送信しました。スレッドを「完了」にしました。' : '送信しました。';
  const waitNote = result.replyWait === 'set' ? ' 返事待ちとして記録しました。' : result.replyWait === 'failed' ? ' ただし回答期限は保存できませんでした。下の「期限」から付け直してください。' : '';
  return base + waitNote;
}

export function MailCompose({
  options,
  initial,
  mode,
  onSent,
  onSubmitted,
  onCancel,
  resubmit,
  initialReplyDue = '',
  initialMarkDone,
}: {
  options: MailSendOptions;
  initial: ComposeDraft;
  mode: ComposeMode;
  onSent: (result: MailSendResponse) => void;
  /** An approval was asked for (the From mailbox needs one for this person). */
  onSubmitted?: (detail: MailApprovalDetail) => void;
  onCancel: () => void;
  /** A returned request, changed and asked again. */
  resubmit?: ComposeResubmit;
  initialReplyDue?: string;
  initialMarkDone?: boolean;
}) {
  const [draft, setDraft] = useState<ComposeDraft>(initial);
  const [files, setFiles] = useState<File[]>([]);
  // The files kept from a returned request (by idx), and the words to the reviewer.
  const [kept, setKept] = useState<ComposeResubmit['attachments']>(resubmit?.attachments ?? []);
  const [note, setNote] = useState(resubmit?.note ?? '');
  const [markDone, setMarkDone] = useState(initialMarkDone ?? mode !== 'new');
  const [preview, setPreview] = useState<Checked | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<'to' | 'cc' | 'bcc' | 'replyTo' | 'subject' | 'body' | 'attachments' | 'replyDue' | 'note', string>>>({});
  // Reply deadline (2026-11-03): only for a From mailbox the sender may edit; the sentence is on by default.
  const [replyDue, setReplyDue] = useState(initialReplyDue);
  // A returned mail already has its deadline sentence in the text.
  const [dueSentence, setDueSentence] = useState(!resubmit);
  const [message, setMessage] = useState<{ kind: 'error' | 'warning'; text: string } | null>(null);
  const [locked, setLocked] = useState(false);
  // CC, BCC and the reply-to address are folded until asked for, and open from the start when any of them has
  // something (a reply to all brings CC), so the form does not show eight fields at once.
  const [more, setMore] = useState(() => !!(initial.cc.trim() || initial.bcc.trim() || (initial.replyTo ?? '').trim()));
  const ccInput = useRef<HTMLTextAreaElement>(null);
  // One token per message: a second press after a lost answer gets the first result.
  const token = useRef(crypto.randomUUID().replace(/-/g, ''));
  const sending = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const from = options.from.find((f) => f.mailboxId === draft.mailboxId) ?? null;
  // From this mailbox the mail is not sent now: a reviewer approves it first.
  const needsApproval = !!resubmit || (options.approvalMailboxIds?.includes(draft.mailboxId) ?? false);
  const fileCount = kept.length + files.length;
  const size = kept.reduce((n, f) => n + f.size, 0) + files.reduce((n, f) => n + f.size, 0);
  const parsed = (values: string[]) => values.flatMap((v) => parseRecipient(v) ?? []);
  const dueHere = options.dueMailboxIds?.includes(draft.mailboxId) ?? false;
  const today = jstDay(new Date());
  // Checks before sending (fixed rules): shown with what will be sent.
  const findings = preview
    ? screenMail({ subject: draft.subject, body: preview.body, to: parsed(preview.to), cc: parsed(preview.cc), replyTo: preview.replyTo ? parseRecipient(preview.replyTo) : null, fromAddress: from?.address ?? '', fromName: options.fromName, attachments: fileCount })
    : [];
  const warnings = findings.filter((f) => f.level === 'warning').length;
  const toNames = parsed(splitRecipients(draft.to)).map((a) => a.name ?? '（名前なし）');

  function edit<K extends keyof ComposeDraft>(key: K, value: ComposeDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    // What was checked is no longer what would be sent.
    setPreview(null);
    setConfirmed(false);
  }

  /** Another From: the signature follows it while it is still the one this form put in. */
  function changeFrom(mailboxId: string) {
    const before = signature(options, draft.mailboxId);
    const body = draft.body.includes(before) ? draft.body.replace(before, signature(options, mailboxId)) : draft.body;
    setDraft((d) => ({ ...d, mailboxId, body }));
    setPreview(null);
    setConfirmed(false);
  }

  /** The deadline or whether its sentence is added: what was checked is no longer what would be sent. */
  function changeDue(value: string | null, sentence: boolean) {
    if (value !== null) setReplyDue(value);
    setDueSentence(sentence);
    setPreview(null);
    setConfirmed(false);
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    // Copied first: clearing the input below empties the live FileList.
    const picked = Array.from(list);
    setFiles((f) => [...f, ...picked]);
    setPreview(null);
    setConfirmed(false);
    if (fileInput.current) fileInput.current.value = '';
  }

  function check(): Checked | null {
    const next: typeof errors = {};
    const read = (field: 'to' | 'cc' | 'bcc', label: string) => {
      const values = splitRecipients(draft[field]);
      const bad = values.filter((v) => !parseRecipient(v));
      if (bad.length > 0) next[field] = `${label}の「${bad[0]!.slice(0, 60)}」はメールアドレスとして読めません。「名前 <アドレス>」かアドレスだけで書き、複数はカンマか改行で区切ります。`;
      return values;
    };
    const to = read('to', '宛先');
    const cc = read('cc', 'CC');
    const bcc = read('bcc', 'BCC');
    if (to.length === 0 && !next.to) next.to = '宛先を入力してください。';
    const replyText = (draft.replyTo ?? '').trim();
    let replyTo: string | null = null;
    if (replyText) {
      const typed = splitRecipients(replyText);
      const one = typed.length === 1 ? parseRecipient(typed[0]!) : null;
      if (typed.length > 1) next.replyTo = '返信先は 1 件だけ指定できます。';
      else if (!one) next.replyTo = `返信先の「${replyText.slice(0, 60)}」はメールアドレスとして読めません。「名前 <アドレス>」かアドレスだけで書きます。`;
      // From itself needs no Reply-To.
      else if (one.address.toLowerCase() !== (from?.address ?? '').toLowerCase()) replyTo = typed[0]!;
    }
    if (to.length + cc.length + bcc.length > options.maxRecipients) next.to = `宛先・CC・BCC は合わせて ${options.maxRecipients} 件までです。`;
    if (!draft.subject.trim()) next.subject = '件名を入力してください。';
    else if (draft.subject.length > MAIL_SUBJECT_MAX) next.subject = `件名は ${MAIL_SUBJECT_MAX} 文字以内にしてください。`;
    if (fileCount > MAIL_ATTACHMENTS_MAX) next.attachments = `添付ファイルは ${MAIL_ATTACHMENTS_MAX} 個までです。`;
    else if (size > options.maxAttachmentBytes) next.attachments = `添付ファイルは合わせて ${fmtSize(options.maxAttachmentBytes)} までです（いま ${fmtSize(size)}）。`;
    const due = dueHere && replyDue ? replyDue : null;
    if (due && !isDueDate(due)) next.replyDue = '回答期限は、実在する日付で入力してください。';
    else if (due && due < today) next.replyDue = '回答期限は今日以降の日付にしてください。';
    const body = due && dueSentence && isDueDate(due) ? withDueSentence(options, draft.mailboxId, draft.body, replyDueSentence(due, today)) : draft.body;
    if (body.length > MAIL_BODY_MAX) next.body = `本文は ${MAIL_BODY_MAX.toLocaleString('ja-JP')} 文字以内にしてください。`;
    if (needsApproval && note.trim().length > MAIL_APPROVAL_NOTE_MAX) next.note = `校閲者へのひとことは ${MAIL_APPROVAL_NOTE_MAX} 文字以内にしてください。`;
    setErrors(next);
    return Object.keys(next).length === 0 ? { to, cc, bcc, replyTo, body, replyDue: due } : null;
  }

  async function send() {
    if (!preview || !confirmed || !from || sending.current || locked) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    const body: MailSendRequest = {
      clientToken: token.current,
      mailboxId: from.mailboxId,
      to: preview.to,
      cc: preview.cc,
      bcc: preview.bcc,
      subject: draft.subject,
      body: preview.body,
      replyToReceiptId: draft.replyToReceiptId,
      markThreadDone: !!draft.replyToReceiptId && markDone,
      replyTo: preview.replyTo,
      replyDue: preview.replyDue,
    };
    const form = new FormData();
    const asked: MailApprovalSubmitRequest = { ...body, note: note.trim(), ...(resubmit ? { expectedVersion: resubmit.version, keepAttachments: kept.map((a) => a.idx) } : {}) };
    form.append('message', JSON.stringify(needsApproval ? asked : body));
    for (const f of files) form.append('attachments', f, f.name);
    try {
      if (needsApproval) {
        const detail = await apiForm<MailApprovalDetail>(resubmit ? `/api/mail/approvals/${resubmit.id}` : '/api/mail/approvals', form, resubmit ? 'PUT' : 'POST');
        onSubmitted?.(detail);
        return;
      }
      const result = await apiForm<MailSendResponse>('/api/mail/send', form);
      onSent(result);
    } catch (err) {
      const failure = toFailure(err);
      const badField = (failure.body?.details as { field?: string } | undefined)?.field;
      if (failure.body?.error === SEND_UNKNOWN) {
        setLocked(true);
        setMessage({ kind: 'warning', text: failure.message });
      } else {
        if (badField) setPreview(null);
        // No answer, or a server error other than a refusal the server explained: it may have been sent.
        const unsure = failure.status === 0 || (failure.status >= 500 && !['send_failed', 'send_unavailable'].includes(failure.body?.error ?? ''));
        const again = needsApproval ? '依頼できたかどうかは、もう一度「承認を依頼する」を押すと確かめられます（二重には出ません）。' : '届いたかどうかは、もう一度「送信する」を押すと確かめられます（二重には送られません）。';
        setMessage({ kind: 'error', text: unsure ? `${failure.message} ${again}` : failure.message });
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const field = (name: keyof typeof errors) => (errors[name] ? { 'aria-invalid': true as const, 'aria-describedby': `compose-${name}-error` } : {});
  const errorOf = (name: keyof typeof errors) =>
    errors[name] ? (
      <p className="field-error" id={`compose-${name}-error`}>
        {errors[name]}
      </p>
    ) : null;

  return (
    <section className="mail-compose" aria-labelledby="compose-title" data-testid="mail-compose">
      <div className="compose-head">
        <div>
          <h3 id="compose-title">{resubmit ? '差し戻されたメールを直す' : TITLES[mode]}</h3>
          <p className="hint compose-sub">
            {needsApproval ? 'この差出人のメールは、校閲者が承認すると委員会のアドレスから送られます（承認されるまでは送られません）。' : '委員会のアドレスから送ります。送ったメールは、差出人の受信箱に「完了」で残ります。'}
          </p>
        </div>
        <button type="button" className="quiet" onClick={onCancel} disabled={busy}>
          閉じる
        </button>
      </div>
      {resubmit?.returnComment && (
        <p className="status warning approval-return" role="status" data-testid="compose-return-comment">
          <strong>差し戻しの理由</strong>
          <span className="approval-comment">{resubmit.returnComment}</span>
        </p>
      )}
      {!preview ? (
        <form
          className="compose-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const checked = check();
            if (checked) {
              setPreview(checked);
              setConfirmed(false);
            }
          }}
        >
          <label htmlFor="compose-from">差出人</label>
          <select id="compose-from" value={draft.mailboxId} onChange={(e) => changeFrom(e.target.value)} disabled={busy || !!resubmit} data-testid="compose-from">
            {options.from.map((f) => (
              <option key={f.mailboxId} value={f.mailboxId}>
                {f.name}（{f.address}）{options.approvalMailboxIds?.includes(f.mailboxId) ? '・承認が必要' : ''}
              </option>
            ))}
          </select>
          <label htmlFor="compose-to">宛先</label>
          <RecipientInput id="compose-to" rows={1} value={draft.to} onValueChange={(v) => edit('to', v)} {...field('to')} data-testid="compose-to" />
          {errorOf('to')}
          {more ? (
            <>
              <label htmlFor="compose-cc">CC</label>
              <RecipientInput ref={ccInput} id="compose-cc" rows={1} value={draft.cc} onValueChange={(v) => edit('cc', v)} {...field('cc')} data-testid="compose-cc" />
              {errorOf('cc')}
              <label htmlFor="compose-bcc">BCC</label>
              <RecipientInput id="compose-bcc" rows={1} value={draft.bcc} onValueChange={(v) => edit('bcc', v)} aria-describedby="compose-bcc-hint" {...field('bcc')} data-testid="compose-bcc" />
              {errorOf('bcc')}
              {options.bcc && (
                <p className="field-hint" id="compose-bcc-hint">
                  委員会の記録用に {options.bcc} にも BCC で届きます（自動）。
                </p>
              )}
              <label htmlFor="compose-reply-to">返信先（任意）</label>
              <input
                id="compose-reply-to"
                type="text"
                list="compose-reply-to-list"
                autoComplete="off"
                value={draft.replyTo ?? ''}
                onChange={(e) => edit('replyTo', e.target.value)}
                aria-describedby="compose-reply-to-hint"
                {...field('replyTo')}
                data-testid="compose-reply-to"
              />
              <datalist id="compose-reply-to-list">
                {options.from
                  .filter((f) => f.mailboxId !== draft.mailboxId)
                  .map((f) => (
                    <option key={f.mailboxId} value={f.address}>
                      {f.name}
                    </option>
                  ))}
              </datalist>
              {errorOf('replyTo')}
              <p className="field-hint" id="compose-reply-to-hint">
                空欄なら、相手の返信は差出人のアドレスに届きます。別のアドレスで返信を受けたいときだけ、1 件入れます。
              </p>
            </>
          ) : (
            <button
              type="button"
              className="quiet compose-more-toggle"
              aria-expanded={false}
              onClick={() => {
                setMore(true);
                requestAnimationFrame(() => ccInput.current?.focus());
              }}
              data-testid="compose-more"
            >
              ＋ CC・BCC・返信先
            </button>
          )}
          <label htmlFor="compose-subject">件名</label>
          <input id="compose-subject" type="text" value={draft.subject} maxLength={MAIL_SUBJECT_MAX} onChange={(e) => edit('subject', e.target.value)} {...field('subject')} data-testid="compose-subject" />
          {errorOf('subject')}
          <label htmlFor="compose-body">本文</label>
          <textarea id="compose-body" rows={14} value={draft.body} onChange={(e) => edit('body', e.target.value)} {...field('body')} data-testid="compose-body" />
          {errorOf('body')}
          <div className="compose-files">
            <span className="compose-files-label">添付ファイル</span>
            {fileCount > 0 && (
              <ul>
                {kept.map((a) => (
                  <li key={`kept-${a.idx}`}>
                    <span className="compose-file-name">{a.filename}</span> <span className="hint">{fmtSize(a.size)}・前回の添付</span>
                    <button
                      type="button"
                      className="quiet"
                      aria-label={`${a.filename} を外す`}
                      onClick={() => {
                        setKept((all) => all.filter((k) => k.idx !== a.idx));
                        setPreview(null);
                      }}
                    >
                      外す
                    </button>
                  </li>
                ))}
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    <span className="compose-file-name">{f.name}</span> <span className="hint">{fmtSize(f.size)}</span>
                    <button
                      type="button"
                      className="quiet"
                      aria-label={`${f.name} を外す`}
                      onClick={() => {
                        setFiles((all) => all.filter((_, j) => j !== i));
                        setPreview(null);
                      }}
                    >
                      外す
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="button secondary compose-file-button">
              ファイルを選ぶ
              <input ref={fileInput} type="file" multiple className="sr-only" onChange={(e) => addFiles(e.target.files)} data-testid="compose-files" />
            </label>
            <p className="hint">
              {MAIL_ATTACHMENTS_MAX} 個・合わせて {fmtSize(options.maxAttachmentBytes)} まで{fileCount > 0 ? `（いま ${fileCount} 個・${fmtSize(size)}）` : ''}
            </p>
            {errorOf('attachments')}
          </div>
          {dueHere && (
            <div className="compose-due">
              <label htmlFor="compose-reply-due">回答期限（任意）</label>
              <input id="compose-reply-due" type="date" min={today} value={replyDue} onChange={(e) => changeDue(e.target.value, dueSentence)} disabled={busy} {...field('replyDue')} data-testid="compose-reply-due" />
              <p className="hint">期限を入れると、送ったスレッドは「返事待ち」になり、相手の返信が届くまで期限の一覧に出ます。</p>
              {replyDue && isDueDate(replyDue) && (
                <label className="confirm-check plain">
                  <input type="checkbox" checked={dueSentence} onChange={(e) => changeDue(null, e.target.checked)} disabled={busy} />
                  本文の末尾に「{replyDueSentence(replyDue, today)}」を入れる
                </label>
              )}
              {errorOf('replyDue')}
            </div>
          )}
          {draft.replyToReceiptId && (
            <label className="confirm-check plain">
              <input type="checkbox" checked={markDone} onChange={(e) => setMarkDone(e.target.checked)} />
              送ったら、このスレッドを「完了」にする
            </label>
          )}
          {needsApproval && (
            <>
              <label htmlFor="compose-note">校閲者へのひとこと（任意）</label>
              <textarea
                id="compose-note"
                rows={2}
                value={note}
                maxLength={MAIL_APPROVAL_NOTE_MAX}
                onChange={(e) => {
                  setNote(e.target.value);
                  setPreview(null);
                  setConfirmed(false);
                }}
                aria-describedby="compose-note-hint"
                {...field('note')}
                data-testid="compose-note"
              />
              {errorOf('note')}
              <p className="field-hint" id="compose-note-hint">
                見てほしい所や急ぎの事情があれば書きます。相手には送られません。
              </p>
            </>
          )}
          <div className="actions">
            <button type="submit" data-testid="compose-check">
              {needsApproval ? '依頼内容を確認' : '送信内容を確認'}
            </button>
            <button type="button" className="secondary" onClick={onCancel}>
              やめる
            </button>
          </div>
        </form>
      ) : (
        <div className="compose-preview" data-testid="compose-preview">
          <h4>{needsApproval ? '依頼内容の確認' : '送信内容の確認'}</h4>
          <dl>
            <dt>差出人</dt>
            <dd>
              {options.fromName} &lt;{from?.address}&gt;
            </dd>
            {preview.replyTo && (
              <>
                <dt>返信先</dt>
                <dd data-testid="preview-reply-to">
                  {preview.replyTo} <span className="hint">（相手の返信はこのアドレスに届きます）</span>
                </dd>
              </>
            )}
            <dt>宛先</dt>
            <dd data-testid="preview-to">{preview.to.join('、')}</dd>
            {preview.cc.length > 0 && (
              <>
                <dt>CC</dt>
                <dd>{preview.cc.join('、')}</dd>
              </>
            )}
            {(preview.bcc.length > 0 || options.bcc) && (
              <>
                <dt>BCC</dt>
                <dd>
                  {preview.bcc.join('、')}
                  {preview.bcc.length > 0 && options.bcc ? '、' : ''}
                  {options.bcc && <span className="hint">{options.bcc}（記録用・自動）</span>}
                </dd>
              </>
            )}
            <dt>件名</dt>
            <dd data-testid="preview-subject">{draft.subject}</dd>
            {fileCount > 0 && (
              <>
                <dt>添付</dt>
                <dd>{[...kept.map((a) => `${a.filename}（${fmtSize(a.size)}）`), ...files.map((f) => `${f.name}（${fmtSize(f.size)}）`)].join('、')}</dd>
              </>
            )}
            {preview.replyDue && (
              <>
                <dt>回答期限</dt>
                <dd data-testid="preview-reply-due">
                  {japaneseDay(preview.replyDue, today)}まで <span className="hint">（送ったあと、このスレッドは「返事待ち」になります）</span>
                </dd>
              </>
            )}
          </dl>
          {!dueHere && replyDue.trim() !== '' && (
            <p className="status warning" role="status" data-testid="preview-due-unavailable">
              この受信箱では回答期限を付けられないため、期限は付きません。
            </p>
          )}
          <pre className="mail-text compose-preview-body" data-testid="preview-body">
            {preview.body}
          </pre>
          {draft.replyToReceiptId && markDone && <p className="hint">送ったあと、このスレッドを「完了」にします。</p>}
          {needsApproval && note.trim() && (
            <p className="hint approval-note" data-testid="preview-note">
              校閲者へのひとこと：{note.trim()}
            </p>
          )}
          <section className="compose-screen" aria-labelledby="compose-screen-title" data-testid="compose-screen">
            <h5 id="compose-screen-title">送信前のチェック</h5>
            {findings.length === 0 ? (
              <p className="status ok">署名・宛名・書きかけ・添付・日付と曜日・宛先で、気になる点は見つかりませんでした。</p>
            ) : (
              <ul>
                {findings.map((f) => (
                  <li key={f.text} className={`screen-${f.level}`}>
                    <strong>{f.level === 'warning' ? '注意' : '参考'}</strong> {f.text}
                  </li>
                ))}
              </ul>
            )}
            {warnings > 0 && <p className="hint">直すときは「編集に戻る」。このままで良ければ、確かめたうえで送れます。</p>}
          </section>
          <label className="confirm-check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy || locked} data-testid="compose-confirm" />
            {warnings > 0 ? `注意 ${warnings} 件を確かめたうえで、` : ''}
            {needsApproval ? 'この宛先と内容で、承認を依頼します（校閲者が承認すると送られます）' : 'この宛先と内容で、委員会のアドレスから送ります'}
          </label>
          <div className="actions">
            <button type="button" onClick={() => void send()} disabled={!confirmed || busy || locked} data-testid="compose-send">
              {needsApproval ? (busy ? '依頼しています…' : '承認を依頼する') : busy ? '送信しています…' : '送信する'}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setPreview(null)}>
              編集に戻る
            </button>
          </div>
        </div>
      )}
      {message && (
        <p className={`status ${message.kind}`} role="alert" data-testid="compose-message">
          {message.text}
        </p>
      )}
      <MailReview subject={draft.subject} body={draft.body} toNames={toNames} fromName={options.fromName} />
    </section>
  );
}
