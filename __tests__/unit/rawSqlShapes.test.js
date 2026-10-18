/**
 * Validates the raw SQL in `src/` against the real schema. See
 * __tests__/helpers/rawSqlGuard.js for how and why.
 *
 * The short version: staticQuerySweep.js checks every `prisma.<model>.<method>(…)`
 * call, but raw SQL takes a *string*, not an args object, so the DMMF validator
 * has nothing to walk. A typo'd column there is the same bug class as
 * `imageCover` — Postgres 500s instead of Prisma — and 94 raw statements had
 * no coverage at all.
 *
 * The subtlety that makes it worth its own helper: raw SQL names *database
 * columns*, Prisma names *fields*, and `@map` splits the two. `Booking.grossAmount`
 * is `total` in Postgres and `platformCommission` is `commissionAmount`, so
 * validating against Prisma field names would false-positive on all 7 mapped
 * columns while missing real ones. This checks `dbName`.
 *
 * Runs in the hermetic `unit-tests` job — no database, no application code.
 */
const path = require('path');
const {
  checkSql,
  checkSqlPerTable,
  extractRawSql,
  sweepRawSql,
  MODEL_COLUMNS,
} = require('../helpers/rawSqlGuard');

const SRC = path.join(__dirname, '..', '..', 'src');

describe('raw SQL identifiers (whole src/ tree)', () => {
  let statements;
  let parseErrors;

  beforeAll(() => {
    ({ statements, parseErrors } = sweepRawSql(SRC));
  });

  test('every file containing raw SQL parses', () => {
    expect(parseErrors).toEqual([]);
  });

  test('the sweep found the raw SQL surface', () => {
    // A pattern change (`queryRaw` → a wrapper helper) would drop this to zero
    // and every assertion below would pass vacuously.
    expect(statements.length).toBeGreaterThan(50);
  });

  test('every quoted identifier exists somewhere in the schema', () => {
    const failures = [];
    for (const { sql, label } of statements) {
      const { unknown } = checkSql(sql);
      if (unknown.length) failures.push(`${label}: ${unknown.join(', ')}`);
    }
    expect(failures).toEqual([]);
  });

  test('every resolvable qualified reference matches its own table', () => {
    const failures = [];
    for (const { sql, label } of statements) {
      const { unknown } = checkSqlPerTable(sql);
      if (unknown.length) failures.push(`${label}: ${unknown.join(', ')}`);
    }
    expect(failures).toEqual([]);
  });

  test('the per-table check actually validates a meaningful share', () => {
    // It skips aliases it cannot resolve (subquery scopes). Left unchecked that
    // skip could grow until the check validates nothing while still passing.
    const totals = statements.reduce((acc, { sql }) => {
      const { validated, skipped } = checkSqlPerTable(sql);
      acc.validated += validated;
      acc.skipped += skipped;
      return acc;
    }, { validated: 0, skipped: 0 });

    expect(totals.validated).toBeGreaterThan(100);
    expect(totals.validated).toBeGreaterThan(totals.skipped);
  });
});

describe('the @map split raw SQL and Prisma disagree on', () => {
  // The reason this guard checks `dbName` rather than Prisma field names.
  test('Booking maps grossAmount -> total and platformCommission -> commissionAmount', () => {
    expect(MODEL_COLUMNS.get('Booking')).toContain('total');
    expect(MODEL_COLUMNS.get('Booking')).toContain('commissionAmount');
  });

  test('a query using the DB column passes', () => {
    expect(checkSql('SELECT "total", "commissionAmount" FROM "Booking"').unknown).toEqual([]);
  });

  test('the same query using Prisma field names would be wrong in SQL', () => {
    // `grossAmount` is not a column Postgres knows — this is what the guard
    // exists to catch, and why field names are deliberately *also* accepted
    // only where they coincide with a real column elsewhere.
    expect(MODEL_COLUMNS.get('Booking')).not.toContain('grossAmount');
  });
});

