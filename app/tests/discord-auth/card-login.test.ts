import { describe, expect, it } from 'vitest';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, setup } from './helpers.js';
import { AccountStore } from '../../src/server/discord-auth/store.js';
import { parseLoginCardUrl } from '../../src/shared/card-login.js';

async function fixture() {
  const ctx = setup();
  const admin = await register(ctx, CHAIR, '21110001');
  const member = await register(ctx, MEMBER, '21110002');
  const device = await ctx.service.registerCardDevice(member.sessionToken, null, '合成スマホ');
  const card = await ctx.service.issueLoginCard(admin.sessionToken, member.initialLoginId, '合成委員カード');
  return { ...ctx, admin, member, device, card };
}
async function active() {
  const ctx = await fixture();
  await ctx.service.activateLoginCard(ctx.admin.sessionToken, ctx.card.id);
  return ctx;
}
describe('committee card authentication', () => {
  it('requires readback activation and a separately verified browser', async () => {
    const c = await fixture();
    await expect(c.service.loginWithCard(c.card.secret, c.device, null)).rejects.toMatchObject({ code: 'card_rejected' });
    await c.service.activateLoginCard(c.admin.sessionToken, c.card.id);
    await expect(c.service.loginWithCard(c.card.secret, null, null)).rejects.toMatchObject({ code: 'device_required' });
    await expect(c.service.loginWithCard(c.card.secret, 'a'.repeat(43), null)).rejects.toMatchObject({ code: 'device_required' });
    const login = await c.service.loginWithCard(c.card.secret, c.device, null);
    expect(await c.service.authenticate(login.sessionToken)).toMatchObject({ initialLoginId: c.member.initialLoginId, admin: false, passwordAt: 0 });
  });
  it('persists only digests, and never lists secrets', async () => {
    const c = await active();
    const saved = JSON.stringify(c.store.read(s => s));
    const listed = JSON.stringify(await c.service.loginCardSettings(c.admin.sessionToken, null));
    expect(saved).not.toContain(c.device);
    expect(saved).not.toContain(c.card.secret);
    expect(listed).not.toContain(c.card.secret);
    expect(listed).not.toContain('tokenHash');
    expect(saved).not.toContain('/card#');
    expect(saved).not.toContain(PASSWORD);
  });
  it('requires the same person to register on each browser, including shared PCs', async () => {
    const c = await active();
    const other = await register(c, OTHER, '21110003');
    const otherCard = await c.service.issueLoginCard(c.admin.sessionToken, other.initialLoginId, '別人');
    await c.service.activateLoginCard(c.admin.sessionToken, otherCard.id);
    await expect(c.service.loginWithCard(otherCard.secret, c.device, null)).rejects.toMatchObject({ code: 'device_required' });
    expect(await c.service.registerCardDevice(other.sessionToken, c.device, '共用PC')).toBe(c.device);
    const login = await c.service.loginWithCard(otherCard.secret, c.device, null);
    expect((await c.service.authenticate(login.sessionToken)).discordUserId).toBe(OTHER);
  });
  it('ordinary members cannot issue or activate any card', async () => {
    const c = await fixture();
    await expect(c.service.issueLoginCard(c.member.sessionToken, c.member.initialLoginId, '不許可')).rejects.toMatchObject({ code: 'card_forbidden' });
    await expect(c.service.activateLoginCard(c.member.sessionToken, c.card.id)).rejects.toMatchObject({ code: 'card_forbidden' });
  });
  it('enrollment needs fresh password proof; card sign-in cannot enroll another device or issue cards', async () => {
    const c = await active();
    const login = await c.service.loginWithCard(c.card.secret, c.device, null);
    await expect(c.service.registerCardDevice(login.sessionToken, null, '無断端末')).rejects.toMatchObject({ code: 'card_forbidden' });
    c.clock.now += 301_000;
    await expect(c.service.registerCardDevice(c.member.sessionToken, null, '古い本人確認')).rejects.toMatchObject({ code: 'card_forbidden' });
    await expect(c.service.registerCardDevice(c.member.sessionToken, null, '再確認', PASSWORD)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('card loss stops all sessions opened with that card immediately, keeping password sessions', async () => {
    const c = await active();
    const one = await c.service.loginWithCard(c.card.secret, c.device, null);
    const two = await c.service.loginWithCard(c.card.secret, c.device, null);
    await c.service.revokeLoginCard(c.member.sessionToken, c.card.id);
    for (const token of [one.sessionToken, two.sessionToken]) await expect(c.service.authenticate(token)).rejects.toMatchObject({ code: 'REJECTED' });
    await expect(c.service.loginWithCard(c.card.secret, c.device, null)).rejects.toMatchObject({ code: 'card_rejected' });
    expect((await c.service.authenticate(c.member.sessionToken)).discordUserId).toBe(MEMBER);
  });
  it('a card session can revoke its own lost card', async () => {
    const c = await active();
    const login = await c.service.loginWithCard(c.card.secret, c.device, null);
    await c.service.revokeLoginCard(login.sessionToken, c.card.id);
    await expect(c.service.authenticate(login.sessionToken)).rejects.toBeDefined();
  });
  it('a member cannot revoke another person card', async () => {
    const c = await active();
    const other = await register(c, OTHER, '21110003');
    await expect(c.service.revokeLoginCard(other.sessionToken, c.card.id)).rejects.toMatchObject({ code: 'card_forbidden' });
  });
  it('removing a device ends card sessions and its next tap; a new registration does not revive old sessions', async () => {
    const c = await active();
    const login = await c.service.loginWithCard(c.card.secret, c.device, null);
    const settings = await c.service.loginCardSettings(c.member.sessionToken, c.device);
    await c.service.revokeCardDevice(c.member.sessionToken, settings.devices[0]!.id);
    await expect(c.service.authenticate(login.sessionToken)).rejects.toBeDefined();
    await expect(c.service.loginWithCard(c.card.secret, c.device, null)).rejects.toMatchObject({ code: 'device_required' });
    await c.service.registerCardDevice(c.member.sessionToken, c.device, '再登録');
    await expect(c.service.authenticate(login.sessionToken)).rejects.toBeDefined();
  });
  it('logging out everywhere also withdraws browser grants, without revoking the physical card', async () => {
    const c = await active();
    await c.service.logout(c.member.sessionToken, true);
    await expect(c.service.loginWithCard(c.card.secret, c.device, null)).rejects.toMatchObject({ code: 'device_required' });
    expect(c.store.read(s => s.cardAuth!.cards[c.card.id]!.revokedAt)).toBeNull();
  });
  it('ordinary logout keeps registration so the next tap works', async () => {
    const c = await active();
    const login = await c.service.loginWithCard(c.card.secret, c.device, null);
    await c.service.logout(login.sessionToken);
    await expect(c.service.loginWithCard(c.card.secret, c.device, null)).resolves.toHaveProperty('sessionToken');
  });
  it('password reset invalidates card versions and browser grants', async () => {
    const c = await active();
    await c.service.changePassword({ sessionToken: c.member.sessionToken, currentPassword: PASSWORD, newPassword: '合成の新しいパスワード0002' });
    await expect(c.service.loginWithCard(c.card.secret, c.device, null)).rejects.toMatchObject({ code: 'device_required' });
  });
  it('expiry invalidates sessions even when the normal session remains unexpired', async () => {
    const c = await active();
    const login = await c.service.loginWithCard(c.card.secret, c.device, null);
    c.store.transact(s => { s.cardAuth!.cards[c.card.id]!.expiresAt = c.clock.now; });
    await expect(c.service.authenticate(login.sessionToken)).rejects.toBeDefined();
    await expect(c.service.loginWithCard(c.card.secret, c.device, null)).rejects.toMatchObject({ code: 'card_rejected' });
  });
  it('expired pending cards cannot be activated and expired browser grants cannot log in', async () => {
    const c = await fixture();
    c.clock.now += 600_001;
    await expect(c.service.activateLoginCard(c.admin.sessionToken, c.card.id, PASSWORD)).rejects.toMatchObject({ code: 'card_rejected' });
    const d = await active();
    d.store.transact(s => { for (const record of Object.values(s.cardAuth!.devices)) record.expiresAt = d.clock.now; });
    await expect(d.service.loginWithCard(d.card.secret, d.device, null)).rejects.toMatchObject({ code: 'device_required' });
  });
  it('refuses inactive members and new logins while the membership provider is down', async () => {
    const c = await active();
    c.host.down = true;
    await expect(c.service.loginWithCard(c.card.secret, c.device, null)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    c.host.down = false;
    c.host.members.get(MEMBER)!.active = false;
    await expect(c.service.loginWithCard(c.card.secret, c.device, null)).rejects.toMatchObject({ code: 'REJECTED' });
  });
  it('rechecks revocation after an awaited membership response', async () => {
    const c = await active();
    const original = c.host.member;
    // The service holds the original callback; inject a revocation before its live member result.
    const service = new (c.service.constructor as typeof import('../../src/server/discord-auth/service.js').DiscordAccountService)({ config: c.config, store: c.store, member: async uid => { c.store.transact(s => { s.cardAuth!.cards[c.card.id]!.revokedAt = c.clock.now; }); return original(uid); }, deliver: c.host.deliver, now: () => c.clock.now });
    await expect(service.loginWithCard(c.card.secret, c.device, null)).rejects.toMatchObject({ code: 'card_rejected' });
  });
  it('reopens a persisted-shape state and keeps all old sessions and account records', async () => {
    const c = await active();
    const clone = AccountStore.memory(c.store.read(s => s));
    expect(clone.read(s => s.accounts)).toEqual(c.store.read(s => s.accounts));
    expect(clone.read(s => s.sessions)).toEqual(c.store.read(s => s.sessions));
    expect(() => AccountStore.memory()).not.toThrow();
  });
  it('never accepts an item URL, foreign host, query credential, extra path, or raw IDm', () => {
    const base = 'https://app.example.invalid';
    const secret = 'a'.repeat(43);
    expect(parseLoginCardUrl(`${base}/card#${secret}`, base)).toBe(secret);
    for (const value of [`${base}/i/IY-100001`, `https://evil.invalid/card#${secret}`, `${base}/card?token=${secret}`, `${base}/card/#${secret}`, `${base}/card#0123456789ABCDEF`, `${base}/card#${secret}x`]) expect(parseLoginCardUrl(value, base)).toBeNull();
  });
});
