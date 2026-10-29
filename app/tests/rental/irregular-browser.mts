import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { seedState, EDITOR_A, EDITOR_C, VIEWER_B } from '../helpers.js';
import { StateStore } from '../../dist/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../dist/server/http/app.js';
import { RentalStore } from '../../dist/server/rental/store.js';
import { seedRentalDemo } from '../../dist/server/rental/seed.js';

const root = path.resolve(import.meta.dirname, '../..'), output = path.join(root,'verification/browser');
mkdirSync(output,{recursive:true});
const rental = new RentalStore(mkdtempSync(path.join(tmpdir(),'irregular-browser-')),{demo:true}); seedRentalDemo(rental);
const port = 17852, origin = `http://127.0.0.1:${port}`;
const app = await buildApp({store:new StateStore(await seedState(),null),listenPort:port,rental:{store:rental,itemOrigin:'https://example.invalid',webDir:path.join(root,'dist/rental-web')}});
const checks: string[] = [], errors: string[] = [];
async function api(url:string, body?:unknown, user:string|null=EDITOR_A, extra={}) {
  return app.inject({method:body?'POST':'GET',url,headers:{host:`127.0.0.1:${port}`,origin,'x-smm-csrf':'1',...(user?{cookie:`${SESSION_COOKIE}=${user}`}:{ }),...(body?{'content-type':'application/json'}:{}),...extra},...(body?{payload:JSON.stringify(body)}:{})});
}
const endpoint = '/api/rental/issuer/irregular-cards';
const revision = (await api('/api/rental/issuer/state')).json().revision;
const body = {request_id:randomUUID(),count:2,expected_revision:revision};
assert.equal((await api(endpoint,body,null)).statusCode,401);
assert.equal((await api(endpoint,body,VIEWER_B)).statusCode,403);
assert.equal((await api(endpoint,body,EDITOR_C)).statusCode,403);
assert.equal((await api(endpoint,body,EDITOR_A,{'x-rental-generation':'99'})).statusCode,409);
checks.push('発行権限・未ログイン・台帳世代の拒否');
const created = await api(endpoint,body); assert.equal(created.statusCode,200,created.body);
const cards = created.json().items;
assert.deepEqual((await api(endpoint,body)).json().items,cards);
checks.push('発行APIの同一ID再送で重複作成なし');
await app.listen({host:'127.0.0.1',port});
const browser = await chromium.launch({headless:true,channel:'msedge'});
const context = await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
await context.addCookies([{name:SESSION_COOKIE,value:EDITOR_A,url:origin}]);
const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
async function read(code:string) { await page.locator('#item-code').fill(code); await page.locator('#item-form button').click(); await expect(page.locator('#current-code')).toContainText('IY-IR-000001'); }
async function next() {
  await page.locator('#workflow-next').click();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#workflow-next')?.disabled || !document.querySelector('#workflow')?.checkVisibility());
}
async function finish() {
  await page.locator('[data-damage="normal"]').click();
  await expect(page.locator('[data-damage="normal"]')).toHaveAttribute('aria-pressed','true');
  await next(); await next(); await next();
  if (await page.locator('#borrower').isVisible()) { await page.locator('#borrower').fill('試用 模擬店A'); await page.locator('#borrower').press('Tab'); }
  await next(); await expect(page.locator('#completion-title')).toContainText('完了');
}
try {
  await page.goto(origin+'/rental'); await read('IR-000001');
  await expect(page.locator('#workflow-details')).toBeVisible(); await next();
  await expect(page.locator('#workflow-navigation')).toContainText('品名');
  await page.locator('#irregular-name').fill('延長コード 5m');
  await page.locator('#irregular-quantity').fill('3'); await page.locator('#irregular-unit').fill('本');
  await page.locator('#irregular-scope').selectOption('学外'); await next();
  await expect(page.locator('#workflow-navigation')).toContainText('借用元');
  await page.locator('#irregular-owner').fill('試験業者');
  await page.screenshot({path:path.join(output,'mobile-details.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.reload(); await expect(page.locator('#irregular-name')).toHaveValue('延長コード 5m');
  await read('IR-000001'); await expect(page.locator('#irregular-quantity')).toHaveValue('3');
  checks.push('スマホ幅・必須欄・再読/再読込で入力保持');
  await next(); await page.locator('[data-damage="normal"]').click(); await next();
  await next(); await expect(page.locator('#workflow-navigation')).toContainText('写真');
  await page.locator('#workflow-back').click(); await page.locator('#workflow-back').click();
  await page.locator('#irregular-scope').selectOption('学内'); await page.locator('#irregular-owner').fill('大学');
  await next(); await finish();
  assert.equal(rental.item(cards[0].code).name,'延長コード 5m');
  checks.push('学外写真必須・学内写真任意で貸出登録');
  await page.locator('#completion-next').click(); await read('IR-000001');
  await expect(page.locator('#operation-choice')).toBeVisible();
  await expect(page.locator('#operation-choice')).toContainText('延長コード');
  await page.locator('[data-choice="return"]').click(); await finish();
  assert.equal(rental.item(cards[0].code).current_loan,null);
  await page.locator('#completion-next').click(); await read('IR-000001');
  await expect(page.locator('#irregular-name')).toHaveValue(''); await expect(page.locator('#irregular-quantity')).toHaveValue('');
  await page.locator('#irregular-history summary').click();
  await expect(page.locator('#irregular-history-values')).toContainText('延長コード 5m 3本');
  checks.push('返却は貸出時の内容表示・再利用時は品名/数量が空欄・履歴保持');
  await page.setViewportSize({width:1280,height:900});
  await page.locator('#irregular-name').fill('台車'); await page.locator('#irregular-quantity').fill('1');
  await page.locator('#irregular-unit').fill('台'); await page.locator('#irregular-scope').selectOption('委員会');
  await next(); await page.screenshot({path:path.join(output,'desktop-reuse.png'),fullPage:true});
  await finish();
  assert.equal(rental.item(cards[0].code).name,'台車');
  const history = rental.inspection(cards[0].code).irregular_history!;
  assert.equal(history.length,3); assert.equal((history[2].irregular as {name:string}).name,'延長コード 5m');
  checks.push('PC幅で別物品へ再貸出・過去スナップショット不変');
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(output,'result.json'),JSON.stringify({status:'passed',checks,page_errors:errors,production:false,physical_cards:false},null,2));
  console.log(JSON.stringify({status:'passed',checks}));
} finally { await browser.close(); await app.close(); rental.close(); }
