import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { MailAccessResponse, MailApprovalDetail, MailApprovalEditRequest, MailApprovalMessage, MailApprovalSubmitRequest, MailSendOptions } from '../../src/shared/mailbox.js';
import { expect, test } from './fixtures.js';

// Approval before sending (2026-11-11) on the production UI with synthetic responses: asking from the compose
// form, the list and one request for the reviewer and the author, and the two new ticks of the grants screen.
// The HTTP tests (tests/mailbox/approval.test.ts) cover the server.
const box = { id: 'contact', name: '問い合わせ', address: 'contact@committee.example' };
const ME = '合成 太郎';
const CHAIR = '合成 委員長';

function readForm(body: Buffer): { message: MailApprovalSubmitRequest; files: string[] } {
  const text = body.toString('utf8');
  const json = /name="message"\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1] ?? '{}';
  return { message: JSON.parse(json) as MailApprovalSubmitRequest, files: [...text.matchAll(/name="attachments"; filename="([^"]*)"/g)].map((m) => m[1]!) };
}

const messageOf = (m: MailApprovalSubmitRequest): MailApprovalMessage => ({ to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, body: m.body, replyTo: m.replyTo ?? null, replyDue: m.replyDue ?? null, replyToReceiptId: m.replyToReceiptId, markThreadDone: m.markThreadDone });

function request(id: string, changes: Partial<MailApprovalDetail> = {}): MailApprovalDetail {
  const message: MailApprovalMessage = { to: ['取引先 ご担当者様 <sender@partner.example>'], cc: [], bcc: [], subject: '協賛のお願い', body: '取引先 ご担当者様\n\nお世話になっております。\n\n合成 医学薬学祭実行委員会\n合成 花子', replyTo: null, replyDue: null, replyToReceiptId: null, markThreadDone: false };
  return {
    id, state: 'pending', version: 1, mailbox: box, subject: message.subject, to: message.to, authorName: '合成 花子', mine: false, canReview: true,
    createdAt: '2026-11-11T01:00:00Z', updatedAt: '2026-11-11T01:00:00Z', decidedByName: null, decidedAt: null,
    message, submitted: null, changedFields: [], note: '', returnComment: null, attachments: [], replyThread: null, sentThreadId: null, canSetDue: false,
    history: [{ at: '2026-11-11T01:00:00Z', actorName: '合成 花子', action: 'submitted', detail: null }],
    ...changes,
  };
}

