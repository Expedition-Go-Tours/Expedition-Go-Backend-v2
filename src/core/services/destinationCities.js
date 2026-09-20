/**
 * Canonical destination cities for the "Popular Destinations" section.
 *
 * Supplier-entered `Tour.city` is free text, so the raw value is frequently a
 * district ("La-Dade-Kotopon Municipal District") or a village ("Dedenya").
 * This module buckets each tour into one of Ghana's 16 curated region capitals
 * (the `City / Town` + `Major City` rows imported from the attractions XLSX),
 * so the section lists real destinations only.
 *
 * The cascade, cheapest and most reliable first:
 *   1. Tour.region                  — clean catalog field
 *   2. Tour.city via curated towns  — the XLSX town/name/alias index
 *   3. Tour.itineraryRegions        — regions the itinerary visits
 *   4. nearest region capital       — by tour coordinates, within range
 *   5. title / attractions scan     — last textual resort
 *
 * Non-Ghana tours are left alone (return null) so the Africa-wide catalog keeps
 * its own cities.
 */

const prisma = require('./prismaClient');
const logger = require('./logger');
const { resolveRegionCentroid } = require('./locationGeo');
const { normalizeRegion } = require('./placeResolver');
const { GHANA_REGION_CAPITALS, canonicalGhanaRegion, capitalForRegion } = require('./ghanaRegions');

const NEAREST_CITY_MAX_KM = 150;
const EARTH_KM = 6371;

