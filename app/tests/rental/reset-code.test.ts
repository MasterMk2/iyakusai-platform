import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {RentalStore} from '../../src/server/rental/store.js';
import {IssuerManagement} from '../../src/server/rental/issuer-management.js';
import {ACTOR,statusOf} from './helpers.js';

let dir:string,store:RentalStore,manager:IssuerManagement;
beforeEach(()=>{
 dir=mkdtempSync(path.join(tmpdir(),'reset-code-'));store=new RentalStore(dir,{demo:true});manager=new IssuerManagement(store,'https://example.test');
 store.addItems([['IY-100001','合成机']]);
});
afterEach(()=>{vi.restoreAllMocks();store.close();rmSync(dir,{recursive:true,force:true});});
const preview=(mode='force_reset')=>manager.preview({mode,confirmation_style:'digits3'},ACTOR,true);
const apply=(p:ReturnType<IssuerManagement['preview']>,confirmation:unknown=p.confirmation_code)=>manager.apply({token:p.token,confirmation,all_writers_stopped:true},ACTOR,true);
describe('server-issued three digit reset confirmation',()=>{
 it.each(['force_reset','force_reset_all'])('requires the displayed code for %s and consumes the preview',mode=>{
  const p=preview(mode);expect(p.confirmation_code).toMatch(/^[1-9][0-9]{2}$/);
  expect(statusOf(()=>apply(p,'物品台帳を強制リセット'))).toBe(400);
  expect(statusOf(()=>apply(p,'連番と重複防止を含めて初期化'))).toBe(400);
  expect(statusOf(()=>apply(p,Number(p.confirmation_code)))).toBe(400);
  const wrong=String(100+(Number(p.confirmation_code)-99)%900);
  expect(statusOf(()=>apply(p,wrong))).toBe(400);
  expect(manager.snapshot().items).toHaveLength(1);
  expect(apply(p).items).toEqual([]);
  expect(statusOf(()=>apply(p))).toBe(409);
 });
 it('keeps the owner, authority, expiry and all-PC-stop checks',()=>{
  const p=preview('force_reset_all');
  expect(statusOf(()=>manager.apply({token:p.token,confirmation:p.confirmation_code},ACTOR,true))).toBe(400);
  expect(statusOf(()=>manager.apply({token:p.token,confirmation:p.confirmation_code,all_writers_stopped:true},{id:'other',name:'他PC'},true))).toBe(409);
  expect(statusOf(()=>manager.apply({token:p.token,confirmation:p.confirmation_code,all_writers_stopped:true},ACTOR,false))).toBe(403);
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+11*60*1000);
  expect(statusOf(()=>apply(p))).toBe(409);expect(manager.snapshot().items).toHaveLength(1);
 });
 it('keeps optimistic concurrency even with the correct code',()=>{
  const p=preview();store.db.prepare('UPDATE items SET version=version+1 WHERE code=?').run('IY-100001');
  expect(statusOf(()=>apply(p))).toBe(409);expect(manager.snapshot().items).toHaveLength(1);
 });
 it('retains the legacy phrase protocol and leaves ordinary edits unchanged',()=>{
  const p=manager.preview({mode:'force_reset'},ACTOR,true);expect(p.confirmation_code).toBeUndefined();
  expect(manager.apply({token:p.token,confirmation:'物品台帳を強制リセット'},ACTOR,true).items).toEqual([]);
  expect(manager.preview({mode:'reset',confirmation_style:'digits3'},ACTOR,true).confirmation_code).toBeUndefined();
 });
});
