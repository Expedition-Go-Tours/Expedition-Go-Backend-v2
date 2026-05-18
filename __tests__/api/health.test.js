const request = require('supertest');
const app = require('../../app');

describe('GET /health', () => {
  it('returns 200 with status success', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'success',
      message: 'API is healthy',
    });
  });
});