/** The mail tab with a fake of the approval routes that keeps its requests, as the server does. */
async function mailbox(page: Page, o: { reviewer?: boolean; approvalFrom?: boolean; requests?: MailApprovalDetail[] } = {}) {
  const requests = o.requests ?? [];
  const forms: { method: string; path: string; message: MailApprovalSubmitRequest; files: string[] }[] = [];
  const options: MailSendOptions = {
    enabled: true, from: [{ mailboxId: box.id, name: box.name, address: box.address }], approvalMailboxIds: o.approvalFrom === false ? [] : [box.id],
    fromName: '合成 医学薬学祭実行委員会', bcc: 'archive@committee.example', maxAttachmentBytes: 15 * 1024 * 1024, maxRecipients: 30, senderName: ME,
  };
  const open = (r: MailApprovalDetail) => r.state === 'pending' || r.state === 'returned' || r.state === 'sending';
  const step = (r: MailApprovalDetail, action: MailApprovalDetail['history'][number]['action'], actorName: string, detail: string | null = null) => {
    r.version += 1;
    r.history = [...r.history, { at: '2026-11-11T02:00:00Z', actorName, action, detail }];
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/api/session') return respond({
      demoAuthentication: false, authMode: 'discord', user: { id: 'iy-000001', displayName: o.reviewer ? CHAIR : ME, roleLabel: '委員', canManageAccess: false },
      account: { initialLoginId: 'iy-000001', studentId: '21000001', departments: [], signIn: { previousLoginAt: null, failedSince: 0 } },
      degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 14,
    });
    if (path === '/api/mail/status') {
      return respond({ enabled: true, canOpen: true, reauthRequired: false, idleHours: 12, unhandledTotal: 0, approvals: { toReview: requests.filter((r) => r.canReview && r.state === 'pending').length, returned: requests.filter((r) => r.mine && r.state === 'returned').length } });
    }
    if (path === '/api/mail/send/options') return respond(options);
    if (path === '/api/mailboxes') return respond([{ ...box, access: 'read', threadCount: 0, unhandledCount: 0 }]);
    if (path === '/api/tasks/context') return respond({ enabled: false, bound: false, memberships: [] });
    if (path === '/api/rental/me') return respond({ permissions: [] });
    if (path === '/api/line/accounts' || path === '/api/inbox/labels') return respond([]);
    if (path === '/api/inbox') return respond({ items: [], total: 0, page: 1, pageSize: 20, counts: { email: 0, line: 0 }, lineEnabled: false });
    if (path === '/api/mail/approvals' && method === 'GET') {
      return respond({ reviewer: !!o.reviewer, review: requests.filter((r) => r.canReview && r.state === 'pending'), mine: requests.filter((r) => r.mine && open(r)), done: requests.filter((r) => !open(r)) });
    }
    if (path === '/api/mail/approvals' && method === 'POST') {
      const form = readForm(route.request().postDataBuffer()!);
      forms.push({ method, path, ...form });
      const message = messageOf(form.message);
      const made = request(`ar_${String(requests.length + 1).padStart(16, '0')}`, { mine: true, canReview: false, authorName: ME, message, subject: message.subject, to: message.to, note: form.message.note, attachments: form.files.map((filename, idx) => ({ idx, filename, contentType: 'application/octet-stream', size: 2048 })), history: [{ at: '2026-11-11T02:00:00Z', actorName: ME, action: 'submitted', detail: null }] });
      requests.push(made);
      return respond(made, 201);
    }
    const one = /^\/api\/mail\/approvals\/(ar_[0-9a-f]{16})(?:\/(approve|return|withdraw))?$/.exec(path);
    const r = one ? requests.find((x) => x.id === one[1]) : undefined;
    if (one && !r) return respond({ error: 'not_found', message: '見つかりません。' }, 404);
    if (one && r) {
      if (method === 'GET') return respond(r);
      const body = method === 'PUT' ? null : (route.request().postDataJSON() as { expectedVersion: number; comment?: string });
      if (body && body.expectedVersion !== r.version) return respond({ error: 'conflict', message: '他の人が先にこの依頼を更新しました。最新の内容を確かめてから、もう一度操作してください。' }, 409);
      if (method === 'PUT') {
        const form = readForm(route.request().postDataBuffer()!);
        forms.push({ method, path, ...form });
        const kept = r.attachments.filter((a) => form.message.keepAttachments?.includes(a.idx));
        Object.assign(r, { state: 'pending', message: messageOf(form.message), subject: form.message.subject, to: form.message.to, note: form.message.note, returnComment: null, submitted: null, changedFields: [], attachments: [...kept, ...form.files.map((filename) => ({ filename, contentType: 'application/octet-stream', size: 2048 }))].map((a, idx) => ({ ...a, idx })) });
        step(r, 'resubmitted', ME);
        return respond(r);
      }
      if (method === 'PATCH') {
        const change = route.request().postDataJSON() as MailApprovalEditRequest;
        const before = r.submitted ?? r.message;
        const next: MailApprovalMessage = { ...r.message, to: change.to, cc: change.cc, bcc: change.bcc, subject: change.subject, body: change.body, replyTo: change.replyTo, replyDue: change.replyDue };
        const changed = (['to', 'cc', 'bcc', 'subject', 'body', 'replyTo', 'replyDue'] as const).filter((f) => JSON.stringify(before[f]) !== JSON.stringify(next[f]));
        Object.assign(r, { message: next, subject: next.subject, to: next.to, submitted: changed.length > 0 ? before : null, changedFields: changed });
        step(r, 'edited', CHAIR, changed.map((f) => ({ to: '宛先', cc: 'CC', bcc: 'BCC', subject: '件名', body: '本文', replyTo: '返信先', replyDue: '回答期限' })[f]).join('・'));
        return respond(r);
      }
      if (one[2] === 'approve') {
        Object.assign(r, { state: 'sent', canReview: false, decidedByName: CHAIR, decidedAt: '2026-11-11T02:00:00Z', sentThreadId: 'th_0000000000000009', attachments: [] });
        step(r, 'approved', CHAIR);
        return respond(r);
      }
      if (one[2] === 'return') {
        Object.assign(r, { state: 'returned', canReview: false, returnComment: body!.comment, decidedByName: CHAIR, decidedAt: '2026-11-11T02:00:00Z' });
        step(r, 'returned', CHAIR, body!.comment);
        return respond(r);
      }
      if (one[2] === 'withdraw') {
        Object.assign(r, { state: 'withdrawn', attachments: [] });
        step(r, 'withdrawn', ME);
        return respond(r);
      }
    }
    return respond({ error: 'not_found' }, 404);
  });
  return { requests, forms };
}

