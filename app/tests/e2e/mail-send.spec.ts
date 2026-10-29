import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { ReceiptView } from '../../src/shared/api.js';
import type { MailSendOptions, MailSendRequest } from '../../src/shared/mailbox.js';
import { installBotFake, MAIL_SUBJECT } from './assistant-fake.js';
import { expect, test } from './fixtures.js';

// Sending from the committee mailbox (2026-10-26) on the production UI with synthetic responses; the HTTP
// tests (tests/mailbox/send.test.ts) cover the server, grants and SMTP.
const box = { id: 'contact', name: '問い合わせ', address: 'contact@committee.example' };
const sponsor = { id: 'sponsorship', name: '協賛', address: 'sponsorship@committee.example' };

interface Sent {
  message: MailSendRequest;
  files: string[];
}

function readForm(body: Buffer): Sent {
  const text = body.toString('utf8');
  const json = /name="message"\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1] ?? '{}';
  const files = [...text.matchAll(/name="attachments"; filename="([^"]*)"/g)].map((m) => m[1]!);
  return { message: JSON.parse(json) as MailSendRequest, files };
}

async function mailbox(page: Page, o: { from?: MailSendOptions['from']; sendAnswer?: { status: number; json: unknown }; receipt?: Partial<ReceiptView> } = {}) {
  const receipt: ReceiptView = {
    receiptId: 'rc_0000000000000001', threadId: 'th_0000000000000001', mailbox: box, mailboxes: [box],
    access: 'read', canEditAssignmentAndLabels: true, canEditStatus: true,
    receivedAt: '2026-10-14T01:00:00Z', subject: '合成メールの問い合わせ',
    from: { name: '取引先', address: 'sender@partner.example' }, to: [{ name: null, address: box.address }], cc: [{ name: '取引先 上長', address: 'boss@partner.example' }],
    text: '合成テストの本文です。\n二行目です。', hasHtml: false, sanitizedHtml: null, blockedRemoteResources: 0,
    attachments: [], triage: { version: 1, status: 'unhandled', assignee: null, labels: [] }, notes: [], history: [],
    ...o.receipt,
  };
  const options: MailSendOptions = {
    enabled: true, from: o.from ?? [box, sponsor].map((b) => ({ mailboxId: b.id, name: b.name, address: b.address })),
    fromName: '合成 医学薬学祭実行委員会', bcc: 'archive@committee.example', maxAttachmentBytes: 15 * 1024 * 1024, maxRecipients: 30, senderName: '合成 太郎',
  };
  const sent: Sent[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/api/session') return respond({
      demoAuthentication: false, authMode: 'discord', user: { id: 'iy-000001', displayName: '合成 太郎', roleLabel: '委員', canManageAccess: false },
      account: { initialLoginId: 'iy-000001', studentId: '21000001', departments: [], signIn: { previousLoginAt: null, failedSince: 0 } },
      degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 14,
    });
    if (path === '/api/mail/status') return respond({ enabled: true, canOpen: true, reauthRequired: false, idleHours: 12, unhandledTotal: 1 });
    if (path === '/api/mail/send/options') return respond(options);
    if (path === '/api/mailboxes') return respond([{ ...box, access: 'read', threadCount: 1, unhandledCount: 1 }]);
    if (path === '/api/tasks/context') return respond({ enabled: false, bound: false, memberships: [] });
    if (path === '/api/rental/me') return respond({ permissions: [] });
    if (path === '/api/line/accounts' || path === '/api/inbox/labels') return respond([]);
    if (path === '/api/inbox') {
      return respond({
        items: [{ source: 'email', threadId: receipt.threadId, mailbox: box, mailboxes: [box], subject: receipt.subject, latestReceivedAt: receipt.receivedAt, receiptCount: 1, matchCount: 1, snippet: receipt.text, senders: ['取引先'], statuses: [receipt.triage.status], labels: [], assignees: [], canSetStatus: true }],
        total: 1, page: 1, pageSize: 5, counts: { email: 1, line: 0 }, lineEnabled: false,
      });
    }
    if (path === `/api/threads/${receipt.threadId}`) return respond({ threadId: receipt.threadId, mailbox: box, mailboxes: [box], subject: receipt.subject, receipts: [receipt] });
    if (path === '/api/mail/send' && route.request().method() === 'POST') {
      sent.push(readForm(route.request().postDataBuffer()!));
      if (o.sendAnswer) return respond(o.sendAnswer.json, o.sendAnswer.status);
      receipt.triage = { ...receipt.triage, status: 'done' };
      return respond({ status: 'sent', receiptId: 'rc_0000000000000002', threadId: receipt.threadId, threadDone: sent[sent.length - 1]!.message.markThreadDone });
    }
    return respond({ error: 'not_found' }, 404);
  });
  return { receipt, sent };
}

