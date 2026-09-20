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
  validateReverseQuery,
  validateNearbyQuery,
};
