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
const { resolvePlace } = require('./placeResolver');
const { getLocationTourIds } = require('./homepageRanking');
const { findNearbyTourIds } = require('./tourFilterBuilder');

/**
 * @param {string} placeQuery
 * @param {{ ghanaOnly?: boolean, expeditionOnly?: boolean }} [scope]
 * @param {{ radiusKm?: number }} [opts]
 * @returns {Promise<{ resolved: object|null, ids: Set<string>|null }>}
 */
async function placeTourIds(placeQuery, scope = {}, { radiusKm = 50 } = {}) {
  const resolved = await resolvePlace(placeQuery, scope);
  if (!resolved) return { resolved: null, ids: null };

  const ghanaOnly = !!scope.ghanaOnly;
  const expeditionOnly = !!scope.expeditionOnly;

  // Band 0 — in-place, matched on the canonical name and the raw query (so
  // "kakum" still matches tours tagged "Kakum National Park").
  const ids = new Set(await getLocationTourIds(resolved.name, ghanaOnly, expeditionOnly));
  const canonical = String(resolved.name || '').trim().toLowerCase();
  const raw = String(placeQuery || '').trim().toLowerCase();
  if (raw && raw !== canonical) {
    for (const id of await getLocationTourIds(placeQuery, ghanaOnly, expeditionOnly)) ids.add(id);
  }

  // Band 1 — near the place. Region/country places are matched by name only
  // (their centroid is not a meaningful "near" point).
  const useRadius = resolved.type !== 'region' && resolved.type !== 'country';
  if (useRadius && resolved.lat != null && resolved.lng != null) {
    const near = await findNearbyTourIds(prisma, resolved.lat, resolved.lng, radiusKm);
    for (const id of near) ids.add(id);
  }

  return { resolved, ids };
}

module.exports = { placeTourIds };
