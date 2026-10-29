import type { Page } from '@playwright/test';
import { expect, loginAs, resetSample, test } from './fixtures.js';
import { installBotFake, jstTodayForTest, MAIL_BODY, MAIL_SUBJECT, type BotFake, type BotFakeOptions } from './assistant-fake.js';

// The Bot tab against the page-level fake of the Bot browser API (tests/e2e/assistant-fake.ts). The fake
// answers with the contract's shapes; the server routes are covered by tests/api/assistant.test.ts.
// The fake is installed before the sign-in, so the first home and Bot requests reach it.

async function start(page: Page, options: BotFakeOptions = {}): Promise<BotFake> {
  await resetSample(page);
  const fake = await installBotFake(page, options);
  await loginAs(page, 'u-editor-a');
  return fake;
}

test('the Bot tab sits between 受信箱 and 設定 and opens the question screen', async ({ page }) => {
  await start(page);
  await page.goto('/#/home');
  const tabs = page.getByRole('navigation', { name: '機能' });
  await expect(tabs.getByRole('link')).toHaveText(['ホーム', 'タスク', '物品貸出', 'メール', '連絡先', 'Bot', '設定']);
  await tabs.getByRole('link', { name: 'Bot', exact: true }).click();
  await expect(page.getByTestId('nav-bot')).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/#\/bot\/ask$/);
  await expect(page).toHaveTitle('Bot｜医薬祭 委員会アプリ');
  await expect(page.getByTestId('bot-section-ask')).toHaveAttribute('aria-current', 'page');
});

test('ask: similar earlier questions before sending, progress, the answer as text, and the recent list', async ({ page }) => {
  const fake = await start(page);
  await page.goto('/#/bot/ask');
  await expect(page.getByRole('heading', { name: 'Bot', exact: true })).toBeVisible();
  await page.getByTestId('ask-question').fill('会場の受付');
  await expect(page.getByTestId('ask-similar')).toContainText('会場の受付時間を教えて');
  await page.getByTestId('ask-question').fill('会場の受付は何時から？');
  await page.getByTestId('ask-submit').click();
  await expect(page.getByTestId('job-progress')).toContainText('資料を検索しています…');
  const answer = page.getByTestId('job-result');
  await expect(answer).toContainText('受付は 9:00 から');
  await expect(answer.locator('strong')).toHaveText('受付は 9:00 から');
  await expect(answer.locator('.bot-small')).toHaveText('参照: 会場案内（合成データ）');
  await expect(answer.getByRole('link', { name: '案内ページ' })).toHaveAttribute('href', 'https://example.org/guide');
  // Raw HTML from the Bot is text, never an element.
  await expect(answer.locator('b')).toHaveCount(0);
  await expect(answer).toContainText('<b>これは太字にならない</b>');
  await expect(page.getByText('回答は Discord の #bottest にも投稿されます。')).toBeVisible();
  await expect(page.getByTestId('recent-ask')).toContainText('会場の受付は何時から？');
  // Gemini is offered only when meta lists it for questions (the fake lists it with ask: false).
  await expect(page.locator('#ask-model option')).toHaveText(['自動', 'Claude Sonnet']);
  expect(fake.calls.filter((c) => c.startsWith('GET /jobs/')).length).toBeGreaterThanOrEqual(2);
});

