import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { depositKey, normalizePayerName, type InvoiceInput } from '../../src/shared/payments.js';
import { PaymentRefused, PaymentsStore, stateOf, type NewDeposit } from '../../src/server/payments/store.js';

// payments.sqlite3 (入金確認): invoices, deposits, the confirmed matches and the accounting permissions. Synthetic data.

const NOW = '2026-11-04T01:00:00.000Z';
const ORG = { name: '合成商事株式会社', nameKey: '合成商事株式会社', fiscalYear: 2026 };
let dir: string;
let store: PaymentsStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-payments-store-'));
  store = new PaymentsStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = (changes: Partial<InvoiceInput> = {}): InvoiceInput => ({ orgId: 'og_0000000000000001', number: '', amountYen: 300_000, issuedOn: '2026-10-20', dueOn: '2026-11-15', payerKana: 'ゴウセイシヨウジ', memo: '', ...changes });
let tokens = 0;
const token = () => `token-${String(++tokens).padStart(16, '0')}`;
const deposit = (line: number, description: string, amountYen: number, balanceYen: number | null, bookedOn = '2026-11-02'): NewDeposit => ({
  line,
  bookedOn,
  description,
  payerKey: normalizePayerName(description),
  dupKey: depositKey({ bookedOn, description, amountYen, balanceYen }),
  amountYen,
  balanceYen,
});
const refusal = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof PaymentRefused) return err.reason;
    throw err;
  }
};

describe('invoices', () => {
  it('numbers the invoices of a year, and a client token sent again makes no second invoice', () => {
    const t = token();
    const a = store.createInvoice(input(), ORG, t, 'u1', NOW);
    expect(a.number).toBe('2026-001');
    expect(store.createInvoice(input({ amountYen: 1 }), ORG, t, 'u1', NOW).id).toBe(a.id);
    expect(store.createInvoice(input({ orgId: 'og_0000000000000002' }), ORG, token(), 'u1', NOW).number).toBe('2026-002');
    expect(refusal(() => store.createInvoice(input({ number: '2026-001' }), ORG, token(), 'u1', NOW))).toBe('number_taken');
    expect(store.invoicesOfYear(2026)).toHaveLength(2);
  });

  it('keeps the old values in the history of a change, and refuses an older version', () => {
    const a = store.createInvoice(input(), ORG, token(), 'u1', NOW);
    const b = store.updateInvoice(a.id, 1, input({ amountYen: 280_000, memo: '値引き' }), 'u2', NOW)!;
    expect(b.version).toBe(2);
    expect(refusal(() => store.updateInvoice(a.id, 1, input({ amountYen: 1 }), 'u2', NOW))).toBe('conflict');
    const h = store.history('invoice', a.id);
    expect(h[0]).toMatchObject({ action: 'invoice_updated', before: { amountYen: 300_000, memo: '' }, detail: { changed: ['amountYen', 'memo'] } });
  });

  it('withdraws an invoice only without confirmed deposits, and puts it back', () => {
    const a = store.createInvoice(input(), ORG, token(), 'u1', NOW);
    const imp = store.addImport('明細', [deposit(2, 'ｺﾞｳｾｲ', 300_000, 1)], 'u1', NOW);
    const d = store.deposits().find((x) => x.import_id === imp)!;
    store.confirm(a.id, 1, [d.id], null, 'u1', NOW);
    expect(refusal(() => store.voidInvoice(a.id, 2, '', 'u1', NOW))).toBe('has_payments');
    store.unconfirm(a.id, 2, [d.id], 'u1', NOW);
    const v = store.voidInvoice(a.id, 3, '二重に作った', 'u1', NOW)!;
    expect(stateOf(v)).toBe('void');
    expect(refusal(() => store.confirm(a.id, 4, [d.id], null, 'u1', NOW))).toBe('void');
    expect(stateOf(store.restoreInvoice(a.id, 4, 'u1', NOW)!)).toBe('open');
  });
});

