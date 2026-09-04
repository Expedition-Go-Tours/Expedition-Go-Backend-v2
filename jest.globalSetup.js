module.exports = async () => {
  let available = false;
  let prisma = null;
  try {
    // Lazy require inside the probe so a Jest run never hard-aborts at
    // bootstrap when the generated Prisma client is unavailable (CI installs
    // with --ignore-scripts and regenerates the client explicitly per job).
    // Unit suites mock the client; DB-gated suites read TEST_DB_AVAILABLE and
    // only run in jobs that generate the client and provision a database.
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
