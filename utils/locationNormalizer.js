function fromGeoapify(feature) {
  if (!feature || !feature.properties) return null;
  const p = feature.properties;
  const coords = feature.geometry?.coordinates;
  return {
    formatted: p.formatted || p.name || '',
    latitude: coords ? coords[1] : null,
    longitude: coords ? coords[0] : null,
    city: p.city || p.town || p.village || p.county || '',
    country: p.country || '',
    countryCode: p.country_code || '',
    region: p.state || p.district || p.region || '',
    postcode: p.postcode || null,
    street: p.street || p.address_line1 || '',
    housenumber: p.housenumber || null,
    category: p.category || null,
    source: 'geoapify',
    confidence: p.rank?.confidence || null,
  };
}

function fromNominatim(result) {
  if (!result) return null;
  const addr = result.address || {};
  return {
    formatted: result.display_name || '',
    latitude: result.lat ? Number(result.lat) : null,
    longitude: result.lon ? Number(result.lon) : null,
    city: addr.city || addr.town || addr.village || addr.county || '',
    country: addr.country || '',
    countryCode: addr.country_code || '',
    region: addr.state || addr.region || addr.district || '',
    postcode: addr.postcode || null,
    street: addr.road || addr.street || addr.footway || '',
    housenumber: addr.house_number || null,
    category: null,
    source: 'nominatim',
    confidence: null,
  };
}

function fromPhoton(feature) {
  if (!feature || !feature.properties) return null;
  const p = feature.properties;
  const coords = feature.geometry?.coordinates;
  return {
    formatted: [p.name, p.street, p.city, p.country].filter(Boolean).join(', ') || p.name || '',
    latitude: coords ? coords[1] : null,
    longitude: coords ? coords[0] : null,
    city: p.city || p.town || p.village || p.county || '',
    country: p.country || '',
    countryCode: p.countrycode || '',
    region: p.state || p.district || p.region || '',
    postcode: p.postcode || null,
    street: p.street || p.name || '',
    housenumber: p.housenumber || null,
    category: p.osm_value || p.type || null,
    source: 'photon',
    confidence: null,
  };
}

function normalizeGeoapifyResponse(data) {
  if (!data || !Array.isArray(data.features)) return [];
  return data.features.map(fromGeoapify).filter(Boolean);
}

function normalizeNominatimResponse(data) {
  if (!Array.isArray(data)) return [];
  return data.map(fromNominatim).filter(Boolean);
}

function normalizePhotonResponse(data) {
  if (!data || !Array.isArray(data.features)) return [];
  return data.features.map(fromPhoton).filter(Boolean);
}

module.exports = {
  fromGeoapify,
  fromNominatim,
  fromPhoton,
  normalizeGeoapifyResponse,
  normalizeNominatimResponse,
  normalizePhotonResponse,
};
