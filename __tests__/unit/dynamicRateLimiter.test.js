/**
 * Unit tests for the dynamic rate limiter middleware.
 *
 * Covers:
 *  - createLimiter exposes a functional middleware.
 *  - createUserLimiter keys on the authenticated user id (not the IP) when
 *    req.user is present, so shared-NAT users aren't penalized together.
 *  - The unauthenticated fallback normalizes IPv6 via express-rate-limit's
 *    ipKeyGenerator (no ERR_ERL_KEY_GEN_IPV6 validation error at creation),
 *    producing a stable /56-subnet key rather than a raw address.
 */
const { createLimiter, createUserLimiter } = require('../../middleware/dynamicRateLimiter');

function passthrough() {
  let i = 0;
  const res = { headersSent: false, on: (event, fn) => res, setHeader: () => {}, end: () => {}, getHeader: () => undefined };
  return { res, next: (err) => { if (err) throw err; i += 1; }, done: () => i > 0 };
}

async function hit(limiter, req) {
  const res = { headersSent: false, on: () => res, setHeader: () => {}, end: () => {}, getHeader: () => undefined };
  await new Promise((resolve) => limiter({ method: 'POST', ip: req.ip, user: req.user }, res, () => resolve()));
}

describe('dynamicRateLimiter', () => {
  it('createLimiter returns a callable middleware without throwing', () => {
    const limiter = createLimiter({ name: 'generic', defaultMax: 10, defaultWindowMs: 60_000 });
    expect(typeof limiter).toBe('function');
    expect(typeof limiter.getKey).toBe('function');
    expect(typeof limiter.resetKey).toBe('function');
  });

  it('createUserLimiter creates without the IPv6 keyGenerator validation error', () => {
    // Regression: reading req.ip in a custom keyGenerator without ipKeyGenerator
    // makes express-rate-limit v8 log ERR_ERL_KEY_GEN_IPV6. Creation here should
    // be clean (no throw) since the fallback uses ipKeyGenerator.
    let limiter;
    expect(() => {
      limiter = createUserLimiter({ name: 'booking-create', defaultMax: 20, defaultWindowMs: 60_000 });
    }).not.toThrow();
    expect(typeof limiter).toBe('function');
  });

  it('keys authenticated requests on the user id, not the IP', async () => {
    const limiter = createUserLimiter({ name: 'booking-create', defaultMax: 20, defaultWindowMs: 60_000 });
    // First request from IP A.
    await hit(limiter, { user: { id: 'user-abc' }, ip: '203.0.113.7' });
    // Second request, different IP, same user.
    await hit(limiter, { user: { id: 'user-abc' }, ip: '198.51.100.9' });

    // Both should have incremented the SAME per-user key (count 2), and the
    // raw IPs must NOT be the bucket keys.
    expect((await limiter.getKey('user:user-abc')).totalHits).toBe(2);
    expect(await limiter.getKey('203.0.113.7')).toBeUndefined();
    expect(await limiter.getKey('198.51.100.9')).toBeUndefined();
    await limiter.resetKey('user:user-abc');
  });

  it('normalizes the unauthenticated IPv6 fallback into a /56 key', async () => {
    const limiter = createUserLimiter({ name: 'booking-create', defaultMax: 20, defaultWindowMs: 60_000 });
    await hit(limiter, { ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' });
    await hit(limiter, { ip: '2001:db8:85a3:00ff:ffff:ffff:ffff:ffff' }); // same /56 → same bucket

    // The key must be the /56 prefix produced by ipKeyGenerator (compressed),
    // so two addresses in the same subnet share a bucket instead of bypassing
    // the limit by rotating raw IPv6 addresses.
    const normalized = require('express-rate-limit').ipKeyGenerator('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    expect(normalized).toMatch(/^2001:db8:85a3::\/56$/);
    expect((await limiter.getKey(normalized)).totalHits).toBe(2);
    await limiter.resetKey(normalized);
  });

  it('falls back to anon when no user and no ip are present', async () => {
    const limiter = createUserLimiter({ name: 'booking-create', defaultMax: 20, defaultWindowMs: 60_000 });
    await hit(limiter, {});
    expect((await limiter.getKey('anon')).totalHits).toBe(1);
    await limiter.resetKey('anon');
  });
});

