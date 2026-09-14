/**
 * Place-scoped listing helper.
 *
 * Given a search query, returns the set of tour IDs that belong to the place:
 *   band 0 — in-place (city / region / attractions / tags match)
 *   band 1 — near the place (within `radiusKm`)
 *
 * The "everywhere else" band is intentionally excluded, matching
 * GetYourGuide's place pages: a place with no tours returns nothing (the
 * storefront then shows its no-tours state), never the whole catalogue.
 *
 * `ids === null` means the query is not a place — callers should fall back to
 * plain text search.
 */

const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const { resolvePlace, regionForQuery, normalizeRegion } = require('./placeResolver');
const { getLocationTourIds } = require('./homepageRanking');
const { findNearbyTourIds } = require('./tourFilterBuilder');

// Place types we trust enough to widen to their region when they have no tours.
// Guards against a spurious text match triggering a region fallback.
const CONFIDENT_PLACE_TYPES = new Set(['city', 'region', 'attraction', 'locality']);

/**
 * Per-type "near" radius. A city legitimately includes its whole metro area,
 * but a neighbourhood/town should only pull tours around it, and an attraction
 * (a market, a park) only tours at/around it — otherwise "Makola Market" or
 * "Nima" would return every Accra tour. Regions/countries are name-matched
 * only (no radius).
 */
function radiusForType(type) {
  if (type === 'attraction') return 10;
  if (type === 'locality') return 15;
  if (type === 'city') return 50;
  return 0; // region / country / unknown
}

/**
 * Tours whose REGION equals the given region — a dedicated, region-only match
 * (not the broader text matcher) so the fallback stays precise. Cached 5 min.
 *
 * @param {string} region  e.g. "Eastern" or "Eastern Region"
 * @param {{ ghanaOnly?: boolean, expeditionOnly?: boolean }} [scope]
 * @returns {Promise<string[]>}
 */
async function regionTourIds(region, scope = {}) {
  const normalized = normalizeRegion(region);
  if (!normalized) return [];
  const bare = normalized.replace(/\s+region$/i, '');
  const key = `hp:regiontours:${normalized.toLowerCase()}${scope.ghanaOnly ? ':ghana' : ''}${scope.expeditionOnly ? ':exp' : ''}`;

  return cache.getOrSet(key, async () => {
    const where = {
      status: 'ACTIVE',
      supplier: { supplierProfile: { status: 'ACTIVE' } },
      region: { in: [normalized, bare], mode: 'insensitive' },
    };
    if (scope.ghanaOnly) where.travioGhanaTour = { isActive: true };
    else if (scope.expeditionOnly) where.expeditionTour = { isActive: true };

    const rows = await prisma.tour.findMany({ where, select: { id: true } });
    return rows.map((r) => r.id);
  }, 300);
}

/**
 * @param {string} placeQuery
 * @param {{ ghanaOnly?: boolean, expeditionOnly?: boolean }} [scope]
 * @param {{ radiusKm?: number }} [opts]
 * @returns {Promise<{ resolved: object|null, ids: Set<string>|null, localIds: Set<string>|null, nearIds: Set<string>|null, regionFallback: { region: string, ids: Set<string> }|null }>}
 */
async function placeTourIds(placeQuery, scope = {}, { radiusKm } = {}) {
  const resolved = await resolvePlace(placeQuery, scope);
  if (!resolved) return { resolved: null, ids: null, localIds: null, nearIds: null, regionFallback: null };

  const ghanaOnly = !!scope.ghanaOnly;
  const expeditionOnly = !!scope.expeditionOnly;

  // Band 0 — in-place, matched on the canonical name and the raw query (so
  // "kakum" still matches tours tagged "Kakum National Park").
  const localIds = new Set(await getLocationTourIds(resolved.name, ghanaOnly, expeditionOnly));
  const canonical = String(resolved.name || '').trim().toLowerCase();
  const raw = String(placeQuery || '').trim().toLowerCase();
  if (raw && raw !== canonical) {
    for (const id of await getLocationTourIds(placeQuery, ghanaOnly, expeditionOnly)) localIds.add(id);
  }

  // Band 1 — near the place, with a radius that depends on what the place is.
  // Kept separate from `localIds` so callers can rank "based there" above
  // "nearby" — merging them made every result look like an exact place match.
  const nearIds = new Set();
  const radius = radiusKm != null ? radiusKm : radiusForType(resolved.type);
  if (radius > 0 && resolved.lat != null && resolved.lng != null) {
    const near = await findNearbyTourIds(prisma, resolved.lat, resolved.lng, radius);
    for (const id of near) if (!localIds.has(id)) nearIds.add(id);
  }

  const ids = new Set([...localIds, ...nearIds]);

  // Band 2 — region fallback. ONLY when the place itself has no tours, widen
  // to the place's region (resolved from the curated Attraction table / the
  // geocoder) so a searched town still surfaces its region's experiences
  // instead of a dead end. Confident place types only; if the region can't be
  // resolved or has no tours, `ids` stays empty and the storefront shows its
  // no-tours state.
  let regionFallback = null;
  if (ids.size === 0 && CONFIDENT_PLACE_TYPES.has(resolved.type)) {
    const region = resolved.region || (await regionForQuery(placeQuery).catch(() => null));
    if (region) {
      const regionIds = new Set(await regionTourIds(region, scope));
      if (regionIds.size > 0) regionFallback = { region: normalizeRegion(region), ids: regionIds };
    }
  }

  return { resolved, ids, localIds, nearIds, regionFallback };
}

module.exports = { placeTourIds, radiusForType, regionTourIds };
