const crypto = require('crypto');
const prisma = require('./prismaClient');
const jwt = require('../config/jwt');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function storeRefreshToken(userId, refreshToken) {
  const hashed = hashToken(refreshToken);
  await prisma.user.update({
    where: { id: userId },
    data: { refreshToken: hashed },
  });
}

async function validateRefreshToken(userId, refreshToken) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { refreshToken: true },
  });
  if (!user || !user.refreshToken) return false;
  return user.refreshToken === hashToken(refreshToken);
}

async function rotateRefreshToken(userId, oldRefreshToken, newRefreshToken) {
  const valid = await validateRefreshToken(userId, oldRefreshToken);
  if (!valid) return false;
  await storeRefreshToken(userId, newRefreshToken);
  return true;
}

async function clearRefreshToken(userId) {
  await prisma.user.update({
    where: { id: userId },
    data: { refreshToken: null },
  });
}

module.exports = {
  storeRefreshToken,
  validateRefreshToken,
  rotateRefreshToken,
  clearRefreshToken,
};
