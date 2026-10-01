/**
 * `/api/sso` — the cross-storefront handoff that logs a user into
 * travioghana.com as they arrive from a tour click on expeditiongotours.com.
 *
 * Exercised on a minimal app rather than the full one so the assertions stay
 * about this route: the mount in app.js is verified at runtime after deploy,
 * and dragging the whole Express graph in would mean mocking forty models to
 * test three HTTP behaviours.
 *
 * What matters here is that the *public* endpoint is genuinely public (the
 * caller has no session yet) while still being unable to mint a session for
 * anyone but the ticket's owner, for a site the ticket was not issued for.
 */
const express = require('express');
const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

// Which sites we own is configuration, and clientOrigin reads it at call time.
// Without this the allow-list is empty and every destination is refused —
// which is exactly the behaviour a production typo would produce.
process.env.ALLOWED_ORIGINS = 'https://www.travioghana.com,https://www.expeditiongotours.com';

jest.mock('../../src/core/services/prismaClient', () => ({
  user: {
    findUnique: jest.fn(),
    // storeRefreshToken writes the refresh-token family onto the user row.
    update: jest.fn(),
  },
}));
jest.mock('../../src/core/services/redisClient', () => ({
  setnx: jest.fn(),
}));
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const redis = require('../../src/core/services/redisClient');
const ssoRoutes = require('../../routes/ssoRoutes');
const errorMiddleware = require('../../middleware/errorMiddleware');

const DEST = 'https://www.travioghana.com';
const ALLOWED = 'https://www.expeditiongotours.com';

const ACTIVE_USER = {
  id: 'user-1',
  name: 'Ama',
  email: 'ama@example.com',
  photoURL: null,
  roles: ['customer'],
  passwordHash: 'hashed',
  active: true,
};

const app = express();
app.use(express.json());
app.use('/api/sso', ssoRoutes);
app.use(errorMiddleware);

const auth = () => ({ Authorization: `Bearer ${signAccessToken({ userId: 'user-1' })}` });

async function mint(destination = DEST) {
  const res = await request(app).post('/api/sso/mint').set(auth()).send({ destination });
  return res;
}

describe('/api/sso', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.setnx.mockResolvedValue(true);
    prisma.user.findUnique.mockResolvedValue(ACTIVE_USER);
  });

  describe('POST /mint', () => {
    it('requires a session — an anonymous visitor cannot mint a ticket', async () => {
      const res = await request(app).post('/api/sso/mint').send({ destination: DEST });

      expect(res.status).toBe(401);
      expect(res.body.data?.ticket).toBeUndefined();
    });

    it('issues a ticket for an allow-listed site', async () => {
      const res = await mint();

      expect(res.status).toBe(200);
      expect(res.body.data.destination).toBe(DEST);
      expect(res.body.data.expiresIn).toBe(120);
      expect(typeof res.body.data.ticket).toBe('string');
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it('refuses to mint for a site we do not own', async () => {
      const res = await mint('https://attacker.example');

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not an allowed site/);
    });

    it('rejects a missing destination', async () => {
      const res = await request(app).post('/api/sso/mint').set(auth()).send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/destination/);
    });
  });

  describe('POST /exchange', () => {
    it('has no auth requirement — the caller arrives without a session', async () => {
      const { body } = await mint();
      const res = await request(app)
        .post('/api/sso/exchange')
        .send({ ticket: body.data.ticket, destination: DEST });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
      expect(res.body.data.user.id).toBe('user-1');
    });

    it('refuses a ticket minted for another site', async () => {
      const res = await request(app)
        .post('/api/sso/exchange')
        .send({ ticket: 'irrelevant', destination: 'https://attacker.example' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not an allowed site/);
    });

    it('rejects a replayed ticket', async () => {
      const { body } = await mint();
      redis.setnx.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/sso/exchange')
        .send({ ticket: body.data.ticket, destination: DEST });

      expect(res.status).toBe(410);
      expect(res.body.message).toMatch(/already been used/);
    });

    it('rejects a ticket whose destination does not match the request', async () => {
      const { body } = await request(app).post('/api/sso/mint').set(auth()).send({ destination: ALLOWED });

      const res = await request(app)
        .post('/api/sso/exchange')
        .send({ ticket: body.data.ticket, destination: DEST });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/different site/);
    });

    it('rejects a malformed ticket', async () => {
      const res = await request(app)
        .post('/api/sso/exchange')
        .send({ ticket: 'not-a-jwt', destination: DEST });

      expect(res.status).toBe(401);
    });
  });
});
