/**
 * Place suggestions for the search bar — grouped the way GetYourGuide does:
 * "Places to see" (destinations + attractions) and "Things to do" (tours).
 *
 * Read-only, cheap, cached. Falls back to text matching so it degrades
 * gracefully when the geocoder is unavailable.
 */

const crypto = require('crypto');
const prisma = require('../utils/prismaClient');
const cache = require('../utils/cacheHelper');
const catchAsync = require('../utils/catchAsync');
const { resolvePlace } = require('../utils/placeResolver');

/**
 * GET /api/places/resolve?q=
 * Resolve a query to a canonical place with coordinates, or null. Used by the
 * storefront search to decide whether to scope a listing to a place or fall
 * back to a plain text search.
 */
exports.resolve = catchAsync(async (req, res) => {
  const q = (req.query.q || '').trim();
  const place = q.length >= 2 ? await resolvePlace(q) : null;
  res.json({ status: 'success', data: { query: q, place } });
});


exports.suggest = catchAsync(async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 6, 10);

  if (q.length < 2) {
    return res.json({ status: 'success', data: { query: q, placesToSee: [], thingsToDo: [] } });
  }

  const cacheKey = `hp:place:suggest:${crypto.createHash('md5').update(`${q.toLowerCase()}:${limit}`).digest('hex')}`;

  const data = await cache.getOrSet(cacheKey, async () => {
    // Destinations — catalog cities matching the query, most tours first.
    const cities = await prisma.tour.groupBy({
      by: ['city', 'country'],
      where: { status: 'ACTIVE', city: { contains: q, mode: 'insensitive' } },
      _count: { _all: true },
      orderBy: { _count: { city: 'desc' } },
      take: limit,
    }).catch(() => []);

    // Attractions — curated names matching the query.
    const attractions = await prisma.attraction.findMany({
      where: { status: 'ACTIVE', name: { contains: q, mode: 'insensitive' } },
      select: { name: true, heroImage: true, tourCount: true },
      orderBy: [{ tourCount: 'desc' }, { avgRating: 'desc' }],
      take: limit,
    }).catch(() => []);

    // Tours — title matches, most reviewed first.
    const tours = await prisma.tour.findMany({
      where: { status: 'ACTIVE', title: { contains: q, mode: 'insensitive' } },
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
