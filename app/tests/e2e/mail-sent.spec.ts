import type { Page } from '@playwright/test';
import type { ReceiptView } from '../../src/shared/api.js';
import type { MailSendOptions, MailSentItem } from '../../src/shared/mailbox.js';
import { expect, test } from './fixtures.js';

// 送信箱 (2026-11-23) on the production UI with synthetic responses: the entry for members who send and who do not,
// the rows (sent from the app, from Gmail, cut off, refused), filters, and opening a thread beside the list on a PC and
// on a phone. The HTTP tests (tests/mailbox/sent.test.ts) cover the server.
const box = { id: 'contact', name: '問い合わせ', address: 'contact@committee.example' };
const sponsor = { id: 'sponsorship', name: '協賛', address: 'sponsorship@committee.example' };

const item = (changes: Partial<MailSentItem>): MailSentItem => ({
  id: 'rc_0000000000000001', state: 'sent', at: '2026-11-20T01:00:00Z', mailbox: { id: box.id, name: box.name }, via: 'app', senderName: '合成 花子',
  threadId: 'th_0000000000000001', subject: '出展のご案内', to: ['取引先 ご担当者様'], recipients: 2, attachments: 1, replyTo: null, reason: null,
  ...changes,
});

const ITEMS: MailSentItem[] = [
  item({ id: 'og_0000000000000002', state: 'unknown', at: '2026-11-22T03:00:00Z', via: 'app', senderName: '合成 太郎', threadId: null, subject: null, to: [], recipients: 3, attachments: null }),
  item({ id: 'og_0000000000000001', state: 'failed', at: '2026-11-22T02:00:00Z', mailbox: { id: sponsor.id, name: sponsor.name }, senderName: '合成 委員長', threadId: null, subject: null, to: [], recipients: 1, attachments: null, replyTo: { threadId: 'th_0000000000000002', subject: '協賛の件' }, reason: '宛先が受け付けられませんでした（550）' }),
  item({ id: 'rc_0000000000000003', at: '2026-11-21T01:00:00Z', mailbox: { id: sponsor.id, name: sponsor.name }, via: 'gmail', senderName: null, threadId: 'th_0000000000000003', subject: 'Gmail から送ったお礼', to: ['協賛企業 ご担当者様'], recipients: 1, attachments: 0 }),
  item({}),
];

const receipt = (threadId: string, subject: string): ReceiptView => ({
  receiptId: 'rc_0000000000000001', threadId, mailbox: box, mailboxes: [box],
  access: 'read', canEditAssignmentAndLabels: true, canEditStatus: true,
  receivedAt: '2026-11-20T01:00:00Z', subject,
  from: { name: '合成 医学薬学祭実行委員会', address: box.address }, to: [{ name: '取引先 ご担当者様', address: 'sender@partner.example' }], cc: [],
  text: '取引先 ご担当者様\n\n合成テストの本文です。', hasHtml: false, sanitizedHtml: null, blockedRemoteResources: 0,
  attachments: [], triage: { version: 1, status: 'done', assignee: null, labels: [] }, notes: [], history: [],
});

async function mailbox(page: Page, o: { canSend?: boolean; sentBox?: boolean } = {}) {
  const asked: URLSearchParams[] = [];
  const options: MailSendOptions = {
    enabled: true, from: o.canSend ? [box, sponsor].map((b) => ({ mailboxId: b.id, name: b.name, address: b.address })) : [],
    fromName: '合成 医学薬学祭実行委員会', bcc: 'archive@committee.example', maxAttachmentBytes: 15 * 1024 * 1024, maxRecipients: 30, senderName: '合成 太郎',
  };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/api/session') return respond({
      demoAuthentication: false, authMode: 'discord', user: { id: 'iy-000001', displayName: '合成 太郎', roleLabel: '委員', canManageAccess: false },
      account: { initialLoginId: 'iy-000001', studentId: '21000001', departments: [], signIn: { previousLoginAt: null, failedSince: 0 } },
      degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 14,
    });
    if (path === '/api/mail/status') return respond({ enabled: true, canOpen: true, reauthRequired: false, idleHours: 12, unhandledTotal: 0, ...(o.sentBox === false ? {} : { sentBox: true }) });
    if (path === '/api/mail/send/options') return respond(options);
    if (path === '/api/mailboxes') return respond([box, sponsor].map((b) => ({ ...b, access: 'read', threadCount: 1, unhandledCount: 0 })));
    if (path === '/api/tasks/context') return respond({ enabled: false, bound: false, memberships: [] });
    if (path === '/api/rental/me') return respond({ permissions: [] });
    if (path === '/api/line/accounts' || path === '/api/inbox/labels') return respond([]);
    if (path === '/api/inbox') return respond({ items: [], total: 0, page: 1, pageSize: 20, counts: { email: 0, line: 0 }, lineEnabled: false });
    if (path === '/api/mail/sent') {
      const q = url.searchParams;
      asked.push(q);
      const items = ITEMS.filter((i) => (!q.get('mailboxId') || i.mailbox.id === q.get('mailboxId')) && (q.get('state') !== 'problem' || i.state === 'unknown' || i.state === 'failed') && (q.get('mine') !== '1' || i.senderName === '合成 太郎') && (!q.get('q') || (i.subject ?? '').includes(q.get('q')!)));
      return respond({ items, total: items.length, page: 1, pageSize: Number(q.get('pageSize') ?? 20) });
    }
    const thread = /^\/api\/threads\/(th_[0-9a-f]{16})$/.exec(path);
    if (thread) {
      const subject = thread[1] === 'th_0000000000000002' ? '協賛の件' : '出展のご案内';
      return respond({ threadId: thread[1], mailbox: box, mailboxes: [box], subject, receipts: [receipt(thread[1]!, subject)] });
    }
    return respond({ error: 'not_found' }, 404);
  });
  return { asked };
}

