import { mkdirSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { ReceiptView } from '../../src/shared/api.js';
import { contactTitle, normalizeContactSearch, validateContact, type ContactInput, type ContactView } from '../../src/shared/contacts.js';
import type { MailSendOptions } from '../../src/shared/mailbox.js';
import { expect, test } from './fixtures.js';

// Committee contacts (2026-10-26) on the production UI with a synthetic contacts API in the browser; the HTTP
// tests (tests/contacts/http.test.ts) cover the server, the rules and the grants. Synthetic names only.

const box = { id: 'contact', name: '問い合わせ', address: 'contact@committee.example' };

const seed: ContactInput[] = [
  { category: 'external', organization: '株式会社合成商事', section: '営業部', name: '合成 一郎', nameKana: 'ごうせい いちろう', emails: [{ label: '', address: 'ichiro@partner.example' }, { label: '請求書', address: 'billing@partner.example' }], phones: [{ label: '代表', number: '076-000-0001' }], postalCode: '930-0000', address: '合成県合成市1-1', tags: ['協賛'], notes: '請求書は郵送' },
  { category: 'exhibitor', organization: '合成サークル', section: '', name: '', nameKana: '', emails: [], phones: [{ label: '代表者', number: '090-0000-0002' }], postalCode: '', address: '', tags: ['出展2026'], notes: '' },
  { category: 'committee', organization: '合成委員会 渉外課', section: '', name: '', nameKana: '', emails: [{ label: '', address: 'sales@committee.example' }], phones: [], postalCode: '', address: '', tags: [], notes: '' },
];

async function app(page: Page, o: { admin?: boolean; canSend?: boolean } = {}) {
  let n = 0;
  const contacts: ContactView[] = seed.map((c) => view(c));
  const imports: { dryRun: boolean; count: number }[] = [];
  function view(c: ContactInput, id = `ct_${(++n).toString(16).padStart(16, '0')}`, version = 1): ContactView {
    return { ...c, id, source: '', version, createdAt: '2026-10-26T01:00:00Z', createdByName: '合成 太郎', updatedAt: '2026-10-26T01:00:00Z', updatedByName: '合成 太郎' };
  }
  const text = (c: ContactView) => normalizeContactSearch([c.organization, c.name, c.nameKana, ...c.emails.map((e) => e.address), ...c.phones.map((p) => p.number), ...c.tags].join(' '));
  const receipt: ReceiptView = {
    receiptId: 'rc_0000000000000001', threadId: 'th_0000000000000001', mailbox: box, mailboxes: [box],
    access: 'read', canEditAssignmentAndLabels: true, canEditStatus: true,
    receivedAt: '2026-10-14T01:00:00Z', subject: '合成の見積もり', from: { name: '合成 二郎', address: 'jiro@vendor.example' }, to: [{ name: null, address: box.address }], cc: [],
    text: '合成テストの本文です。', hasHtml: false, sanitizedHtml: null, blockedRemoteResources: 0,
    attachments: [], triage: { version: 1, status: 'unhandled', assignee: null, labels: [] }, notes: [], history: [],
  };
  const options: MailSendOptions = { enabled: true, from: [{ mailboxId: box.id, name: box.name, address: box.address }], fromName: '合成 医学薬学祭実行委員会', bcc: 'archive@committee.example', maxAttachmentBytes: 15 * 1024 * 1024, maxRecipients: 30, senderName: '合成 太郎' };

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    const body = () => JSON.parse(route.request().postData() ?? 'null') as Record<string, unknown>;
    if (path === '/api/session') return respond({
      demoAuthentication: false, authMode: 'discord', user: { id: 'iy-000001', displayName: '合成 太郎', roleLabel: '委員', canManageAccess: !!o.admin },
      account: { initialLoginId: 'iy-000001', studentId: '21000001', departments: [], signIn: { previousLoginAt: null, failedSince: 0 } },
      degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 14,
    });
    if (path === '/api/mail/status') return respond({ enabled: true, canOpen: true, reauthRequired: false, idleHours: 12, unhandledTotal: 1 });
    if (path === '/api/mail/send/options') return respond(o.canSend === false ? { ...options, enabled: false, from: [] } : options);
    if (path === '/api/mailboxes') return respond([{ ...box, access: 'read', threadCount: 1, unhandledCount: 1 }]);
    if (path === '/api/tasks/context') return respond({ enabled: false, bound: false, memberships: [] });
    if (path === '/api/rental/me') return respond({ permissions: [] });
    if (path === '/api/assistant/summary') return respond({ error: 'assistant_disabled' }, 404);
    if (path === '/api/line/accounts' || path === '/api/inbox/labels') return respond([]);
    if (path === '/api/inbox') {
      return respond({
        items: [{ source: 'email', threadId: receipt.threadId, mailbox: box, mailboxes: [box], subject: receipt.subject, latestReceivedAt: receipt.receivedAt, receiptCount: 1, matchCount: 1, snippet: receipt.text, senders: ['合成 二郎'], statuses: ['unhandled'], labels: [], assignees: [], canSetStatus: true }],
        total: 1, page: 1, pageSize: 5, counts: { email: 1, line: 0 }, lineEnabled: false,
      });
    }
    if (path === `/api/threads/${receipt.threadId}`) return respond({ threadId: receipt.threadId, mailbox: box, mailboxes: [box], subject: receipt.subject, receipts: [receipt] });

    if (path === '/api/contacts' && method === 'GET') {
      const terms = normalizeContactSearch(url.searchParams.get('q') ?? '').split(/\s+/).filter(Boolean);
      const category = url.searchParams.get('category');
      const tag = url.searchParams.get('tag');
      const matched = contacts.filter((c) => terms.every((t) => text(c).includes(t)) && (!tag || c.tags.includes(tag)));
      const items = matched.filter((c) => !category || c.category === category);
      const counts = { all: matched.length, external: 0, exhibitor: 0, committee: 0, member: 0 };
      for (const c of matched) counts[c.category] += 1;
      const tags = [...new Set(contacts.flatMap((c) => c.tags))].map((t) => ({ tag: t, count: contacts.filter((c) => c.tags.includes(t)).length }));
      const pageSize = Number(url.searchParams.get('pageSize') ?? 50);
      const pageNo = Number(url.searchParams.get('page') ?? 1);
      return respond({
        items: items.slice((pageNo - 1) * pageSize, pageNo * pageSize).map((c) => ({ id: c.id, category: c.category, organization: c.organization, section: c.section, name: c.name, nameKana: c.nameKana, email: c.emails[0]?.address ?? null, phone: c.phones[0] ?? null, tags: c.tags })),
        total: items.length, page: pageNo, pageSize, counts, tags, canAdminister: !!o.admin,
      });
    }
    if (path === '/api/contacts/suggest') {
      const q = normalizeContactSearch(url.searchParams.get('q') ?? '');
      return respond(contacts.filter((c) => text(c).includes(q)).flatMap((c) => c.emails.map((e) => ({ contactId: c.id, name: contactTitle(c), organization: c.name ? c.organization : '', address: e.address, label: e.label }))).slice(0, 8));
    }
    if (path === '/api/contacts/by-address') {
      const wanted = (url.searchParams.get('addresses') ?? '').split(',');
      return respond(contacts.flatMap((c) => c.emails.filter((e) => wanted.includes(e.address.toLowerCase())).map((e) => ({ address: e.address.toLowerCase(), contactId: c.id, name: contactTitle(c) }))));
    }
    if (path === '/api/contacts/import' && method === 'POST') {
      const b = body() as { contacts: ContactInput[]; dryRun: boolean };
      imports.push({ dryRun: b.dryRun, count: b.contacts.length });
      if (!b.dryRun) for (const c of b.contacts) contacts.push(view(validateContact(c)));
      return respond({ dryRun: b.dryRun, added: b.contacts.length - 1, duplicates: [{ index: 0, label: '合成 一郎', reason: 'メールアドレス ichiro@partner.example がすでにあります' }], invalid: [] });
    }
    if (path === '/api/contacts' && method === 'POST') {
      const created = view(validateContact(body()));
      contacts.push(created);
      return respond({ contact: created, history: [{ at: created.createdAt, actorName: '合成 太郎', action: 'created', changed: [] }], canAdminister: !!o.admin }, 201);
    }
    const one = /^\/api\/contacts\/(ct_[0-9a-f]{16})$/.exec(path);
    if (one) {
      const i = contacts.findIndex((c) => c.id === one[1]);
      if (i < 0) return respond({ error: 'not_found', message: '対象が見つからないか、閲覧権限がありません。' }, 404);
      if (method === 'PUT') {
        const b = body() as { expectedVersion: number; contact: unknown };
        contacts[i] = view(validateContact(b.contact), contacts[i]!.id, contacts[i]!.version + 1);
      }
      if (method === 'DELETE') {
        contacts.splice(i, 1);
        return route.fulfill({ status: 204 });
      }
      return respond({ contact: contacts[i], history: [{ at: '2026-10-26T01:00:00Z', actorName: '合成 太郎', action: 'created', changed: [] }], canAdminister: !!o.admin });
    }
    return respond({ error: 'not_found' }, 404);
  });
  return { contacts, imports };
}