test('a member whose mail needs an approval asks for it from the compose form and sees it wait', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { requests, forms } = await mailbox(page);
  await page.goto('/#/all');
  await page.getByTestId('compose-new-list').click();
  const compose = page.getByRole('region', { name: '新しいメール' });
  await expect(compose.getByText('校閲者が承認すると委員会のアドレスから送られます')).toBeVisible();
  await expect(compose.getByLabel('差出人')).toContainText('承認が必要');
  await compose.getByLabel('宛先', { exact: true }).fill('取引先 ご担当者様 <sender@partner.example>');
  await compose.getByLabel('件名').fill('協賛のお願い');
  const body = await compose.getByLabel('本文').inputValue();
  await compose.getByLabel('本文').fill(`取引先 ご担当者様\n\nお世話になっております。${body}`);
  await compose.getByLabel('校閲者へのひとこと（任意）').fill('宛名の書き方を見てください。');
  await compose.getByRole('button', { name: '依頼内容を確認' }).click();

  const ask = compose.getByRole('button', { name: '承認を依頼する' });
  await expect(compose.getByRole('heading', { name: '依頼内容の確認' })).toBeVisible();
  await expect(compose.getByTestId('preview-note')).toHaveText('校閲者へのひとこと：宛名の書き方を見てください。');
  await expect(ask).toBeDisabled();
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/mail-approval-ask-mobile.png', fullPage: true });
  await compose.getByLabel('この宛先と内容で、承認を依頼します（校閲者が承認すると送られます）').check();
  await ask.click();

  // Nothing was sent: the request opens, waiting, with what the author may do.
  const detail = page.getByTestId('approval-detail');
  await expect(detail.getByRole('heading', { name: '協賛のお願い' })).toBeVisible();
  await expect(detail.getByText('校閲者の承認を待っています。')).toBeVisible();
  await expect(detail.getByRole('button', { name: '承認して送信' })).toHaveCount(0);
  expect(forms).toHaveLength(1);
  expect(forms[0]).toMatchObject({ method: 'POST', path: '/api/mail/approvals', message: { mailboxId: 'contact', subject: '協賛のお願い', note: '宛名の書き方を見てください。', to: ['取引先 ご担当者様 <sender@partner.example>'] } });
  await expect(page).toHaveURL(/approval=ar_0000000000000001$/);
  await page.screenshot({ path: '.tmp/mail-approval-waiting-mobile.png', fullPage: true });

  // Back to the list: the request is under 自分の依頼; withdrawing asks first.
  await page.getByRole('button', { name: '← 一覧に戻る' }).click();
  await expect(page.getByTestId('approval-mine').getByTestId('approval-row')).toContainText('協賛のお願い');
  await page.getByTestId('approval-row').click();
  await detail.getByRole('button', { name: '取り下げる…' }).click();
  await expect(detail.getByText('取り下げると、添付ファイルごと消えて元に戻せません。')).toBeVisible();
  await detail.getByRole('button', { name: '取り下げる', exact: true }).click();
  await expect(detail.getByTestId('approval-message')).toHaveText('取り下げました。このメールは送られません。');
  expect(requests[0]!.state).toBe('withdrawn');
});

