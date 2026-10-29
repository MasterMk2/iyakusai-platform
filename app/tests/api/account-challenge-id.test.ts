import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMAIL, expectAcceptedWithoutCode, makeMockAccountApp, type AccountApp } from '../account-harness.js';

// Regression for the code-leak check: a random challenge ID (32 hex characters) can contain a run of
// eight or more decimal digits. Here every challenge ID is made only of digits, so a check that looks
// for "any 8 digits" in the whole body would fail although no code is present. Only the challenge ID
// is replaced; the code itself still comes from the real generator.
vi.mock('../../src/server/login/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/login/crypto.js')>();
  let n = 0;
  return { ...actual, publicId: (prefix: string) => (prefix === 'lc' ? `lc_${'0123456789'.repeat(3)}${String(n++ % 100).padStart(2, '0')}` : actual.publicId(prefix)) };
});

let a: AccountApp | null = null;
afterEach(async () => {
  await a?.close();
  a = null;
});

describe('code-leak check with an all-digit challenge ID', () => {
  it('accepts the opaque ID, finds no delivered code and the same ID verifies the code', async () => {
    a = await makeMockAccountApp();
    const b = a.browser();
    const req = await b.call('POST', '/api/auth/setup/request', { email: EMAIL['u-editor-a'] });
    expect(req.json.challengeId).toBe(`lc_${'0123456789'.repeat(3)}00`);
    // The case the former whole-body check got wrong.
    expect(req.raw).toMatch(/\d{8}/);
    const code = await a.codeFor('u-editor-a');
    expectAcceptedWithoutCode(req, code, a.service.policy.codeTtlMs / 1000);

    const verify = await b.call('POST', '/api/auth/setup/verify', { challengeId: req.json.challengeId, code });
    expect(verify.status).toBe(200);
    expect(verify.json).toMatchObject({ next: 'set_password', hasPassword: false });
  });
});