async function noSideScroll(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(width, 'no horizontal scroll').toBeLessThanOrEqual(0);
}

test('from home: search, open a contact, call and write mail to it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app(page);
  await page.goto('/#/home');
  const card = page.getByTestId('home-contacts');
  await card.getByLabel('連絡先を探す').fill('ゴウセイ');
  await card.getByRole('button', { name: '探す' }).click();
  // The search is handed over in memory: it is not in the address bar (nor in the history).
  await expect(page).toHaveURL(/#\/contacts$/);
  await expect(page.getByLabel('連絡先を探す')).toHaveValue('ゴウセイ');
  await expect(page.getByRole('link', { name: '連絡先', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('contact-row')).toHaveCount(1);
  await expect(page.getByTestId('contact-count')).toHaveText('1 件');
  await page.screenshot({ path: '.tmp/contacts-list-mobile.png', fullPage: true });
  await page.getByTestId('contact-row').click();
  const detail = page.getByTestId('contact-detail');
  await expect(detail.getByRole('heading', { name: '合成 一郎' })).toBeVisible();
  await expect(detail.getByRole('link', { name: '076-000-0001' })).toHaveAttribute('href', 'tel:0760000001');
  await expect(detail.getByText('請求書は郵送')).toBeVisible();
  await noSideScroll(page);
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/contacts-detail-mobile.png', fullPage: true });

  await detail.getByTestId('contact-write-mail').first().click();
  await expect(page).toHaveURL(/compose=1/);
  const compose = page.getByRole('region', { name: '新しいメール' });
  await expect(compose.getByLabel('宛先', { exact: true })).toHaveValue('合成 一郎 <ichiro@partner.example>');
  // Leaving the form forgets the recipient: the next new mail starts empty.
  await page.getByRole('button', { name: '← 一覧に戻る' }).click();
  await page.getByTestId('compose-new-list').click();
  await expect(page.getByRole('region', { name: '新しいメール' }).getByLabel('宛先', { exact: true })).toHaveValue('');
});

test('contacts have their own tab on every width, and the rows per page can be chosen and are remembered', async ({ page }) => {
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await app(page);
    await page.goto('/#/home');
    const tabs = page.getByRole('navigation', { name: '機能' });
    await expect(tabs.getByRole('link')).toHaveText(['ホーム', 'タスク', '物品貸出', 'メール', '連絡先', 'Bot', '設定']);
    await tabs.getByRole('link', { name: '連絡先', exact: true }).click();
    await expect(page).toHaveURL(/#\/contacts$/);
    await expect(page).toHaveTitle('連絡先｜医薬祭 委員会アプリ');
    await expect(tabs.getByRole('link', { name: '連絡先', exact: true })).toHaveAttribute('aria-current', 'page');
    await noSideScroll(page);
    // Every label but 物品 | 貸出 stays on one line, even with seven tabs at 320px.
    const lines = await tabs.locator('a span').evaluateAll((els) => els.map((el) => [el.textContent, Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))] as const));
    for (const [label, count] of lines) if (label !== '物品貸出') expect(count, `${label} at ${width}px`).toBe(1);
    if (width === 320) await page.screenshot({ path: '.tmp/contacts-tab-320.png' });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
  // The mail screen no longer carries a way into the contacts (the tab is the way in).
  await app(page);
  await page.goto('/#/all');
  await expect(page.getByTestId('open-contacts')).toHaveCount(0);

  // Rows per page: 50 by default; 20 shows a pager; the choice is kept after a reload.
  const sizes: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/contacts') sizes.push(u.searchParams.get('pageSize') ?? '');
  });
  await page.goto('/#/contacts');
  const size = page.getByTestId('contact-page-size');
  await expect(size).toHaveValue('50');
  await expect(size.locator('option')).toHaveText(['20 件', '50 件', '100 件', 'すべて']);
  await size.selectOption('20');
  await expect.poll(() => sizes.at(-1)).toBe('20');
  await page.reload();
  await expect(page.getByTestId('contact-page-size')).toHaveValue('20');
  await page.getByTestId('contact-page-size').selectOption('1000');
  await expect.poll(() => sizes.at(-1)).toBe('1000');

  // The rental phone screen repeats the same seven tabs in its own HTML and CSS (this test server does not serve
  // that screen, so its files are loaded as they are, without its script).
  const rental = await page.context().newPage();
  await rental.setViewportSize({ width: 320, height: 800 });
  const rentalHtml = readFileSync('src/rental-web/index.html', 'utf8')
    .replace('<link rel="stylesheet" href="/rental/styles.css">', `<style>${readFileSync('src/rental-web/styles.css', 'utf8')}</style>`)
    .replace('<script src="/rental/app.js" defer></script>', '');
  await rental.setContent(rentalHtml);
  const rentalTabs = rental.getByRole('navigation', { name: '機能' });
  await expect(rentalTabs.getByRole('link')).toHaveText(['ホーム', 'タスク', '物品貸出', 'メール', '連絡先', 'Bot', '設定']);
  await expect(rentalTabs.getByRole('link', { name: '連絡先' })).toHaveAttribute('href', '/#/contacts');
  const rentalLines = await rentalTabs.locator('a span').evaluateAll((els) => els.map((el) => [el.textContent, Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))] as const));
  for (const [label, count] of rentalLines) if (label !== '物品貸出') expect(count, `rental ${label}`).toBe(1);
  await rental.screenshot({ path: '.tmp/contacts-rental-tabs-320.png' });
  await rental.close();
});

