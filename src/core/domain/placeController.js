/**
 * Place endpoints for the search bar — resolve a query to a canonical place
 * (or null), and suggest grouped results the way GetYourGuide does:
 * "Places to see" (destinations + attractions) and "Things to do" (tours).
 *
 * Read-only, cheap, cached. `scope` selects the catalog (lite/expedition =
 * expedition catalog, ghana = TravioGhana catalog, default = all).
 */

const crypto = require('crypto');
const prisma = require('../services/prismaClient');
const cache = require('../services/cacheHelper');
const catchAsync = require('../services/catchAsync');
const { resolvePlace } = require('../services/placeResolver');
const { listMajorCities, searchPlaces } = require('../services/destinationCities');

/** Map the `scope` query param to a resolver scope. */
function parseScope(req) {
  const s = String(req.query.scope || '').toLowerCase();
  if (s === 'ghana' || s === 'travioghana') return { ghanaOnly: true };
  if (s === 'lite' || s === 'expedition') return { expeditionOnly: true };
  return {};
}

/** Catalog scope filter for Prisma queries. */
function scopeWhere(scope) {
  if (scope.ghanaOnly) return { travioGhanaTour: { isActive: true } };
  if (scope.expeditionOnly) return { expeditionTour: { isActive: true } };
  return {};
}

/**
 * GET /api/places/resolve?q=&scope=
 * Resolve a query to a canonical place with coordinates, or null. Used by the
 * storefront to decide whether to scope a listing to a place or text-search.
 */
exports.resolve = catchAsync(async (req, res) => {
  const q = (req.query.q || '').trim();
  const place = q.length >= 2 ? await resolvePlace(q, parseScope(req)) : null;
  res.json({ status: 'success', data: { query: q, place } });
});

/**
 * GET /api/places/cities
 *
 * The curated major-city picklist (Ghana's 16 region capitals). Suppliers
 * choose from this so a tour's city is canonical from creation, instead of
 * whatever the geocoder returns for an address ("La-Dade-Kotopon Municipal
 * District"). Cached — it only changes when the attractions XLSX does.
 */
exports.cities = catchAsync(async (req, res) => {
  const cities = await cache.getOrSet('hp:place:cities', () => listMajorCities(), 3600);
  res.json({ status: 'success', data: { cities } });
});

/**
 * GET /api/places/search?q=&limit=&types=
 *
 * Flat, typed autocomplete over the curated places catalog (cities, towns and
 * attractions — the XLSX import). Used by the supplier product builder's
 * location modal. `types` is a comma-separated subset of `city,town,attraction`
 * (e.g. a city picker sends `types=city,town`). Cached per query; empty `q`
 * returns major cities + top places.
 */
exports.search = catchAsync(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
  const allowedTypes = new Set(['city', 'town', 'attraction']);
  const types = String(req.query.types || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => allowedTypes.has(t));
  const typesKey = types.length > 0 ? [...types].sort().join(',') : 'all';
  const key = `hp:place:search:${crypto.createHash('md5').update(`${q.toLowerCase()}:${limit}:${typesKey}`).digest('hex')}`;
  const places = await cache.getOrSet(key, () => searchPlaces(q, limit, types.length > 0 ? types : null), 3600);
  res.json({ status: 'success', data: { places } });
});

exports.suggest = catchAsync(async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 6, 10);
  const scope = parseScope(req);

  if (q.length < 2) {
    return res.json({ status: 'success', data: { query: q, placesToSee: [], thingsToDo: [] } });
  }

  const cacheKey = `hp:place:suggest:${scope.ghanaOnly ? 'ghana' : scope.expeditionOnly ? 'exp' : 'all'}:${crypto.createHash('md5').update(`${q.toLowerCase()}:${limit}`).digest('hex')}`;
  const scopeFilter = scopeWhere(scope);

  const data = await cache.getOrSet(cacheKey, async () => {
    // Destinations — catalog cities matching the query, most tours first.
    const cities = await prisma.tour.groupBy({
      by: ['city', 'country'],
      where: { status: 'ACTIVE', city: { contains: q, mode: 'insensitive' }, ...scopeFilter },
      _count: { _all: true },
      orderBy: { _count: { city: 'desc' } },
      take: limit,
    }).catch(() => []);

    // Attractions — curated names matching the query.
    const attractions = await prisma.attraction.findMany({
      where: { status: 'ACTIVE', name: { contains: q, mode: 'insensitive' } },
      select: { name: true, heroImage: true, tourCount: true, region: true },
      orderBy: [{ tourCount: 'desc' }, { avgRating: 'desc' }],
      take: limit,
    }).catch(() => []);

    // Regions — match Ghana region names.
    const GHANA_REGIONS = [
      'Ahafo','Ashanti','Bono','Bono East','Central','Eastern',
      'Greater Accra','North East','Northern','Oti','Savannah',
      'Upper East','Upper West','Volta','Western','Western North',
    ];
    const nq = String(q || '').toLowerCase().trim();
    const regionMatches = GHANA_REGIONS
      .filter(r => r.toLowerCase().includes(nq) || `${r} Region`.toLowerCase().includes(nq))
      .slice(0, 3)
      .map(r => ({
        id: `region-${r}`,
        type: 'region',
        name: `${r} Region`,
        region: r,
        city: null,
        country: null,
        tourCount: 0,
        image: null,
      }));

    // Tours — title matches, most reviewed first.
    const tours = await prisma.tour.findMany({
      where: { status: 'ACTIVE', title: { contains: q, mode: 'insensitive' }, ...scopeFilter },
      select: { id: true, title: true, slug: true, coverPhoto: true, city: true, country: true, averageRating: true },
      orderBy: [{ reviewCount: 'desc' }, { totalBookings: 'desc' }],
      take: limit,
    }).catch(() => []);

    const placesToSee = [
      ...cities
        .filter((c) => c.city)
        .map((c) => ({
          id: `dest-${c.city}`,
          type: 'destination',
          name: c.city,
          city: c.city,
          country: c.country || null,
          tourCount: c._count?._all ?? 0,
          image: null,
        })),
      ...attractions.map((a) => ({
        id: `attr-${a.name}`,
        type: 'attraction',
        name: a.name,
        city: null,
        country: null,
        tourCount: a.tourCount ?? 0,
        image: a.heroImage || null,
      })),
      ...regionMatches,
    ].slice(0, limit * 2);

    const thingsToDo = tours.map((t) => ({
      id: t.id,
      title: t.title,
      slug: t.slug,
      image: t.coverPhoto || null,
      city: t.city || null,
      country: t.country || null,
      rating: t.averageRating != null ? Number(t.averageRating) : null,
    }));

    return { query: q, placesToSee, thingsToDo };
  }, 300);

  res.json({ status: 'success', data });
});
