const request = require('supertest');
const app = require('../../app');
const prisma = require('../../utils/prismaClient');

describe('GET /api/tours', () => {
  jest.setTimeout(30000);

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns 200 with paginated tours', async () => {
    const res = await request(app).get('/api/tours');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data.tours)).toBe(true);
    expect(res.body.data.pagination).toBeDefined();
    expect(res.body.data.pagination.currentPage).toBe(1);
  });

  it('respects limit query parameter', async () => {
    const res = await request(app).get('/api/tours?limit=5');

    expect(res.status).toBe(200);
    expect(res.body.data.tours.length).toBeLessThanOrEqual(5);
  });

  it('returns 400 for invalid filter params', async () => {
    const res = await request(app).get('/api/tours?page=-1');

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('fail');
  });
});
