import type { User } from '../domain/types.js';

// Telling people on Discord about an approval before sending (2026-11-11): a request arrived (to the mailbox's
// reviewers), it was approved and sent, or it was returned (to its author). The Bot delivers the text as a direct
// message (contract: docs/contracts/bot-front.md, POST /assistant/notices). The text never carries an address,
// the subject or the mail's text: a person whose direct messages are closed gets it as a mention in a channel.
// A notice that cannot be delivered changes nothing: the counts on the mail screens are the record.

export type ApprovalNoticeKind = 'requested' | 'approved' | 'returned';

export interface ApprovalNotice {
  kind: ApprovalNoticeKind;
  requestId: string;
  /** The request's version after the step: with the kind, it names this one notice (a retry is not sent twice). */
  version: number;
  /** Who took the step: the author (requested) or the reviewer (approved, returned). */
  actor: User;
  /** Whom to tell: the reviewers (requested) or the author. */
  targets: User[];
  mailboxName: string;
  authorName: string;
}

export type ApprovalNotifier = (notice: ApprovalNotice) => void;

export const APPROVAL_NOTICE_MAX_TARGETS = 30;

/** Where the request opens in the app, or null when the app's public address is not known. */
export function approvalUrl(publicOrigin: string | null, requestId: string): string | null {
  return publicOrigin ? `${publicOrigin.replace(/\/+$/, '')}/#/all?approval=${encodeURIComponent(requestId)}` : null;
}

export function approvalNoticeText(notice: ApprovalNotice, publicOrigin: string | null): string {
  const url = approvalUrl(publicOrigin, notice.requestId);
  const where = `統合アプリの「メール › 承認待ち」${url ? `\n${url}` : ''}`;
  const lines =
    notice.kind === 'requested'
      ? [`📨 メールの承認依頼が届きました（書いた人：${notice.authorName}／受信箱：${notice.mailboxName}）。`, `内容を確かめて、承認か差し戻しをしてください。${where}`]
      : notice.kind === 'approved'
        ? [`✅ 依頼したメール（受信箱：${notice.mailboxName}）が ${notice.actor.displayName} さんに承認され、送信されました。`, where]
        : [`↩️ 依頼したメール（受信箱：${notice.mailboxName}）が ${notice.actor.displayName} さんから差し戻されました。`, `理由を確かめて、直して出し直すか取り下げてください。${where}`];
  return lines.join('\n').slice(0, 500);
}