test('the list filters by category and tag on a wide screen; an edit is saved', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await app(page);
  await page.goto('/#/contacts');
  await expect(page.getByTestId('contact-row')).toHaveCount(3);
  await page.getByTestId('contact-category-exhibitor').click();
  await expect(page.getByTestId('contact-row')).toHaveCount(1);
  await expect(page.getByTestId('contact-row')).toContainText('合成サークル');
  await page.getByTestId('contact-category-all').click();
  await page.getByLabel('タグで絞る').selectOption('協賛');
  await expect(page.getByTestId('contact-row')).toHaveCount(1);
  await page.getByTestId('contact-row').click();
  await page.getByTestId('contact-edit').click();
  const form = page.getByTestId('contact-form');
  await form.getByLabel('部署・役職').fill('総務部');
  await form.getByTestId('contact-phone').first().fill('０７６－０００－９９９９');
  await form.getByTestId('contact-save').click();
  const detail = page.getByTestId('contact-detail');
  await expect(detail.getByText('保存しました。')).toBeVisible();
  await expect(detail.getByRole('link', { name: '076-000-9999' })).toBeVisible();
  await page.screenshot({ path: '.tmp/contacts-wide.png', fullPage: true });
});

test('a sender is added from the thread, with errors shown at the field', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { contacts } = await app(page);
  await page.goto('/#/all?thread=th_0000000000000001');
  await page.getByTestId('sender-contact-add').click();
  await expect(page).toHaveURL(/#\/contacts\?new=1/);
  const form = page.getByTestId('contact-form');
  await expect(form.getByLabel('氏名')).toHaveValue('合成 二郎');
  await expect(form.getByTestId('contact-email').first()).toHaveValue('jiro@vendor.example');
  await form.getByLabel('組織・団体').fill('合成レンタル');
  await form.getByLabel('郵便番号').fill('93-0');
  await form.getByTestId('contact-save').click();
  await expect(form.getByTestId('contact-form-error')).toContainText('郵便番号');
  await expect(form.getByLabel('郵便番号')).toBeFocused();
  await page.screenshot({ path: '.tmp/contacts-form-error.png', fullPage: true });
  await form.getByLabel('郵便番号').fill('9300000');
  await form.getByLabel('タグ').fill('業者、レンタル');
  await form.getByTestId('contact-save').click();
  await expect(page.getByTestId('contact-detail').getByRole('heading', { name: '合成 二郎' })).toBeVisible();
  expect(contacts.at(-1)).toMatchObject({ organization: '合成レンタル', postalCode: '930-0000', tags: ['業者', 'レンタル'] });

  // The thread now links to the contact.
  await page.goto('/#/all?thread=th_0000000000000001');
  await expect(page.getByTestId('sender-contact-open')).toBeVisible();
});

