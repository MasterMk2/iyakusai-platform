import { useRef, useState } from 'react';
import type { Address, ReceiptView } from '../../shared/api';
import {
  MAIL_ATTACHMENTS_MAX,
  MAIL_BODY_MAX,
  MAIL_SUBJECT_MAX,
  parseRecipient,
  SEND_UNKNOWN,
  splitRecipients,
  type MailSendOptions,
  type MailSendRequest,
  type MailSendResponse,
} from '../../shared/mailbox';
import { screenMail } from '../../shared/mailScreen';
import { apiForm, fmtDate, toFailure } from '../api';
import { MailReview } from './MailReview';
import { RecipientInput } from './RecipientInput';

// Writing and sending mail from a committee address (2026-10-26): a reply, a reply to all, or new mail.
// Write → check what will be sent (with a confirmation tick) → send once. The browser makes one token per
// message, so pressing again after a lost answer never sends it twice. Mail also goes as BCC to the archive.
// A reply-to address other than From can be given.

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

/** The signature the body starts with (it can be changed like the rest of the text). */
export function signature(options: MailSendOptions, mailboxId: string): string {
  const box = options.from.find((f) => f.mailboxId === mailboxId);
  return ['--', options.fromName, box ? `${box.name}（${box.address}）` : '', options.senderName].filter(Boolean).join('\n');
}

/** A Bot draft's body, with the committee's signature added when the Bot did not write the committee's name. */
function withSignature(options: MailSendOptions, mailboxId: string, body: string): string {
  const text = body.replace(/\r\n/g, '\n').trimEnd();
  return text.includes(options.fromName) ? `${text}\n` : `${text}\n\n${signature(options, mailboxId)}\n`;
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
}

const TITLES: Record<ComposeMode, string> = { new: '新しいメール', reply: '返信', replyAll: '全員に返信' };

export function MailCompose({ options, initial, mode, onSent, onCancel }: { options: MailSendOptions; initial: ComposeDraft; mode: ComposeMode; onSent: (result: MailSendResponse) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<ComposeDraft>(initial);
  const [files, setFiles] = useState<File[]>([]);
  const [markDone, setMarkDone] = useState(mode !== 'new');
  const [preview, setPreview] = useState<Checked | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<'to' | 'cc' | 'bcc' | 'replyTo' | 'subject' | 'body' | 'attachments', string>>>({});
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
  const size = files.reduce((n, f) => n + f.size, 0);
  const parsed = (values: string[]) => values.flatMap((v) => parseRecipient(v) ?? []);
  // Checks before sending (fixed rules): shown with what will be sent.
  const findings = preview
    ? screenMail({ subject: draft.subject, body: draft.body, to: parsed(preview.to), cc: parsed(preview.cc), replyTo: preview.replyTo ? parseRecipient(preview.replyTo) : null, fromAddress: from?.address ?? '', fromName: options.fromName, attachments: files.length })
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
    if (draft.body.length > MAIL_BODY_MAX) next.body = `本文は ${MAIL_BODY_MAX.toLocaleString('ja-JP')} 文字以内にしてください。`;
    if (files.length > MAIL_ATTACHMENTS_MAX) next.attachments = `添付ファイルは ${MAIL_ATTACHMENTS_MAX} 個までです。`;
    else if (size > options.maxAttachmentBytes) next.attachments = `添付ファイルは合わせて ${fmtSize(options.maxAttachmentBytes)} までです（いま ${fmtSize(size)}）。`;
    setErrors(next);
    return Object.keys(next).length === 0 ? { to, cc, bcc, replyTo } : null;
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
      body: draft.body,
      replyToReceiptId: draft.replyToReceiptId,
      markThreadDone: !!draft.replyToReceiptId && markDone,
      replyTo: preview.replyTo,
    };
    const form = new FormData();
    form.append('message', JSON.stringify(body));
    for (const f of files) form.append('attachments', f, f.name);
    try {
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
        setMessage({ kind: 'error', text: unsure ? `${failure.message} 届いたかどうかは、もう一度「送信する」を押すと確かめられます（二重には送られません）。` : failure.message });
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
          <h3 id="compose-title">{TITLES[mode]}</h3>
          <p className="hint compose-sub">委員会のアドレスから送ります。送ったメールは、差出人の受信箱に「完了」で残ります。</p>
        </div>
        <button type="button" className="quiet" onClick={onCancel} disabled={busy}>
          閉じる
        </button>
      </div>
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
          <select id="compose-from" value={draft.mailboxId} onChange={(e) => changeFrom(e.target.value)} disabled={busy}>
            {options.from.map((f) => (
              <option key={f.mailboxId} value={f.mailboxId}>
                {f.name}（{f.address}）
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
            {files.length > 0 && (
              <ul>
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
              {MAIL_ATTACHMENTS_MAX} 個・合わせて {fmtSize(options.maxAttachmentBytes)} まで{files.length > 0 ? `（いま ${files.length} 個・${fmtSize(size)}）` : ''}
            </p>
            {errorOf('attachments')}
          </div>
          {draft.replyToReceiptId && (
            <label className="confirm-check plain">
              <input type="checkbox" checked={markDone} onChange={(e) => setMarkDone(e.target.checked)} />
              送ったら、このスレッドを「完了」にする
            </label>
          )}
          <div className="actions">
            <button type="submit" data-testid="compose-check">
              送信内容を確認
            </button>
            <button type="button" className="secondary" onClick={onCancel}>
              やめる
            </button>
          </div>
        </form>
      ) : (
        <div className="compose-preview" data-testid="compose-preview">
          <h4>送信内容の確認</h4>
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
            {files.length > 0 && (
              <>
                <dt>添付</dt>
                <dd>{files.map((f) => `${f.name}（${fmtSize(f.size)}）`).join('、')}</dd>
              </>
            )}
          </dl>
          <pre className="mail-text compose-preview-body" data-testid="preview-body">
            {draft.body}
          </pre>
          {draft.replyToReceiptId && markDone && <p className="hint">送ったあと、このスレッドを「完了」にします。</p>}
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
            {warnings > 0 ? `注意 ${warnings} 件を確かめたうえで、` : ''}この宛先と内容で、委員会のアドレスから送ります
          </label>
          <div className="actions">
            <button type="button" onClick={() => void send()} disabled={!confirmed || busy || locked} data-testid="compose-send">
              {busy ? '送信しています…' : '送信する'}
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
