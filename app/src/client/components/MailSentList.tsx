import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LIMITS, PAGE_SIZE_CHOICES } from '../../shared/api';
import { MAIL_SENT_STATE_LABELS, REAUTH_REQUIRED, type MailSentItem, type MailSentResponse } from '../../shared/mailbox';
import { api, fmtListDate } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

// 送信箱 (2026-11-23): mail sent from the committee mailboxes, newest first, one row per message. A sent row opens
// its thread (the partner's answers show there too). A send that did not go out, or may not have, has no subject or
// text kept: its row says what to do, and opens the thread it answers when it was a reply.

interface Filters {
  q: string;
  /** '' | '1' (自分が送った). */
  mine: string;
  /** '' | 'problem' (送信できたか不明・送れなかった). */
  state: string;
}

const EMPTY: Filters = { q: '', mine: '', state: '' };
// The same remembered page size as the mail list (this device only; storage may be blocked).
const PAGE_SIZE_KEY = 'iyakusai-mail-page-size';

function savedPageSize(): number {
  try {
    const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
    if ((PAGE_SIZE_CHOICES as readonly number[]).includes(saved)) return saved;
  } catch {
    // fall through to the default
  }
  return 20;
}

/** What to do about a send that is not known to have gone out (the words say it; the colour only repeats it). */
const STATE_NOTES: Partial<Record<MailSentItem['state'], string>> = {
  sending: 'いま送っています。少し待ってから読み込み直してください。',
  unknown: '届いている可能性があります。もう一度は送らず、相手か委員会の Gmail の送信済みで確かめてください。',
};

function recipientsText(item: MailSentItem): string {
  if (item.to.length === 0) return `宛先 ${item.recipients} 件`;
  const rest = item.recipients - 1;
  return `宛先: ${item.to[0]}${rest > 0 ? ` ほか${rest}` : ''}`;
}

function SentRow({ item, selected, showMailbox, onOpen }: { item: MailSentItem; selected: boolean; showMailbox: boolean; onOpen: (threadId: string) => void }) {
  const meta = (
    <span className="row-meta">
      <span className="senders" title={item.to.join('、')}>
        {recipientsText(item)}
      </span>
      {showMailbox && <span className="mailbox-names">{item.mailbox.name}</span>}
      <span className="sent-by">{item.senderName ? `送った人: ${item.senderName}` : 'Gmail から送信'}</span>
      {(item.attachments ?? 0) > 0 && <span>添付 {item.attachments}</span>}
    </span>
  );
  if (item.threadId && item.subject !== null) {
    return (
      <li className={`row thread-row ${selected ? 'selected' : ''}`}>
        <button type="button" className={`row-open thread ${selected ? 'selected' : ''}`} aria-current={selected ? 'true' : undefined} onClick={() => onOpen(item.threadId!)} data-sent-id={item.id}>
          <span className="row-line">
            <span className="subject" title={item.subject}>
              {item.subject || '（件名なし）'}
            </span>
            <span className="date">{fmtListDate(item.at)}</span>
          </span>
          {meta}
        </button>
      </li>
    );
  }
  // Not kept here: the subject is not known (a reply names the thread it answers).
  const title = item.replyTo ? `返信: ${item.replyTo.subject}` : '新しいメール（件名は残っていません）';
  const note = item.state === 'failed' ? `${item.reason ?? 'メールサーバーが受け付けませんでした'}。相手には届いていません。` : item.state === 'sent' ? '送信済みです。件名と本文は、委員会の Gmail から記録が取り込まれると（数分）出ます。' : STATE_NOTES[item.state];
  return (
    <li className={`row thread-row sent-unkept sent-${item.state}`} data-sent-id={item.id}>
      <div className="row-open thread">
        <span className="row-line">
          <span className="subject" title={title}>
            {title}
          </span>
          <span className="date">{fmtListDate(item.at)}</span>
        </span>
        {meta}
      </div>
      <div className="row-foot sent-foot">
        <span className="chips">
          <span className={`chip sent-state-${item.state}`}>{MAIL_SENT_STATE_LABELS[item.state]}</span>
        </span>
        {note && <span className="sent-note">{note}</span>}
        {item.replyTo && (
          <button type="button" className="quiet sent-reply-open" onClick={() => onOpen(item.replyTo!.threadId)}>
            返信先のスレッドを開く
          </button>
        )}
      </div>
    </li>
  );
}

