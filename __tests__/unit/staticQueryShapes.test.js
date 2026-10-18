/**
 * Validates every statically-analyzable Prisma query in `src/` against the real
 * schema. See __tests__/helpers/staticQuerySweep.js for how it works and
 * __tests__/helpers/prismaQueryGuard.js for why it exists.
 *
 * The short version: the rest of this suite mocks Prisma, so it can prove what
 * a controller *does* with rows but never that the query it wrote is one Prisma
 * accepts. That is how `imageCover` — a field that has never existed on `Tour`
 * (it is `coverPhoto`) — shipped on the invoice detail and PDF endpoints and
 * 500'd every supplier who opened an invoice in production. This sweep checks
 * the whole source tree in one pass instead of the two controllers the runtime
 * guard happens to drive.
 *
 * It found the same class again, immediately: `prisma.trackedClick` — a model
 * that has never existed — behind two routed Expedition admin analytics
 * endpoints, plus two more in unrouted handlers.
 *
 * These tests do not run any application code and need no database, so they
 * execute in the hermetic `unit-tests` job alongside the mocks.
 */
const path = require('path');
const { sweepSourceTree, UNRESOLVED } = require('../helpers/staticQuerySweep');
const {
  assertQueryShape,
  PrismaQueryShapeError,
} = require('../helpers/prismaQueryGuard');

const SRC = path.join(__dirname, '..', '..', 'src');

/**
 * Queries whose keys are not statically known, e.g.
 * `prisma[BRAND.listingModel].findMany(...)`. Each is a real gap in this
 * sweep's reach, so the count is ratcheted rather than free: coverage may
 * grow, but it can never quietly shrink. Drop this only after moving a site to
 * a literal shape, never to make a failure go away.
 */
const UNRESOLVED_BASELINE = 5;

describe('static Prisma query shapes (whole src/ tree)', () => {
  let calls;
  let parseErrors;

  beforeAll(() => {
    ({ calls, parseErrors } = sweepSourceTree(SRC));
  });

  test('every source file parses — an unparsable file is an unchecked file', () => {
    expect(parseErrors).toEqual([]);
  });

  test('the sweep actually found the query surface', () => {
    // A refactor that hid `prisma.<model>.<method>(...)` behind a helper would
    // drop the count to near zero and pass every assertion below. Pinning a
    // floor makes that failure loud instead.
    expect(calls.length).toBeGreaterThan(1000);
  });

  test('every statically-resolvable Prisma query is valid against the schema', () => {
    const failures = [];

    for (const { model, args, label } of calls) {
      if (args === UNRESOLVED) continue;
      try {
        assertQueryShape(model, args, label);
      } catch (err) {
        if (err instanceof PrismaQueryShapeError) failures.push(err.message);
        else throw err;
      }
    }

    expect(failures).toEqual([]);
  });

  test('the count of dynamically-built queries stays at or below the baseline', () => {
    const unresolved = calls.filter((c) => c.args === UNRESOLVED);

    if (unresolved.length > UNRESOLVED_BASELINE) {
      const byFile = {};
      for (const c of unresolved) {
        byFile[c.file.replace(`${SRC}${path.sep}`, '')] = (byFile[c.file.replace(`${SRC}${path.sep}`, '')] || 0) + 1;
      }
      const detail = Object.entries(byFile)
        .map(([file, n]) => `  ${n}× ${file}`)
        .join('\n');

      throw new Error(
        `${unresolved.length} Prisma queries have statically unknown keys `
          + `(baseline ${UNRESOLVED_BASELINE}). Either make their shapes literal `
          + `or, if a site is genuinely irreducible, raise the baseline and say why:\n${detail}`
      );
    }

    expect(unresolved.length).toBeLessThanOrEqual(UNRESOLVED_BASELINE);
  });
});

describe('the sweep catches what it claims to', () => {
  // Without this, a validator that silently accepted everything would still
  // green the three tests above. These prove it rejects a bad shape on a
  // synthetic source string, so a pass above means something.
  const { extractFromSource } = require('../helpers/staticQuerySweep');

  const modelOf = (source) => extractFromSource(source, 'synthetic.js');

  test('rejects a field that does not exist', () => {
    const [call] = modelOf('prisma.tour.findMany({ select: { imageCover: true } });');
    expect(() => assertQueryShape(call.model, call.args, call.label))
      .toThrow(/unknown field `imageCover`/);
  });

  test('accepts the same query with the real field name', () => {
    const [call] = modelOf('prisma.tour.findMany({ select: { coverPhoto: true } });');
    expect(() => assertQueryShape(call.model, call.args, call.label)).not.toThrow();
  });

  test('rejects a delegate that is not a model at all', () => {
    // `prisma.trackedClick` — the exact shape of the bug this sweep found in
    // the Expedition analytics controller.
    const found = modelOf('prisma.trackedClick.count({ where: { event: "x" } });');
    expect(found).toHaveLength(0);
  });

  test('rejects an unknown field nested under a relation', () => {
    const [call] = modelOf(
      'prisma.booking.findUnique({ include: { tour: { select: { timeZone: true } } } });'
    );
    expect(() => assertQueryShape(call.model, call.args, call.label))
      .toThrow(/unknown field `timeZone`/);
  });

  test('ignores non-Prisma clients that happen to share the call shape', () => {
    // stripe.customers.update, sanityClient, etc. — must not be mistaken for
    // `prisma.<model>.<method>`.
    expect(modelOf('stripe.customers.update("cus_1", { name: "x" });')).toHaveLength(0);
    expect(modelOf('getStripe().checkout.sessions.create({ line_items: [] });')).toHaveLength(0);
  });

  test('resolves identifier spreads of module-level select constants', () => {
    const [call] = modelOf([
      'const PICKS = { id: true, title: true };',
      'prisma.tour.findMany({ select: { ...PICKS, city: true } });',
    ].join('\n'));
    expect(call.args.select).toEqual({ id: true, title: true, city: true });
    expect(() => assertQueryShape(call.model, call.args, call.label)).not.toThrow();
  });

  test('a bad field hidden inside a spread constant is still caught', () => {
    const [call] = modelOf([
      'const PICKS = { id: true, imageCover: true };',
      'prisma.tour.findMany({ select: { ...PICKS } });',
    ].join('\n'));
    expect(() => assertQueryShape(call.model, call.args, call.label))
      .toThrow(/unknown field `imageCover`/);
  });

  test('checks both branches of a conditional object', () => {
    const [call] = modelOf(
      'prisma.tour.findMany({ select: includePhotos ? { coverPhoto: true } : { id: true } });'
    );
    expect(call.args.select).toEqual({ coverPhoto: true });
  });

  test('accepts compound unique keys and relation operators', () => {
    // Both are valid Prisma and were the first wave of false positives.
    const compound = modelOf(
      'prisma.teamMember.findUnique({ where: { supplierId_email: { supplierId: "s", email: "e" } } });'
    );
    expect(() => assertQueryShape(compound[0].model, compound[0].args, compound[0].label)).not.toThrow();

    const isNull = modelOf(
      'prisma.booking.findMany({ where: { review: { is: null } } });'
    );
    expect(() => assertQueryShape(isNull[0].model, isNull[0].args, isNull[0].label)).not.toThrow();
  });
});
