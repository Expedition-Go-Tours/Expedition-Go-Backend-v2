/**
 * Regression cover for the raw-SQL fragment shim in `jest.setup.js`.
 *
 * Prisma lets production code assemble SQL at runtime and splice it into a
 * tagged template:
 *
 *     prisma.$queryRaw`SELECT ... WHERE 1 = 1 ${maybeFilter} ${maybeOrder}`
 *
 * Outside Jest the client splices the fragment in and binds its own values as
 * $1, $2, … . Under Jest it does not: the fragment object is serialised as a
 * *parameter* and Postgres rejects the statement (`42601 syntax error at or
 * near "$1"`, or `42804 argument of WHERE must be type boolean, not type
 * jsonb`). Reproducible with a two-line script against the same database, so
 * it is a harness quirk of the Jest + Prisma 5.20 pairing and never happens in
 * production.
 *
 * `jest.setup.js` rebuilds those tagged calls and hands them to
 * `$queryRawUnsafe`, which takes SQL text plus positional parameters — i.e.
 * exactly the query the client would have sent. This file pins that behaviour,
 * because the shim is the only reason `homepageRanking`,
 * `admin.getOverview`, `admin.getAiStatus` and every other SQL-building code
 * path can be exercised against a real database at all: without it they 500
 * under Jest and would have to be skipped or mocked, which is the failure mode
 * this suite exists to eliminate.
 *
 * Gated on TEST_DB_AVAILABLE like every other real-DB suite — a fragment is
 * only meaningful once Postgres is there to reject a mis-numbered placeholder.
 */
const prisma = require('../../src/core/services/prismaClient');
const { Prisma } = require('@prisma/client');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

describeDb('raw SQL fragments under Jest (jest.setup.js shim)', () => {
  jest.setTimeout(30000);

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('wraps the shared client instance, not just the prototype', () => {
    // `prismaClient.js` caches its client on `global` so every test file in a
    // worker shares one connection, and that instance can outlive the module
    // registry it was built in. A prototype-only patch would land on a
    // different copy of the class than the one under test.
    expect(prisma.$queryRaw.name).toBe('flattenedRawTag');
    expect(prisma.$executeRaw.name).toBe('flattenedRawTag');
  });

  it('still binds plain values', async () => {
    expect(await prisma.$queryRaw`SELECT ${1}::int AS x`).toEqual([{ x: 1 }]);
  });

  it('still binds a string parameter through a function', async () => {
    expect(await prisma.$queryRaw`SELECT LOWER(${'Accra'}) AS a`).toEqual([{ a: 'accra' }]);
  });

  it('splices a Prisma.sql fragment', async () => {
    const condition = Prisma.sql`true`;
    expect(await prisma.$queryRaw`SELECT 1 AS x WHERE ${condition}`).toEqual([{ x: 1 }]);
  });

  it('splices a Prisma.raw identifier without adding a parameter', async () => {
    const r = await prisma.$queryRaw`SELECT COUNT(*)::int AS c FROM ${Prisma.raw('"User"')}`;
    expect(r[0].c).toBeGreaterThanOrEqual(0);
  });

  it('splices Prisma.empty, which contributes nothing at all', async () => {
    expect(await prisma.$queryRaw`SELECT 1 AS x ${Prisma.empty}`).toEqual([{ x: 1 }]);
  });

  it('keeps numbering right when a fragment is optional', async () => {
    // The shape that `getLocationTourIds` and most filter builders use: the
    // fragment may or may not be present, and the parameters after it have to
    // move up or down accordingly.
    const city = 'accra';
    const withCity = city ? Prisma.sql`AND LOWER(${'Accra'}::text) = ${city}` : Prisma.empty;
    const withoutCity = Prisma.empty;

    expect(
      await prisma.$queryRaw`SELECT ${42}::int AS x WHERE true ${withCity}`,
    ).toEqual([{ x: 42 }]);
    expect(
      await prisma.$queryRaw`SELECT ${7}::int AS x WHERE true ${withoutCity}`,
    ).toEqual([{ x: 7 }]);
  });

  it('continues placeholder numbering through nested fragments', async () => {
    // A fragment spliced mid-query must pick up the outer query's next $n,
    // not restart at $1 and collide with what is already bound.
    const inner = Prisma.sql`CONCAT(${'a'}, ${'b'})`;
    const outer = Prisma.join([inner, Prisma.sql`'c'`], ' || ');
    expect(await prisma.$queryRaw`SELECT (${outer}) AS letters`).toEqual([{ letters: 'abc' }]);
  });

  it('splices Prisma.join with a separator', async () => {
    const sum = Prisma.join([Prisma.sql`${1}::int`, Prisma.sql`${2}::int`], ' + ');
    expect(await prisma.$queryRaw`SELECT (${sum}) AS n`).toEqual([{ n: 3 }]);
  });

  it('applies the same shim to $executeRaw', async () => {
    const condition = Prisma.sql`1 = 1`;
    const affected = await prisma.$executeRaw`SELECT COUNT(*) FROM "User" WHERE ${condition}`;
    expect(typeof affected).toBe('number');
  });

  it('leaves non-tagged calls alone', async () => {
    // `$queryRawUnsafe` is the escape hatch the shim itself uses, so it must
    // not be rewritten on the way through.
    expect(await prisma.$queryRawUnsafe('SELECT $1::int AS x', 5)).toEqual([{ x: 5 }]);
  });
});