test('a member with a send grant replies from the thread after checking what will be sent', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { sent } = await mailbox(page);
  await page.goto('/#/all?thread=th_0000000000000001');
  await page.getByRole('button', { name: '返信', exact: true }).click();
  const compose = page.getByRole('region', { name: '返信' });
  await expect(compose).toBeVisible();
  await expect(compose.getByLabel('差出人')).toHaveValue('contact');
  await expect(compose.getByLabel('宛先', { exact: true })).toHaveValue('取引先 <sender@partner.example>');
  // CC, BCC and the reply-to address are folded while empty; one press opens them, on the CC field.
  await expect(compose.getByLabel('CC', { exact: true })).toHaveCount(0);
  const more = compose.getByRole('button', { name: '＋ CC・BCC・返信先' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(compose.getByLabel('CC', { exact: true })).toBeFocused();
  await expect(compose.getByLabel('CC', { exact: true })).toHaveValue('');
  await expect(compose.getByLabel('返信先（任意）')).toHaveValue('');
  await expect(more).toHaveCount(0);
  await expect(compose.getByLabel('件名')).toHaveValue('Re: 合成メールの問い合わせ');
  const body = await compose.getByLabel('本文').inputValue();
  expect(body).toContain('合成 医学薬学祭実行委員会\n問い合わせ（contact@committee.example）\n合成 太郎');
  expect(body).toContain('> 合成テストの本文です。\n> 二行目です。');
  await expect(compose.getByText('archive@committee.example にも BCC で届きます')).toBeVisible();
  await compose.getByLabel('本文').fill(`取引先 様\n\nお問い合わせありがとうございます。\n${body}`);

  await compose.getByRole('button', { name: '送信内容を確認' }).click();
  const send = compose.getByRole('button', { name: '送信する' });
  await expect(send).toBeDisabled();
  await expect(compose.getByTestId('preview-to')).toHaveText('取引先 <sender@partner.example>');
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/mail-send-reply-mobile.png', fullPage: true });
  await compose.getByLabel('この宛先と内容で、委員会のアドレスから送ります').check();
  await send.click();
  await expect(page.getByTestId('compose-sent')).toHaveText('送信しました。スレッドを「完了」にしました。');
  await expect(compose).toBeHidden();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.message).toMatchObject({ mailboxId: 'contact', to: ['取引先 <sender@partner.example>'], cc: [], bcc: [], subject: 'Re: 合成メールの問い合わせ', replyToReceiptId: 'rc_0000000000000001', markThreadDone: true });
  expect(sent[0]!.message.clientToken).toMatch(/^[0-9a-f]{32}$/);
  expect(sent[0]!.message.body.startsWith('取引先 様')).toBe(true);
});

test('reply to all keeps the other recipients; new mail checks addresses and carries attachments', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { sent } = await mailbox(page);
  await page.goto('/#/all?thread=th_0000000000000001');
  await page.getByRole('button', { name: '全員に返信' }).click();
  const all = page.getByRole('region', { name: '全員に返信' });
  // A reply to all brings CC, so the folded fields are open from the start.
  await expect(all.getByLabel('CC', { exact: true })).toHaveValue('取引先 上長 <boss@partner.example>');
  await expect(all.getByRole('button', { name: '＋ CC・BCC・返信先' })).toHaveCount(0);
  await all.getByRole('button', { name: '閉じる' }).click();
  await expect(all).toBeHidden();

  await page.getByRole('button', { name: '新しいメールを書く' }).click();
  await expect(page).toHaveURL(/compose=1/);
  const compose = page.getByRole('region', { name: '新しいメール' });
  await compose.getByLabel('差出人').selectOption('sponsorship');
  await compose.getByLabel('宛先', { exact: true }).fill('株式会社 合成 ご担当者様 <contact@partner.example>, 山田 様');
  await compose.getByLabel('件名').fill('協賛のお願い');
  await compose.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(compose.getByText('宛先の「山田 様」はメールアドレスとして読めません。', { exact: false })).toBeVisible();
  await expect(compose.getByLabel('宛先', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  expect(sent).toHaveLength(0);

  await compose.getByLabel('宛先', { exact: true }).fill('株式会社 合成 ご担当者様 <contact@partner.example>\n"山田, 太郎" <yamada@partner.example>');
  await compose.getByTestId('compose-files').setInputFiles([{ name: '協賛申込書.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-synthetic') }]);
  await expect(compose.getByText('協賛申込書.pdf')).toBeVisible();
  await compose.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(compose.getByTestId('preview-to')).toHaveText('株式会社 合成 ご担当者様 <contact@partner.example>、"山田, 太郎" <yamada@partner.example>');
  await expect(compose.getByText('協賛申込書.pdf（1 KB）')).toBeVisible();
  await page.screenshot({ path: '.tmp/mail-send-new-desktop.png', fullPage: true });
  await compose.getByLabel('この宛先と内容で、委員会のアドレスから送ります').check();
  await compose.getByRole('button', { name: '送信する' }).click();
  // The sent message's thread opens.
  await expect(page).toHaveURL(/thread=th_0000000000000001/);
  await expect(page.getByRole('heading', { name: '合成メールの問い合わせ' })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.message).toMatchObject({ mailboxId: 'sponsorship', to: ['株式会社 合成 ご担当者様 <contact@partner.example>', '"山田, 太郎" <yamada@partner.example>'], replyToReceiptId: null, markThreadDone: false });
  expect(sent[0]!.message.body).toContain('協賛（sponsorship@committee.example）');
  expect(sent[0]!.files).toEqual(['協賛申込書.pdf']);
});

