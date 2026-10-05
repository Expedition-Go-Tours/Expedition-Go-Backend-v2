/**
 * A blank `?page=` 500'd the public tour list.
 *
 * GET /api/tours reaches tourController.getAllTours through the legacy
 * routes/tourRoutes.js, which — unlike the three brand routers — applies no
 * zod schema to the query string. getAllTours took the defaults `page = 1,
 * limit = 12` from destructuring, but those only fire for `undefined`: a blank
 * `?page=` is `''`, so it passed straight through to
 *
 *     const skip = (parseInt(page) - 1) * parseInt(limit);
 *
 * and parseInt('') is NaN. Prisma serializes a NaN argument away instead of
 * rejecting it, so findMany({ take: 50 }) reached the engine with no `skip` at
 * all — and Prisma treats skip as required whenever take is present:
 *
 *     Argument `skip` is missing. PrismaClientValidationError
 *
 * The guard meant to catch it made it worse. validateFilterParams tested
 * `if (queryParams.page && ...)`, and `''` is falsy, so a blank page read as
 * absent and passed validation. The same input against a brand route returns
 * a clean 400, because `z.coerce.number().int().min(1)` rejects it.
 *
 * These tests pin both halves of the repair, and the coercion itself.
 */
const { toPositiveInt, toSkip, paginationFrom } = require('../../src/core/services/pagination');
const { validateFilterParams } = require('../../src/core/services/tourFilterBuilder');

describe('a blank page or limit is a client error, not a crash', () => {
  it('rejects the exact production query, ?page=&limit=50', () => {
    // Before the fix this returned isValid:true and let NaN reach Prisma.
    const result = validateFilterParams({ page: '', limit: '50' });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('page must be a positive integer');
  });

  it('rejects a blank limit on its own', () => {
    const result = validateFilterParams({ limit: '' });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('limit must be a positive integer');
  });

  it.each([
    ['whitespace only', ' '],
    ['non-numeric', 'abc'],
    ['a partially numeric value parseInt would silently truncate', '2abc'],
    ['zero', '0'],
    ['a negative page', '-1'],
    ['a fractional page', '3.7'],
  ])('rejects %s', (_label, value) => {
    expect(validateFilterParams({ page: value }).isValid).toBe(false);
  });

  it('still accepts every ordinary page and limit', () => {
    expect(validateFilterParams({}).isValid).toBe(true);
    expect(validateFilterParams({ page: '1', limit: '50' }).isValid).toBe(true);
    expect(validateFilterParams({ page: '4' }).isValid).toBe(true);
    expect(validateFilterParams({ page: ' 2 ' }).isValid).toBe(true);
    expect(validateFilterParams({ page: '+5' }).isValid).toBe(true);
    expect(validateFilterParams({ page: 3 }).isValid).toBe(true);
  });

  it.each([
    ['scientific notation', '1e3', 1000],
    ['hex notation', '0x10', 16],
  ])('accepts %s, because Number() — and therefore zod on the brand routes — does', (_label, value, coerced) => {
    // Deliberate: this mirrors `z.coerce.number().int().min(1)`, so all four
    // tour routers now agree on what a page value means. parseInt() would have
    // read these as 1 and 0; Number() reads them as the page the caller meant.
    expect(validateFilterParams({ page: value }).isValid).toBe(true);
    expect(toPositiveInt(value, 1)).toBe(coerced);
  });
});

