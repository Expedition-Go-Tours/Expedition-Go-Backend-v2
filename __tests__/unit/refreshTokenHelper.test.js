jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn(), update: jest.fn() },
}));

const prisma = require('../../utils/prismaClient');
const crypto = require('crypto');
const {
  storeRefreshToken,
  validateRefreshToken,
  rotateRefreshToken,
  clearRefreshToken,
} = require('../../utils/refreshTokenHelper');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

describe('refreshTokenHelper', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('storeRefreshToken', () => {
    it('hashes and stores the refresh token', async () => {
      prisma.user.update.mockResolvedValue();
      await storeRefreshToken('user-1', 'my-refresh-token');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { refreshToken: hashToken('my-refresh-token') },
      });
    });
  });

  describe('validateRefreshToken', () => {
    it('returns true when token matches', async () => {
      const token = 'valid-token';
      prisma.user.findUnique.mockResolvedValue({ refreshToken: hashToken(token) });
      expect(await validateRefreshToken('user-1', token)).toBe(true);
    });

    it('returns false when user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      expect(await validateRefreshToken('user-1', 'any')).toBe(false);
    });

    it('returns false when user has no stored token', async () => {
      prisma.user.findUnique.mockResolvedValue({ refreshToken: null });
      expect(await validateRefreshToken('user-1', 'any')).toBe(false);
    });

    it('returns false when token does not match', async () => {
      prisma.user.findUnique.mockResolvedValue({ refreshToken: hashToken('correct') });
      expect(await validateRefreshToken('user-1', 'wrong')).toBe(false);
    });
  });

  describe('rotateRefreshToken', () => {
    it('rotates when old token is valid', async () => {
      const oldToken = 'old-token';
      prisma.user.findUnique.mockResolvedValue({ refreshToken: hashToken(oldToken) });
      prisma.user.update.mockResolvedValue();

      const result = await rotateRefreshToken('user-1', oldToken, 'new-token');
      expect(result).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { refreshToken: hashToken('new-token') },
      });
    });

    it('returns false when old token is invalid', async () => {
      prisma.user.findUnique.mockResolvedValue({ refreshToken: hashToken('correct') });
      const result = await rotateRefreshToken('user-1', 'wrong', 'new-token');
      expect(result).toBe(false);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('clearRefreshToken', () => {
    it('sets refreshToken to null', async () => {
      prisma.user.update.mockResolvedValue();
      await clearRefreshToken('user-1');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { refreshToken: null },
      });
    });
  });
});
