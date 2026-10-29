/** No card secrets are returned by list/status APIs. A newly issued secret is shown once. */
export interface LoginCardView {
  id: string;
  account: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  state: 'pending' | 'active' | 'revoked' | 'expired';
}
export interface CardDeviceView {
  id: string;
  label: string;
  expiresAt: number;
  current: boolean;
}
export interface CardSettings {
  cards: LoginCardView[];
  devices: CardDeviceView[];
  deviceRegistered: boolean;
  people: { account: string; name: string }[];
}
export const LOGIN_CARD_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function parseLoginCardUrl(value: string, origin: string): string | null {
  try {
    const url = new URL(value);
    const token = url.hash.slice(1);
    return url.origin === origin && !url.username && !url.password && url.pathname === '/card' && !url.search && LOGIN_CARD_TOKEN.test(token) ? token : null;
  } catch { return null; }
}
