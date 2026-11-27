import { describe, expect, it } from 'vitest';
import type { ReceiptView } from '../../src/shared/api.js';
import type { MailSendOptions } from '../../src/shared/mailbox.js';
import { replyDraft } from '../../src/client/components/mailDrafts.js';

// Where a reply goes (2026-11-27). A reply to mail a Google Group passed on ("'名前' via システム課" <system@…>) once went
// back to the committee's own group and never reached the sender. Synthetic addresses only.

const GROUP = 'system@committee.example';
const OWN = 'adm@committee.example';
const AUTHOR = { name: '取引先 担当', address: 'person@partner.example' };
const DESK = { name: null, address: 'desk@partner.example' };

const options: MailSendOptions = {
  enabled: true,
  from: [
    { mailboxId: 'system', name: 'システム課', address: GROUP },
    { mailboxId: 'adm', name: '大学窓口', address: OWN },
  ],
  fromName: '合成実行委員会',
  bcc: 'archive@committee.example',
  maxAttachmentBytes: 1024,
  maxRecipients: 50,
  senderName: '合成 太郎',
};

function receipt(over: Partial<ReceiptView>): ReceiptView {
  return {
    receiptId: 'rc_0000000000000001',
    threadId: 'th_0000000000000001',
    mailbox: { id: 'system', name: 'システム課', address: GROUP },
    mailboxes: [{ id: 'system', name: 'システム課', address: GROUP }],
    access: 'read',
    receivedAt: '2026-11-19T00:47:29.000Z',
    subject: '[IT] RE: お問い合わせの件',
    from: { name: "'取引先 担当' via システム課", address: GROUP },
    to: [{ name: null, address: GROUP }],
    cc: [DESK],
    text: '本文',
    hasHtml: false,
    sanitizedHtml: null,
    blockedRemoteResources: 0,
    attachments: [],
    triage: { version: 1, status: 'unhandled', labels: [], assignee: null },
    notes: [],
    history: [],
    ...over,
  } as ReceiptView;
}

describe('replyDraft', () => {
  it('answers mail a group passed on to its author (Reply-To), never to the group', () => {
    const via = receipt({ viaGroup: true, replyTo: [AUTHOR], originalFrom: AUTHOR });
    const reply = replyDraft(options, via, 'reply');
    expect(reply.to).toBe('取引先 担当 <person@partner.example>');
    expect(reply.cc).toBe('');
    expect(reply.viaGroupAddress).toBe(GROUP);
    expect(reply.notice).toBeUndefined();
    // To all: the other people it went to stay in CC; the group (this person's own From) does not.
    expect(replyDraft(options, via, 'replyAll')).toMatchObject({ to: '取引先 担当 <person@partner.example>', cc: 'desk@partner.example' });
  });

  it('does not take group mail for the committee own mail when the person writes from that group', () => {
    // Written to the group and someone else: the author is the answer, the other person stays in CC for all.
    const via = receipt({ viaGroup: true, replyTo: [AUTHOR], originalFrom: AUTHOR, to: [{ name: null, address: GROUP }, DESK], cc: [] });
    expect(replyDraft(options, via, 'reply')).toMatchObject({ to: '取引先 担当 <person@partner.example>', cc: '' });
    expect(replyDraft(options, via, 'replyAll')).toMatchObject({ to: '取引先 担当 <person@partner.example>', cc: 'desk@partner.example' });
    // Without the headers: To stays empty with the notice, not the other person.
    expect(replyDraft(options, { ...via, replyTo: undefined, originalFrom: undefined }, 'reply')).toMatchObject({ to: '', notice: expect.stringContaining(GROUP) });
  });

  it('uses X-Original-From when Reply-To names only the group', () => {
    const via = receipt({ viaGroup: true, replyTo: [{ name: 'システム課', address: GROUP }], originalFrom: AUTHOR });
    expect(replyDraft(options, via, 'reply').to).toBe('取引先 担当 <person@partner.example>');
  });

  it('leaves To empty with a notice when the author of group mail is not known (mail stored before 2026-11-27)', () => {
    const reply = replyDraft(options, receipt({ viaGroup: true }), 'replyAll');
    expect(reply.to).toBe('');
    expect(reply.cc).toBe('desk@partner.example');
    expect(reply.notice).toContain(GROUP);
    expect(reply.viaGroupAddress).toBe(GROUP);
  });

  it('answers other mail at Reply-To when it names someone else, otherwise at From', () => {
    const direct = receipt({ from: AUTHOR, to: [{ name: null, address: GROUP }], cc: [], viaGroup: false });
    expect(replyDraft(options, direct, 'reply')).toMatchObject({ to: '取引先 担当 <person@partner.example>' });
    expect(replyDraft(options, { ...direct, replyTo: [DESK] }, 'reply').to).toBe('desk@partner.example');
    // A Reply-To of the committee's own address is not where an answer to someone else's mail goes.
    expect(replyDraft(options, { ...direct, replyTo: [{ name: null, address: OWN }] }, 'reply').to).toBe('取引先 担当 <person@partner.example>');
  });

  it('answers the committee own mail to whom it was sent', () => {
    const own = receipt({ from: { name: '合成実行委員会', address: GROUP }, to: [AUTHOR], cc: [], viaGroup: false });
    expect(replyDraft(options, own, 'reply').to).toBe('取引先 担当 <person@partner.example>');
  });

  it('writes from the mailbox the message was addressed to, not the first one it is in', () => {
    // The group forwards into the other mailbox, so the message is in both; mailbox order puts the other one first.
    const both = [
      { id: 'adm', name: '大学窓口', address: OWN },
      { id: 'system', name: 'システム課', address: GROUP },
    ];
    const admFirst: MailSendOptions = { ...options, from: [options.from[1]!, options.from[0]!] };
    const via = receipt({ viaGroup: true, replyTo: [AUTHOR], mailboxes: both });
    expect(replyDraft(admFirst, via, 'reply').mailboxId).toBe('system');
    const direct = receipt({ from: AUTHOR, to: [{ name: null, address: GROUP }], cc: [], viaGroup: false, mailboxes: both });
    expect(replyDraft(admFirst, direct, 'reply').mailboxId).toBe('system');
    // Addressed to neither: the first mailbox it is in, as before.
    expect(replyDraft(admFirst, { ...direct, to: [DESK] }, 'reply').mailboxId).toBe('adm');
  });
});
