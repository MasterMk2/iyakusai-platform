import { useCallback, type MouseEvent } from 'react';
import type { AssistantMeta } from '../../../shared/assistant';
import { api, ApiFailure } from '../../api';
import type { MailBotLink } from '../../../shared/mailHandoff';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { AskView } from './AskView';
import { CandidatesView } from './CandidatesView';
import { DocView } from './DocView';
import { ImageView } from './ImageView';
import { MailView } from './MailView';
import { PendingJobs } from './PendingJobs';
import { RemindView } from './RemindView';

/** The Bot sub-views (../docs/contracts/bot-front.md §5), in this order. メール was added 2026-10-25. */
export const BOT_SECTIONS = ['ask', 'doc', 'mail', 'image', 'remind', 'candidates'] as const;
export type BotSection = (typeof BOT_SECTIONS)[number];

export const BOT_SECTION_LABELS: Record<BotSection, string> = {
  ask: '質問',
  doc: '文書',
  mail: 'メール',
  image: '画像',
  remind: 'リマインド',
  candidates: 'タスク候補',
};

export function parseBotSection(value: string | undefined): BotSection {
  return BOT_SECTIONS.find((section) => section === value) ?? 'ask';
}

/** The Bot host answered with a feature that is switched off on this server. */
export function isBotDisabled(err: ApiFailure): boolean {
  return err.status === 404 && err.body?.error === 'ASSISTANT_DISABLED';
}

export interface BotViewProps {
  section: BotSection;
  jobId: string | null;
  refresh: number;
  onNavigate: (section: BotSection, jobId?: string | null) => void;
  /** The mail screen's links to the committee mailbox (a message to answer, sending a finished draft). */
  mail?: MailBotLink;
}

/**
 * The Bot tab: a sub-navigation of the screens above, the Bot's state (meta) and the reasons a part cannot be
 * used. The tab itself is always shown (../docs/ui-guidelines.md §2); what is unavailable says why.
 */
export function BotView({ section, jobId, refresh, onNavigate, mail }: BotViewProps) {
  const loadMeta = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<AssistantMeta>('GET', '/api/assistant/meta', undefined, signal);
    },
    [refresh],
  );
  const meta = useLoader(loadMeta);
  const failure = meta.error;
  // The picture screen (画像) is optional: it is shown only when the Bot
  // reports the image feature on. Opening its address while it is off shows the questions instead.
  const imageOn = meta.data?.features.image === true;
  const shown: BotSection = section === 'image' && meta.data && !imageOn ? 'ask' : section;
  const sections = BOT_SECTIONS.filter((item) => item !== 'image' || imageOn);
  const select = (target: BotSection) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(target, null);
  };

  return (
    <main className="main bot" aria-labelledby="bot-title" data-testid="bot">
      <div className="page-head">
        <div>
          <h1 id="bot-title">Bot</h1>
          <p className="hint">IyakusaiBot の機能を、この画面から使えます。結果や通知は Discord にも届きます。</p>
        </div>
      </div>
      <nav className="bot-sections" aria-label="Bot の機能">
        <ul>
          {sections.map((item) => (
            <li key={item}>
              <a href={`#/bot/${item}`} data-testid={`bot-section-${item}`} aria-current={item === shown ? 'page' : undefined} onClick={select(item)}>
                {BOT_SECTION_LABELS[item]}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {meta.loading && <LoadStatus loader={meta} what="Bot の状態" compact />}
      {failure && isBotDisabled(failure) && (
        <p className="status error" role="alert" data-testid="bot-disabled">
          Bot 機能は、このサーバーでは有効になっていません。管理者に設定を確認してもらってください。
        </p>
      )}
      {failure && !isBotDisabled(failure) && failure.status === 403 && (
        <p className="status error" role="alert" data-testid="bot-forbidden">
          {failure.message}
        </p>
      )}
      {failure && !isBotDisabled(failure) && failure.status !== 403 && <LoadStatus loader={meta} what="Bot の状態" />}
      {meta.data && !meta.data.bot.alive && (
        <p className="banner banner-warning" role="status" data-testid="bot-not-alive">
          Bot が応答していません（Discord の Bot が止まっている可能性）。依頼は受け付けられ、Bot が動き出すと順に処理されます。
        </p>
      )}
      {meta.data && !meta.data.bot.alive && <PendingJobs openedJobId={jobId} />}
      {meta.data && (
        <section className="bot-body" aria-label={BOT_SECTION_LABELS[shown]} data-section={shown}>
          {shown === 'ask' && <AskView meta={meta.data} jobId={jobId} onNavigate={onNavigate} />}
          {shown === 'doc' && <DocView meta={meta.data} jobId={jobId} onNavigate={onNavigate} />}
          {shown === 'mail' && <MailView meta={meta.data} jobId={jobId} onNavigate={onNavigate} mail={mail} />}
          {shown === 'image' && <ImageView meta={meta.data} jobId={jobId} onNavigate={onNavigate} />}
          {shown === 'remind' && <RemindView meta={meta.data} />}
          {shown === 'candidates' && <CandidatesView meta={meta.data} />}
        </section>
      )}
    </main>
  );
}
