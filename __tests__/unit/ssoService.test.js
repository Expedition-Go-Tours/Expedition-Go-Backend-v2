process.env.JWT_SSO_SECRET = 'test-sso-secret';

jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findUnique: jest.fn() },
}));
jest.mock('../../src/core/services/redisClient', () => ({
  setnx: jest.fn(),
}));
jest.mock('../../src/core/services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../../src/core/services/refreshTokenHelper', () => ({
  storeRefreshToken: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const prisma = require('../../src/core/services/prismaClient');
const redis = require('../../src/core/services/redisClient');
const logger = require('../../src/core/services/logger');
const { storeRefreshToken } = require('../../src/core/services/refreshTokenHelper');
const { mintTicket, exchangeTicket } = require('../../src/core/services/ssoService');

const DEST = 'https://www.travioghana.com';
const OTHER_DEST = 'https://www.expeditiongotours.com';
const SECRET = 'test-sso-secret';

const ACTIVE_USER = {
  id: 'user-1',
  name: 'Ama',
  email: 'ama@example.com',
  photoURL: null,
  roles: ['customer'],
  passwordHash: 'hashed',
  active: true,
};

describe('ssoService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.setnx.mockResolvedValue(true);
    prisma.user.findUnique.mockResolvedValue(ACTIVE_USER);
    storeRefreshToken.mockResolvedValue(undefined);
  });

  describe('mintTicket', () => {
    it('issues a ticket bound to its destination and nothing more', () => {
      const { ticket, expiresIn } = mintTicket('user-1', DEST);

      expect(expiresIn).toBe(120);
      const claims = jwt.decode(ticket);
      expect(claims.userId).toBe('user-1');
      expect(claims.dest).toBe(DEST);
      expect(typeof claims.jti).toBe('string');
      // The ticket must carry no authority of its own — it is not a session.
      expect(claims.accessToken).toBeUndefined();
      expect(claims.refreshToken).toBeUndefined();
      expect(claims.iat).toBeDefined();
    });

    it('gives each mint a distinct jti, so two clicks cannot collide', () => {
      const a = jwt.decode(mintTicket('user-1', DEST).ticket);
      const b = jwt.decode(mintTicket('user-1', DEST).ticket);
      expect(a.jti).not.toBe(b.jti);
    });
  });

  describe('exchangeTicket', () => {
    it('returns a fresh token pair and registers the refresh token', async () => {
      const session = await exchangeTicket(mintTicket('user-1', DEST).ticket, DEST);

      expect(session.accessToken).toEqual(expect.any(String));
      expect(session.refreshToken).toEqual(expect.any(String));
      expect(session.user).toEqual({
        id: 'user-1',
        name: 'Ama',
        email: 'ama@example.com',
        photoURL: null,
        roles: ['customer'],
        hasPassword: true,
      });
      // The pair is minted here, not carried from the caller — a long-lived
      // refresh token never travels across the origin boundary.
      expect(storeRefreshToken).toHaveBeenCalledWith('user-1', session.refreshToken);
      expect(jwt.decode(session.accessToken).userId).toBe('user-1');
    });

    it('refuses a ticket minted for another site', async () => {
      const ticket = mintTicket('user-1', OTHER_DEST).ticket;

      await expect(exchangeTicket(ticket, DEST)).rejects.toThrow(
        'This sign-in link was issued for a different site',
      );
      expect(redis.setnx).not.toHaveBeenCalled();
      expect(storeRefreshToken).not.toHaveBeenCalled();
    });

    it('rejects a replayed ticket', async () => {
      const ticket = mintTicket('user-1', DEST).ticket;
      redis.setnx.mockResolvedValue(false);

      await expect(exchangeTicket(ticket, DEST)).rejects.toThrow('already been used');
      expect(storeRefreshToken).not.toHaveBeenCalled();
    });

    it('marks the jti used under a key that expires with the ticket', async () => {
      const ticket = mintTicket('user-1', DEST).ticket;
      const { jti } = jwt.decode(ticket);

      await exchangeTicket(ticket, DEST);

      expect(redis.setnx).toHaveBeenCalledTimes(1);
      const [key, ttl] = redis.setnx.mock.calls[0];
      expect(key).toBe(`sso:used:${jti}`);
      expect(ttl).toBe(120);
    });

    it('rejects a tampered signature', async () => {
      const ticket = `${mintTicket('user-1', DEST).ticket}x`;

      await expect(exchangeTicket(ticket, DEST)).rejects.toThrow('invalid or has expired');
      expect(redis.setnx).not.toHaveBeenCalled();
    });

    it('rejects an expired ticket without touching Redis', async () => {
      const expired = jwt.sign({ userId: 'user-1', jti: 'stale', dest: DEST }, SECRET, {
        expiresIn: '-5s',
      });

      await expect(exchangeTicket(expired, DEST)).rejects.toThrow('invalid or has expired');
      expect(redis.setnx).not.toHaveBeenCalled();
    });

    it('rejects a ticket with no jti even if the signature is good', async () => {
      const noJti = jwt.sign({ userId: 'user-1', dest: DEST }, SECRET, { expiresIn: 120 });

      await expect(exchangeTicket(noJti, DEST)).rejects.toThrow('invalid or has expired');
      expect(redis.setnx).not.toHaveBeenCalled();
    });

    it('fails closed on a deactivated account', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...ACTIVE_USER, active: false });

      await expect(exchangeTicket(mintTicket('user-1', DEST).ticket, DEST)).rejects.toThrow(
        'has been deactivated',
      );
      expect(storeRefreshToken).not.toHaveBeenCalled();
    });

    it('fails closed when the account no longer exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(exchangeTicket(mintTicket('user-1', DEST).ticket, DEST)).rejects.toThrow(
        'Account not found',
      );
      expect(storeRefreshToken).not.toHaveBeenCalled();
    });

    /**
     * Redis being unreachable returns null, not false. Failing closed there
     * would take the whole handoff down on a cache blip in exchange for
     * guarding a 120-second window, so we allow it and log loudly instead.
     */
    it('still exchanges when Redis is unavailable, but warns', async () => {
      redis.setnx.mockResolvedValue(null);

      const session = await exchangeTicket(mintTicket('user-1', DEST).ticket, DEST);

      expect(session.accessToken).toEqual(expect.any(String));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Redis unavailable'));
    });

    it('does not hand back the caller’s own tokens (it mints new ones)', async () => {
      const session = await exchangeTicket(mintTicket('user-1', DEST).ticket, DEST);
      const claims = jwt.decode(session.refreshToken);

      expect(claims.jti).toBeUndefined();
      expect(claims.dest).toBeUndefined();
      expect(claims.userId).toBe('user-1');
    });
  });
});
