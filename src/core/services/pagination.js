/**
 * Pagination arithmetic that cannot produce NaN.
 *
 * Every paginated list in this codebase derives its `skip` and `take` from
 * `parseInt(req.query.page)` / `parseInt(req.query.limit)`. Those two helpers
 * were trusted to return a number, but `parseInt('')` is `NaN`, and a query
 * string with a blank value — `?page=`, `?limit=`, which crawlers, link
 * checkers and hand-written URLs all produce — reaches them untouched because
 * the destructuring defaults (`page = 1`) only fire for `undefined`, not `''`.
 *
 * NaN then propagates into `skip`, and Prisma serializes the argument away
 * rather than rejecting it, so the query arrives at the engine as
 * `findMany({ take: 50 })` with no `skip`. Prisma treats `skip` as required
 * whenever `take` is present and fails the call:
 *
 *     Argument `skip` is missing. PrismaClientValidationError
 *
 * Observed in production on GET /api/tours?page=&limit=50, which returned a
 * 500 for a request whose only defect was a blank query value.
 *
 * The guard that should have caught it, `validateFilterParams`, tests
 * `if (queryParams.page && ...)` — and `''` is falsy, so a blank page was
 * treated as absent and passed validation. Both halves have to agree: this
 * module makes the arithmetic total, and the validator rejects blank values
 * with the same 400 the zod-validated brand routes already return for them.
 *
 * Coercion is deliberately forgiving rather than throwing. An empty string,
 * whitespace, `abc`, a negative number, zero, an array or an object all fall
 * back to the caller's default, because a list endpoint answering with page 1
 * is always a better outcome than a 500 — and because the brand routes reach
 * the same conclusion through `z.coerce.number().int().min(1)`, which rejects
 * the blank value outright. Both paths converge on the same successful page.
 */

/**
 * Coerce a query value to a positive integer, falling back when it is not one.
 *
 * @param {unknown} value raw value, typically `req.query.<name>`
 * @param {number} fallback value to use when `value` is not a positive integer
 * @param {{ max?: number }} [options] clamp the result to `max`
 * @returns {number} an integer >= 1, and <= `max` when given
 */
function toPositiveInt(value, fallback, options = {}) {
  const { max } = options;
  const fallbackSafe = Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : 1;

  // An array (`?page=1&page=2`) or object arrives from qs; parse only the first
  // scalar so `['1','2']` behaves like `1` rather than becoming NaN.
  const raw = Array.isArray(value) ? value[0] : value;

  let parsed;
  if (typeof raw === 'number') {
    parsed = raw;
  } else if (typeof raw === 'string') {
    // Number('') is 0, so a blank value is rejected by the `whole < 1` check
    // below rather than needing its own branch. Number() rather than parseInt()
    // because parseInt() stops at the first non-digit, turning '2abc' into 2.
    parsed = Number(raw.trim());
  } else {
    parsed = NaN;
  }

  if (!Number.isFinite(parsed)) return fallbackSafe;

  const whole = Math.floor(parsed);
  if (whole < 1) return fallbackSafe;

  if (typeof max === 'number' && Number.isFinite(max) && max >= 1) {
    return Math.min(whole, Math.floor(max));
  }
  return whole;
}

/**
 * The `skip` for a page number, clamped so it can never go negative.
 *
 * @param {unknown} page raw page value
 * @param {number} [limit] page size, used to scale the offset
 * @returns {number} a non-negative integer
 */
function toSkip(page, limit) {
  const safePage = toPositiveInt(page, 1);
  const safeLimit = toPositiveInt(limit, 12);
  return (safePage - 1) * safeLimit;
}

/**
 * A `{ page, limit, skip }` triple with every member guaranteed usable.
 *
 * @param {object} query typically `req.query`
 * @param {{ defaultPage?: number, defaultLimit: number, maxLimit?: number }} options
 * @returns {{ page: number, limit: number, skip: number }}
 */
function paginationFrom(query, options) {
  const { defaultPage = 1, defaultLimit, maxLimit } = options;
  const limit = toPositiveInt(query && query.limit, defaultLimit, { max: maxLimit });
  const page = toPositiveInt(query && query.page, defaultPage);
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = { toPositiveInt, toSkip, paginationFrom };