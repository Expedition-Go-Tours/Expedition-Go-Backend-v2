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

/**
 * SerpApi Google Maps place → the same shape every other provider produces.
 *
 * Google Maps results carry a NAME (`title`) and an ADDRESS separately: for
 * "Ghana Girl Guides Training Center" the address is just "Accra, Ghana". The
 * display string must be the two together — using the address alone made the
 * picker save "Accra, Ghana" for a named landmark, losing the only part the
 * supplier actually typed. `place_id` is kept in `externalId` so a result can
 * be re-resolved.
 *
 * Structured fields the other providers give (city/region) are left EMPTY
 * rather than guessed out of the address string: a fabricated `city` would
 * flow into the saved pickup address and look real forever.
 */
function fromSerpMaps(place) {
  if (!place || typeof place !== 'object') return null;
  const coords = place.gps_coordinates || {};
  const latitude = Number.isFinite(Number(coords.latitude)) ? Number(coords.latitude) : null;
  const longitude = Number.isFinite(Number(coords.longitude)) ? Number(coords.longitude) : null;
  const title = String(place.title || '').trim();
  const address = String(place.address || '').trim();
  if ((!title && !address) || latitude === null || longitude === null) return null;

  // "Name, Address" — unless the address already names the place, or one of
  // the two is missing.
  const addressNamesPlace = title.length > 0 && address.toLowerCase().includes(title.toLowerCase());
  const formatted = addressNamesPlace
    ? address
    : [title, address].filter(Boolean).join(', ');

  return {
    formatted,
    latitude,
    longitude,
    city: '',
    country: String(place.country || '').trim(),
    countryCode: '',
    region: '',
    postcode: null,
    street: '',
    housenumber: null,
    category: null,
    source: 'google_maps',
    confidence: null,
    externalId: place.place_id ? String(place.place_id) : null,
    name: title || formatted,
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

/**
 * SerpApi already returns the place list pre-filtered to Ghana by the
 * provider, so this is a straight map — no response envelope to unwrap.
 */
function normalizeSerpMapsResponse(places) {
  if (!Array.isArray(places)) return [];
  return places.map(fromSerpMaps).filter(Boolean);
}

module.exports = {
  fromGeoapify,
  fromNominatim,
  fromPhoton,
  fromSerpMaps,
  normalizeGeoapifyResponse,
  normalizeNominatimResponse,
  normalizePhotonResponse,
  normalizeSerpMapsResponse,
};
