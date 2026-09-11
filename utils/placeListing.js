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
 * @param {string} placeQuery
 * @param {{ ghanaOnly?: boolean, expeditionOnly?: boolean }} [scope]
 * @param {{ radiusKm?: number }} [opts]
 * @returns {Promise<{ resolved: object|null, ids: Set<string>|null }>}
 */
async function placeTourIds(placeQuery, scope = {}, { radiusKm } = {}) {
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

  // Band 1 — near the place, with a radius that depends on what the place is.
  const radius = radiusKm != null ? radiusKm : radiusForType(resolved.type);
  if (radius > 0 && resolved.lat != null && resolved.lng != null) {
    const near = await findNearbyTourIds(prisma, resolved.lat, resolved.lng, radius);
    for (const id of near) ids.add(id);
  }

  return { resolved, ids };
}

module.exports = { placeTourIds, radiusForType };
