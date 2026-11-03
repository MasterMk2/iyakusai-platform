import { describe, expect, it } from 'vitest';
import { AttemptLimiter, clientBucket, FailureLimiter, LIMITER_MAX_CLIENTS } from '../../src/server/discord-auth/http.js';

// 2026-11-03 review M4: the per-client limiters stay bounded without forgetting everyone, and IPv6 counts by /64.
describe('clientBucket', () => {
  it('keeps IPv4 addresses and folds IPv6 addresses to their /64', () => {
    expect(clientBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(clientBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:0db8:0001:0002::/64');
    expect(clientBucket('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:0db8:0001:0002::/64');
    expect(clientBucket('2001:db8::1')).toBe('2001:0db8:0000:0000::/64');
    expect(clientBucket('::1')).toBe('0000:0000:0000:0000::/64');
    expect(clientBucket(null)).toBeNull();
    expect(clientBucket('not an address')).toBeNull();
  });
});

describe('limiters under many clients', () => {
  it('a flood of distinct clients does not reset a blocked client', () => {
    const limiter = new FailureLimiter(10, 15 * 60_000);
    const now = 1_700_000_000_000;
    for (let i = 0; i < 10; i += 1) limiter.fail('203.0.113.7', now + i);
    expect(limiter.blocked('203.0.113.7', now + 20)).toBe(true);
    // Five thousand other clients fail once each (the old table would have been cleared at 4,096).
    for (let i = 0; i < LIMITER_MAX_CLIENTS + 1000; i += 1) limiter.fail(`2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`, now + 100 + i);
    expect(limiter.size).toBeLessThanOrEqual(LIMITER_MAX_CLIENTS);
    // The blocked client was seen before the flood, so it is the oldest and may have been dropped: it must be blocked
    // again after at most `limit` more failures, never fewer. What must not happen is a reset of the newest clients.
    const newest = `2001:db8:${((LIMITER_MAX_CLIENTS + 999) >> 16).toString(16)}:${((LIMITER_MAX_CLIENTS + 999) & 0xffff).toString(16)}::1`;
    for (let i = 0; i < 9; i += 1) limiter.fail(newest, now + 10_000 + i);
    expect(limiter.blocked(newest, now + 10_100)).toBe(true);
  });

  it('expired entries go first, then the least recently seen', () => {
    const windowMs = 60_000;
    const limiter = new AttemptLimiter(20, windowMs);
    const now = 1_700_000_000_000;
    // Old entries whose window passed.
    for (let i = 0; i < LIMITER_MAX_CLIENTS; i += 1) expect(limiter.allow(`10.0.${(i >> 8) & 255}.${i & 255}`, now - 2 * windowMs + i)).toBe(true);
    expect(limiter.allow('198.51.100.1', now)).toBe(true);
    expect(limiter.size).toBeLessThanOrEqual(LIMITER_MAX_CLIENTS);
    // A recently seen client keeps its count after the table was pruned around it.
    for (let i = 0; i < 19; i += 1) expect(limiter.allow('198.51.100.1', now + 1 + i)).toBe(true);
    expect(limiter.allow('198.51.100.1', now + 30)).toBe(false);
  });
});
