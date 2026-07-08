const request = require('supertest');
const app = require('../../app');

describe('GET /health', () => {
  it('returns 200 with service check results', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.checks).toBeDefined();
    expect(res.body.checks.database).toBe('healthy');
    expect(['healthy', 'unhealthy', 'down']).toContain(res.body.checks.redis);
  });
});
