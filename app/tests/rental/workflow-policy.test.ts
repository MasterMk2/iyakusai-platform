import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RentalStore } from '../../src/server/rental/store.js';
import { recordBytes, ledgerPayload } from '../../src/server/rental/drive-sync.js';
import { ACTOR, demoStore, metadata, RED, statusOf } from './helpers.js';
let ctx: ReturnType<typeof demoStore>;
beforeEach(() => { ctx = demoStore(); });
afterEach(() => ctx.cleanup());
function item(scope: string, extra: Record<string, unknown> = {}) {
  const group = ctx.store.borrowerGroups()[0]!;
  const value = {code:'IY-100001', name:'試験物品', url:'https://app.iyakusai.com/i/IY-100001',borrower_id:group.id,item_scope:scope,...extra};
  ctx.store.preassign([value], ACTOR);
  return metadata({item_code:value.code,item_version:1,borrower:group.name});
}
describe('per-item photo and note requirements, with saved checks', () => {
  it('requires an external photo for loans, returns and checks even with a forged skip flag', () => {
    const loan = item('学外');
    expect(statusOf(() => ctx.store.submit({...loan,photo_skip:true}, [], ACTOR))).toBe(400);
    ctx.store.submit(loan, [RED], ACTOR);
    for (const action of ['return','check']) expect(statusOf(() => ctx.store.submit(metadata({item_code:'IY-100001',item_version:2,action,borrower:''}), [], ACTOR))).toBe(400);
    ctx.store.submit(metadata({item_code:'IY-100001',item_version:2,action:'return',borrower:''}), [RED], ACTOR);
    expect(ctx.store.item('IY-100001').status).toBe('ready');
  });
  it.each(['学内','委員会'])('accepts zero photos on all three operations for %s', (scope) => {
    const loan = item(scope);
    ctx.store.submit(loan, [], ACTOR);
    ctx.store.submit(metadata({item_code:'IY-100001',item_version:2,action:'check',borrower:''}), [], ACTOR);
    ctx.store.submit(metadata({item_code:'IY-100001',item_version:3,action:'return',borrower:''}), [], ACTOR);
    expect(ctx.store.item('IY-100001')).toMatchObject({status:'ready',photo_required:false});
  });
  it('requires damage notes for every operation before adding history or changing state', () => {
    const loan = item('学内');
    expect(statusOf(() => ctx.store.submit({...loan,condition:'damage'}, [], ACTOR))).toBe(400);
    ctx.store.submit(loan, [], ACTOR);
    for (const action of ['return','check']) expect(statusOf(() => ctx.store.submit(metadata({item_code:'IY-100001',item_version:2,action,condition:'damage',borrower:''}), [], ACTOR))).toBe(400);
    expect(ctx.store.item('IY-100001').version).toBe(2);
  });
  it('preserves the active loan and group count, persists checkpoint photos, and replays checks once', () => {
    const loan = item('学外'); ctx.store.submit({...loan,condition:'damage',note:'貸出前の傷'}, [RED], ACTOR);
    const before = ctx.store.item('IY-100001'), totals = ctx.store.summary();
    const check = metadata({item_code:'IY-100001',item_version:2,action:'check',condition:'damage',note:'搬出前の確認',borrower:''});
    const receipt = ctx.store.submit(check,[RED],ACTOR);
    expect(ctx.store.submit(check,[RED],ACTOR)).toEqual(receipt);
    expect(ctx.store.item('IY-100001')).toMatchObject({status:'loaned',current_loan:before.current_loan,version:3});
    expect(ctx.store.summary()).toEqual(totals);
    expect(ctx.store.overview().items[0]!.returned_at).toBeNull();
    const info = ctx.store.inspection('IY-100001');
    expect(info.loan).toMatchObject({condition:'damage',note:'貸出前の傷'});
    expect(info.last_check).toMatchObject({condition:'damage',note:'搬出前の確認',photos:[{index:1}]});
    expect(ctx.store.loanPhoto(check.operation_id,'1').data).toEqual(RED);
    const reopened = new RentalStore(ctx.dir,{demo:true}); expect(reopened.inspection('IY-100001').last_check!.note).toBe('搬出前の確認'); reopened.close();
    const op = ctx.store.operationLog().find(o=>o.id===check.operation_id)!;
    expect(recordBytes({...op,action:'check',server_at:receipt.server_at,item_code:'IY-100001'}, []).toString()).toContain('随時チェック');
    expect(JSON.stringify(ledgerPayload(ctx.store,new Date()))).toContain('随時チェック');
  });
  it('rejects conflicting requirements and persists the derived rule after reopening', () => {
    expect(() => item('学外',{photo_required:false})).toThrow();
    item('学外',{photo_required:true});
    const reopened = new RentalStore(ctx.dir,{demo:true}); expect(reopened.item('IY-100001').photo_required).toBe(true); reopened.close();
  });
});