/** Lowercase, strip accents/punctuation, collapse whitespace. */
function normalizePlace(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * The town column mixes qualifiers ("Kakum / near Cape Coast", "Lakeside
 * Estate, Accra"), so only its head segment identifies the town.
 */
function townHead(town) {
  return normalizePlace(
    String(town || '').split(/[,/]/)[0].replace(/^near\s+/i, '').trim()
  );
}

/**
 * Build the curated index: the 16 capital cities (with region centroids) and a
 * normalized locality → region map from the imported Attraction rows.
 */
async function buildMajorCityIndex(client = prisma) {
  const rows = await client.attraction.findMany({
    where: { status: 'ACTIVE', region: { not: null } },
    select: { name: true, town: true, region: true, category: true, placeType: true },
    orderBy: [{ tourCount: 'desc' }, { priority: 'desc' }],
  });

  const cityRows = new Map();
  const localityToRegion = new Map();

  const addLocality = (key, region) => {
    if (key && region && !localityToRegion.has(key)) localityToRegion.set(key, region);
  };

  for (const row of rows) {
    const region = canonicalGhanaRegion(row.region);
    if (!region) continue;

    if (row.category === 'City / Town' && row.placeType === 'Major City') {
      const capital = GHANA_REGION_CAPITALS[region];
      if (!cityRows.has(capital)) cityRows.set(capital, { name: capital, region });
    }

    addLocality(townHead(row.town), region);
    addLocality(normalizePlace(row.name), region);
  }

  const cities = [];
  for (const info of cityRows.values()) {
    const centroid = await resolveRegionCentroid(normalizeRegion(info.region)).catch(() => null);
    cities.push({
      name: info.name,
      region: info.region,
      lat: centroid ? centroid.lat : null,
      lng: centroid ? centroid.lng : null,
    });
  }

  return {
    cities,
    cityByKey: new Map(cities.map((c) => [normalizePlace(c.name), c])),
    localityToRegion,
  };
}

/**
 * Resolve a tour to its curated major city, or null when it cannot be mapped
 * (or is not a Ghana tour).
 *
 * @param {Object} tour - { city, region, country, itineraryRegions, latitude, longitude, title, attractions }
 * @param {Object} index - result of buildMajorCityIndex()
 * @returns {string|null} capital city name
 */
function majorCityForTour(tour, index) {
  if (!tour || !index) return null;

  const country = String(tour.country || '').trim().toLowerCase();
  if (country && country !== 'ghana') return null;

  const known = (capital) => {
    if (!capital) return null;
    return index.cityByKey.has(normalizePlace(capital)) ? capital : null;
  };

  // 1. Catalog region.
  const byRegion = known(capitalForRegion(tour.region));
  if (byRegion) return byRegion;

  // 2. Free-text city: a capital name itself, or a curated town's region.
  const cityKey = normalizePlace(tour.city);
  if (cityKey) {
    const direct = index.cityByKey.get(cityKey);
    if (direct) return direct.name;
    const viaLocality = known(capitalForRegion(index.localityToRegion.get(cityKey)));
    if (viaLocality) return viaLocality;
  }

  // 3. Regions the itinerary visits.
  for (const region of tour.itineraryRegions || []) {
    const viaItinerary = known(capitalForRegion(region));
    if (viaItinerary) return viaItinerary;
  }

  // 4. Nearest capital by coordinates.
  if (tour.latitude != null && tour.longitude != null) {
    let best = null;
    let bestKm = Infinity;
    for (const city of index.cities) {
      if (city.lat == null || city.lng == null) continue;
      const km = haversineKm(tour.latitude, tour.longitude, city.lat, city.lng);
      if (km < bestKm) {
        bestKm = km;
        best = city;
      }
    }
    if (best && bestKm <= NEAREST_CITY_MAX_KM) return best.name;
  }

  // 5. Title / attractions tokens.
  const tokens = [tour.title, ...(tour.attractions || [])]
    .flatMap((s) => String(s || '').split(/[^A-Za-z0-9']+/))
    .map(normalizePlace)
    .filter(Boolean);

  for (const token of tokens) {
    const direct = index.cityByKey.get(token);
    if (direct) return direct.name;
  }
  for (const token of tokens) {
    const viaLocality = known(capitalForRegion(index.localityToRegion.get(token)));
    if (viaLocality) return viaLocality;
  }

  return null;
}

/**
 * The value to persist in `Tour.destinationCity` for a tour-shaped object: the
 * curated capital for Ghana tours, the tour's own city otherwise. Null means
 * "no destination" (a Ghana tour that could not be mapped).
 */
function destinationCityFor(tour, index) {
  if (!tour) return null;
  const country = String(tour.country || '').trim().toLowerCase();
  const isGhana = !country || country === 'ghana';
  if (isGhana) return majorCityForTour(tour, index);
  return String(tour.city || '').trim() || null;
}

/**
 * Compute `destinationCity` for a tour-shaped object about to be written.
 * Builds the curated index once per call; pass `index` to reuse one across
 * many tours (the backfill does).
 */
async function enrichDestinationCity(data, index = null) {
  const idx = index || (await buildMajorCityIndex());
  return { ...data, destinationCity: destinationCityFor(data, idx) };
}

/**
 * Compute `destinationCity` for a partial patch merged over an existing row, so
 * an edit that omits location keeps the correct value.
 *
 * Derived and non-critical: a failure is logged and yields null rather than
 * aborting the tour write (the backfill repairs any gap).
 */
async function destinationCityFromPatch(patch, existing = null, index = null, client = prisma) {
  try {
    const pick = (key) =>
      patch && patch[key] !== undefined ? patch[key] : existing ? existing[key] : undefined;
    const merged = {
      city: pick('city'),
      region: pick('region'),
      country: pick('country'),
      itineraryRegions: pick('itineraryRegions'),
      latitude: pick('latitude'),
      longitude: pick('longitude'),
      title: pick('title'),
      attractions: pick('attractions'),
    };
    const idx = index || (await buildMajorCityIndex(client));
    return destinationCityFor(merged, idx);
  } catch (err) {
    logger.warn(`[destinationCities] destinationCity computation failed: ${err.message}`);
    return null;
  }
}

/**
 * The curated major cities (name, region, centroid) — the picklist suppliers
 * choose from and the destination rail groups by.
 */
async function listMajorCities(index = null) {
  const idx = index || (await buildMajorCityIndex());
  return idx.cities
    .map((c) => ({ name: c.name, region: c.region, lat: c.lat, lng: c.lng }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Categorise a curated Attraction row as a city, town, or attraction. */
function placeTypeFor(row) {
  if (row.category !== 'City / Town') return 'attraction';
  return /major city|regional capital/i.test(String(row.placeType || '')) ? 'city' : 'town';
}

const PLACE_TYPE_RANK = { city: 0, town: 1, attraction: 2 };

/**
 * Head segment of a town value, preserving casing. The XLSX town column mixes
 * qualifiers ("Kakum / near Cape Coast", "Lakeside Estate, Accra"), so only the
 * head segment identifies the town. Unlike `townHead` (index keying), this keeps
 * the original casing for storage/display.
 */
function cleanTown(town) {
  const head = String(town || '')
    .split(/[,/]/)[0]
    .replace(/^near\s+/i, '')
    .trim();
  return head || null;
}

/**
 * The city/town to store for a picked place: cities and towns ARE the place
 * (`name`), attractions resolve to their town.
 */
function cityForPlace(row, type) {
  if (type === 'attraction') return cleanTown(row.town);
  return row.name || null;
}

/**
 * Search the curated places catalog (cities, towns and attractions — the rows
 * imported from the attractions XLSX) for a supplier autocomplete.
 *
 * Empty/short queries return a sensible default: the 16 major cities first,
 * then the most-booked places. A real query ranks exact name matches ahead of
 * name-prefix, name-substring, then town/alias matches, and prefers cities over
 * towns over attractions within a rank. The response is a flat, typed list:
 * `{ name, type, city, region, lat, lng }`.
 *
 * `types` optionally restricts results to a subset of `city` / `town` /
 * `attraction` (e.g. a city picker passes `['city', 'town']`).
 */
async function searchPlaces(query = '', limit = 25, types = null) {
  const q = normalizePlace(query);
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const allowed = Array.isArray(types) && types.length > 0 ? new Set(types) : null;
  const inTypes = (type) => !allowed || allowed.has(type);
  const select = {
    name: true,
    town: true,
    region: true,
    category: true,
    placeType: true,
    latitude: true,
    longitude: true,
    tourCount: true,
  };

  // Translate the type filter into a Prisma category constraint so the DB does
  // the heavy lifting (cities/towns share the `City / Town` category).
  const typeWhere = (() => {
    if (!allowed) return {};
    const wantsPlace = allowed.has('city') || allowed.has('town');
    const wantsAttraction = allowed.has('attraction');
    if (wantsPlace && !wantsAttraction) return { category: 'City / Town' };
    if (wantsAttraction && !wantsPlace) return { category: { not: 'City / Town' } };
    return {};
  })();

  // Default list — no usable query yet.
  if (q.length < 2) {
    const capitals = await listMajorCities();
    const top = await prisma.attraction.findMany({
      where: { status: 'ACTIVE', ...typeWhere },
      select,
      orderBy: [{ tourCount: 'desc' }, { name: 'asc' }],
      take: 60,
    });
    const seen = new Set();
    const out = [];
    for (const c of capitals) {
      if (!inTypes('city')) continue;
      seen.add(normalizePlace(c.name));
      out.push({ name: c.name, type: 'city', city: c.name, region: c.region || null, lat: c.lat ?? null, lng: c.lng ?? null });
    }
    for (const r of top) {
      const key = normalizePlace(r.name);
      if (seen.has(key)) continue;
      seen.add(key);
      const type = placeTypeFor(r);
      if (!inTypes(type)) continue;
      out.push({ name: r.name, type, city: cityForPlace(r, type), region: r.region || null, lat: r.latitude ?? null, lng: r.longitude ?? null });
    }
    return out.slice(0, take);
  }

  const candidates = await prisma.attraction.findMany({
    where: {
      status: 'ACTIVE',
      ...typeWhere,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { town: { contains: q, mode: 'insensitive' } },
        { aliases: { contains: q, mode: 'insensitive' } },
      ],
    },
    select,
    orderBy: [{ tourCount: 'desc' }, { name: 'asc' }],
    take: 300,
  });

  const ranked = candidates
    .map((r) => {
      const nameN = normalizePlace(r.name);
      const townN = normalizePlace(r.town);
      const aliases = String(r.aliases || '').split(';').map(normalizePlace);
      let score;
      if (nameN === q) score = 0;
      else if (nameN.startsWith(q)) score = 1;
      else if (nameN.includes(q)) score = 2;
      else if (townN === q || townN.startsWith(q) || aliases.some((a) => a === q || a.startsWith(q))) score = 3;
      else score = 4;
      return { r, score, type: placeTypeFor(r) };
    })
    .filter((x) => inTypes(x.type))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const ta = PLACE_TYPE_RANK[a.type];
      const tb = PLACE_TYPE_RANK[b.type];
      if (ta !== tb) return ta - tb;
      return (b.r.tourCount || 0) - (a.r.tourCount || 0);
    });

  return ranked.slice(0, take).map(({ r, type }) => ({
    name: r.name,
    type,
    city: cityForPlace(r, type),
    region: r.region || null,
    lat: r.latitude ?? null,
    lng: r.longitude ?? null,
  }));
}

module.exports = {
  buildMajorCityIndex,
  majorCityForTour,
  destinationCityFor,
  destinationCityFromPatch,
  enrichDestinationCity,
  listMajorCities,
  searchPlaces,
  normalizePlace,
  NEAREST_CITY_MAX_KM,
};
