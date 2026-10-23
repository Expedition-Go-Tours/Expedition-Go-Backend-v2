const AppError = require('./appError');

function validateSearchQuery(req) {
  const { q, limit } = req.query;
  if (!q || !q.trim()) {
    throw new AppError('Search query "q" is required', 400);
  }
  return {
    query: q.trim(),
    limit: Math.min(Math.max(parseInt(limit, 10) || 5, 1), 20),
  };
}

function validateAutocompleteQuery(req) {
  const { q, limit } = req.query;
  if (!q || !q.trim()) {
    throw new AppError('Autocomplete query "q" is required', 400);
  }
  return {
    query: q.trim(),
    limit: Math.min(Math.max(parseInt(limit, 10) || 5, 1), 10),
  };
}

/**
 * Google Maps (SerpApi) fallback search: an explicit, deliberate lookup, so
 * the query is validated as a real phrase (≥3 chars) rather than a keystroke.
 * `lat`/`lng` are an optional search-area bias and must come as a pair.
 */
function validateGoogleSearchQuery(req) {
  const { q, lat, lng } = req.query;
  const query = typeof q === 'string' ? q.trim() : '';
  if (query.length < 3) {
    throw new AppError('Search query "q" must be at least 3 characters', 400);
  }
  if (query.length > 200) {
    throw new AppError('Search query "q" must be 200 characters or fewer', 400);
  }

  let origin = null;
  if ((lat != null) !== (lng != null)) {
    throw new AppError('"lat" and "lng" must be provided together', 400);
  }
  if (lat != null && lng != null) {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum) || latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      throw new AppError('Valid "lat" and "lng" query parameters are required', 400);
    }
    origin = { lat: latNum, lng: lngNum };
  }

  return { query, origin };
}

function validateReverseQuery(req) {
  const { lat, lng } = req.query;
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (isNaN(latNum) || isNaN(lngNum)) {
    throw new AppError('Valid "lat" and "lng" query parameters are required', 400);
  }
  if (latNum < -90 || latNum > 90) {
    throw new AppError('"lat" must be between -90 and 90', 400);
  }
  if (lngNum < -180 || lngNum > 180) {
    throw new AppError('"lng" must be between -180 and 180', 400);
  }
  return { lat: latNum, lng: lngNum };
}

function validateNearbyQuery(req) {
  const { lat, lng, radius } = req.query;
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (isNaN(latNum) || isNaN(lngNum)) {
    throw new AppError('Valid "lat" and "lng" query parameters are required', 400);
  }
  if (latNum < -90 || latNum > 90) {
    throw new AppError('"lat" must be between -90 and 90', 400);
  }
  if (lngNum < -180 || lngNum > 180) {
    throw new AppError('"lng" must be between -180 and 180', 400);
  }
  const radiusKm = Math.min(Math.max(parseFloat(radius) || 10, 1), 100);
  return { lat: latNum, lng: lngNum, radius: radiusKm };
}

module.exports = {
  validateSearchQuery,
  validateAutocompleteQuery,
  validateGoogleSearchQuery,
  validateReverseQuery,
  validateNearbyQuery,
};
