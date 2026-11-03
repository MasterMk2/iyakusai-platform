import { useCallback } from 'react';
import { japaneseDay, type MailDueEntry, type MailDueResponse } from '../../shared/mailDue';
import { api } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

// Home (2026-11-03): the mail deadlines, and only mail (the official LINE is not part of it). Two short lists:
// reply waits past their deadline, and response dues near or passed. The wording suggests a next step without
// saying what happened: the partner may have the mail and simply not replied yet.

function EntryLine({ entry, today, onOpenThread }: { entry: MailDueEntry; today: string; onOpenThread?: (threadId: string) => void }) {
  const what = entry.kind === 'reply' ? '回答期限' : '対応期限';
  const when = `${what} ${japaneseDay(entry.dueOn, today)}${entry.kind === 'reply' ? 'まで' : ''}`;
  const subject = entry.subject;
  return (
    <li>
      {onOpenThread ? (
        <button type="button" className="link-button" onClick={() => onOpenThread(entry.threadId)}>
          {subject}
        </button>
      ) : (
        <span>{subject}</span>
      )}
      <span className="hint">
        {' '}
        {entry.mailboxName}・{when}
        {entry.overdue ? '（期限を過ぎています）' : ''}
      </span>
      {entry.kind === 'reply' && entry.overdue && <span className="hint"> 電話などで、相手に届いているかを確かめることを考えてください。</span>}
    </li>
  );
}

export function MailDueCard({ onOpenThread }: { onOpenThread?: (threadId: string) => void }) {
  const load = useCallback((signal: AbortSignal) => api<MailDueResponse>('GET', '/api/mail/due', undefined, signal), []);
  const due = useLoader(load);
  const data = due.data;
  const empty = data !== null && data.counts.replyOverdue === 0 && data.counts.responseDue === 0;
  return (
    <section className="panel home-mail-due" aria-labelledby="home-mail-due-title" id="home-mail-due" tabIndex={-1} data-testid="home-mail-due">
      <div className="panel-head">
        <h2 id="home-mail-due-title">メールの期限</h2>
      </div>
      <LoadStatus loader={due} what="メールの期限" compact />
      {data && !empty && (
        <>
          {data.counts.replyOverdue > 0 && (
            <>
              <h3>
                返事待ちで期限を過ぎたもの <span className="chip due-chip overdue">{data.counts.replyOverdue} 件</span>
              </h3>
              <ul className="rows">
                {data.replyOverdue.map((e) => (
                  <EntryLine key={`r-${e.threadId}`} entry={e} today={data.today} {...(onOpenThread ? { onOpenThread } : {})} />
                ))}
              </ul>
              {data.counts.replyOverdue > data.replyOverdue.length && <p className="hint">ほか {data.counts.replyOverdue - data.replyOverdue.length} 件は受信箱の「期限切れ」で見られます。</p>}
            </>
          )}
          {data.counts.responseDue > 0 && (
            <>
              <h3>
                対応期限が近い・過ぎたもの <span className="chip due-chip wait">{data.counts.responseDue} 件</span>
              </h3>
              <ul className="rows">
                {data.responseDue.map((e) => (
                  <EntryLine key={`s-${e.threadId}`} entry={e} today={data.today} {...(onOpenThread ? { onOpenThread } : {})} />
                ))}
              </ul>
              {data.counts.responseDue > data.responseDue.length && <p className="hint">ほか {data.counts.responseDue - data.responseDue.length} 件は受信箱の「並び：期限の近い順」で見られます。</p>}
            </>
          )}
        </>
      )}
      {empty && <p className="status ok">期限を過ぎた返事待ちや、期限が近い対応はありません。</p>}
    </section>
  );
}
