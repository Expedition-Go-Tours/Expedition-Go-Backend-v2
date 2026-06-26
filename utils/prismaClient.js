

const { PrismaClient } = require('@prisma/client');

const globalForPrisma = global;

const poolUrl = (() => {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('connection_limit=')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}connection_limit=25`;
})();

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasources: poolUrl ? { db: { url: poolUrl } } : undefined,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

module.exports = prisma;
