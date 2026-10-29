import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { ReceiptView, TriageView } from '../../src/shared/api.js';
import { expect, test } from './fixtures.js';

// Synthetic committee-mail responses exercise the production UI; HTTP tests cover authorization.
async function mailbox(page: Page, edit = false) {
  const box = { id: 'contact', name: '問い合わせ', address: 'contact@committee.example' };
  const receipt: ReceiptView = {
    receiptId: 'rc_0000000000000001', threadId: 'th_0000000000000001', mailbox: box, mailboxes: [box],
    access: edit ? 'edit' : 'read', canEditAssignmentAndLabels: true, canEditStatus: true,
    receivedAt: '2026-10-14T01:00:00Z', subject: '合成メールの共同整理',
    from: { name: '取引先', address: 'sender@partner.example' }, to: [{ name: null, address: box.address }], cc: [],
    text: '合成テストの本文です。', hasHtml: false, sanitizedHtml: null, blockedRemoteResources: 0,
    attachments: [], triage: { version: 1, status: 'unhandled', assignee: null, labels: [] }, notes: [], history: [],
  };
  const patches: Record<string, unknown>[] = [];
  const statusPatches: Record<string, unknown>[] = [];
  let conflict = false;
  const item = () => ({
    source: 'email', threadId: receipt.threadId, mailbox: box, mailboxes: [box], subject: receipt.subject, latestReceivedAt: receipt.receivedAt,
    receiptCount: 1, matchCount: 1, snippet: receipt.text, senders: ['取引先'], statuses: [receipt.triage.status], labels: receipt.triage.labels, assignees: [], canSetStatus: true,
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === '/api/session') return respond({
      demoAuthentication: false, authMode: 'discord', user: { id: 'iy-000001', displayName: '合成 太郎', roleLabel: '委員', canManageAccess: false },
      account: { initialLoginId: 'iy-000001', studentId: '21000001', departments: [], signIn: { previousLoginAt: null, failedSince: 0 } },
      degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 14,
    });
    if (path === '/api/mail/status') return respond({ enabled: true, canOpen: true, reauthRequired: false, idleHours: 12, unhandledTotal: 1 });
    if (path === '/api/mailboxes') return respond([{ ...box, access: receipt.access, threadCount: 1, unhandledCount: 1 }]);
    if (path === '/api/tasks/context') return respond({ enabled: false, bound: false, memberships: [] });
    if (path === '/api/rental/me') return respond({ permissions: [] });
    if (path === '/api/line/accounts' || path === '/api/inbox/labels') return respond([]);
    if (path === '/api/inbox') return respond({ items: [item()], total: 1, page: 1, pageSize: 5, counts: { email: 1, line: 0 }, lineEnabled: false });
    if (path === `/api/threads/${receipt.threadId}`) return respond({ threadId: receipt.threadId, mailbox: box, mailboxes: [box], subject: receipt.subject, receipts: [receipt] });
    if (path === `/api/threads/${receipt.threadId}/status` && route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { status: TriageView['status'] };
      statusPatches.push(body);
      const changed = receipt.triage.status === body.status ? 0 : 1;
      receipt.triage = { ...receipt.triage, version: receipt.triage.version + changed, status: body.status };
      return respond({ threadId: receipt.threadId, statuses: [body.status], changed });
    }
    if (path.endsWith('/assignees')) return respond([{ id: 'iy-000002', displayName: '合成 花子' }]);
    if (path.endsWith('/triage')) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(body);
      if (conflict) {
        conflict = false;
        receipt.triage = { ...receipt.triage, version: receipt.triage.version + 1, status: 'in_progress', labels: ['別の委員の変更'] };
        return respond({ error: 'conflict', message: '他の利用者が更新しました。', current: receipt.triage }, 409);
      }
      receipt.triage = {
        ...receipt.triage, version: receipt.triage.version + 1,
        ...('status' in body ? { status: body.status as TriageView['status'] } : {}),
        ...('labels' in body ? { labels: body.labels as string[] } : {}),
        ...('assigneeId' in body ? { assignee: body.assigneeId ? { id: String(body.assigneeId), displayName: '合成 花子', hasMailboxAccess: true } : null } : {}),
      };
      return respond(receipt.triage);
    }
    return respond({ error: 'not_found' }, 404);
  });
  await page.goto(`/#/all?thread=${receipt.threadId}`);
  const form = page.getByRole('form', { name: '対応情報の編集' });
  await expect(form).toBeVisible();
  return { receipt, patches, statusPatches, form, conflictNext: () => { conflict = true; } };
}

