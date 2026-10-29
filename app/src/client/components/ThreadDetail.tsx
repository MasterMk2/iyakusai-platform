import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { STATUS_LABELS, type Address, type ReceiptView, type ThreadDetailResponse } from '../../shared/api';
import { isMailAddress, REAUTH_REQUIRED, type MailSendOptions, type MailSendResponse } from '../../shared/mailbox';
import { api, fmtDate } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';
import { MailBody } from './MailBody';
import { botReplyRequest, type BotReplyRequest, type DraftToSend } from '../../shared/mailHandoff';
import type { ContactAddressMatch } from '../../shared/contacts';
import type { ContactPrefill } from './contacts/ContactsView';
import { MailCompose, replyDraft } from './MailCompose';
import { Notes } from './Notes';
import { ThreadStatusButtons } from './ThreadStatusButtons';
import { DONE_HINT, TriageForm } from './TriageForm';
import { CaseTasks } from './tasks/CaseTasks';

const HISTORY_LABEL = { assignee: '担当', status: '状態', labels: 'ラベル', note_added: 'メモ追加' } as const;

function fmtAddress(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function fmtKB(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The contacts link of a sender: open the contact, or add the sender as one. */
interface SenderContact {
  match: ContactAddressMatch | null;
  onAdd: () => void;
  onOpen: (contactId: string) => void;
}

/** What the app does with a sender (committee mailbox only). */
export interface ThreadContactLinks {
  onAdd: (prefill: ContactPrefill) => void;
  onOpen: (contactId: string) => void;
}

/**
 * One message: who sent it and when, its handling (assignee and labels; the status is set for the whole
 * thread above), the body, attachments, then internal notes, linked tasks and the change history.
 */
function ReceiptCard({
  receipt,
  onChanged,
  caseTasks,
  threadStatus,
  threadSubject,
  onReply,
  onAskBot,
  contact,
}: {
  receipt: ReceiptView;
  onChanged: () => void;
  caseTasks: boolean;
  threadStatus: boolean;
  threadSubject: string;
  /** Present when this person can send from a committee address. */
  onReply?: (mode: 'reply' | 'replyAll') => void;
  /** Opens the Bot's mail form with this message to answer. */
  onAskBot?: () => void;
  /** The sender in the committee contacts (2026-10-26). */
  contact?: SenderContact;
}) {
  const canEdit = receipt.access === 'edit';
  const canEditStatus = canEdit || receipt.canEditStatus === true;
  // The committee mailbox stores a message once (all its mailboxes, one handling record, addresses as written).
  const committee = receipt.mailboxes !== undefined;
  return (
    <article className="receipt" data-receipt-id={receipt.receiptId} aria-label={receipt.subject}>
      <header className="receipt-head">
        <div className="receipt-from">
          <strong>{receipt.from.name ?? receipt.from.address}</strong>
          {receipt.from.name && <span className="hint">&lt;{receipt.from.address}&gt;</span>}
          <span className="receipt-date">{fmtDate(receipt.receivedAt)}</span>
          {contact &&
            (contact.match ? (
              <button type="button" className="link-button receipt-contact" onClick={() => contact.onOpen(contact.match!.contactId)} data-testid="sender-contact-open">
                連絡先を見る
              </button>
            ) : (
              <button type="button" className="link-button receipt-contact" onClick={contact.onAdd} data-testid="sender-contact-add">
                連絡先に追加
              </button>
            ))}
        </div>
        {/* The thread title already says the subject; a reply's own subject is shown only when it differs. */}
        {receipt.subject !== threadSubject && <h3 className="receipt-subject">{receipt.subject}</h3>}
        <dl className="receipt-addresses">
          <dt>宛先</dt>
          <dd>{receipt.to.map(fmtAddress).join('、') || '（表示できる宛先なし）'}</dd>
          {receipt.cc.length > 0 && (
            <>
              <dt>CC</dt>
              <dd>{receipt.cc.map(fmtAddress).join('、')}</dd>
            </>
          )}
          <dt>受信箱</dt>
          <dd>{(receipt.mailboxes ?? [receipt.mailbox]).map((m) => m.name).join('・')}</dd>
        </dl>
        {!committee && <p className="hint">宛先表示の方針: この受信箱のアドレスとアプリ外のアドレスだけを表示し、他の受信箱のアドレスや配送情報は表示しません。</p>}
        {onReply && (
          <div className="reply-actions">
            <button type="button" className="secondary" onClick={() => onReply('reply')} data-testid="reply">
              返信
            </button>
            {receipt.to.length + receipt.cc.length > 1 && (
              <button type="button" className="secondary" onClick={() => onReply('replyAll')} data-testid="reply-all">
                全員に返信
              </button>
            )}
            {onAskBot && (
              <button type="button" className="secondary" onClick={onAskBot} data-testid="reply-bot">
                Bot に返信の草案を頼む
              </button>
            )}
          </div>
        )}
      </header>
      {/* Handling before the body, so it is changed without scrolling past a long mail. */}
      <section className="handling" aria-label="対応情報">
        {canEditStatus || receipt.canEditAssignmentAndLabels ? (
          <TriageForm
            basePath={`/api/receipts/${receipt.receiptId}`}
            triage={receipt.triage}
            onSaved={onChanged}
            canEditStatus={canEditStatus}
            // The status buttons at the top of the thread set the status and carry the hint.
            showStatus={!threadStatus}
            {...(threadStatus ? { doneHint: '' } : {})}
            {...(committee && (receipt.mailboxes?.length ?? 0) > 1 ? { scopeHint: `担当とラベルは、このメールが載っている ${receipt.mailboxes!.length} つの受信箱で共通です。` } : {})}
          />
        ) : (
          <div className="triage readonly">
            <p className="status info">{committee ? 'このアカウントでは対応情報を編集できません。' : '閲覧のみの権限です。対応情報とメモは編集できません。'}</p>
            <p>
              対応状況: <strong>{STATUS_LABELS[receipt.triage.status]}</strong> ／ 担当者: {receipt.triage.assignee?.displayName ?? '担当なし'} ／ ラベル:{' '}
              {receipt.triage.labels.join(', ') || 'なし'}
            </p>
          </div>
        )}
      </section>
      <MailBody receipt={receipt} />
      {receipt.attachments.length > 0 && (
        <div className="attachments">
          <h4>添付ファイル（{receipt.attachments.length}）<span className="hint">ダウンロードだけ。画面内では開きません</span></h4>
          <ul>
            {receipt.attachments.map((a) => (
              <li key={a.id}>
                <a href={`/api/receipts/${receipt.receiptId}/attachments/${a.id}`} download={a.filename}>
                  {a.filename}
                </a>{' '}
                <span className="hint">
                  {fmtKB(a.size)}・{a.contentType}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <section className="mail-activity" aria-label="内部メモと変更履歴">
        <Notes
          basePath={`/api/receipts/${receipt.receiptId}`}
          notes={receipt.notes}
          canEdit={canEdit}
          onAdded={onChanged}
          {...(committee ? { heading: '内部メモ', description: '委員全員に表示されます。外部には送信されません。' } : {})}
        />
        {caseTasks && <CaseTasks kind="mail" sourceId={receipt.receiptId} />}
        <details className="history">
          <summary>変更履歴（{receipt.history.length} 件）</summary>
          <ul>
            {[...receipt.history].reverse().map((h) => (
              <li key={h.id}>
                {fmtDate(h.at)} {h.actorName}: {HISTORY_LABEL[h.action]}
                {h.action !== 'note_added' && ` 「${h.from ?? 'なし'}」→「${h.to ?? 'なし'}」`}
              </li>
            ))}
          </ul>
        </details>
      </section>
    </article>
  );
}

/** An earlier message of the thread, folded to one line until it is opened. */
function FoldedReceipt({ receipt, children }: { receipt: ReceiptView; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="receipt-fold" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="receipt-fold-from">{receipt.from.name ?? receipt.from.address}</span>
        <span className={`chip status-${receipt.triage.status}`}>{STATUS_LABELS[receipt.triage.status]}</span>
        <span className="receipt-fold-snippet">{receipt.text.replace(/\s+/g, ' ').slice(0, 80)}</span>
        <span className="receipt-date">{fmtDate(receipt.receivedAt)}</span>
      </summary>
      {open && children}
    </details>
  );
}

export function ThreadDetail({
  threadId,
  refresh,
  onChanged,
  caseTasks = false,
  onReauthRequired,
  sendOptions = null,
  onAskBot,
  draft = null,
  onDraftUsed,
  contacts = null,
}: {
  threadId: string;
  refresh: number;
  onChanged: () => void;
  caseTasks?: boolean;
  /** The mail screens need the password again (committee mailbox idle limit). */
  onReauthRequired?: () => void;
  /** Committee mailbox: what this person can send (replies appear only with a From address). */
  sendOptions?: MailSendOptions | null;
  /** Hands a message to the Bot's mail form (a reply draft is asked for there). */
  onAskBot?: (request: BotReplyRequest) => void;
  /** A Bot draft to send as a reply in this thread: the reply form opens with it once. */
  draft?: DraftToSend | null;
  onDraftUsed?: () => void;
  /** Committee contacts: senders get 連絡先に追加 / 連絡先を見る. */
  contacts?: ThreadContactLinks | null;
}) {
  const loadThread = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<ThreadDetailResponse>('GET', `/api/threads/${encodeURIComponent(threadId)}`, undefined, signal);
    },
    [threadId, refresh],
  );
  const thread = useLoader(loadThread);
  const notFound = thread.error && (thread.error.status === 404 || thread.error.status === 400);
  const reauth = thread.error?.body?.error === REAUTH_REQUIRED;
  useEffect(() => {
    if (reauth) onReauthRequired?.();
  }, [reauth, onReauthRequired]);

  const data = thread.data && !notFound ? thread.data : null;
  const threadStatus = !!data?.receipts.some((r) => r.canEditStatus);
  // Newest message last and open; the earlier ones fold to a line each.
  const receipts = data ? [...data.receipts].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)) : [];
  const latest = receipts[receipts.length - 1];

  // Which senders are already contacts (one request per thread; a failure only hides the links).
  const senders = contacts && data ? [...new Set(data.receipts.map((r) => r.from.address.toLowerCase()).filter(isMailAddress))].slice(0, 50).join(',') : '';
  const loadKnown = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return senders ? api<ContactAddressMatch[]>('GET', `/api/contacts/by-address?addresses=${encodeURIComponent(senders)}`, undefined, signal).catch(() => null) : Promise.resolve(null);
    },
    [senders, refresh],
  );
  const known = useLoader(loadKnown).data;
  const contactOf = (r: ReceiptView): SenderContact | undefined => {
    if (!contacts || !known) return undefined;
    const address = r.from.address.toLowerCase();
    return {
      match: known.find((m) => m.address === address) ?? null,
      onAdd: () => contacts.onAdd({ name: r.from.name ?? '', email: r.from.address }),
      onOpen: contacts.onOpen,
    };
  };

  // Replies: committee mail only, for people with a send grant (the server checks again on sending).
  const canSend = !!data?.receipts[0]?.mailboxes && !!sendOptions?.enabled && sendOptions.from.length > 0;
  const [opened, setOpened] = useState<{ mode: 'reply' | 'replyAll'; receipt: ReceiptView; key: string } | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);
  // A Bot draft for this thread opens as the reply to the message it was asked for (the newest if that one
  // is gone), until the form is closed or sent (then the app forgets the draft).
  const draftReceipt = draft?.reply && canSend && !opened ? (data?.receipts.find((r) => r.receiptId === draft.reply!.receiptId) ?? latest ?? null) : null;
  const compose = opened ?? (draft && draftReceipt ? { mode: 'reply' as const, receipt: draftReceipt, key: 'bot-draft', fromBot: { subject: draft.subject, body: draft.body } } : null);
  const composeRef = useRef<HTMLDivElement>(null);
  const composeKey = compose?.key ?? null;
  useEffect(() => {
    if (composeKey) composeRef.current?.scrollIntoView({ block: 'start' });
  }, [composeKey]);
  const closeCompose = () => {
    setOpened(null);
    onDraftUsed?.();
  };
  const replyTo = (r: ReceiptView) =>
    canSend
      ? (mode: 'reply' | 'replyAll') => {
          setSentNote(null);
          onDraftUsed?.();
          setOpened({ mode, receipt: r, key: `${r.receiptId}:${mode}:${Date.now()}` });
        }
      : undefined;
  const askBot = (r: ReceiptView) => (canSend && onAskBot ? () => onAskBot(botReplyRequest(r)) : undefined);
  const sent = (result: MailSendResponse) => {
    closeCompose();
    setSentNote(result.threadDone ? '送信しました。スレッドを「完了」にしました。' : '送信しました。');
    onChanged();
  };

  return (
    <div className="thread-detail">
      {notFound ? (
        <p className="status error" role="alert" data-testid="thread-not-found">
          スレッドが見つからないか、閲覧権限がありません。
        </p>
      ) : (
        <LoadStatus loader={thread} what="スレッド" />
      )}
      {data && latest && (
        <>
          <header className="detail-head">
            <h2 className="thread-title">{data.subject || '（件名なし）'}</h2>
            <p className="facts-line">
              {(data.mailboxes ?? [data.mailbox]).map((m) => (
                <span key={m.id} className="mailbox-badge">
                  {m.name}
                </span>
              ))}
              <span>{receipts.length} 通</span>
              <span>最新 {fmtDate(latest.receivedAt)}</span>
            </p>
          </header>
          {threadStatus && (
            <section className="thread-status" aria-label="スレッドの対応状況">
              <h3 className="section-label">
                対応状況<span className="hint">{receipts.length > 1 ? `押すとすぐ保存（${receipts.length} 通をまとめて変更）` : '押すとすぐ保存'}</span>
              </h3>
              <ThreadStatusButtons
                threadId={data.threadId}
                subject={data.subject}
                statuses={[...new Set(data.receipts.map((r) => r.triage.status))]}
                onChanged={onChanged}
              />
              <p className="hint">{canSend ? '「完了」にしても返信は送信されません。返信は各メールの「返信」から送ります。' : DONE_HINT}</p>
            </section>
          )}
          {receipts.length > 1 && (
            <p className="hint thread-fold-hint">前の {receipts.length - 1} 通はたたんでいます。行を押すと開きます。</p>
          )}
          {receipts.map((r) =>
            r === latest ? (
              <ReceiptCard key={r.receiptId} receipt={r} onChanged={onChanged} caseTasks={caseTasks} threadStatus={threadStatus} threadSubject={data.subject} onReply={replyTo(r)} onAskBot={askBot(r)} contact={contactOf(r)} />
            ) : (
              <FoldedReceipt key={r.receiptId} receipt={r}>
                <ReceiptCard receipt={r} onChanged={onChanged} caseTasks={caseTasks} threadStatus={threadStatus} threadSubject={data.subject} onReply={replyTo(r)} onAskBot={askBot(r)} contact={contactOf(r)} />
              </FoldedReceipt>
            ),
          )}
          {sentNote && (
            <p className="status ok" role="status" data-testid="compose-sent">
              {sentNote}
            </p>
          )}
          {compose && sendOptions && (
            <div ref={composeRef}>
              <MailCompose
                key={compose.key}
                options={sendOptions}
                initial={replyDraft(sendOptions, compose.receipt, compose.mode, 'fromBot' in compose ? compose.fromBot : undefined)}
                mode={compose.mode}
                onCancel={closeCompose}
                onSent={sent}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
