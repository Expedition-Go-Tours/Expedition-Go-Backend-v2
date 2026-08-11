
const { PrismaClient } = require('@prisma/client');

const globalForPrisma = global;

const poolUrl = (() => {
  const raw = process.env.DATABASE_URL;
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    // Neon: disable Prisma's prepared-statement cache (incompatible with
    // PgBouncer transaction mode) and cap the pool to a sane default.
    u.searchParams.set('connection_limit', '10');
    u.searchParams.set('pool_timeout', '15');
    u.searchParams.set('statement_cache_size', '0');
    return u.toString();
  } catch {
    // If the URL is malformed, fall through and let Prisma handle it
    return raw;
  }
})();

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasources: poolUrl ? { db: { url: poolUrl } } : undefined,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

module.exports = prisma;