test('the mail form offers addresses from the contacts', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await app(page);
  await page.goto('/#/all?compose=1');
  const to = page.getByRole('region', { name: '新しいメール' }).getByLabel('宛先', { exact: true });
  await to.fill('other@partner.example, ごうせい');
  const options = page.getByTestId('recipient-suggestion');
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText('ichiro@partner.example');
  await page.screenshot({ path: '.tmp/contacts-suggest.png' });
  // Nothing is chosen until an arrow key moves to it.
  await expect(page.locator('[data-testid="recipient-suggestion"][aria-selected="true"]')).toHaveCount(0);
  await to.press('ArrowDown');
  await to.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await to.press('Enter');
  await expect(to).toHaveValue('other@partner.example, 合成 一郎 <billing@partner.example>, ');
  await expect(options).toHaveCount(0);
  // A finished address offers nothing, so Enter is a line break and the address stays as typed.
  await to.fill('kato@partner.example');
  await page.waitForTimeout(400);
  await expect(options).toHaveCount(0);
  await to.press('Enter');
  await expect(to).toHaveValue('kato@partner.example\n');
  // Picking with the mouse in the CC field.
  await page.getByTestId('compose-more').click();
  const cc = page.getByRole('region', { name: '新しいメール' }).getByLabel('CC', { exact: true });
  await cc.fill('渉外');
  await page.getByTestId('recipient-suggestion').first().click();
  await expect(cc).toHaveValue('合成委員会 渉外課 <sales@committee.example>, ');
});

