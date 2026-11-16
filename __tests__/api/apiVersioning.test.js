/**
 * API version contract tests.
 *
 * The canonical prefix is `/api/v1`; `/api` stays as a compatibility alias for
 * every existing storefront and supplier integration. These tests exist because
 * a second prefix is only safe if it cannot behave differently from the first.
 *
 * What is asserted:
 *   - both prefixes reach the same routers and the same guards
 *   - a canonical request is not charged twice to the global rate limiter
 *   - an upload guard covers both spellings of the URL
 *   - maintenance mode blocks both prefixes and exempts admin/webhooks on both
 *   - webhook raw-body parsing is registered for both prefixes
 *   - the response tells the caller which contract answered
 *
 * No database is required: every request below is either rejected before a
 * query (no token) or answered by middleware.
 */
const request = require('supertest');

const baseApp = require('../../apps/platform-api/app');
const { buildPlatformApp } = require('../../apps/platform-api/app');
const maintenanceMode = require('../../middleware/maintenanceMode');
const prisma = require('../../src/core/services/prismaClient');
const {
  normalizeWithinApi,
  isVersionedPath,
} = require('../../middleware/apiVersion');

describe('apiVersion helpers', () => {
  it('normalises only the known major version', () => {
    expect(normalizeWithinApi('/v1/tours')).toBe('/tours');
    expect(normalizeWithinApi('/v1')).toBe('/');
    expect(normalizeWithinApi('/tours')).toBe('/tours');
    expect(normalizeWithinApi('/v10/tours')).toBe('/v10/tours');
    expect(normalizeWithinApi('/v1foo')).toBe('/v1foo');
  });

  it('recognises absolute canonical paths', () => {
    expect(isVersionedPath('/api/v1/tours')).toBe(true);
    expect(isVersionedPath('/api/v1')).toBe(true);
    expect(isVersionedPath('/api/tours')).toBe(false);
    expect(isVersionedPath('/apiv1/tours')).toBe(false);
  });
});

describe('legacy and canonical parity', () => {
  it('guards the same protected route on both prefixes', async () => {
    const legacy = await request(baseApp).get('/api/bookings/mine');
    const canonical = await request(baseApp).get('/api/v1/bookings/mine');

    expect(legacy.status).toBe(401);
    expect(canonical.status).toBe(401);
    expect(canonical.body).toEqual(legacy.body);
  });

  it('stamps responses with the contract that served them', async () => {
    const legacy = await request(baseApp).get('/api/bookings/mine');
    const canonical = await request(baseApp).get('/api/v1/bookings/mine');

    expect(legacy.headers['x-api-version']).toBe('legacy');
    expect(canonical.headers['x-api-version']).toBe('v1');
    expect(legacy.headers['x-served-by']).toBe('platform-api');
    expect(canonical.headers['x-served-by']).toBe('platform-api');
  });

  it('reports unknown routes identically', async () => {
    const legacy = await request(baseApp).get('/api/definitely-not-a-route');
    const canonical = await request(baseApp).get('/api/v1/definitely-not-a-route');

    expect(legacy.status).toBe(404);
    expect(canonical.status).toBe(404);
  });

  it('parses raw webhook bodies on both prefixes', async () => {
    const payload = { id: 'evt_version_test', type: 'payment_intent.succeeded' };
    const legacy = await request(baseApp)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload);
    const canonical = await request(baseApp)
      .post('/api/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload);

    // No Stripe signature: both must fail verification the same way. A 404
    // would mean the route is only mounted on one prefix; a 500 with
    // "Cannot read property of undefined" would mean the raw parser is missing.
    expect(canonical.status).toBe(legacy.status);
    expect(canonical.body).toEqual(legacy.body);
  });
});

describe('maintenance mode cannot be bypassed with /v1', () => {
  let spy;

  beforeEach(() => {
    spy = jest.spyOn(prisma.systemConfig, 'findUnique').mockResolvedValue({ value: true });
    maintenanceMode.clearCache();
  });

  afterEach(() => {
    spy.mockRestore();
    maintenanceMode.clearCache();
  });

  it('blocks the same protected route on both prefixes', async () => {
    const legacy = await request(baseApp).get('/api/bookings/mine');
    const canonical = await request(baseApp).get('/api/v1/bookings/mine');

    expect(legacy.status).toBe(503);
    expect(canonical.status).toBe(503);
  });

  it('keeps admin reachable on both prefixes', async () => {
    const legacy = await request(baseApp).get('/api/admin/stats');
    const canonical = await request(baseApp).get('/api/v1/admin/stats');

    expect(legacy.status).not.toBe(503);
    expect(canonical.status).not.toBe(503);
  });

  it('keeps webhooks reachable on both prefixes', async () => {
    const legacy = await request(baseApp)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send({ id: 'evt_maintenance' });
    const canonical = await request(baseApp)
      .post('/api/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send({ id: 'evt_maintenance' });

    expect(legacy.status).not.toBe(503);
    expect(canonical.status).not.toBe(503);
  });
});

describe('rate limits are shared, not doubled', () => {
  const saved = {};

  function setEnv(key, value) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
  });

  it('charges one global budget across both prefixes', async () => {
    setEnv('RATELIMIT_GLOBAL_MAX', '2');
    setEnv('RATELIMIT_GLOBAL_WINDOW_MS', '60000');
    const app = buildPlatformApp();

    const first = await request(app).get('/api/bookings/mine');
    const second = await request(app).get('/api/v1/bookings/mine');
    const third = await request(app).get('/api/bookings/mine');

    expect(first.status).toBe(401);
    // If `/api/v1` had its own limiter instance, or were charged twice, this
    // would already be 429.
    expect(second.status).toBe(401);
    expect(third.status).toBe(429);
  });

  it('applies the upload guard to both prefixes from one instance', async () => {
    setEnv('RATELIMIT_UPLOAD_MAX', '1');
    setEnv('RATELIMIT_UPLOAD_WINDOW_MS', '60000');
    const app = buildPlatformApp();

    const first = await request(app).post('/api/users/updateMe').send({});
    const second = await request(app).post('/api/v1/users/updateMe').send({});

    expect(first.status).not.toBe(429);
    // One upload request through the legacy prefix used the shared budget.
    expect(second.status).toBe(429);
  });
});