describe('the guard catches what it claims to', () => {
  const bad = (sql) => checkSql(sql).unknown;

  test('rejects a column that exists nowhere', () => {
    expect(bad('SELECT "imageCover" FROM "Tour"')).toEqual(['imageCover']);
  });

  test('rejects the other bug this class produced', () => {
    expect(bad('SELECT "timeZone" FROM "Tour"')).toEqual(['timeZone']);
  });

  test('rejects a wrong-case column', () => {
    // Postgres folds unquoted identifiers to lowercase, so `"coverphoto"` is
    // not `coverPhoto`. A case error is as fatal as a typo.
    expect(bad('SELECT "CoverPhoto" FROM "Tour"')).toEqual(['CoverPhoto']);
  });

  test('accepts a real column', () => {
    expect(bad('SELECT "coverPhoto" FROM "Tour"')).toEqual([]);
  });

  test('accepts output aliases, which are not schema identifiers', () => {
    expect(bad('SELECT COUNT(*)::int AS "totalSearches" FROM "Event"')).toEqual([]);
    expect(bad('SELECT COUNT(*)::int AS "signupsToday" FROM "User"')).toEqual([]);
  });

  test('accepts cast targets', () => {
    expect(bad(`SELECT e."name"::"OverrideStatus" FROM "Event" e`)).toEqual([]);
  });

  test('accepts CTE names', () => {
    expect(bad('WITH recent AS (SELECT 1) SELECT * FROM recent')).toEqual([]);
  });

  test('per-table check flags a real column used against the wrong table', () => {
    // The stronger question `checkSql` cannot answer: `bookingNumber` exists,
    // just not on Tour.
    expect(MODEL_COLUMNS.get('Booking')).toContain('bookingNumber');
    const { unknown } = checkSqlPerTable('SELECT b."bookingNumber" FROM "Tour" b');
    expect(unknown).toEqual(['b."bookingNumber" (not a column of Tour)']);
  });

  test('per-table check accepts the same column against its own table', () => {
    const { unknown } = checkSqlPerTable('SELECT b."bookingNumber" FROM "Booking" b');
    expect(unknown).toEqual([]);
  });

  test('per-table check skips an alias it cannot resolve rather than guessing', () => {
    const { unknown, skipped } = checkSqlPerTable('SELECT s."whatever" FROM (SELECT 1) s');
    expect(unknown).toEqual([]);
    expect(skipped).toBe(1);
  });
});

describe('extractRawSql', () => {
  test('reads both tagged-template and call forms', () => {
    const src = [
      'prisma.$queryRaw`SELECT "id" FROM "Tour"`;',
      'prisma.$queryRawUnsafe(`SELECT "id" FROM "Tour"`, 1);',
      "prisma.$executeRaw`UPDATE \"Tour\" SET \"viewCount\" = 1`;",
    ].join('\n');
    const found = extractRawSql(src, 'synthetic.js');
    expect(found).toHaveLength(3);
    expect(found.every((s) => checkSql(s.sql).unknown.length === 0)).toBe(true);
  });

  test('a typo in either form is caught', () => {
    const src = [
      'prisma.$queryRaw`SELECT "imageCover" FROM "Tour"`;',
      'prisma.$queryRawUnsafe(`SELECT "nope" FROM "Tour"`);',
    ].join('\n');
    for (const s of extractRawSql(src, 'synthetic.js')) {
      expect(checkSql(s.sql).unknown.length).toBe(1);
    }
  });

  test('substitutions keep the statement shape checkable', () => {
    const [s] = extractRawSql('prisma.$queryRawUnsafe(`SELECT "id" FROM "Tour" WHERE "city" = ${city}`, city);', 'synthetic.js');
    expect(s.sql).toContain('"city"');
    expect(checkSql(s.sql).unknown).toEqual([]);
  });
});
