const catchAsync = require('../utils/catchAsync');
const locationService = require('../utils/locationService');
const validator = require('../utils/locationValidator');

exports.search = catchAsync(async (req, res) => {
  const { query, limit } = validator.validateSearchQuery(req);
  const results = await locationService.search(query, limit);
  res.status(200).json({ status: 'success', data: { results } });
});

exports.autocomplete = catchAsync(async (req, res) => {
  const { query, limit } = validator.validateAutocompleteQuery(req);
  const results = await locationService.autocomplete(query, limit);
  res.status(200).json({ status: 'success', data: { results } });
});

exports.reverse = catchAsync(async (req, res) => {
  const { lat, lng } = validator.validateReverseQuery(req);
  const results = await locationService.reverse(lat, lng);
  res.status(200).json({ status: 'success', data: { results } });
});

exports.nearby = catchAsync(async (req, res) => {
  const { lat, lng, radius } = validator.validateNearbyQuery(req);
  const results = await locationService.nearby(lat, lng, radius);
  res.status(200).json({ status: 'success', data: { results } });
});

/**
 * GET /api/locations/resolve?q=Accra
 *
 * Resolve a city name to canonical form by looking up the Tour table.
 * Used by the frontend to normalize user-typed location names.
 * Falls back to geocoding if no tours match.
 */
const prisma = require('../utils/prismaClient');

exports.resolveLocation = catchAsync(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) {
    return res.status(200).json({ status: 'success', data: { location: null } });
  }

  // 1. Try exact city match (case-insensitive)
  const exact = await prisma.tour.findFirst({
    where: { city: { equals: q, mode: 'insensitive' }, status: 'ACTIVE' },
    select: { city: true, country: true },
  });

  if (exact) {
    return res.status(200).json({ status: 'success', data: { location: { city: exact.city, country: exact.country } } });
  }

  // 2. Try starts-with match
  const startsWith = await prisma.tour.findFirst({
    where: { city: { startsWith: q, mode: 'insensitive' }, status: 'ACTIVE' },
    select: { city: true, country: true },
  });

  if (startsWith) {
    return res.status(200).json({ status: 'success', data: { location: { city: startsWith.city, country: startsWith.country } } });
  }

  // 3. Try contains match
  const contains = await prisma.tour.findFirst({
    where: { city: { contains: q, mode: 'insensitive' }, status: 'ACTIVE' },
    select: { city: true, country: true },
  });

  if (contains) {
    return res.status(200).json({ status: 'success', data: { location: { city: contains.city, country: contains.country } } });
  }

  // 4. Fallback: geocode
  try {
    const geoResults = await locationService.search(q, 1);
    if (geoResults && geoResults.length > 0) {
      return res.status(200).json({ status: 'success', data: { location: geoResults[0] } });
    }
  } catch { /* geocoding failure */ }

  return res.status(200).json({ status: 'success', data: { location: null } });
});

/**
 * GET /api/locations/my-location
 *
 * Resolve the caller's approximate location from their IP address.
 * Uses geoip-lite (city-level accuracy, ~25km). No auth required.
 * Returns null for localhost, private IPs, or when geoip-lite is unavailable.
 */
let geoip;
try { geoip = require('geoip-lite'); } catch { geoip = null; }

exports.myLocation = catchAsync(async (req, res) => {
  if (!geoip) {
    return res.status(200).json({ status: 'success', data: { location: null } });
  }

  const realIp =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    '';

  if (!realIp || realIp === 'unknown' || realIp === '127.0.0.1' || realIp === '::1') {
    return res.status(200).json({ status: 'success', data: { location: null } });
  }

  const geo = geoip.lookup(realIp);
  if (!geo || !geo.ll) {
    return res.status(200).json({ status: 'success', data: { location: null } });
  }

  res.status(200).json({
    status: 'success',
    data: {
      location: {
        lat: geo.ll[0],
        lng: geo.ll[1],
        city: geo.city || null,
        country: geo.country || null,
        timezone: geo.timezone || null,
        source: 'ip',
      },
    },
  });
});