test('mail: recipient and purpose make a draft sent as a /doc job; the subject and the body are shown with copy buttons', async ({ page, context }) => {
  const fake = await start(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#/bot/mail');
  await expect(page.getByTestId('bot-section-mail')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.bot-sections a')).toHaveText(['質問', '文書', 'メール', '画像', 'リマインド', 'タスク候補']);
  // Nothing typed: the reason is said beside the field and the field gets the focus.
  await page.getByTestId('mail-submit').click();
  await expect(page.locator('#mail-to-error')).toHaveText('相手を入力してください。');
  await expect(page.getByTestId('mail-to')).toBeFocused();
  await expect(page.getByTestId('mail-to')).toHaveAttribute('aria-invalid', 'true');

  await page.getByLabel('相手', { exact: true }).fill('株式会社サンプル ご担当者様');
  await page.getByTestId('mail-purpose').fill('発電機 3 台の見積依頼');
  await page.getByLabel('差出人（任意）').fill('渉外課 山田');
  await page.getByTestId('mail-details').locator('summary').click();
  await page.getByLabel('相手とのこれまでのやりとり').selectOption({ label: '初めて連絡する' });
  await page.getByTestId('mail-submit').click();
  await expect(page.getByTestId('mail-result')).toBeFocused();
  await expect(page.getByTestId('mail-subject')).toHaveText(MAIL_SUBJECT);
  expect(await page.getByTestId('mail-body').evaluate((el) => el.textContent)).toBe(MAIL_BODY);
  const draft = page.getByTestId('mail-draft');
  await expect(draft).toContainText('要記入: 【担当者名】 【氏名】');
  await expect(draft).not.toContainText('✉️'); // the title line repeats the subject; it is not shown twice
  await expect(page.getByText('作った草案は Discord の #bottest にも投稿されます。')).toBeVisible();
  await expect(page.getByRole('link', { name: /メール\.txt をダウンロード/ })).toBeVisible();

  // What reached the Bot host: an ordinary /doc job with the labelled request (shared/mailDraft.ts).
  const sent = [...fake.jobs.values()].find((job) => job.input.docType === 'mail')!;
  expect(sent.kind).toBe('doc');
  expect(sent.input).toEqual({
    docType: 'mail',
    content: '【相手】株式会社サンプル ご担当者様\n【差出人】渉外課 山田\n【これまでのやりとり】初めて連絡する\n【要件】\n発電機 3 台の見積依頼',
    format: 'txt',
    useSources: true,
    model: 'auto',
  });

  await page.getByTestId('mail-copy-body').click();
  await expect(page.getByTestId('mail-copied')).toHaveText('本文をコピーしました。メールの本文の欄に貼り付けてください。');
  // The Windows clipboard gives the line breaks back as CRLF.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(MAIL_BODY);
  await page.getByTestId('mail-copy-subject').click();
  await expect(page.getByTestId('mail-copied')).toHaveText('件名をコピーしました。メールの件名の欄に貼り付けてください。');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MAIL_SUBJECT);

  // The inputs stay for another try; the recent list has only mail drafts, as "相手 宛：要件".
  await expect(page.getByTestId('mail-to')).toHaveValue('株式会社サンプル ご担当者様');
  const recent = page.getByTestId('recent-mail');
  await expect(recent.getByTestId('recent-item')).toHaveCount(1);
  await expect(recent).toContainText('株式会社サンプル ご担当者様 宛：発電機 3 台の見積依頼');
  await expect(recent).not.toContainText('会場の受付時間を教えて');

  await page.getByTestId('mail-new').click();
  await expect(page.getByTestId('mail-result')).toHaveCount(0);
  await expect(page.getByTestId('mail-to')).toHaveValue('');
  await expect(page.getByTestId('mail-purpose')).toHaveValue('');
  await expect(page.getByTestId('mail-to')).toBeFocused();
  await expect(page).toHaveURL(/#\/bot\/mail$/);
});

test('mail: the mail being answered is under 詳細; over the limit it is refused there, with 詳細 opened, and is not cut', async ({ page }) => {
  const fake = await start(page);
  await page.goto('/#/bot/mail');
  const details = page.getByTestId('mail-details');
  await expect(details.locator('summary')).toHaveText('詳細（返信先のメール・やりとり・資料・モデル）');
  await expect(page.getByTestId('mail-received')).toBeHidden();
  await page.getByLabel('相手', { exact: true }).fill('学務課 ご担当者様');
  await page.getByTestId('mail-purpose').fill('質問への回答');
  await details.locator('summary').click();
  await expect(page.getByLabel('返信先のメール本文')).toBeVisible();
  await expect(page.locator('#mail-received-hint')).toHaveText('相手から届いたメールに返信するときは、本文をここに貼り付けます。新しく送るメールなら空のままにします。');
  const long = 'あ'.repeat(801);
  await page.getByTestId('mail-received').fill(long);
  await expect(page.locator('#mail-received-count')).toHaveText('801／800字');
  await expect(page.locator('#mail-received-count')).toHaveClass(/over/);
  // Closed again, the summary still says a mail is pasted.
  await details.locator('summary').click();
  await expect(page.getByTestId('mail-received')).toBeHidden();
  await expect(details.locator('summary')).toContainText('返信先のメールあり');
  await page.getByTestId('mail-submit').click();
  await expect(details).toHaveAttribute('open', '');
  await expect(page.locator('#mail-received-error')).toHaveText('返信先のメール本文は 800 字までです。質問や依頼の部分だけを残してください。');
  await expect(page.getByTestId('mail-received')).toBeFocused();
  await expect(page.getByTestId('mail-received')).toHaveValue(long);
  expect(fake.calls.filter((c) => c === 'POST /jobs')).toHaveLength(0);
});

test('mail: the 文書 screen lists a mail draft as "相手 宛：要件"', async ({ page }) => {
  await start(page);
  await page.goto('/#/bot/mail');
  await page.getByLabel('相手', { exact: true }).fill('株式会社サンプル');
  await page.getByTestId('mail-purpose').fill('お礼');
  await page.getByTestId('mail-submit').click();
  await expect(page.getByTestId('mail-subject')).toHaveText(MAIL_SUBJECT);
  await page.getByTestId('bot-section-doc').click();
  await expect(page.getByTestId('recent-doc')).toContainText('株式会社サンプル 宛：お礼');
});

test('reminders: overdue and today are marked in text, add, done, and delete asks once inline', async ({ page }) => {
  const fake = await start(page);
  await page.goto('/#/bot/remind');
  const rows = page.getByTestId('reminder-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('期限超過');
  await expect(rows.nth(1)).toContainText('今日まで');
  await page.getByRole('button', { name: 'リマインドを追加' }).click();
  await page.getByLabel('内容').fill('ポスターを貼る');
  await page.getByLabel('期限（日付と時刻）').fill(`${jstTodayForTest()}T18:00`);
  await page.getByLabel('通知先').selectOption({ label: '#bot-reminders' });
  await page.getByRole('button', { name: 'リマインドを登録' }).click();
  await expect(page.getByTestId('remind-notice')).toHaveText('リマインドを登録しました。');
  await expect(rows).toHaveCount(3);
  const added = page.getByTestId('reminder-row').filter({ hasText: 'ポスターを貼る' });
  await added.getByRole('button', { name: '完了にする' }).click();
  await expect(page.getByTestId('reminder-row').filter({ hasText: 'ポスターを貼る' })).toHaveCount(0);
  expect(fake.calls.some((c) => /^POST \/reminders\/\d+\/done$/.test(c))).toBe(true);

  const printing = page.getByTestId('reminder-row').filter({ hasText: '資料を印刷する' });
  await printing.getByRole('button', { name: '削除', exact: true }).click();
  const confirm = page.getByRole('group', { name: '削除の確認' });
  await expect(confirm).toContainText('削除すると元に戻せません');
  await confirm.getByRole('button', { name: 'やめる' }).click();
  await expect(page.getByTestId('reminder-row')).toHaveCount(2);
  await page.getByTestId('reminder-row').filter({ hasText: '資料を印刷する' }).getByRole('button', { name: '削除', exact: true }).click();
  await page.getByRole('button', { name: '削除する' }).click();
  await expect(page.getByTestId('reminder-row').filter({ hasText: '資料を印刷する' })).toHaveCount(0);
  expect(fake.calls).toContain('POST /reminders/11/delete');
  // The reminder that the owner cannot delete (canDelete is false) has no delete button.
  await expect(page.getByTestId('reminder-row').filter({ hasText: '会場の鍵を受け取る' }).getByRole('button', { name: '削除', exact: true })).toHaveCount(0);
});

test('candidates: approve from the Bot buttons; returning needs a comment', async ({ page }) => {
  const fake = await start(page);
  await page.goto('/#/bot/candidates');
  const posted = page.getByTestId('candidate').filter({ hasText: '会場の備品を確認する' });
  await expect(posted).toContainText('承認待ち');
  await expect(posted.locator('.chip')).toHaveText(['kaijo']);
  await posted.getByRole('button', { name: '起票する' }).click();
  await expect(page.getByTestId('candidate-notice')).toHaveText('起票しました。');
  await expect(page.getByTestId('candidate').filter({ hasText: '会場の備品を確認する' })).toHaveCount(0);

  const created = page.getByTestId('candidate').filter({ hasText: '看板の掲示を依頼する' });
  await expect(created).toContainText('自動起票');
  await created.getByRole('button', { name: '差し戻す', exact: true }).click();
  await created.locator('.bot-return').getByRole('button', { name: '差し戻す', exact: true }).click();
  await expect(created.getByRole('alert')).toContainText('理由');
  await created.getByLabel(/差し戻しの理由/).fill('日程を確認してください');
  await created.locator('.bot-return').getByRole('button', { name: '差し戻す', exact: true }).click();
  await expect(page.getByTestId('candidate-notice')).toHaveText('差し戻しました。');
  expect(fake.calls).toContain('POST /candidates/4/return');
});

test('image: the picture is shown with a download; the AI usage is said', async ({ page }) => {
  await start(page);
  await page.goto('/#/bot/image');
  await expect(page.getByText('画像を作ると、Bot が使う AI の利用量を消費します。')).toBeVisible();
  await page.getByLabel('どんな画像か').fill('医薬祭の看板の下絵');
  await page.getByLabel('縦横比').selectOption('16:9');
  await page.getByTestId('image-submit').click();
  const picture = page.locator('.bot-image img');
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: /image\.png をダウンロード/ })).toHaveAttribute('download', 'image.png');
});