test('member labels and assigns mail, clears both, and keeps notes restricted', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { form, patches, receipt } = await mailbox(page);
  // The status is set by the buttons at the top of the thread; the form does not offer it a second time.
  await expect(form.getByLabel('対応状況')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'スレッドの対応状況' }).getByRole('button', { name: '対応中' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: '内部メモ', exact: true })).toHaveCount(0);
  await form.getByLabel('担当者').selectOption('iy-000002');
  await form.getByLabel('追加するラベル').fill('要確認');
  await form.getByRole('button', { name: '追加', exact: true }).click();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByText('保存しました。')).toBeVisible();
  expect(patches[0]).toEqual({ expectedVersion: 1, assigneeId: 'iy-000002', labels: ['要確認'] });
  expect(receipt.triage.status).toBe('unhandled');
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/mail-collaboration-mobile.png', fullPage: true });
  await page.reload();
  await expect(form.getByLabel('担当者')).toHaveValue('iy-000002');
  await form.getByLabel('ラベル「要確認」を外す').click();
  await form.getByLabel('担当者').selectOption('');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByText('保存しました。')).toBeVisible();
  expect(patches[1]).toEqual({ expectedVersion: 2, assigneeId: null, labels: [] });
});

test('conflict shows the newer data without overwriting another member, then saves only labels', async ({ page }) => {
  const { form, patches, conflictNext } = await mailbox(page);
  await form.getByLabel('追加するラベル').fill('自分の変更');
  await form.getByRole('button', { name: '追加', exact: true }).click();
  conflictNext();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('他の利用者が先に更新');
  // The newer state from the other member is shown: their label in the form, their status at the top.
  await expect(form.getByLabel('ラベル「別の委員の変更」を外す')).toBeVisible();
  await expect(page.getByRole('region', { name: 'スレッドの対応状況' }).getByRole('button', { name: '対応中' })).toHaveAttribute('aria-pressed', 'true');
  await form.getByLabel('追加するラベル').fill('追加確認');
  await form.getByRole('button', { name: '追加', exact: true }).click();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByText('保存しました。')).toBeVisible();
  expect(patches[1]).toEqual({ expectedVersion: 2, labels: ['別の委員の変更', '追加確認'] });
});

test('member sets the status without a grant from the top of the thread and the list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { form, patches, statusPatches, receipt } = await mailbox(page);
  const detail = page.getByRole('region', { name: 'スレッド詳細' });
  const top = detail.getByRole('region', { name: 'スレッドの対応状況' });
  const body = detail.locator('.mail-text');
  await expect(top.getByRole('button', { name: '未対応' })).toHaveAttribute('aria-pressed', 'true');
  // The status and handling controls come before the mail body; the status is offered once.
  expect((await top.boundingBox())!.y).toBeLessThan((await body.boundingBox())!.y);
  expect((await form.boundingBox())!.y).toBeLessThan((await body.boundingBox())!.y);
  await expect(form.getByLabel('対応状況')).toHaveCount(0);
  // Nothing changed yet: no save button in the way.
  await expect(form.getByRole('button', { name: '保存', exact: true })).toBeHidden();

  await top.getByRole('button', { name: '対応中' }).click();
  await expect(top.getByRole('button', { name: '対応中' })).toHaveAttribute('aria-pressed', 'true');
  expect(patches).toEqual([]);

  const row = page.getByRole('region', { name: 'スレッド一覧' }).getByRole('group', { name: `「${receipt.subject}」の対応状況` });
  await expect(row.getByRole('button', { name: '対応中' })).toHaveAttribute('aria-pressed', 'true');
  await row.getByRole('button', { name: '完了' }).click();
  await expect(row.getByRole('button', { name: '完了' })).toHaveAttribute('aria-pressed', 'true');
  await expect(top.getByRole('button', { name: '完了' })).toHaveAttribute('aria-pressed', 'true');
  expect(statusPatches).toEqual([{ status: 'in_progress' }, { status: 'done' }]);
  // Pressing the current status again sends nothing.
  await row.getByRole('button', { name: '完了' }).click();
  expect(statusPatches).toHaveLength(2);
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/mail-status-desktop.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/all');
  await expect(row.getByRole('button', { name: '完了' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '.tmp/mail-status-list-mobile.png', fullPage: true });
});

test('mailbox editor retains the status and internal-note controls', async ({ page }) => {
  const { form, patches, statusPatches } = await mailbox(page, true);
  const top = page.getByRole('region', { name: 'スレッドの対応状況' });
  await expect(page.getByRole('textbox', { name: '内部メモ', exact: true })).toBeVisible();
  await top.getByRole('button', { name: '完了' }).click();
  await expect(top.getByRole('button', { name: '完了' })).toHaveAttribute('aria-pressed', 'true');
  expect(statusPatches).toEqual([{ status: 'done' }]);
  await form.getByLabel('追加するラベル').fill('済');
  await form.getByRole('button', { name: '追加', exact: true }).click();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByText('保存しました。')).toBeVisible();
  expect(patches[0]).toEqual({ expectedVersion: 2, labels: ['済'] });
});
