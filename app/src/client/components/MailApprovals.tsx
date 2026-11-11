import { useCallback, useState } from 'react';
import {
  MAIL_APPROVAL_COMMENT_MAX,
  MAIL_APPROVAL_FIELD_LABELS,
  MAIL_APPROVAL_STATE_LABELS,
  MAIL_BODY_MAX,
  MAIL_SUBJECT_MAX,
  parseRecipient,
  SEND_UNKNOWN,
  splitRecipients,
  type MailApprovalAction,
  type MailApprovalDetail,
  type MailApprovalEditRequest,
  type MailApprovalMessage,
  type MailApprovalsResponse,
  type MailApprovalSummary,
  type MailSendOptions,
} from '../../shared/mailbox';
import { isDueDate, japaneseDay, jstDay } from '../../shared/mailDue';
import { screenMail } from '../../shared/mailScreen';
import { api, fmtDate, fmtListDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';
import { RecipientInput } from './RecipientInput';

// Approval before sending (2026-11-11): the list of mail that waits (for this person's approval, or their own
// requests) and one request with what a reviewer or its author can do. The list is in the mailbox's list column
// and the request in its detail column, as a thread is.

const fmtSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const ACTION_LABELS: Record<MailApprovalAction, string> = {
  submitted: '承認を依頼',
  resubmitted: '直して依頼し直し',
  edited: '校閲者が修正',
  returned: '差し戻し',
  approved: '承認',
  sent: '送信',
  send_failed: '送信できず（承認待ちに戻りました）',
  send_unknown: '送信できたか確認できず',
  withdrawn: '取り下げ',
};

function StateChip({ state }: { state: MailApprovalSummary['state'] }) {
  return <span className={`chip approval-state approval-${state}`}>{MAIL_APPROVAL_STATE_LABELS[state]}</span>;
}

// ---- the list

function Row({ item, selectedId, onSelect, showAuthor }: { item: MailApprovalSummary; selectedId: string | null; onSelect: (id: string) => void; showAuthor: boolean }) {
  const selected = selectedId === item.id;
  return (
    <li className={`row ${selected ? 'selected' : ''}`}>
      <button type="button" className={`row-open thread ${selected ? 'selected' : ''}`} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(item.id)} data-testid="approval-row">
        <span className="row-line">
          <span className="subject">{item.subject || '（件名なし）'}</span>
          <StateChip state={item.state} />
          <span className="date">{fmtListDate(item.updatedAt)}</span>
        </span>
        <span className="row-meta">
          <span className="mailbox-badge">{item.mailbox.name}</span>
          {showAuthor && <span>書いた人：{item.authorName}</span>}
          <span>宛先：{item.to.join('、')}</span>
        </span>
      </button>
    </li>
  );
}

export function MailApprovalList({ refresh, selectedId, onSelect, onBack }: { refresh: number; selectedId: string | null; onSelect: (id: string) => void; onBack: () => void }) {
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<MailApprovalsResponse>('GET', '/api/mail/approvals', undefined, signal);
    },
    [refresh],
  );
  const list = useLoader(load);
  const data = list.data;
  const section = (id: string, title: string, items: MailApprovalSummary[], showAuthor: boolean, hint?: string) => (
    <section className="approval-section" aria-labelledby={`approval-${id}-title`} data-testid={`approval-${id}`}>
      <h3 className="section-label" id={`approval-${id}-title`}>
        {title}
        <span className="hint">
          {items.length} 件{hint ? `・${hint}` : ''}
        </span>
      </h3>
      <ul className="rows-list">
        {items.map((item) => (
          <Row key={item.id} item={item} selectedId={selectedId} onSelect={onSelect} showAuthor={showAuthor} />
        ))}
      </ul>
    </section>
  );
  return (
    <div className="approval-list" data-testid="approval-list">
      <button type="button" className="quiet approval-back" onClick={onBack}>
        ← 受信箱の一覧へ
      </button>
      <h2>承認待ちのメール</h2>
      <p className="hint">校閲者が承認すると送られるメールです。承認されるまで、相手には届きません。</p>
      <LoadStatus loader={list} what="承認待ちのメール" compact />
      {data && (
        <>
          {data.reviewer && data.review.length === 0 && <p className="empty">あなたの承認を待っているメールはありません。</p>}
          {data.review.length > 0 && section('review', '承認する', data.review, true, '古い順')}
          {data.mine.length > 0 && section('mine', '自分の依頼', data.mine, false)}
          {!data.reviewer && data.mine.length === 0 && data.done.length === 0 && (
            <p className="empty">依頼したメールはまだありません。「メールを送信」から書いて「承認を依頼する」と、ここに出ます。</p>
          )}
          {data.done.length > 0 && section('done', '済んだもの', data.done, true, '新しい順・最近の 30 件')}
        </>
      )}
    </div>
  );
}