test('new mail can name a reply-to address other than From; it shows when checking, and one outside is pointed out', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { sent } = await mailbox(page);
  await page.goto('/#/all?thread=th_0000000000000001');
  await page.getByRole('button', { name: '新しいメールを書く' }).click();
  const compose = page.getByRole('region', { name: '新しいメール' });
  await compose.getByLabel('差出人').selectOption('sponsorship');
  await compose.getByLabel('宛先', { exact: true }).fill('株式会社 合成 ご担当者様 <company@partner.example>');
  await compose.getByLabel('件名').fill('協賛のお願い');
  await compose.getByLabel('本文').fill('株式会社 合成 ご担当者様\n\n協賛のお願いでご連絡いたしました。よろしくお願いいたします。\n\n--\n合成 医学薬学祭実行委員会\n合成 太郎\n');
  // Two addresses, then one outside the committee.
  await compose.getByRole('button', { name: '＋ CC・BCC・返信先' }).click();
  const replyTo = compose.getByLabel('返信先（任意）');
  await replyTo.fill('contact@committee.example, someone@partner.example');
  await compose.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(compose.getByText('返信先は 1 件だけ指定できます。')).toBeVisible();
  await expect(replyTo).toHaveAttribute('aria-invalid', 'true');
  await replyTo.fill('個人 <someone@partner.example>');
  await compose.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(compose.getByTestId('compose-screen')).toContainText('返信先（someone@partner.example）が委員会の外のアドレスです。');
  await compose.getByRole('button', { name: '編集に戻る' }).click();
  // The committee's other address, as offered for the field.
  await expect(compose.locator('#compose-reply-to-list option')).toHaveAttribute('value', 'contact@committee.example');
  await replyTo.fill('contact@committee.example');
  await compose.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(compose.getByTestId('preview-reply-to')).toContainText('contact@committee.example');
  await expect(compose.getByTestId('compose-screen')).not.toContainText('返信先');
  await page.screenshot({ path: '.tmp/mail-send-reply-to.png', fullPage: true });
  await compose.getByLabel('この宛先と内容で、委員会のアドレスから送ります').check();
  await compose.getByRole('button', { name: '送信する' }).click();
  await expect(page).toHaveURL(/thread=th_0000000000000001/);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.message).toMatchObject({ mailboxId: 'sponsorship', replyTo: 'contact@committee.example' });
});

test('a reply-to address that is From itself is not sent', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { sent } = await mailbox(page);
  await page.goto('/#/all?thread=th_0000000000000001');
  await page.getByRole('button', { name: '返信', exact: true }).click();
  const reply = page.getByRole('region', { name: '返信' });
  await reply.getByRole('button', { name: '＋ CC・BCC・返信先' }).click();
  await expect(reply.getByLabel('返信先（任意）')).toHaveValue('');
  await reply.getByLabel('返信先（任意）').fill('CONTACT@committee.example');
  await reply.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(reply.getByTestId('preview-reply-to')).toHaveCount(0);
  await reply.getByLabel('この宛先と内容で、委員会のアドレスから送ります').check();
  await reply.getByRole('button', { name: '送信する' }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]!.message.replyTo).toBeNull();
});

