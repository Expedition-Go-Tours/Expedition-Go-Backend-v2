module.exports = async () => {
  // Hermetic runs (unit / e2e) never touch a real database and set
  // TEST_DB_GATED=0 — skip the probe entirely so they don't load the Prisma
  // client or attempt a connection. Local runs and DB-gated jobs (api /
  // integration / coverage) probe below.
  if (process.env.TEST_DB_GATED === '0') {
    process.env.TEST_DB_AVAILABLE = 'false';
    return;
  }

  // Same override as jest.setup.js, applied here too so the probe itself tests
  // the database the workers will actually use. `.env` points at the dev `travio`
  // database; TEST_DATABASE_URL points at an isolated one.
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }
  if (process.env.TEST_DIRECT_URL) {
    process.env.DIRECT_URL = process.env.TEST_DIRECT_URL;
  }

  let available = false;
  let reason = null;
  let prisma = null;
  try {
    // Lazy require inside the probe: if the generated client or DB is ever
    // unavailable, degrade to "no DB" instead of crashing the bootstrap.
    prisma = require('./src/core/services/prismaClient');
    await prisma.$connect();
    available = true;
  } catch (err) {
    reason = (err && err.message) ? err.message : String(err);
    available = false;
  } finally {
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
  }

  // Refuse to run the DB-gated suites against the development database.
  //
  // Those tests write: `user.integration` creates users (and leaves its
  // `dup-*@test.com` rows behind) and `regionFallback` deletes attractions.
  // Against dev that is silent data mutation, so a probe that reaches `travio`
  // is reported as "no DB" and the suites skip instead of touching it. Use
  // scripts/test-db-up.sh to provision `travio_test` and set TEST_DATABASE_URL.
  if (available && !process.env.TEST_DATABASE_URL && databaseIsDev(process.env.DATABASE_URL)) {
    available = false;
    reason = 'resolved to the dev `travio` database; set TEST_DATABASE_URL to an isolated DB';
  }

  if (!available && process.stderr && reason) {
    process.stderr.write(`[jest.globalSetup] DB probe skipped (${reason}); TEST_DB_AVAILABLE=false\n`);
  }

  // TEST_DB_EXPECTED=1 turns a silent skip into a failure.
  //
  // CI's integration and coverage jobs stand up PostGIS and run migrate+seed,
  // so if the probe comes back empty there the DB-gated tests simply did not
  // run — the job would go green having verified nothing. That is exactly the
  // vacuous pass this whole effort exists to prevent, so when a run *knows* it
  // has a database, a failed probe must fail the run.
  if (!available && process.env.TEST_DB_EXPECTED === '1') {
    throw new Error(
      `[jest.globalSetup] TEST_DB_EXPECTED=1 but no usable test database was found`
      + `${reason ? `: ${reason}` : ''}. Refusing to let the DB-gated suites skip silently.`,
    );
  }

  process.env.TEST_DB_AVAILABLE = available ? 'true' : 'false';
};

/** True when a DATABASE_URL names the local development `travio` database. */
function databaseIsDev(url) {
  if (!url) return false;
  try {
    const pathname = new URL(url).pathname.replace(/^\//, '');
    return pathname === 'travio';
  } catch {
    // Unparseable URL — leave it to Prisma, which reports a clearer error.
    return false;
  }
}