describe('confirming payments', () => {
  const setup = () => {
    const a = store.createInvoice(input(), ORG, token(), 'u1', NOW);
    const b = store.createInvoice(input({ orgId: 'og_0000000000000002', amountYen: 5_000 }), { ...ORG, name: '合成サークル', nameKey: '合成サークル' }, token(), 'u1', NOW);
    store.addImport('明細', [deposit(2, 'ｺﾞｳｾｲ', 100_000, 100_000), deposit(3, 'ｺﾞｳｾｲ', 199_560, 299_560), deposit(4, 'ｻｰｸﾙ', 5_000, 304_560)], 'u1', NOW);
    const [d1, d2, d3] = store.deposits().sort((x, y) => x.line - y.line);
    return { a, b, d1: d1!, d2: d2!, d3: d3! };
  };

  it('puts several deposits on one invoice (分割), and closes a shortfall only when someone accepts it', () => {
    const { a, d1, d2 } = setup();
    const first = store.confirm(a.id, 1, [d1.id], null, 'u1', NOW)!;
    expect(stateOf(first.after)).toBe('partial');
    expect(first.after.paid_yen).toBe(100_000);
    const second = store.confirm(a.id, 2, [d2.id], null, 'u1', NOW)!;
    expect(stateOf(second.after)).toBe('partial');
    expect(second.after.paid_yen).toBe(299_560);
    const settled = store.confirm(a.id, 3, [], { note: '振込手数料' }, 'u1', NOW)!;
    expect(stateOf(settled.after)).toBe('paid');
    expect(settled.after.short_note).toBe('振込手数料');
    expect(store.allocations(a.id).map((x) => x.deposit_id)).toEqual([d1.id, d2.id]);
  });

  it('never puts one deposit on two invoices, and a second confirmation from an older screen is refused', () => {
    const { a, b, d3 } = setup();
    store.confirm(b.id, 1, [d3.id], null, 'u1', NOW);
    expect(refusal(() => store.confirm(a.id, 1, [d3.id], null, 'u2', NOW))).toBe('deposit_taken');
    expect(refusal(() => store.confirm(b.id, 1, [], { note: 'x' }, 'u2', NOW))).toBe('conflict');
    // The refused writes left nothing behind.
    expect(store.allocations(a.id)).toHaveLength(0);
    expect(store.invoice(a.id)!.version).toBe(1);
  });

  it('takes a confirmation back, keeps its row and history, and the deposit can be used again', () => {
    const { a, b, d3 } = setup();
    store.confirm(b.id, 1, [d3.id], null, 'u1', NOW);
    const back = store.unconfirm(b.id, 2, [d3.id], 'u2', NOW)!;
    expect(stateOf(back.after)).toBe('open');
    expect(back.amountYen).toBe(5_000);
    expect(refusal(() => store.unconfirm(b.id, 3, [d3.id], 'u2', NOW))).toBe('not_allocated');
    expect(Number((store.db.prepare('SELECT count(*) AS n FROM allocations WHERE undone_at IS NOT NULL').get() as { n: number }).n)).toBe(1);
    expect(store.history('invoice', b.id).map((h) => h.action)).toEqual(['unconfirmed', 'confirmed', 'invoice_created']);
    expect(store.history('deposit', d3.id).map((h) => h.action)).toEqual(['unconfirmed', 'confirmed']);
    expect(stateOf(store.confirm(a.id, 1, [d3.id], null, 'u1', NOW)!.after)).toBe('partial');
  });

  it('refuses a deposit that is set aside, and one that is on an invoice cannot be set aside', () => {
    const { a, b, d1, d3 } = setup();
    store.setExcluded(d1.id, true, '利息', 'u1', NOW);
    expect(refusal(() => store.confirm(a.id, 1, [d1.id], null, 'u1', NOW))).toBe('deposit_unusable');
    store.confirm(b.id, 1, [d3.id], null, 'u1', NOW);
    expect(refusal(() => store.setExcluded(d3.id, true, '', 'u1', NOW))).toBe('deposit_taken');
    expect(store.setExcluded(d1.id, false, '', 'u1', NOW)!.excluded).toBe(0);
  });

  it('learns the names a payer used, for the next year\'s invoice of the same organization', () => {
    const { b, d3 } = setup();
    store.confirm(b.id, 1, [d3.id], null, 'u1', NOW);
    expect(store.learnedDescriptions('合成サークル')).toEqual(['ｻｰｸﾙ']);
    expect(store.payerHint('合成商事株式会社')).toBe('ゴウセイシヨウジ');
    expect(store.payerHint('知らない団体')).toBe('');
  });
});

describe('imports', () => {
  it('counts the stored deposits of each key, and an import is taken back only while none of it is confirmed', () => {
    const rows = [deposit(2, 'ｺﾞｳｾｲ', 5_000, null), deposit(3, 'ｺﾞｳｾｲ', 5_000, null)];
    const id = store.addImport('明細', rows, 'u1', NOW);
    expect(store.keyCounts([rows[0]!.dupKey]).get(rows[0]!.dupKey)).toBe(2);
    const inv = store.createInvoice(input({ amountYen: 5_000 }), ORG, token(), 'u1', NOW);
    const d = store.deposits()[0]!;
    store.confirm(inv.id, 1, [d.id], null, 'u1', NOW);
    expect(store.removeImport(id, 'u1', NOW)).toBe('matched');
    store.unconfirm(inv.id, 2, [d.id], 'u1', NOW);
    expect(store.removeImport(id, 'u1', NOW)).toBe('removed');
    expect(store.deposits()).toHaveLength(0);
    expect(store.keyCounts([rows[0]!.dupKey]).size).toBe(0);
    expect(store.imports()[0]).toMatchObject({ added: 2, removed_by: 'u1' });
  });
});

describe('accounting permissions', () => {
  it('adds the departments\' grants to a member\'s own, and confirming includes viewing', () => {
    expect(store.setAccess(0, { kind: 'department', id: '会計課' }, 'accounting.confirm', true, 'admin', NOW)).toBe(1);
    expect(store.setAccess(1, { kind: 'user', id: 'u-view' }, 'accounting.view', true, 'admin', NOW)).toBe(2);
    expect(store.permissionsOf('u-any', ['会計課'])).toEqual(['accounting.view', 'accounting.confirm']);
    expect(store.permissionsOf('u-view', ['企画部'])).toEqual(['accounting.view']);
    expect(store.permissionsOf('u-none', [])).toEqual([]);
    expect(store.setAccess(1, { kind: 'user', id: 'u-view' }, 'accounting.view', false, 'admin', NOW)).toBe('conflict');
    expect(store.setAccess(2, { kind: 'user', id: 'u-view' }, 'accounting.view', false, 'admin', NOW)).toBe(3);
    expect(store.permissionsOf('u-view', [])).toEqual([]);
    expect(store.accessEvents().map((e) => [e.target, e.granted])).toEqual([
      ['u-view', false],
      ['u-view', true],
      ['会計課', true],
    ]);
  });
});