test('sending has its own place apart from the mailboxes: the side column on a wide screen, above the list on a narrow one', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mailbox(page);
  await page.goto('/#/all');
  const send = page.getByRole('region', { name: '送信' });
  await expect(send).toBeVisible();
  await expect(send).toContainText('委員会のアドレスから送ります。');
  // One way in on a wide screen, outside the mailbox list.
  await expect(page.getByRole('button', { name: '新しいメールを書く' })).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: '受信箱' }).getByRole('button', { name: '新しいメールを書く' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'スレッド一覧' }).getByRole('button', { name: '新しいメールを書く' })).toHaveCount(0);
  await send.getByRole('button', { name: '新しいメールを書く' }).click();
  // While writing, the send entry is the current place, not a mailbox.
  await expect(send.getByRole('button', { name: '新しいメールを書く' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: '受信箱' }).getByRole('button', { name: /すべての受信箱/ })).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: '新しいメール' })).toContainText('送ったメールは、差出人の受信箱に「完了」で残ります。');
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/mail-send-entry-1280.png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/all');
  const narrow = page.getByRole('region', { name: 'スレッド一覧' }).getByRole('region', { name: '送信' });
  await expect(narrow).toBeVisible();
  await expect(page.getByRole('button', { name: '新しいメールを書く' })).toHaveCount(1);
  await page.screenshot({ path: '.tmp/mail-send-entry-390.png' });
  await narrow.getByRole('button', { name: '新しいメールを書く' }).click();
  await expect(page.getByRole('region', { name: '新しいメール' })).toBeVisible();
});

test('a send that may have gone out cannot be sent again from the form', async ({ page }) => {
  const { sent } = await mailbox(page, { sendAnswer: { status: 502, json: { error: 'send_unknown', message: '送信できたか確認できませんでした（合成）。' } } });
  await page.goto('/#/all?thread=th_0000000000000001');
  await page.getByRole('button', { name: '返信', exact: true }).click();
  const compose = page.getByRole('region', { name: '返信' });
  await compose.getByRole('button', { name: '送信内容を確認' }).click();
  await compose.getByLabel('この宛先と内容で、委員会のアドレスから送ります').check();
  await compose.getByRole('button', { name: '送信する' }).click();
  await expect(compose.getByRole('alert')).toHaveText('送信できたか確認できませんでした（合成）。');
  await expect(compose.getByRole('button', { name: '送信する' })).toBeDisabled();
  expect(sent).toHaveLength(1);
});

test('replies to the committee own mail go back to its recipients, never to our own addresses or the archive', async ({ page }) => {
  // Sent from contact@ to the partner, with the archive, another sendable address and the partner's boss in Cc.
  await mailbox(page, {
    receipt: {
      from: { name: '合成 医学薬学祭実行委員会', address: box.address },
      to: [{ name: '取引先', address: 'sender@partner.example' }],
      cc: [{ name: null, address: 'archive@committee.example' }, { name: null, address: sponsor.address }, { name: '上長', address: 'boss@partner.example' }],
    },
  });
  await page.goto('/#/all?thread=th_0000000000000001');
  await page.getByRole('button', { name: '全員に返信' }).click();
  const all = page.getByRole('region', { name: '全員に返信' });
  await expect(all.getByLabel('宛先', { exact: true })).toHaveValue('取引先 <sender@partner.example>');
  await expect(all.getByLabel('CC', { exact: true })).toHaveValue('上長 <boss@partner.example>');
});

test('a reply to mail from another committee address goes to that address', async ({ page }) => {
  await mailbox(page, { receipt: { from: { name: '総務', address: 'soumu@committee.example' }, to: [{ name: null, address: box.address }], cc: [] } });
  await page.goto('/#/all?thread=th_0000000000000001');
  await page.getByRole('button', { name: '返信', exact: true }).click();
  await expect(page.getByRole('region', { name: '返信' }).getByLabel('宛先', { exact: true })).toHaveValue('総務 <soumu@committee.example>');
});