test('a member without sending opens 送信箱 from the side column and reads what was sent, opening a thread beside it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { asked } = await mailbox(page);
  await page.goto('/#/all');
  const side = page.locator('.sidebar-send');
  await expect(side.getByRole('button', { name: 'メールを送信' })).toHaveCount(0);
  await side.getByTestId('sent-open').click();
  await expect(page).toHaveURL(/#\/all\?sent=1$/);
  await expect(side.getByTestId('sent-open')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('nav[aria-label="受信箱"] .nav-item[aria-current="page"]')).toHaveCount(0);

  const list = page.getByTestId('sent-list');
  await expect(list.getByRole('heading', { name: '送信箱' })).toBeVisible();
  await expect(list.getByTestId('sent-count')).toHaveText('全 4 件中 1–4 件');
  const rows = list.locator('.rows-list > li');
  await expect(rows).toHaveCount(4);
  // Cut off: may have gone out; no subject is kept, so the row is not a link.
  await expect(rows.nth(0)).toContainText('新しいメール（件名は残っていません）');
  await expect(rows.nth(0)).toContainText('送信できたか不明');
  await expect(rows.nth(0)).toContainText('もう一度は送らず');
  await expect(rows.nth(0)).toContainText('宛先 3 件');
  await expect(rows.nth(0).getByRole('button')).toHaveCount(0);
  // Refused, as a reply: why, and the thread it answers.
  await expect(rows.nth(1)).toContainText('返信: 協賛の件');
  await expect(rows.nth(1)).toContainText('送れなかった');
  await expect(rows.nth(1)).toContainText('宛先が受け付けられませんでした（550）。相手には届いていません。');
  await expect(rows.nth(1)).toContainText('送った人: 合成 委員長');
  await expect(rows.nth(2)).toContainText('Gmail から送信');
  await expect(rows.nth(3)).toContainText('宛先: 取引先 ご担当者様 ほか1');
  await expect(rows.nth(3)).toContainText('添付 1');
  await page.screenshot({ path: '.tmp/sent-box-pc.png' });

  await rows.nth(3).getByRole('button').click();
  await expect(page).toHaveURL(/#\/all\?sent=1&thread=th_0000000000000001$/);
  await expect(page.locator('.detail-pane')).toContainText('合成テストの本文です。');
  await expect(rows.nth(3).locator('.row-open')).toHaveAttribute('aria-current', 'true');
  await expect(list).toBeVisible();

  await rows.nth(1).getByRole('button', { name: '返信先のスレッドを開く' }).click();
  await expect(page).toHaveURL(/thread=th_0000000000000002$/);
  await expect(page.locator('.detail-pane')).toContainText('協賛の件');

  // Filters: the From mailbox is the route's mailbox; the state and "mine" are asked of the server.
  await list.getByLabel('差出').selectOption(sponsor.id);
  await expect(page).toHaveURL(/#\/mailbox\/sponsorship\?sent=1$/);
  await expect(rows).toHaveCount(2);
  await list.getByLabel('状態').selectOption('problem');
  await expect(rows).toHaveCount(1);
  expect(asked.at(-1)?.get('mailboxId')).toBe('sponsorship');
  expect(asked.at(-1)?.get('state')).toBe('problem');
  await list.getByLabel('送った人').selectOption('1');
  await expect(list.getByText('条件に一致する送ったメールはありません。')).toBeVisible();
  await list.locator('.list-empty').getByRole('button', { name: '条件をクリア' }).click();
  await expect(page).toHaveURL(/#\/all\?sent=1$/);
  await expect(rows).toHaveCount(4);
  await expect(list.getByLabel('状態')).toHaveValue('');

  // Back to the mailboxes from the side column.
  await page.locator('nav[aria-label="受信箱"]').getByRole('button', { name: 'すべての受信箱' }).click();
  await expect(page).toHaveURL(/#\/all$/);
  await expect(page.getByTestId('sent-list')).toHaveCount(0);
});

test('on a phone, 送信箱 is above the list, a thread opens over it and goes back to it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mailbox(page, { canSend: true });
  await page.goto('/#/all');
  await page.locator('.list-compose').getByTestId('sent-open-list').click();
  const list = page.getByTestId('sent-list');
  await expect(list.getByRole('button', { name: '← 受信箱の一覧へ' })).toBeVisible();
  await expect(page.locator('.list-compose').getByTestId('sent-open-list')).toHaveCount(0);
  await expect(page.locator('.list-compose').getByRole('button', { name: 'メールを送信' })).toBeVisible();
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scroll).toBeLessThanOrEqual(0);
  await page.screenshot({ path: '.tmp/sent-box-phone.png', fullPage: true });

  await list.locator('.rows-list > li').nth(3).getByRole('button').click();
  await expect(list).toBeHidden();
  await page.getByRole('button', { name: '← 一覧に戻る' }).click();
  await expect(page).toHaveURL(/#\/all\?sent=1$/);
  await expect(page.getByTestId('sent-list')).toBeVisible();
  await page.getByTestId('sent-list').getByRole('button', { name: '← 受信箱の一覧へ' }).click();
  await expect(page).toHaveURL(/#\/all$/);
});

test('an older server without 送信箱 shows no entry, and a link to it opens the mailboxes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mailbox(page, { sentBox: false, canSend: true });
  await page.goto('/#/all?sent=1');
  await expect(page.locator('.sidebar-send').getByRole('button', { name: 'メールを送信' })).toBeVisible();
  await expect(page.getByTestId('sent-open')).toHaveCount(0);
  await expect(page.getByTestId('sent-list')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'すべての受信箱' })).toBeVisible();
});
