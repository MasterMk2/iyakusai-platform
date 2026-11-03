import { describe, expect, it } from 'vitest';
import { orgPaymentText } from '../../src/shared/organizations.js';
import {
  depositKey,
  guessHeaderRow,
  guessStatementMapping,
  invoiceState,
  nameSimilarity,
  normalizePayerName,
  parseStatementAmount,
  parseStatementDate,
  PaymentValidationError,
  rankDeposit,
  rankDepositsFor,
  rankInvoicesFor,
  readStatementRow,
  tokyoDate,
  validateInvoice,
  type RankDeposit,
  type RankInvoice,
} from '../../src/shared/payments.js';

// The payments' shared rules (入金確認): names, the statement's rows and the ranking of candidates. Synthetic names only.

describe('payer names', () => {
  it('makes a bank\'s half-width kana, hiragana, small kana and the legal form the same text', () => {
    // The bank's marks: ｶ) in front, (ｶ) in the middle, (ｶ at the end.
    const forms = ['ｺﾞｳｾｲｼﾖｳｼﾞ(ｶ', 'ｶ)ｺﾞｳｾｲｼﾖｳｼﾞ', 'ｺﾞｳｾｲ(ｶ)ｼﾖｳｼﾞ', '（カ）ゴウセイショウジ', 'ごうせいしょうじ　かぶしきがいしゃ', 'ゴウセイ ショウジ カブシキガイシャ', 'ﾌﾘｺﾐ ｺﾞｳｾｲｼﾖｳｼﾞ(ｶ'];
    expect(new Set(forms.map(normalizePayerName))).toEqual(new Set(['ゴウセイシヨウジ']));
    expect(normalizePayerName('ｺﾞｳｾｲｼﾖｳｼﾞ(ｶ')).toBe('ゴウセイシヨウジ');
    expect(normalizePayerName('ｶ)ｺﾞｳｾｲｼﾖｳｼﾞ')).toBe('ゴウセイシヨウジ');
    expect(normalizePayerName('ごうせいしょうじ　かぶしきがいしゃ')).toBe('ゴウセイシヨウジ');
    expect(normalizePayerName('ﾌﾘｺﾐ ｺﾞｳｾｲｼﾖｳｼﾞ')).toBe('ゴウセイシヨウジ');
  });

  it('leaves out long-vowel marks, digits and punctuation, and the kanji legal forms', () => {
    expect(normalizePayerName('ｺﾞｳｾｲｻ-ｸﾙ ﾃｽﾄ')).toBe(normalizePayerName('ゴウセイサークル・テスト'));
    expect(normalizePayerName('合成商事株式会社')).toBe('合成商事');
    expect(normalizePayerName('㈱合成商事')).toBe('合成商事');
    expect(normalizePayerName('123456 ｺﾞｳｾｲ')).toBe('ゴウセイ');
    expect(normalizePayerName('Gousei Trading')).toBe('GOUSEITRADING');
    expect(normalizePayerName('')).toBe('');
  });

  it('scores names: equal 1, one inside the other 0.9, else the shared letter pairs', () => {
    expect(nameSimilarity('ゴウセイシヨウジ', 'ゴウセイシヨウジ')).toBe(1);
    expect(nameSimilarity('ゴウセイ', 'ゴウセイシヨウジ')).toBe(0.9);
    expect(nameSimilarity('ゴウセイシヨクヒン', 'ゴウセイシヨウジ')).toBeGreaterThan(0.3);
    expect(nameSimilarity('ゴウセイシヨクヒン', 'ゴウセイシヨウジ')).toBeLessThan(0.9);
    expect(nameSimilarity('リソク', 'ゴウセイシヨウジ')).toBe(0);
    expect(nameSimilarity('', 'ゴウセイ')).toBe(0);
  });
});

