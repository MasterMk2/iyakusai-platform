import type { LoginCardView } from '../../shared/card-login.js';
export const CARD_DAYS = 365;
export const DEVICE_DAYS = 180;
export interface LoginCard {
  id: string;
  tokenHash: string;
  discordUserId: string;
  version: number;
  label: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  activatedAt: number | null;
  revokedAt: number | null;
}
export interface CardDevice {
  id: string;
  label: string;
  expiresAt: number;
  /** Each person verifies themselves once, including on a shared PC. */
  grants: Record<string, number>;
}
export interface CardAuthState {
  cards: Record<string, LoginCard>;
  /** HMAC of the HttpOnly browser cookie. */
  devices: Record<string, CardDevice>;
  events: { at: number; kind: string; actor: string; subject: string; id: string }[];
}
export class CardAuthError extends Error {
  constructor(readonly code: 'card_rejected' | 'device_required' | 'account_switch' | 'card_forbidden' | 'card_limit') { super(code); }
}
export function cardView(card: LoginCard, account: string, now: number, version: number): LoginCardView {
  return { id: card.id, account, label: card.label, createdAt: card.createdAt, expiresAt: card.expiresAt, lastUsedAt: card.lastUsedAt,
    state: card.revokedAt !== null || card.version !== version ? 'revoked' : card.expiresAt <= now ? 'expired' : card.activatedAt === null ? 'pending' : 'active' };
}
export function validateCardAuth(value: CardAuthState): boolean {
  const digest = /^[a-f0-9]{64}$/;
  const id = /^[a-f0-9]{32}$/;
  const uid = /^\d{17,20}$/;
  const time = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  const nullableTime = (v: unknown) => v === null || time(v);
  if (!value || typeof value !== 'object' || !value.cards || !value.devices || !Array.isArray(value.events)) return false;
  const hashes = new Set<string>();
  for (const [key, c] of Object.entries(value.cards)) {
    if (!c || key !== c.id || !id.test(key) || !digest.test(c.tokenHash) || hashes.has(c.tokenHash) || !uid.test(c.discordUserId) || !Number.isSafeInteger(c.version) || c.version < 1 || typeof c.label !== 'string' || !c.label.trim() || c.label.length > 80 || !time(c.createdAt) || !time(c.expiresAt) || !nullableTime(c.activatedAt) || !nullableTime(c.revokedAt) || !nullableTime(c.lastUsedAt)) return false;
    hashes.add(c.tokenHash);
  }
  for (const [hash, d] of Object.entries(value.devices)) {
    if (!d || !digest.test(hash) || !id.test(d.id) || typeof d.label !== 'string' || d.label.length > 80 || !time(d.expiresAt) || !d.grants || typeof d.grants !== 'object' || Array.isArray(d.grants)) return false;
    if (Object.entries(d.grants).some(([u, v]) => !uid.test(u) || !Number.isSafeInteger(v) || v < 1)) return false;
  }
  return value.events.every(e => e && time(e.at) && typeof e.kind === 'string' && uid.test(e.actor) && uid.test(e.subject) && id.test(e.id));
}
