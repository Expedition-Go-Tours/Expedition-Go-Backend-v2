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