describe('ranking', () => {
  const invoice: RankInvoice = { id: 'iv_a', amountYen: 300_000, paidYen: 0, issuedOn: '2026-10-20', dueOn: '2026-11-15', names: ['ゴウセイシヨウジ', '合成商事'] };
  const dep = (id: string, amountYen: number, desc: string, bookedOn = '2026-11-02'): RankDeposit => ({ id, bookedOn, amountYen, payerKey: normalizePayerName(desc) });

  it('puts the same amount and name first, then the amount less a transfer fee, then a part, then other names', () => {
    const deposits = [dep('dp_d', 300_000, 'ﾍﾞﾂﾉﾋﾄ'), dep('dp_c', 100_000, 'ｺﾞｳｾｲｼﾖｳｼﾞ(ｶ'), dep('dp_b', 299_560, 'ｺﾞｳｾｲｼﾖｳｼﾞ(ｶ'), dep('dp_a', 300_000, 'ｺﾞｳｾｲｼﾖｳｼﾞ(ｶ'), dep('dp_e', 12, 'ﾘｿｸ')];
    const order = rankDepositsFor(invoice, deposits).map((r) => r.deposit.id);
    expect(order).toEqual(['dp_a', 'dp_b', 'dp_d', 'dp_c', 'dp_e']);
    const best = rankDeposit(invoice, deposits[3]!);
    expect(best.amountFit).toBe('exact');
    expect(best.reasons).toEqual(['金額が一致', '振込人の名前が一致']);
    expect(rankDeposit(invoice, deposits[2]!).amountFit).toBe('fee');
    expect(rankDeposit(invoice, deposits[1]!).amountFit).toBe('part');
  });

  it('compares with the amount still owed once a part is paid, and counts a deposit before the invoice date against it', () => {
    const half = { ...invoice, paidYen: 100_000 };
    expect(rankDeposit(half, dep('dp_x', 200_000, 'ｺﾞｳｾｲｼﾖｳｼﾞ')).reasons[0]).toBe('残りの額と一致');
    expect(rankDeposit(half, dep('dp_x', 300_000, 'ｺﾞｳｾｲｼﾖｳｼﾞ')).amountFit).toBe('over');
    const early = rankDeposit(invoice, dep('dp_y', 300_000, 'ｺﾞｳｾｲｼﾖｳｼﾞ', '2026-10-01'));
    const later = rankDeposit(invoice, dep('dp_z', 300_000, 'ｺﾞｳｾｲｼﾖｳｼﾞ', '2026-11-01'));
    expect(early.score).toBe(later.score - 10);
    expect(early.reasons).toContain('請求日より前の入金');
  });

  it('breaks ties by the earlier deposit then the id, and invoices by the earlier deadline then the id', () => {
    const same = [dep('dp_2', 5_000, 'ｱ', '2026-11-03'), dep('dp_1', 5_000, 'ｱ', '2026-11-03'), dep('dp_0', 5_000, 'ｱ', '2026-11-04')];
    const target = { ...invoice, amountYen: 5_000, names: [] };
    expect(rankDepositsFor(target, same).map((r) => r.deposit.id)).toEqual(['dp_1', 'dp_2', 'dp_0']);
    const invoices: RankInvoice[] = [
      { ...target, id: 'iv_c', dueOn: null },
      { ...target, id: 'iv_b', dueOn: '2026-11-30' },
      { ...target, id: 'iv_a', dueOn: '2026-11-30' },
      { ...target, id: 'iv_d', dueOn: '2026-11-10' },
    ];
    expect(rankInvoicesFor(same[0]!, invoices).map((r) => r.invoice.id)).toEqual(['iv_d', 'iv_a', 'iv_b', 'iv_c']);
  });

  it('closes an invoice only when it is paid in full or a shortfall is accepted', () => {
    expect(invoiceState(300_000, 0, false, false)).toBe('open');
    expect(invoiceState(300_000, 100_000, false, false)).toBe('partial');
    expect(invoiceState(300_000, 299_560, true, false)).toBe('paid');
    expect(invoiceState(300_000, 300_001, false, false)).toBe('paid');
    expect(invoiceState(300_000, 300_000, false, true)).toBe('void');
  });
});

