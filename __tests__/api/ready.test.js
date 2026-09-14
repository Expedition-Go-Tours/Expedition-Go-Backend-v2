const request = require('supertest');
const app = require('../../app');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

describeDb('GET /ready', () => {
  it('returns 200 only when Postgres and Redis are both healthy', async () => {
    const res = await request(app).get('/ready');

    // Readiness is a plain status-code contract for external monitors.
    expect([200, 503]).toContain(res.status);
    expect(res.body.checks).toBeDefined();

    // This suite is gated on a reachable test database.
    expect(res.body.checks.database).toBe('healthy');

    // The status code and body must agree, and must track Redis health:
    // ready (200) iff Redis is healthy, otherwise not_ready (503).
    const redisHealthy = res.body.checks.redis === 'healthy';
    expect(res.body.status).toBe(redisHealthy ? 'ready' : 'not_ready');
    expect(res.status).toBe(redisHealthy ? 200 : 503);
  });
});
