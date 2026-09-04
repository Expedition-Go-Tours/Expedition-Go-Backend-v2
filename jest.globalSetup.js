module.exports = async () => {
  // Hermetic runs (unit / e2e) never touch a real database and set
  // TEST_DB_GATED=0 — skip the probe entirely so they don't load the Prisma
  // client or attempt a connection. Local runs and DB-gated jobs (api /
  // integration / coverage) probe below.
  if (process.env.TEST_DB_GATED === '0') {
    process.env.TEST_DB_AVAILABLE = 'false';
    return;
  }

  let available = false;
  let prisma = null;
  try {
    // Lazy require inside the probe: if the generated client or DB is ever
    // unavailable, degrade to "no DB" instead of crashing the bootstrap.
    prisma = require('./utils/prismaClient');
    await prisma.$connect();
    available = true;
  } catch (err) {
    const reason = (err && err.message) ? err.message : String(err);
    process.stderr.write(`[jest.globalSetup] DB probe skipped (${reason}); TEST_DB_AVAILABLE=false\n`);
    available = false;
  } finally {
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
  }
  process.env.TEST_DB_AVAILABLE = available ? 'true' : 'false';
};