describe('bank statement rows', () => {
  it('reads the dates banks write, and nothing that is not a real day', () => {
    expect(parseStatementDate('2026/11/05')).toBe('2026-11-05');
    expect(parseStatementDate('2026-1-5')).toBe('2026-01-05');
    expect(parseStatementDate('2026.11.05')).toBe('2026-11-05');
    expect(parseStatementDate('20261105')).toBe('2026-11-05');
    expect(parseStatementDate('2026年11月5日')).toBe('2026-11-05');
    expect(parseStatementDate('令和8年11月5日')).toBe('2026-11-05');
    expect(parseStatementDate('R8.11.5')).toBe('2026-11-05');
    expect(parseStatementDate('R08/11/05')).toBe('2026-11-05');
    expect(parseStatementDate('２０２６／１１／０５')).toBe('2026-11-05');
    expect(parseStatementDate('2026/11/05 10:30')).toBe('2026-11-05');
    expect(parseStatementDate('2026/02/30')).toBeNull();
    expect(parseStatementDate('11/05')).toBeNull();
    expect(parseStatementDate('')).toBeNull();
  });

  it('reads amounts with commas, yen marks, full-width digits and the signs of a withdrawal', () => {
    expect(parseStatementAmount('1,000')).toBe(1000);
    expect(parseStatementAmount('¥300,000')).toBe(300000);
    expect(parseStatementAmount('５，０００円')).toBe(5000);
    expect(parseStatementAmount('-5,000')).toBe(-5000);
    expect(parseStatementAmount('△5,000')).toBe(-5000);
    expect(parseStatementAmount('▲12')).toBe(-12);
    expect(parseStatementAmount('(800)')).toBe(-800);
    expect(parseStatementAmount('')).toBeNull();
    expect(parseStatementAmount('abc')).toBe('invalid');
    expect(parseStatementAmount('1.5')).toBe('invalid');
  });

  it('keeps deposits, never withdrawals, and says why a row cannot be read', () => {
    const row = (changes: Partial<Record<'date' | 'description' | 'deposit' | 'withdrawal' | 'balance', string>>) => ({ date: '2026/11/02', description: 'ﾌﾘｺﾐ ｺﾞｳｾｲｼﾖｳｼﾞ(ｶ', deposit: '300,000', withdrawal: '', balance: '1,300,000', ...changes });
    expect(readStatementRow(row({}))).toEqual({ kind: 'deposit', bookedOn: '2026-11-02', description: 'フリコミ ゴウセイシヨウジ(カ', amountYen: 300000, balanceYen: 1300000 });
    expect(readStatementRow(row({ deposit: '', withdrawal: '5,000' }))).toEqual({ kind: 'withdrawal' });
    expect(readStatementRow(row({ deposit: '-5,000' }))).toEqual({ kind: 'withdrawal' });
    expect(readStatementRow(row({ deposit: '△5,000' }))).toEqual({ kind: 'withdrawal' });
    expect(readStatementRow(row({ deposit: '' }))).toEqual({ kind: 'unreadable', reason: '入金額が空です' });
    expect(readStatementRow(row({ date: '合計' }))).toMatchObject({ kind: 'unreadable' });
    expect(readStatementRow(row({ description: '  ' }))).toEqual({ kind: 'unreadable', reason: '摘要（振込人）が空です' });
    expect(readStatementRow(row({ deposit: '三万円' }))).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('入金額') });
    expect(readStatementRow(row({ balance: '' }))).toMatchObject({ kind: 'deposit', balanceYen: null });
  });

  it('finds the header row below a bank\'s own lines and guesses the columns by their names', () => {
    const rows = [['口座番号', '（合成）'], ['期間', '2026/10/01～2026/11/04'], ['取引日', '摘要', 'お支払金額', 'お預り金額', '差引残高'], ['2026/11/02', 'ｺﾞｳｾｲ', '', '300,000', '1,300,000']];
    const header = guessHeaderRow(rows);
    expect(header).toBe(2);
    expect(guessStatementMapping(rows[header]!)).toEqual({ date: 0, description: 1, withdrawal: 2, deposit: 3, balance: 4 });
    expect(guessStatementMapping(['日付', '内容', '入金額', '出金額', '残高'])).toEqual({ date: 0, description: 1, deposit: 2, withdrawal: 3, balance: 4 });
  });

  it('gives two rows the same key only when the date, the description, the amount and the balance are all the same', () => {
    const a = { bookedOn: '2026-11-02', description: 'ゴウセイ', amountYen: 5000, balanceYen: 10_000 };
    expect(depositKey(a)).toBe(depositKey({ ...a }));
    expect(depositKey(a)).not.toBe(depositKey({ ...a, balanceYen: 15_000 }));
    expect(depositKey(a)).not.toBe(depositKey({ ...a, balanceYen: null }));
    expect(depositKey(a)).not.toBe(depositKey({ ...a, bookedOn: '2026-11-03' }));
  });
});