test('without a send grant there is no reply or new mail button', async ({ page }) => {
  await mailbox(page, { from: [] });
  await page.goto('/#/all?thread=th_0000000000000001');
  await expect(page.getByRole('heading', { name: '合成メールの問い合わせ' })).toBeVisible();
  await expect(page.getByRole('button', { name: '返信', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新しいメールを書く' })).toHaveCount(0);
});

test('a reply drafted by the Bot from the thread opens as the reply, and the checks find its blanks', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mailbox(page);
  const fake = await installBotFake(page);
  const jobsBefore = fake.jobs.size;
  await page.goto('/#/all?thread=th_0000000000000001');
  await page.getByRole('button', { name: 'Bot に返信の草案を頼む' }).click();
  await expect(page).toHaveURL(/#\/bot\/mail$/);
  await expect(page.getByTestId('mail-reply-target')).toContainText('「合成メールの問い合わせ」への返信の草案');
  await expect(page.getByTestId('mail-to')).toHaveValue('取引先 様');
  await expect(page.getByTestId('mail-received')).toHaveValue('合成テストの本文です。\n二行目です。');
  await expect(page.getByTestId('mail-details')).toHaveAttribute('open', '');
  // Nothing went to the Bot yet.
  expect(fake.jobs.size).toBe(jobsBefore);
  await page.getByTestId('mail-purpose').fill('問い合わせに回答する');
  await page.getByTestId('mail-submit').click();
  await expect(page.getByTestId('mail-draft')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'この草案で返信する' }).click();

  await expect(page).toHaveURL(/thread=th_0000000000000001/);
  const compose = page.getByRole('region', { name: '返信' });
  await expect(compose.getByLabel('件名')).toHaveValue(MAIL_SUBJECT);
  await expect(compose.getByLabel('宛先', { exact: true })).toHaveValue('取引先 <sender@partner.example>');
  const body = await compose.getByLabel('本文').inputValue();
  expect(body.startsWith('株式会社サンプル\n【担当者名】様')).toBe(true);
  // The committee's signature is added (the Bot wrote another name) and the message answered is quoted.
  expect(body).toContain('合成 医学薬学祭実行委員会\n問い合わせ（contact@committee.example）');
  expect(body).toContain('> 合成テストの本文です。');
  await compose.getByRole('button', { name: '送信内容を確認' }).click();
  await expect(compose.getByTestId('compose-screen')).toContainText('書きかけの箇所が残っているようです：【担当者名】、【氏名】');
  await expect(compose.getByLabel(/注意 1 件を確かめたうえで/)).toBeVisible();
});

test('the checks before sending list a wrong weekday, a missing signature and an attachment not attached', async ({ page }) => {
  await mailbox(page);
  await page.goto('/#/all?compose=1');
  const compose = page.getByRole('region', { name: '新しいメール' });
  await compose.getByLabel('宛先', { exact: true }).fill('<contact@partner.example>');
  await compose.getByLabel('件名').fill('打合せのご案内');
  await compose.getByLabel('本文').fill('株式会社サンプル 御中\n\n2026年10月27日（月）の打合せの資料を添付します。よろしくお願いいたします。');
  await compose.getByRole('button', { name: '送信内容を確認' }).click();
  const checks = compose.getByTestId('compose-screen');
  await expect(checks).toContainText('署名が見当たりません');
  await expect(checks).toContainText('「2026年10月27日(月)」の曜日が違います（2026年10月27日は火曜日）。');
  await expect(checks).toContainText('本文に「添付」とありますが、ファイルが付いていません。');
  await expect(compose.getByLabel(/注意 3 件を確かめたうえで、この宛先と内容で/)).toBeVisible();
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/mail-send-checks.png', fullPage: true });
  await compose.getByRole('button', { name: '編集に戻る' }).click();
  await expect(compose.getByLabel('本文')).toHaveValue(/2026年10月27日（月）/);
});

test('the Bot proofreads and fact-checks the mail being written, without the addresses', async ({ page }) => {
  await mailbox(page);
  const fake = await installBotFake(page);
  await page.goto('/#/all?thread=th_0000000000000001');
  await page.getByRole('button', { name: '返信', exact: true }).click();
  const compose = page.getByRole('region', { name: '返信' });
  await compose.getByLabel('本文').fill('取引先 様\n\n10月30日（金）に伺います。\n\n--\n合成 医学薬学祭実行委員会\n\n> 合成テストの本文です。');
  const review = compose.getByTestId('mail-review');
  await review.getByRole('button', { name: '校閲・ファクトチェックを頼む' }).click();
  await expect(review.getByTestId('job-panel')).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
  await expect(review).toContainText('文書の本文です。');
  const job = [...fake.jobs.values()].find((j) => j.input.docType === 'free');
  expect(job!.kind).toBe('doc');
  expect(job!.input).toMatchObject({ docType: 'free', format: 'txt', useSources: true });
  const content = String(job!.input.content);
  expect(content).toContain('【件名】Re: 合成メールの問い合わせ');
  expect(content).toContain('【宛先】取引先');
  expect(content).toContain('10月30日（金）に伺います。');
  expect(content).not.toContain('@partner.example');
  expect(content).not.toContain('> 合成テストの本文です。');
  await page.screenshot({ path: '.tmp/mail-send-review.png', fullPage: true });
  // Changing the text after asking says the answer is for the earlier text.
  await compose.getByLabel('本文').fill('取引先 様\n\n10月30日（金）の午後に伺います。\n\n--\n合成 医学薬学祭実行委員会');
  await expect(review).toContainText('依頼したあとで件名か本文が変わっています。');
});
