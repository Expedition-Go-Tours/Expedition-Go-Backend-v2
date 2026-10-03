/**
 * How a tour route param is turned into a Prisma `where`.
 *
 * Tour route params (`:slug`) also accept the tour's id, so id-based links
 * keep resolving: both storefronts publish `/tour/{id}/{slug}` as the canonical
 * tour URL, and their detail pages pass the id straight through. The lookup is
 * therefore always `slug OR id` — correct for any param, whatever it looks like.
 *
 * This lives in its own module because both the shared storefront controller
 * and the Ghana brand override need it, and a second hand-rolled copy is
 * exactly how the two drifted apart in the first place: Ghana's override
 * matched on `slug` alone, so `/api/travioghana/tours/{id}` 404'd on every
 * tour page view on both storefronts while `/reviews`, `/similar` and
 * `/availability` — which all route through here — resolved the same id fine.
 */

/** `slug OR id`, for use as `{ tour: tourMatchWhere(param) }`. */
const tourMatchWhere = (value) => ({ OR: [{ slug: value }, { id: value }] });

/**
 * Whether a param looks like a tour id rather than a slug.
 *
 * The lookup is `slug OR id` either way; this only decides caching. Detail
 * entries are cached under the param they were requested with, but
 * `invalidateCaches()` only ever purges the *slug*-keyed entry — so an
 * id-keyed copy would outlive a supplier's edit until its TTL expired, which
 * is precisely the staleness the storefront's `cache: 'no-store'` detail fetch
 * exists to avoid. Id-shaped params therefore bypass the cache.
 *
 * CUIDs are 24-32 alphanumeric chars with no hyphens. A slug that happens to
 * fall in that range merely loses caching, which is harmless.
 */
const isTourIdParam = (value) => typeof value === 'string' && /^[a-z0-9]{24,32}$/i.test(value);

module.exports = { tourMatchWhere, isTourIdParam };