// ---- one request

const FIELDS = ['to', 'cc', 'bcc'] as const;
type EditErrors = Partial<Record<'to' | 'cc' | 'bcc' | 'replyTo' | 'subject' | 'body' | 'replyDue', string>>;

/** A reviewer's change of the mail, before approving. */
function EditForm({ detail, onSaved, onCancel, onConflict }: { detail: MailApprovalDetail; onSaved: (next: MailApprovalDetail) => void; onCancel: () => void; onConflict: (text: string) => void }) {
  const m = detail.message;
  const [draft, setDraft] = useState({ to: m.to.join(', '), cc: m.cc.join(', '), bcc: m.bcc.join(', '), subject: m.subject, body: m.body, replyTo: m.replyTo ?? '', replyDue: m.replyDue ?? '' });
  const [errors, setErrors] = useState<EditErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const today = jstDay(new Date());
  const set = <K extends keyof typeof draft>(key: K, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  async function save() {
    const next: EditErrors = {};
    const lists = { to: splitRecipients(draft.to), cc: splitRecipients(draft.cc), bcc: splitRecipients(draft.bcc) };
    for (const f of FIELDS) {
      const bad = lists[f].find((v) => !parseRecipient(v));
      if (bad) next[f] = `「${bad.slice(0, 60)}」はメールアドレスとして読めません。「名前 <アドレス>」かアドレスだけで書き、複数はカンマか改行で区切ります。`;
    }
    if (lists.to.length === 0 && !next.to) next.to = '宛先を入力してください。';
    const replyTo = draft.replyTo.trim();
    if (replyTo && (splitRecipients(replyTo).length !== 1 || !parseRecipient(replyTo))) next.replyTo = '返信先は、アドレス 1 件で書きます。';
    if (!draft.subject.trim()) next.subject = '件名を入力してください。';
    if (draft.body.length > MAIL_BODY_MAX) next.body = `本文は ${MAIL_BODY_MAX.toLocaleString('ja-JP')} 文字以内にしてください。`;
    if (draft.replyDue && !isDueDate(draft.replyDue)) next.replyDue = '回答期限は、実在する日付で入力してください。';
    else if (draft.replyDue && draft.replyDue !== m.replyDue && draft.replyDue < today) next.replyDue = '回答期限は今日以降の日付にしてください。';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    setFailure(null);
    const body: MailApprovalEditRequest = { expectedVersion: detail.version, ...lists, subject: draft.subject, body: draft.body, replyTo: replyTo || null, replyDue: draft.replyDue || null };
    try {
      onSaved(await api<MailApprovalDetail>('PATCH', `/api/mail/approvals/${detail.id}`, body));
    } catch (err) {
      const f = toFailure(err);
      if (f.status === 409) onConflict(f.message);
      else setFailure(f.message);
    } finally {
      setBusy(false);
    }
  }

  const field = (name: keyof EditErrors) => (errors[name] ? { 'aria-invalid': true as const, 'aria-describedby': `approval-edit-${name}-error` } : {});
  const errorOf = (name: keyof EditErrors) =>
    errors[name] ? (
      <p className="field-error" id={`approval-edit-${name}-error`}>
        {errors[name]}
      </p>
    ) : null;
  return (
    <form
      className="compose-form approval-edit"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-testid="approval-edit"
    >
      <p className="hint">直した内容は、書いた人にも「校閲者が直した項目」として見えます。添付ファイルは変えられません（変えるときは差し戻します）。</p>
      <label htmlFor="approval-edit-to">宛先</label>
      <RecipientInput id="approval-edit-to" rows={1} value={draft.to} onValueChange={(v) => set('to', v)} {...field('to')} />
      {errorOf('to')}
      <label htmlFor="approval-edit-cc">CC</label>
      <RecipientInput id="approval-edit-cc" rows={1} value={draft.cc} onValueChange={(v) => set('cc', v)} {...field('cc')} />
      {errorOf('cc')}
      <label htmlFor="approval-edit-bcc">BCC</label>
      <RecipientInput id="approval-edit-bcc" rows={1} value={draft.bcc} onValueChange={(v) => set('bcc', v)} {...field('bcc')} />
      {errorOf('bcc')}
      <label htmlFor="approval-edit-reply-to">返信先（任意）</label>
      <input id="approval-edit-reply-to" type="text" autoComplete="off" value={draft.replyTo} onChange={(e) => set('replyTo', e.target.value)} {...field('replyTo')} />
      {errorOf('replyTo')}
      <label htmlFor="approval-edit-subject">件名</label>
      <input id="approval-edit-subject" type="text" value={draft.subject} maxLength={MAIL_SUBJECT_MAX} onChange={(e) => set('subject', e.target.value)} {...field('subject')} data-testid="approval-edit-subject" />
      {errorOf('subject')}
      <label htmlFor="approval-edit-body">本文</label>
      <textarea id="approval-edit-body" rows={14} value={draft.body} onChange={(e) => set('body', e.target.value)} {...field('body')} data-testid="approval-edit-body" />
      {errorOf('body')}
      {(detail.canSetDue || m.replyDue) && (
        <>
          <label htmlFor="approval-edit-due">回答期限（任意）</label>
          <input id="approval-edit-due" type="date" value={draft.replyDue} onChange={(e) => set('replyDue', e.target.value)} {...field('replyDue')} />
          {errorOf('replyDue')}
          <p className="field-hint">期限を変えても、本文の中の期限の文は変わりません。本文も合わせて直してください。</p>
        </>
      )}
      {failure && (
        <p className="status error" role="alert">
          {failure}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy} data-testid="approval-edit-save">
          {busy ? '保存しています…' : '修正を保存'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

/** The parts of the mail a reviewer changed, as the author asked for them. */
function Submitted({ detail }: { detail: MailApprovalDetail }) {
  const before = detail.submitted;
  if (!before) return null;
  const text = (field: (typeof detail.changedFields)[number], m: MailApprovalMessage) => {
    const value = m[field];
    return Array.isArray(value) ? value.join('、') || '（なし）' : value || '（なし）';
  };
  return (
    <section className="approval-changed" aria-label="校閲者が直した項目" data-testid="approval-changed">
      <p className="status info">
        校閲者が直した項目：<strong>{detail.changedFields.map((f) => MAIL_APPROVAL_FIELD_LABELS[f]).join('・')}</strong>
      </p>
      <details>
        <summary>依頼したときの内容を見る</summary>
        <dl>
          {detail.changedFields.map((f) => (
            <div key={f}>
              <dt>{MAIL_APPROVAL_FIELD_LABELS[f]}（依頼時）</dt>
              <dd className={f === 'body' ? 'mail-text' : undefined}>{text(f, before)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

export function MailApprovalDetailView({
  id,
  refresh,
  options,
  onChanged,
  onResubmit,
  onOpenThread,
}: {
  id: string;
  refresh: number;
  /** For the checks before sending (the From name); null when the options are not loaded. */
  options: MailSendOptions | null;
  onChanged: () => void;
  /** The author changes a returned mail in the compose form. */
  onResubmit: (detail: MailApprovalDetail) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<MailApprovalDetail>('GET', `/api/mail/approvals/${id}`, undefined, signal);
    },
    [id, refresh],
  );
  const loader = useLoader(load);
  // The answer of the last action here: newer than what was loaded.
  const [acted, setActed] = useState<MailApprovalDetail | null>(null);
  const detail = acted && (!loader.data || acted.version >= loader.data.version) ? acted : loader.data;
  const [mode, setMode] = useState<'view' | 'edit' | 'return' | 'withdraw'>('view');
  const [confirmed, setConfirmed] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'warning'; text: string } | null>(null);
  const notFound = loader.error?.status === 404;
  const today = jstDay(new Date());

  const done = (next: MailApprovalDetail, text: string) => {
    setActed(next);
    setMode('view');
    setConfirmed(false);
    setComment('');
    setMessage({ kind: 'ok', text });
    onChanged();
  };
  const conflict = (text: string) => {
    setMode('view');
    setConfirmed(false);
    setActed(null);
    setMessage({ kind: 'warning', text });
    loader.retry();
    onChanged();
  };

  async function act(what: 'approve' | 'return' | 'withdraw', body: Record<string, unknown>, text: string) {
    if (!detail || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      done(await api<MailApprovalDetail>('POST', `/api/mail/approvals/${detail.id}/${what}`, { expectedVersion: detail.version, ...body }), text);
    } catch (err) {
      const f = toFailure(err);
      if (f.status === 409) conflict(f.message);
      else {
        // After a send that did not go out, or may have: the request's state changed on the server.
        setActed(null);
        setConfirmed(false);
        setMessage({ kind: f.body?.error === SEND_UNKNOWN ? 'warning' : 'error', text: f.message });
        loader.retry();
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <p className="status error" role="alert" data-testid="approval-not-found">
        この依頼は見つからないか、見る権限がありません（書いた人と、その受信箱の校閲者だけが見られます）。
      </p>
    );
  }
  if (!detail) return <LoadStatus loader={loader} what="依頼の内容" />;

  const m = detail.message;
  const parsed = (values: string[]) => values.flatMap((v) => parseRecipient(v) ?? []);
  const findings = detail.canReview
    ? screenMail({ subject: m.subject, body: m.body, to: parsed(m.to), cc: parsed(m.cc), replyTo: m.replyTo ? parseRecipient(m.replyTo) : null, fromAddress: detail.mailbox.address, fromName: options?.fromName ?? '', attachments: detail.attachments.length })
    : [];
  const warnings = findings.filter((f) => f.level === 'warning').length;
  const waitingMine = detail.mine && detail.state === 'pending';
  const returnedMine = detail.mine && detail.state === 'returned';

  return (
    <div className="thread-detail approval-detail" data-testid="approval-detail">
      <LoadStatus loader={loader} what="依頼の内容" />
      <header className="detail-head">
        <h2 className="thread-title">{m.subject || '（件名なし）'}</h2>
        <p className="facts-line">
          <StateChip state={detail.state} />
          <span className="mailbox-badge">{detail.mailbox.name}</span>
          <span>書いた人：{detail.authorName}</span>
          <span>依頼 {fmtDate(detail.createdAt)}</span>
        </p>
      </header>

      {message && (
        <p className={`status ${message.kind}`} role={message.kind === 'ok' ? 'status' : 'alert'} data-testid="approval-message">
          {message.text}
        </p>
      )}
      {detail.state === 'returned' && detail.returnComment && (
        <p className="status warning approval-return" role="status" data-testid="approval-return-comment">
          <strong>
            差し戻しの理由（{detail.decidedByName ?? '校閲者'}
            {detail.decidedAt ? `・${fmtDate(detail.decidedAt)}` : ''}）
          </strong>
          <span className="approval-comment">{detail.returnComment}</span>
        </p>
      )}
      {waitingMine && <p className="status info">校閲者の承認を待っています。承認されると、委員会のアドレスから送られます。</p>}
      {detail.state === 'pending' && !detail.mine && !detail.canReview && <p className="status info">この受信箱の校閲権限が無いため、承認・差し戻しはできません。</p>}
      {detail.state === 'sending' && <p className="status info">承認され、いま送信しています。少し待ってから開き直してください。</p>}
      {detail.state === 'sent' && (
        <p className="status ok" role="status">
          送信済みです（承認：{detail.decidedByName ?? '校閲者'}
          {detail.decidedAt ? `・${fmtDate(detail.decidedAt)}` : ''}）。
          {detail.sentThreadId && (
            <button type="button" className="secondary" onClick={() => onOpenThread(detail.sentThreadId!)} data-testid="approval-open-sent">
              送ったメールを開く
            </button>
          )}
        </p>
      )}
      {detail.state === 'unknown' && (
        <p className="status warning" role="alert">
          承認のあと、送信の途中で接続が切れました。届いている可能性があるので、もう一度は送らず、委員会の Gmail の送信済みか、相手への確認で確かめてください。届いていなければ、新しく書いて出し直します。
        </p>
      )}
      {detail.state === 'withdrawn' && <p className="status info">書いた人が取り下げました。送られていません。</p>}

      {detail.note && (
        <section className="approval-note-box" aria-label="校閲者へのひとこと">
          <h3 className="section-label">校閲者へのひとこと（{detail.authorName}）</h3>
          <p className="mail-text">{detail.note}</p>
        </section>
      )}
      <Submitted detail={detail} />

      {mode === 'edit' ? (
        <EditForm detail={detail} onSaved={(next) => done(next, '修正を保存しました。内容を確かめてから、承認して送信できます。')} onCancel={() => setMode('view')} onConflict={conflict} />
      ) : (
        <div className="compose-preview approval-mail">
          <dl>
            <dt>差出人</dt>
            <dd>
              {options?.fromName ? `${options.fromName} ` : ''}&lt;{detail.mailbox.address}&gt;
            </dd>
            {m.replyTo && (
              <>
                <dt>返信先</dt>
                <dd>{m.replyTo}</dd>
              </>
            )}
            <dt>宛先</dt>
            <dd data-testid="approval-to">{m.to.join('、')}</dd>
            {m.cc.length > 0 && (
              <>
                <dt>CC</dt>
                <dd>{m.cc.join('、')}</dd>
              </>
            )}
            {m.bcc.length > 0 && (
              <>
                <dt>BCC</dt>
                <dd>{m.bcc.join('、')}</dd>
              </>
            )}
            {detail.attachments.length > 0 && (
              <>
                <dt>添付</dt>
                <dd>
                  <ul className="approval-files">
                    {detail.attachments.map((a) => (
                      <li key={a.idx}>
                        <a href={`/api/mail/approvals/${detail.id}/attachments/${a.idx}`} download={a.filename}>
                          {a.filename}
                        </a>{' '}
                        <span className="hint">{fmtSize(a.size)}</span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {m.replyDue && (
              <>
                <dt>回答期限</dt>
                <dd>{japaneseDay(m.replyDue, today)}まで（送ったあと「返事待ち」になります）</dd>
              </>
            )}
            {m.replyToReceiptId && (
              <>
                <dt>返信元</dt>
                <dd>
                  {detail.replyThread ? (
                    <button type="button" className="quiet approval-thread-link" onClick={() => onOpenThread(detail.replyThread!.threadId)}>
                      {detail.replyThread.subject || '（件名なし）'} を開く
                    </button>
                  ) : (
                    '（元のメールを開けません）'
                  )}
                  {m.markThreadDone && <span className="hint approval-done-note">送ったら、このスレッドを「完了」にします</span>}
                </dd>
              </>
            )}
          </dl>
          <pre className="mail-text compose-preview-body" data-testid="approval-body">
            {m.body}
          </pre>
        </div>
      )}

      {detail.canReview && mode !== 'edit' && (
        <section className="approval-actions" aria-labelledby="approval-actions-title" data-testid="approval-review">
          <h3 className="section-label" id="approval-actions-title">
            校閲
          </h3>
          <section className="compose-screen" aria-labelledby="approval-screen-title">
            <h5 id="approval-screen-title">送信前のチェック</h5>
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
          </section>
          {mode === 'return' ? (
            <form
              className="compose-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act('return', { comment }, '差し戻しました。書いた人の「承認待ち」に、理由と一緒に出ます。');
              }}
            >
              <label htmlFor="approval-return-comment">差し戻す理由（書いた人に見えます）</label>
              <textarea id="approval-return-comment" rows={3} value={comment} maxLength={MAIL_APPROVAL_COMMENT_MAX} onChange={(e) => setComment(e.target.value)} data-testid="approval-return-text" />
              <p className="field-hint">どこをどう直してほしいかを書きます。</p>
              <div className="actions">
                <button type="submit" disabled={busy || !comment.trim()} data-testid="approval-return-send">
                  {busy ? '差し戻しています…' : '差し戻す'}
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => setMode('view')}>
                  やめる
                </button>
              </div>
            </form>
          ) : (
            <>
              <label className="confirm-check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} data-testid="approval-confirm" />
                {warnings > 0 ? `注意 ${warnings} 件を確かめたうえで、` : ''}この宛先と内容で、委員会のアドレスから送ります
              </label>
              <div className="actions">
                <button type="button" disabled={!confirmed || busy} onClick={() => void act('approve', {}, '承認して送信しました。')} data-testid="approval-approve">
                  {busy ? '送信しています…' : '承認して送信'}
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => setMode('edit')} data-testid="approval-edit-open">
                  直す
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => setMode('return')} data-testid="approval-return-open">
                  差し戻す…
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {(waitingMine || returnedMine) && (
        <section className="approval-actions" aria-label="この依頼の操作">
          {mode === 'withdraw' ? (
            <div className="actions">
              <span className="approval-ask">取り下げると、添付ファイルごと消えて元に戻せません。取り下げますか？</span>
              <button type="button" className="danger" disabled={busy} onClick={() => void act('withdraw', {}, '取り下げました。このメールは送られません。')} data-testid="approval-withdraw-yes">
                {busy ? '取り下げています…' : '取り下げる'}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setMode('view')}>
                やめる
              </button>
            </div>
          ) : (
            <div className="actions">
              {returnedMine && (
                <button type="button" onClick={() => onResubmit(detail)} data-testid="approval-resubmit">
                  直して出し直す
                </button>
              )}
              <button type="button" className="secondary" disabled={busy} onClick={() => setMode('withdraw')} data-testid="approval-withdraw">
                取り下げる…
              </button>
            </div>
          )}
          {waitingMine && <p className="hint">直したいときは、いったん取り下げて書き直すか、校閲者に差し戻してもらいます。</p>}
        </section>
      )}

      <details className="history" open={detail.history.length <= 4}>
        <summary>履歴（{detail.history.length} 件）</summary>
        <ul>
          {detail.history.map((h, i) => (
            <li key={i}>
              <span>
                {ACTION_LABELS[h.action]}
                {h.action === 'edited' && h.detail ? `（${h.detail}）` : ''}
              </span>
              {h.action === 'returned' && h.detail && <span className="approval-comment">{h.detail}</span>}
              <span className="history-meta">
                {h.actorName}・{fmtDate(h.at)}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
