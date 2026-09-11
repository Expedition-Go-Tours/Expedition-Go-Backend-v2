/**
 * Location geo helpers — resolve a city name to a centroid and measure
 * great-circle distance. Used by the tours listing to order results
 * "closest to the searched location first".
 *
 * The centroid is cached under the `hp:loctier:*` family so it is cleared
 * together with the rest of the homepage/location caches when a tour changes.
 */

const prisma = require('./prismaClient');
const cache = require('./cacheHelper');

/** Great-circle distance in kilometres between two lat/lng points. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Resolve a city name to the centroid (average lat/lng) of its ACTIVE,
 * geolocated tours. Cached for an hour; returns null when the city has no
 * geolocated tours (the listing then simply falls back to its default order).
 *
 * @param {string} city
 * @returns {Promise<{ lat: number, lng: number, city: string } | null>}
 */
async function resolveCityCentroid(city) {
  const name = (city || '').trim();
  if (name.length < 2) return null;

  const key = `hp:loctier:centroid:${name.toLowerCase()}`;
  return cache.getOrSet(key, async () => {
    const rows = await prisma.tour.findMany({
      where: {
        status: 'ACTIVE',
        city: { equals: name, mode: 'insensitive' },
        latitude: { not: null },
        longitude: { not: null },
      },
      select: { latitude: true, longitude: true },
      take: 200,
    });
    if (rows.length === 0) return null;
    const lat = rows.reduce((s, r) => s + r.latitude, 0) / rows.length;
    const lng = rows.reduce((s, r) => s + r.longitude, 0) / rows.length;
    return { lat, lng, city: name };
  }, 3600);
}

module.exports = { haversineKm, resolveCityCentroid };
