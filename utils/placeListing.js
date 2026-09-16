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
const { resolvePlace, regionForQuery, normalizeRegion, geocodedRegionFor } = require('./placeResolver');
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
    // Prefix-match the region column so "Bono" finds both "Bono Region" and
    // "Bono East Region" — a place in a region with no tours still surfaces
    // its sibling sub-regions instead of dead-ending.
    // itineraryRegions is a JSON text array stored as full names
    // ("Bono East Region"), so a substring check on the array text covers
    // prefix matching there too.
    const regionPattern = bare.replace(/'/g, "''");
    const conditions = [
      `t.region ILIKE '${regionPattern}%'`,
      `t."itineraryRegions"::text ILIKE '%${regionPattern}%'`,
    ];

    let joinSql = '';
    if (scope.ghanaOnly) {
      joinSql = 'JOIN "TravioGhanaTour" tgt ON tgt."tourId" = t.id AND tgt."isActive" = true';
    } else if (scope.expeditionOnly) {
      joinSql = 'JOIN "ExpeditionTour" et ON et."tourId" = t.id AND et."isActive" = true';
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT t.id FROM "Tour" t ${joinSql}
       WHERE t.status = 'ACTIVE'
         AND EXISTS (SELECT 1 FROM "SupplierProfile" sp WHERE sp."userId" = t."supplierId" AND sp.status = 'ACTIVE')
         AND (${conditions.join(' OR ')})`,
    );
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

  // Band 2 — region fallback. Whenever the place itself has no tours, widen to
  // its region so a searched town / attraction / city still surfaces its
  // region's experiences instead of a dead end.
  //
  // Unconditional on purpose: the in-place check above already reads the tour's
  // city, region, attractions, tags AND its itinerary, title and description, so
  // reaching here means nothing genuinely relates to the place — falling back to
  // the region is then always the right answer.
  //
  // Several candidate regions are tried in order and the first that actually has
  // tours wins: the resolved place's own region, the query's, its city's, and
  // finally the geocoder's. That last one rescues a mis-assigned town (Bantama
  // is stored as Bono but is a Kumasi suburb in Ashanti) instead of dead-ending.
  let regionFallback = null;
  if (localIds.size === 0) {
    const candidates = [];
    const push = (r) => { if (r && !candidates.includes(r)) candidates.push(r); };
    push(resolved.region);
    push(await regionForQuery(placeQuery).catch(() => null));
    if (resolved.city) push(await regionForQuery(resolved.city).catch(() => null));
    if (resolved.name && resolved.name !== placeQuery) push(await regionForQuery(resolved.name).catch(() => null));
    push(await geocodedRegionFor(placeQuery, scope).catch(() => null));

    for (const region of candidates) {
      const regionIds = new Set(await regionTourIds(region, scope));
      if (regionIds.size > 0) {
        regionFallback = { region: normalizeRegion(region), ids: regionIds };
        break;
      }
    }
  }

  return { resolved, ids, localIds, nearIds, regionFallback };
}

/**
 * Number of tours the place-scoped LISTING would return for `place` — the same
 * figure `/expedition/tours?place=` reports, so a search suggestion's
 * "N tours available" agrees with the page it links to.
 *
 * Mirrors the controller exactly: localIds + nearIds normally, widened to the
 * region (∪ nearIds) when the place itself has no tours, then counted through
 * the same active/scope joins the listing counts.
 *
 * @param {string} placeQuery
 * @param {{ ghanaOnly?: boolean, expeditionOnly?: boolean }} [scope]
 * @returns {Promise<number|null>} null when the query isn't a place at all.
 */
async function placeTourCount(placeQuery, scope = {}) {
  const { resolved, ids, localIds, nearIds, regionFallback } = await placeTourIds(placeQuery, scope);
  if (!resolved) return null;

  const useRegionFallback = localIds.size === 0 && !!regionFallback && regionFallback.ids.size > 0;
  const effective = useRegionFallback ? new Set([...regionFallback.ids, ...nearIds]) : ids;
  const fallbackRegion = useRegionFallback ? regionFallback.region : null;
  if (effective.size === 0) return { count: 0, fallbackRegion };

  const tourWhere = {
    status: 'ACTIVE',
    supplier: { supplierProfile: { status: 'ACTIVE' } },
    id: { in: [...effective] },
  };

  const count = scope.ghanaOnly
    ? await prisma.travioGhanaTour.count({ where: { isActive: true, tour: tourWhere } })
    : scope.expeditionOnly
      ? await prisma.expeditionTour.count({ where: { isActive: true, tour: tourWhere } })
      : await prisma.tour.count({ where: tourWhere });

  return { count, fallbackRegion };
}

module.exports = { placeTourIds, radiusForType, regionTourIds, placeTourCount };