test('an access administrator imports a checked list after a dry run, and deletes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { imports } = await app(page, { admin: true });
  await page.goto('/#/contacts');
  await page.getByTestId('contact-import-open').click();
  const panel = page.getByTestId('contact-import');
  const list = { version: 1, contacts: [seed[0], { category: 'external', organization: '合成印刷', name: '', emails: [{ label: '', address: 'print@vendor.example' }] }] };
  await panel.getByTestId('contact-import-file').setInputFiles({ name: '取り込み候補_20261026.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(list)) });
  await expect(panel.getByTestId('contact-import-run')).toBeDisabled();
  await panel.getByTestId('contact-import-check').click();
  await expect(panel.getByTestId('contact-import-result')).toContainText('取り込むと 1 件が入ります。 すでにある 1 件はとばします。');
  await noSideScroll(page);
  await page.screenshot({ path: '.tmp/contacts-import-mobile.png', fullPage: true });
  await panel.getByTestId('contact-import-run').click();
  await expect(panel.getByTestId('contact-import-result')).toContainText('1 件を取り込みました。');
  expect(imports).toEqual([
    { dryRun: true, count: 2 },
    { dryRun: false, count: 2 },
  ]);

  await page.getByRole('button', { name: '← 一覧に戻る' }).click();
  await page.getByTestId('contact-row').filter({ hasText: '合成サークル' }).click();
  await page.getByTestId('contact-delete').click();
  await page.getByTestId('contact-delete-confirm').click();
  await expect(page.getByTestId('contact-row').filter({ hasText: '合成サークル' })).toHaveCount(0);
});

test('members without the administrator role see no delete, import or export', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await app(page, { canSend: false });
  await page.goto('/#/contacts');
  await page.getByTestId('contact-row').first().click();
  await expect(page.getByTestId('contact-edit')).toBeVisible();
  await expect(page.getByTestId('contact-delete')).toHaveCount(0);
  await expect(page.getByTestId('contact-import-open')).toHaveCount(0);
  await expect(page.getByTestId('contact-export')).toHaveCount(0);
  // Without a send grant there is no button to write mail.
  await expect(page.getByTestId('contact-write-mail')).toHaveCount(0);
});