test('image: while the picture feature is postponed (off) its tab is absent and its address shows the questions', async ({ page }) => {
  await start(page, { features: { image: false } });
  await page.goto('/#/bot/image');
  await expect(page.getByTestId('bot-section-image')).toHaveCount(0);
  await expect(page.getByTestId('bot-section-ask')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('ask-question')).toBeVisible();
  await expect(page.getByTestId('image-submit')).toHaveCount(0);
});

test('a Bot host that does not answer keeps the waiting jobs visible and says so', async ({ page }) => {
  const fake = await start(page, { alive: false });
  await page.goto('/#/bot/ask');
  await expect(page.getByTestId('bot-not-alive')).toContainText('Bot が応答していません');
  await page.getByTestId('ask-question').fill('受付の時間を確認したい');
  await page.getByTestId('ask-submit').click();
  await expect(page.getByTestId('bot-waiting').getByTestId('waiting-job')).toContainText('受付の時間を確認したい');
  expect(fake.calls).toContain('GET /jobs?mine=1&limit=20');
});

test('home: one request for the Bot card, its counts, and the link into the Bot tab', async ({ page }) => {
  const fake = await start(page);
  await page.goto('/#/home');
  await expect(page.getByTestId('bot-pending')).toHaveText('2件');
  await expect(page.getByTestId('bot-overdue')).toHaveText('1件');
  await expect(page.getByTestId('bot-today')).toHaveText('1件');
  expect(fake.calls.filter((c) => c === 'GET /summary')).toHaveLength(1);
  await page.getByTestId('home-bot').getByRole('button', { name: 'Bot を開く' }).click();
  await expect(page).toHaveURL(/#\/bot\/ask$/);
});

test('home: the Bot card is hidden while the feature is off', async ({ page }) => {
  await start(page, { failAll: { status: 404, body: { error: 'ASSISTANT_DISABLED', message: 'Bot 機能はこのサーバーでは有効になっていません。' } } });
  await page.goto('/#/home');
  await expect(page.getByRole('heading', { name: 'ホーム', exact: true })).toBeVisible();
  await expect(page.getByTestId('home-bot')).toHaveCount(0);
});

test('home: a failure is shown with retry and never as a zero', async ({ page }) => {
  await start(page, { failAll: { status: 503, body: { error: 'ASSISTANT_UNAVAILABLE', message: 'Bot に接続できません。しばらくしてから再試行してください。' } } });
  await page.goto('/#/home');
  const card = page.getByTestId('home-bot');
  await expect(card.getByRole('alert')).toContainText('Bot の状況を読み込めませんでした');
  await expect(card.getByRole('button', { name: '再試行' })).toBeVisible();
  await expect(page.getByTestId('bot-pending')).toHaveCount(0);
});

test('phone widths: no horizontal scroll on the Bot screens and the module tabs, and 44px touch targets', async ({ page }) => {
  await start(page);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 740 });
    for (const section of ['ask', 'doc', 'mail', 'image', 'remind', 'candidates'] as const) {
      await page.goto(`/#/bot/${section}`);
      await expect(page.getByTestId('bot')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${section} at ${width}px`).toBe(true);
      const sections = await page.locator('.bot-sections a').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
      for (const height of sections) expect(height).toBeGreaterThanOrEqual(44);
    }
    await page.goto('/#/home');
    await expect(page.getByTestId('home-bot')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `home at ${width}px`).toBe(true);
    const tabs = await page.locator('.global-nav a').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(tabs).toHaveLength(7);
    for (const height of tabs) expect(height).toBeGreaterThanOrEqual(44);
  }
});
