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
    it('hashes and stores the refresh token in a family array', async () => {
      prisma.user.update.mockResolvedValue();
      await storeRefreshToken('user-1', 'my-refresh-token');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { refreshToken: JSON.stringify([hashToken('my-refresh-token')]) },
      });
    });

    it('keeps the most recent 5 tokens (capped family)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        refreshToken: JSON.stringify(['a', 'b', 'c', 'd', 'e']),
      });
      prisma.user.update.mockResolvedValue();
      await storeRefreshToken('user-1', 'f');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { refreshToken: JSON.stringify([hashToken('f'), 'a', 'b', 'c', 'd']) },
      });
    });

    it('dedupes a token already present in the family', async () => {
      const hashedX = hashToken('x');
      prisma.user.findUnique.mockResolvedValue({
        refreshToken: JSON.stringify([hashedX, 'y']),
      });
      prisma.user.update.mockResolvedValue();
      await storeRefreshToken('user-1', 'x');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { refreshToken: JSON.stringify([hashedX, 'y']) },
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
    it('rotates when old token is valid, keeping the old token in the family', async () => {
      const oldToken = 'old-token';
      prisma.user.findUnique.mockResolvedValue({ refreshToken: hashToken(oldToken) });
      prisma.user.update.mockResolvedValue();

      const result = await rotateRefreshToken('user-1', oldToken, 'new-token');
      expect(result).toBe(true);
      // The used token stays valid so an overlapping concurrent refresh in
      // another tab/device still validates.
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { refreshToken: JSON.stringify([hashToken('new-token'), hashToken(oldToken)]) },
      });
    });

    it('rotates within an existing family', async () => {
      const oldToken = 'old-token';
      prisma.user.findUnique.mockResolvedValue({
        refreshToken: JSON.stringify([hashToken(oldToken), 'other']),
      });
      prisma.user.update.mockResolvedValue();

      const result = await rotateRefreshToken('user-1', oldToken, 'new-token');
      expect(result).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { refreshToken: JSON.stringify([hashToken('new-token'), hashToken(oldToken), 'other']) },
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