export function MailSentList(props: {
  /** The From mailbox shown (null: every mailbox). */
  mailboxId: string | null;
  mailboxes: { id: string; name: string }[];
  selectedThreadId: string | null;
  refresh: number;
  /** The person can write mail (the empty list then says where to start). */
  canSend: boolean;
  onOpenThread: (threadId: string) => void;
  onChooseMailbox: (mailboxId: string | null) => void;
  onBack: () => void;
  onReauthRequired?: () => void;
}) {
  const { mailboxId, refresh } = props;
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(savedPageSize);
  const [formError, setFormError] = useState<string | null>(null);
  // Another From mailbox starts at the first page (the filters stay).
  const [shownMailbox, setShownMailbox] = useState(mailboxId);
  if (shownMailbox !== mailboxId) {
    setShownMailbox(mailboxId);
    setPage(1);
  }

  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      const params = new URLSearchParams();
      if (mailboxId) params.set('mailboxId', mailboxId);
      for (const [key, value] of Object.entries(applied)) if (value) params.set(key, value);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      return api<MailSentResponse>('GET', `/api/mail/sent?${params.toString()}`, undefined, signal);
    },
    [mailboxId, applied, page, pageSize, refresh],
  );
  const list = useLoader(load);
  const reauth = list.error?.body?.error === REAUTH_REQUIRED;
  const { onReauthRequired } = props;
  useEffect(() => {
    if (reauth) onReauthRequired?.();
  }, [reauth, onReauthRequired]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (draft.q.length > LIMITS.queryMaxLength) {
      setFormError(`検索語は ${LIMITS.queryMaxLength} 文字以内で入力してください。`);
      return;
    }
    setFormError(null);
    setPage(1);
    setApplied({ ...draft, q: draft.q.trim() });
  }

  // A choice in a list box filters at once (the keyword waits for Enter or 検索, as it is typed).
  function choose(key: 'mine' | 'state', value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setPage(1);
    setApplied((a) => ({ ...a, [key]: value }));
  }

  function changePageSize(next: number) {
    setPage(Math.floor(((page - 1) * pageSize) / next) + 1);
    setPageSize(next);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(next));
    } catch {
      // not remembered; this view still uses it
    }
  }

  function clear() {
    setDraft(EMPTY);
    setApplied(EMPTY);
    setPage(1);
    setFormError(null);
    if (mailboxId) props.onChooseMailbox(null);
  }

  const data = list.data;
  const filtered = !!mailboxId || Object.values(applied).some(Boolean);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="thread-list sent-list" data-testid="sent-list">
      <button type="button" className="quiet sent-back" onClick={props.onBack}>
        ← 受信箱の一覧へ
      </button>
      <header className="pane-head">
        <div className="pane-title">
          <h2>送信箱</h2>
          <span className="pane-sub">委員会のアドレスから送ったメール（このアプリからと、Gmail から直接）</span>
        </div>
      </header>
      <form className="list-tools filters" onSubmit={submit} role="search" aria-label="送ったメールの検索">
        <div className="search-row">
          <input type="search" className="list-search" aria-label="検索語" placeholder="件名・宛先・本文で検索" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          <button type="submit" className="secondary">
            検索
          </button>
        </div>
        <div className="filter-row">
          <label>
            差出
            <select aria-label="差出" value={mailboxId ?? ''} onChange={(e) => props.onChooseMailbox(e.target.value || null)}>
              <option value="">すべての受信箱</option>
              {props.mailboxes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            送った人
            <select aria-label="送った人" value={draft.mine} onChange={(e) => choose('mine', e.target.value)}>
              <option value="">すべて</option>
              <option value="1">自分が送った</option>
            </select>
          </label>
          <label>
            状態
            <select aria-label="状態" value={draft.state} onChange={(e) => choose('state', e.target.value)}>
              <option value="">すべて</option>
              <option value="problem">送信できたか不明・送れなかった</option>
            </select>
          </label>
        </div>
      </form>
      {formError && (
        <p className="status error" role="alert">
          {formError}
        </p>
      )}
      <LoadStatus loader={list} what="送ったメールの一覧" />
      {data && (
        <>
          <div className="list-bar">
            <p className="count" data-testid="sent-count">
              {data.total === 0 ? '0 件' : `全 ${data.total} 件中 ${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)} 件`}
            </p>
            {filtered && (
              <button type="button" className="quiet" onClick={clear}>
                条件をクリア
              </button>
            )}
            <label className="page-size">
              表示件数
              <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
                {PAGE_SIZE_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n} 件
                  </option>
                ))}
              </select>
            </label>
          </div>
          {data.total === 0 && (
            <div className="empty list-empty">
              {filtered ? (
                <>
                  <p>条件に一致する送ったメールはありません。</p>
                  <button type="button" className="secondary" onClick={clear}>
                    条件をクリア
                  </button>
                </>
              ) : (
                <p>まだ送ったメールはありません。{props.canSend ? '「メールを送信」から送ると、ここに出ます。' : ''}</p>
              )}
            </div>
          )}
          <ul className="rows-list threads">
            {data.items.map((item) => (
              <SentRow key={item.id} item={item} selected={!!item.threadId && item.threadId === props.selectedThreadId} showMailbox={!mailboxId} onOpen={props.onOpenThread} />
            ))}
          </ul>
          {data.total > data.pageSize && (
            <div className="pager">
              <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                前へ
              </button>
              <span>
                {page} / {pages} ページ
              </span>
              <button type="button" className="secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>
                次へ
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