test('a reviewer opens the waiting mail from the side bar, changes it, and approves it after the confirmation tick', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { requests } = await mailbox(page, { reviewer: true, approvalFrom: false, requests: [request('ar_00000000000000a1', { note: '初めて書きました。' }), request('ar_00000000000000a2', { subject: '見積もりの件', message: { ...request('x').message, subject: '見積もりの件' } })] });
  await page.goto('/#/all');
  const entry = page.getByTestId('approvals-open');
  await expect(entry).toContainText('承認待ち');
  await expect(entry.getByLabel('承認待ち 2 件')).toHaveText('2');
  await entry.click();
  const list = page.getByTestId('approval-list');
  await expect(list.getByTestId('approval-review').getByTestId('approval-row')).toHaveCount(2);
  await list.getByTestId('approval-row').first().click();

  const detail = page.getByTestId('approval-detail');
  await expect(detail.getByText('書いた人：合成 花子')).toBeVisible();
  await expect(detail.getByText('初めて書きました。')).toBeVisible();
  const approve = detail.getByRole('button', { name: '承認して送信' });
  await expect(approve).toBeDisabled();
  await page.screenshot({ path: '.tmp/mail-approval-review-desktop.png', fullPage: true });

  // A change by the reviewer is saved first, and shown as changed.
  await detail.getByRole('button', { name: '直す' }).click();
  await detail.getByLabel('件名').fill('【医薬祭】協賛のお願い');
  await detail.getByRole('button', { name: '修正を保存' }).click();
  await expect(detail.getByTestId('approval-message')).toHaveText('修正を保存しました。内容を確かめてから、承認して送信できます。');
  await expect(detail.getByTestId('approval-changed')).toContainText('校閲者が直した項目：件名');
  await expect(detail.getByRole('heading', { name: '【医薬祭】協賛のお願い' })).toBeVisible();

  await detail.getByLabel('この宛先と内容で、委員会のアドレスから送ります').check();
  await approve.click();
  await expect(detail.getByTestId('approval-message')).toHaveText('承認して送信しました。');
  await expect(detail.getByText('送信済みです（承認：合成 委員長')).toBeVisible();
  await expect(detail.getByTestId('approval-review')).toHaveCount(0);
  expect(requests[0]).toMatchObject({ state: 'sent', subject: '【医薬祭】協賛のお願い' });
  await expect(entry.getByLabel('承認待ち 1 件')).toHaveText('1');

  // The other one goes back to its author with the reason.
  await list.getByTestId('approval-review').getByTestId('approval-row').click();
  await detail.getByRole('button', { name: '差し戻す…' }).click();
  const send = detail.getByRole('button', { name: '差し戻す', exact: true });
  await expect(send).toBeDisabled();
  await detail.getByLabel('差し戻す理由（書いた人に見えます）').fill('金額の根拠を一文足してください。');
  await send.click();
  await expect(detail.getByTestId('approval-message')).toContainText('差し戻しました。');
  expect(requests[1]).toMatchObject({ state: 'returned', returnComment: '金額の根拠を一文足してください。' });
  await expect(entry.locator('.count-badge')).toHaveCount(0);
  await expect(list.getByText('あなたの承認を待っているメールはありません。')).toBeVisible();
});

test('the author changes a returned mail in the compose form, keeps its file, and asks again', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const returned = request('ar_00000000000000b1', { mine: true, canReview: false, authorName: ME, state: 'returned', version: 2, returnComment: '宛名の敬称を「様」にしてください。', decidedByName: CHAIR, decidedAt: '2026-11-11T02:00:00Z', attachments: [{ idx: 0, filename: '申込書.pdf', contentType: 'application/pdf', size: 20480 }] });
  const { forms } = await mailbox(page, { requests: [returned] });
  await page.goto('/#/all');
  await expect(page.getByTestId('approvals-open').getByLabel('差し戻し 1 件')).toHaveText('1');
  await page.goto('/#/all?approval=ar_00000000000000b1');
  const detail = page.getByTestId('approval-detail');
  await expect(detail.getByTestId('approval-return-comment')).toContainText('宛名の敬称を「様」にしてください。');
  await detail.getByRole('button', { name: '直して出し直す' }).click();

  const compose = page.getByRole('region', { name: '差し戻されたメールを直す' });
  await expect(compose.getByTestId('compose-return-comment')).toContainText('宛名の敬称を「様」にしてください。');
  await expect(compose.getByLabel('差出人')).toBeDisabled();
  await expect(compose.getByLabel('件名')).toHaveValue('協賛のお願い');
  await expect(compose.getByText('申込書.pdf')).toBeVisible();
  await compose.getByLabel('本文').fill('取引先 様\n\nお世話になっております。\n\n合成 医学薬学祭実行委員会\n合成 太郎');
  await compose.getByRole('button', { name: '依頼内容を確認' }).click();
  await compose.getByLabel(/承認を依頼します/).check();
  await compose.getByRole('button', { name: '承認を依頼する' }).click();

  await expect(page.getByTestId('approval-detail').getByText('校閲者の承認を待っています。')).toBeVisible();
  expect(forms).toHaveLength(1);
  expect(forms[0]).toMatchObject({ method: 'PUT', path: '/api/mail/approvals/ar_00000000000000b1', message: { expectedVersion: 2, keepAttachments: [0], mailboxId: 'contact' } });
  expect(forms[0]!.message.body.startsWith('取引先 様')).toBe(true);
});