describe('toPositiveInt never yields NaN', () => {
  it('falls back for every input that used to poison the arithmetic', () => {
    // Each of these produced NaN through `(parseInt(page) - 1) * parseInt(limit)`.
    for (const value of ['', ' ', 'abc', '2abc', '1e3', '0x10', undefined, null, {}, [], NaN, Infinity, true]) {
      expect(Number.isNaN(toPositiveInt(value, 1))).toBe(false);
    }
  });

  it('keeps the default for a blank or malformed value', () => {
    expect(toPositiveInt('', 1)).toBe(1);
    expect(toPositiveInt('abc', 1)).toBe(1);
    expect(toPositiveInt(undefined, 1)).toBe(1);
    expect(toPositiveInt('', 12)).toBe(12);
  });

  it('never returns less than 1', () => {
    expect(toPositiveInt('0', 1)).toBe(1);
    expect(toPositiveInt('-5', 1)).toBe(1);
    expect(toPositiveInt('0', 12)).toBe(12);
  });

  it('parses the numeric values a query string actually carries', () => {
    expect(toPositiveInt('1', 12)).toBe(1);
    expect(toPositiveInt('50', 12)).toBe(50);
    expect(toPositiveInt(' 7 ', 1)).toBe(7);
    expect(toPositiveInt('+5', 1)).toBe(5);
    expect(toPositiveInt(3, 1)).toBe(3);
  });

  it('truncates a fractional value rather than passing it to Prisma', () => {
    expect(toPositiveInt('3.7', 1)).toBe(3);
    expect(toPositiveInt(3.9, 1)).toBe(3);
  });

  it('honours a max clamp', () => {
    expect(toPositiveInt('999', 12, { max: 50 })).toBe(50);
    expect(toPositiveInt('10', 12, { max: 50 })).toBe(10);
  });

  it('reads the first element when qs produced an array', () => {
    expect(toPositiveInt(['3', '4'], 1)).toBe(3);
    expect(toPositiveInt([], 1)).toBe(1);
  });

  it('recovers a bad fallback rather than propagating it', () => {
    expect(toPositiveInt('', undefined)).toBe(1);
    expect(toPositiveInt('', NaN)).toBe(1);
    expect(toPositiveInt('', -3)).toBe(1);
  });
});

describe('toSkip is always a non-negative integer', () => {
  it('is 0 for the first page and scales beyond it', () => {
    expect(toSkip('1', '50')).toBe(0);
    expect(toSkip('2', '50')).toBe(50);
    expect(toSkip('3', '20')).toBe(40);
  });

  it('is 0 for the inputs that used to reach Prisma as NaN', () => {
    expect(toSkip('', '50')).toBe(0);
    expect(toSkip('abc', '50')).toBe(0);
    expect(toSkip('1', '')).toBe(0);
    expect(toSkip(undefined, undefined)).toBe(0);
  });
});

describe('paginationFrom returns a usable triple', () => {
  it('defaults when the query is empty or absent', () => {
    expect(paginationFrom({}, { defaultLimit: 12 }))
      .toEqual({ page: 1, limit: 12, skip: 0 });
    expect(paginationFrom(undefined, { defaultLimit: 24 }))
      .toEqual({ page: 1, limit: 24, skip: 0 });
  });

  it('computes skip from the coerced values', () => {
    expect(paginationFrom({ page: '3', limit: '10' }, { defaultLimit: 12 }))
      .toEqual({ page: 3, limit: 10, skip: 20 });
  });

  it('clamps limit to the maximum', () => {
    expect(paginationFrom({ limit: '5000' }, { defaultLimit: 12, maxLimit: 50 }).limit).toBe(50);
  });
});

describe('the controller no longer parses page or limit itself', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'core', 'domain', 'tourController.js'),
    'utf-8',
  );
  const handler = source.slice(
    source.indexOf('exports.getAllTours'),
    source.indexOf('exports.getSearchFallback'),
  );

  it('coerces both values through the helper', () => {
    expect(handler).toMatch(/const pageNumber = toPositiveInt\(page, 1\)/);
    expect(handler).toMatch(/const pageLimit = toPositiveInt\(limit, 12\)/);
  });

  it('never computes skip from a raw parseInt', () => {
    // The defect in one line: (parseInt(page) - 1) * parseInt(limit).
    expect(handler).not.toMatch(/parseInt\(page\)/);
    expect(handler).not.toMatch(/parseInt\(limit\)/);
  });
});