describe('invoices', () => {
  const base = { orgId: 'og_0000000000000001', number: '', amountYen: 300_000, issuedOn: '2026-10-20', dueOn: '2026-11-15', payerKana: ' ゴウセイ　シヨウジ ', memo: '' };

  it('tidies an invoice and names the field of an error', () => {
    expect(validateInvoice(base)).toEqual({ ...base, payerKana: 'ゴウセイ シヨウジ' });
    const field = (changes: Record<string, unknown>) => {
      try {
        validateInvoice({ ...base, ...changes });
        return null;
      } catch (err) {
        return err instanceof PaymentValidationError ? err.field : 'other';
      }
    };
    expect(field({ amountYen: 0 })).toBe('amountYen');
    expect(field({ amountYen: 1.5 })).toBe('amountYen');
    expect(field({ dueOn: '2026-10-01' })).toBe('dueOn');
    expect(field({ issuedOn: '2026-02-30' })).toBe('issuedOn');
    expect(field({ number: '請求1' })).toBe('number');
    expect(field({ orgId: 'x' })).toBe('orgId');
    expect(field({ number: '2026-010' })).toBeNull();
  });

  it('counts days in Japan', () => {
    expect(tokyoDate('2026-11-03T15:30:00Z')).toBe('2026-11-04');
    expect(tokyoDate('2026-11-03T14:59:00Z')).toBe('2026-11-03');
  });
});

describe("the payment lines of an organization's history (for the accounting only)", () => {
  const line = { amountYen: 2_500, date: '2026-11-04', invoiceNumber: '2026-001', paidYen: 2_500 };
  it('says what came in, and what an accepted shortfall closed with, never a payment of 0 yen', () => {
    expect(orgPaymentText('payment_confirmed', { ...line, acceptShort: false })).toBe('2,500円・2026-11-04・請求 2026-001');
    expect(orgPaymentText('payment_confirmed', { ...line, acceptShort: true })).toBe('2,500円・2026-11-04・請求 2026-001（不足を認めて入金済み）');
    expect(orgPaymentText('payment_confirmed', { ...line, amountYen: 0, acceptShort: true })).toBe('不足を認めて入金済み（入金 2,500円・最後の入金 2026-11-04）・請求 2026-001');
    expect(orgPaymentText('payment_unconfirmed', { ...line, date: null, acceptShort: true })).toBe('2,500円・請求 2026-001（不足の承認も取り消し）');
    expect(orgPaymentText('payment_unconfirmed', { ...line, amountYen: 0, date: null, acceptShort: true })).toBe('不足の承認を取り消し（入金 2,500円）・請求 2026-001');
  });
  it('says which change of an invoice moved the stage', () => {
    const recheck = { amountYen: 0, date: null, invoiceNumber: '2026-002' };
    expect(orgPaymentText('payment_rechecked', { ...recheck, cause: 'invoice_restored', settled: false })).toBe('請求 2026-002 の取り消しを戻したため、入金済みでない請求があります');
    expect(orgPaymentText('payment_rechecked', { ...recheck, cause: 'invoice_voided', settled: true })).toBe('請求 2026-002 を取り消したため、すべての請求が入金済みになりました');
  });
});
