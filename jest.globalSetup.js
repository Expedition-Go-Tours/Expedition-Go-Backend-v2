const prisma = require('./utils/prismaClient');

module.exports = async () => {
  let available = false;
  try {
    await prisma.$connect();
    available = true;
  } catch {
    available = false;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
  process.env.TEST_DB_AVAILABLE = available ? 'true' : 'false';
};