test('the grants screen has the review tick for people and departments and the 承認必須 tick for people who can send', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const data: MailAccessResponse = {
    people: [
      { id: 'iy-000001', displayName: CHAIR, roleLabel: '総務部' },
      { id: 'iy-000002', displayName: ME, roleLabel: '企画部' },
    ],
    mailboxes: [{ id: 'contact', name: '問い合わせ', address: 'contact@committee.example' }],
    grants: [], sendGrants: [], sendable: ['contact'], departments: ['企画部', '総務部'],
    departmentGrants: [{ department: '企画部', mailboxId: 'contact', kind: 'send' }],
    reviewGrants: [], approvalRequired: [],
    ingest: { messages: 1, latestStoredAt: '2026-11-11T00:00:00Z', sources: {} },
  };
  const puts: Record<string, unknown>[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/api/session') return respond({
      demoAuthentication: false, authMode: 'discord', user: { id: 'iy-000001', displayName: CHAIR, roleLabel: '総務部', canManageAccess: true },
      account: { initialLoginId: 'iy-000001', studentId: '21000001', departments: ['総務部'], signIn: { previousLoginAt: null, failedSince: 0 } },
      degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 14,
    });
    if (path === '/api/mail/status') return respond({ enabled: true, canOpen: true, reauthRequired: false, idleHours: 12, unhandledTotal: 0, approvals: { toReview: 0, returned: 0 } });
    if (path === '/api/mail/admin/access' && route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { userId?: string; department?: string; mailboxId: string; review?: boolean; approval?: boolean };
      puts.push(body);
      if (body.department && body.review !== undefined) data.departmentGrants = [...data.departmentGrants.filter((g) => !(g.department === body.department && g.kind === 'review')), ...(body.review ? [{ department: body.department, mailboxId: body.mailboxId, kind: 'review' as const }] : [])];
      else if (body.review !== undefined) data.reviewGrants = body.review ? [{ userId: body.userId!, mailboxId: body.mailboxId }] : [];
      else if (body.approval !== undefined) data.approvalRequired = body.approval ? [{ userId: body.userId!, mailboxId: body.mailboxId }] : [];
      return respond(data);
    }
    if (path === '/api/mail/admin/access') return respond(data);
    return respond({ error: 'not_found' }, 404);
  });
  await page.goto('/#/settings/mail');
  const panel = page.getByTestId('mail-access');
  await expect(panel.getByText('校閲者が 1 人でもいる受信箱では')).toBeVisible();
  // 承認必須 shows only for a person who could send at once (here through the department's send grant).
  await expect(panel.getByLabel(`${CHAIR} さんの承認必須`)).toHaveCount(0);
  await panel.getByLabel(`${CHAIR} さんの校閲権限`).check();
  await expect(panel.getByTestId('mail-access-message')).toHaveText(`${CHAIR} さんの「問い合わせ」の校閲権限を付けました。`);
  await panel.getByLabel(`${ME} さんの承認必須`).check();
  await expect(panel.getByTestId('mail-access-message')).toHaveText(`${ME} さんの「問い合わせ」の承認必須を付けました。`);
  await panel.getByLabel('総務部 の校閲権限').check();
  await expect(panel.getByLabel(`${CHAIR} さんの校閲権限`)).toBeChecked();
  await page.screenshot({ path: '.tmp/mail-approval-grants-desktop.png', fullPage: true });
  expect(puts).toEqual([
    { userId: 'iy-000001', mailboxId: 'contact', review: true },
    { userId: 'iy-000002', mailboxId: 'contact', approval: true },
    { department: '総務部', mailboxId: 'contact', review: true },
  ]);
});
