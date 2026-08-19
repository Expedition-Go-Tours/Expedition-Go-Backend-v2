const crypto = require('crypto');
const prisma = require('./prismaClient');

// Cap the number of concurrently-valid refresh tokens per user. Kept small so
// an old leaked token expires quickly (the JWT itself is valid 7d and the list
// is trimmed by the cap).
const MAX_REFRESH_TOKENS = 5;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Legacy rows hold a single raw hash. Newer storage keeps a JSON array of the
// most recent hashes (a "family") so concurrent refreshes across tabs and
// devices don't revoke each other.
async function getStoredTokens(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { refreshToken: true },
  });
  const raw = user?.refreshToken;
  if (!raw) return [];
  if (!raw.startsWith('[')) return [raw];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [raw];
  } catch {
    return [raw];
  }
}

async function setStoredTokens(userId, tokens) {
  const next = [...new Set(tokens.filter(Boolean))].slice(0, MAX_REFRESH_TOKENS);
  await prisma.user.update({
    where: { id: userId },
    data: { refreshToken: next.length ? JSON.stringify(next) : null },
  });
}

async function storeRefreshToken(userId, refreshToken) {
  const hashed = hashToken(refreshToken);
  const current = await getStoredTokens(userId);
  await setStoredTokens(userId, [hashed, ...current.filter((t) => t !== hashed)]);
}

async function validateRefreshToken(userId, refreshToken) {
  const tokens = await getStoredTokens(userId);
  if (!tokens.length) return false;
  return tokens.includes(hashToken(refreshToken));
}

async function rotateRefreshToken(userId, oldRefreshToken, newRefreshToken) {
  const tokens = await getStoredTokens(userId);
  const hashedOld = hashToken(oldRefreshToken);
  if (!tokens.includes(hashedOld)) return false;

  const hashedNew = hashToken(newRefreshToken);
  // Keep the used token in the family so an overlapping refresh (another tab
  // or device issuing the same token concurrently) still validates. The list
  // is capped and the JWT itself expires after 7 days.
  await setStoredTokens(userId, [hashedNew, ...tokens.filter((t) => t !== hashedNew)]);
  return true;
}

async function clearRefreshToken(userId) {
  await setStoredTokens(userId, []);
}

module.exports = {
  storeRefreshToken,
  validateRefreshToken,
  rotateRefreshToken,
  clearRefreshToken,
};