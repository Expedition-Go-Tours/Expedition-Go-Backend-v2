/**
 * The Google Maps (SerpApi) fallback for location search.
 *
 * The pattern this copies came from the TravioGhana storefront: when a place
 * is not in any of the free providers, the UI offers one explicit "Search
 * Google Maps" action instead of leaving the supplier stuck. Three properties
 * matter more than the HTTP call itself:
 *
 *  1. THE KEY NEVER LEAVES THE SERVER and never appears in a response —
 *     SerpApi has no CORS support and the secret must stay secret.
 *  2. `not_configured` is not `no results`. A server without the key says so,
 *     and the UI hides the option instead of reporting an empty search.
 *  3. GHANA ONLY. A "Central Park, New York" row in a Ghana pickup list is
 *     worse than no row at all.
 */
jest.mock('axios');
const axios = require('axios');

// The free providers are what the reverse geocoder walks; mocked here so the
// enrichment tests can say what the world looks like at a given pin without a
// network. `serpApiProvider` keeps using the mocked axios.
jest.mock('../../providers/geoapifyProvider', () => ({
  search: jest.fn(),
  autocomplete: jest.fn(),
  reverse: jest.fn(),
  nearby: jest.fn(),
}));
jest.mock('../../providers/nominatimProvider', () => ({
  search: jest.fn(),
  reverse: jest.fn(),
}));
jest.mock('../../providers/photonProvider', () => ({
  search: jest.fn(),
  reverse: jest.fn(),
}));

const geoapify = require('../../providers/geoapifyProvider');
const nominatim = require('../../providers/nominatimProvider');
const photon = require('../../providers/photonProvider');

const serpApi = require('../../providers/serpApiProvider');
const normalizer = require('../../src/core/services/locationNormalizer');
const locationService = require('../../src/core/services/locationService');

function gaPlace(over = {}) {
  return {
    title: 'Coconut Grove Beach Resort',
    address: 'Coconut Grove Beach Resort, Elmina, Ghana',
    country: 'Ghana',
    gps_coordinates: { latitude: 5.0833, longitude: -1.35 },
    place_id: 'ChIJ123',
    ...over,
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  // Both caches live across tests within a file (the Google search cache and
  // the reverse-geocoder cache). A shared query or pin would be answered from
  // the previous test's world and derail the mock queues below.
  const cacheHelper = require('../../src/core/services/cacheHelper');
  await cacheHelper.invalidateKeys(['geo:v3:*']);
  // The reverse chain must not answer by accident: every test says what the
  // world looks like at its own pin.
  geoapify.reverse.mockRejectedValue(new Error('404'));
  nominatim.reverse.mockResolvedValue(null);
  photon.reverse.mockResolvedValue(null);
  delete process.env.SERPAPI_API_KEY;
  delete process.env.VITE_SERP_API_KEY;
});

afterEach(() => {
  delete process.env.SERPAPI_API_KEY;
  delete process.env.VITE_SERP_API_KEY;
});

describe('the key stays server-side', () => {
  it('reports not_configured — without any network call — when no key is set', async () => {
    const outcome = await serpApi.search('Elmina Castle');

    expect(outcome).toEqual({ ok: false, reason: 'not_configured' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('accepts the legacy VITE_SERP_API_KEY alias the storefront uses', () => {
    process.env.VITE_SERP_API_KEY = 'legacy-key';
    expect(serpApi.isConfigured()).toBe(true);
  });

  it('never returns the key in any payload', async () => {
    process.env.SERPAPI_API_KEY = 'super-secret-key';
    axios.get.mockResolvedValue({
      data: { local_results: [gaPlace()] },
    });

    const outcome = await serpApi.search('Elmina Castle');

    expect(JSON.stringify(outcome)).not.toContain('super-secret-key');
  });
});

describe('reading both Google Maps response shapes', () => {
  it('reads a list query (local_results[])', () => {
    const places = serpApi.extractPlaces({
      local_results: [gaPlace(), gaPlace({ title: 'Another spot', place_id: 'ChIJ456' })],
    });

    expect(places.map((p) => p.place_id)).toEqual(['ChIJ123', 'ChIJ456']);
  });

  it('reads a single-place query (place_results) — the shape a business name returns', () => {
    const places = serpApi.extractPlaces({
      place_results: gaPlace({ title: 'Elmina Castle' }),
    });

    expect(places).toHaveLength(1);
    expect(places[0].title).toBe('Elmina Castle');
  });

  it('caps the result list', () => {
    const many = Array.from({ length: 12 }, (_, i) => gaPlace({ place_id: `p${i}` }));
    expect(serpApi.extractPlaces({ local_results: many })).toHaveLength(serpApi.MAX_RESULTS);
  });
});

describe('Ghana only', () => {
  it('drops results explicitly outside Ghana and keeps the unlabelled ones', () => {
    const places = serpApi.extractPlaces({
      local_results: [
        gaPlace({ title: 'Elmina Castle', country: 'Ghana' }),
        gaPlace({ title: 'Central Park', country: 'United States', place_id: 'us1' }),
        gaPlace({ title: 'A junction with no country', country: '', place_id: 'x1' }),
      ],
    });

    expect(places.map((p) => p.title)).toEqual(['Elmina Castle', 'A junction with no country']);
  });

  it('is case-insensitive about the country label', () => {
    expect(serpApi.isGhanaResult({ country: 'ghana' })).toBe(true);
    expect(serpApi.isGhanaResult({ country: 'GHANA' })).toBe(true);
    expect(serpApi.isGhanaResult({ country: 'Togo' })).toBe(false);
  });
});

describe('failure reasons reach the UI as themselves', () => {
  beforeEach(() => {
    process.env.SERPAPI_API_KEY = 'key';
  });

  it('maps an exhausted quota to `quota`, not to "no matches"', async () => {
    axios.get.mockRejectedValue({ response: { status: 429 } });

    expect(await serpApi.search('Elmina Castle')).toEqual({ ok: false, reason: 'quota' });
  });

  it('maps a rejected key to `quota` too (the option stops offering itself)', async () => {
    axios.get.mockRejectedValue({ response: { status: 401 } });

    expect(await serpApi.search('Elmina Castle')).toEqual({ ok: false, reason: 'quota' });
  });

  it('maps a body-level API error to `upstream`', async () => {
    axios.get.mockResolvedValue({
      data: { search_metadata: { status: 'Error' }, error: 'Invalid request' },
    });

    expect(await serpApi.search('Elmina Castle')).toEqual({ ok: false, reason: 'upstream' });
  });

  it('maps a network failure to `upstream`', async () => {
    axios.get.mockRejectedValue(new Error('ECONNRESET'));

    expect(await serpApi.search('Elmina Castle')).toEqual({ ok: false, reason: 'upstream' });
  });

  it('refuses a query too short to be worth a credit', async () => {
    expect(await serpApi.search('El')).toEqual({ ok: false, reason: 'upstream' });
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('the shape the rest of the app consumes', () => {
  it('keeps a Google Maps place NAME with its address — never the address alone', () => {
    // The real case: a named landmark whose Google Maps address is just the
    // city. Using `address` as the label made the picker save "Accra, Ghana"
    // for "Ghana Girl Guides Training Center", losing the only words the
    // supplier actually typed.
    const [place] = normalizer.normalizeSerpMapsResponse([{
      title: 'Ghana Girl Guides Training Center',
      address: 'Accra, Ghana',
      country: 'Ghana',
      gps_coordinates: { latitude: 5.62148, longitude: -0.21691 },
      place_id: 'ChIJgguid',
    }]);

    expect(place.formatted).toBe('Ghana Girl Guides Training Center, Accra, Ghana');
    expect(place.name).toBe('Ghana Girl Guides Training Center');
    expect(place.latitude).toBe(5.62148);
  });

  it('does not double the name when the address already names the place', () => {
    const [place] = normalizer.normalizeSerpMapsResponse([{
      title: 'Coconut Grove Beach Resort',
      address: 'Coconut Grove Beach Resort, Elmina, Ghana',
      country: 'Ghana',
      gps_coordinates: { latitude: 5.0833, longitude: -1.35 },
    }]);

    expect(place.formatted).toBe('Coconut Grove Beach Resort, Elmina, Ghana');
  });

  it('falls back cleanly when only one of name/address exists', () => {
    const [nameOnly] = normalizer.normalizeSerpMapsResponse([{
      title: 'Elmina Castle',
      country: 'Ghana',
      gps_coordinates: { latitude: 5.08, longitude: -1.35 },
    }]);
    const [addressOnly] = normalizer.normalizeSerpMapsResponse([{
      address: 'W1 Lagoon St, Elmina, Ghana',
      country: 'Ghana',
      gps_coordinates: { latitude: 5.08, longitude: -1.35 },
    }]);

    expect(nameOnly.formatted).toBe('Elmina Castle');
    expect(addressOnly.formatted).toBe('W1 Lagoon St, Elmina, Ghana');
  });

  it('normalizes a Google Maps place to the same contract as every other provider', () => {
    const [place] = normalizer.normalizeSerpMapsResponse([gaPlace()]);

    // Exactly the fields LocationAutocomplete / EditPickupModal read.
    expect(place).toMatchObject({
      formatted: 'Coconut Grove Beach Resort, Elmina, Ghana',
      latitude: 5.0833,
      longitude: -1.35,
      source: 'google_maps',
    });
    // Structured fields SerpApi does not provide stay EMPTY, never guessed:
    // a fabricated city would flow into the saved pickup address forever.
    expect(place.city).toBe('');
    expect(place.region).toBe('');
  });

  it('drops a place with no usable coordinates instead of saving a broken pin', () => {
    const places = normalizer.normalizeSerpMapsResponse([
      gaPlace({ gps_coordinates: {} }),
      gaPlace({ title: 'Good place', place_id: 'ok1' }),
    ]);

    expect(places).toHaveLength(1);
    expect(places[0].name).toBe('Good place');
  });

  it('service: reports the outcome contract and does not cache failures', async () => {
    process.env.SERPAPI_API_KEY = 'key';
    axios.get.mockResolvedValueOnce({
      data: { local_results: [gaPlace()] },
    });

    const first = await locationService.googleSearch('Cape Coast Castle');
    expect(first.ok).toBe(true);
    expect(first.results[0]).toMatchObject({ source: 'google_maps' });

    // A failed retry must surface its own reason, not a cached success and not
    // an empty list.
    axios.get.mockRejectedValueOnce({ response: { status: 429 } });
    const cached = await locationService.googleSearch('Cape Coast Castle');
    expect(cached.ok).toBe(true); // served from cache — no second credit

    const different = await locationService.googleSearch('Kakum National Park');
    expect(different).toEqual({ ok: false, reason: 'quota' });
  });

  it('service: passes the caller’s search-area bias through', async () => {
    process.env.SERPAPI_API_KEY = 'key';
    axios.get.mockResolvedValue({ data: { local_results: [gaPlace()] } });

    await locationService.googleSearch('Beach resort', { lat: 5.1, lng: -1.35 });

    const params = axios.get.mock.calls[0][1].params;
    expect(params.get('ll')).toBe('@5.1,-1.35,12z');
    expect(params.get('engine')).toBe('google_maps');
    expect(params.get('api_key')).toBe('key');
  });
});

describe('the label carries its locality (reverse geocoding)', () => {
  // Google Maps search says "Accra, Ghana" for a place that sits on Achimota
  // Forest Road — and a supplier setting a pickup point cannot tell WHICH
  // Accra that is. The free reverse geocoder knows; it is what the map-click
  // path already uses.
  // One pin per test: the reverse geocoder caches per coordinates, so reusing
  // a pin would have one test's world answered to the next.
  const PINS = {
    achimota: { latitude: 5.6214816, longitude: -0.2169066 },
    elmina: { latitude: 5.0833, longitude: -1.35 },
    remote: { latitude: 7.1, longitude: -2.2 },
  };

  beforeEach(() => {
    process.env.SERPAPI_API_KEY = 'key';
  });

  it('rebuilds the label as Name, Street, City, Country', async () => {
    axios.get.mockResolvedValue({
      data: {
        local_results: [{
          title: 'Ghana Girl Guides Training Center',
          address: 'Accra, Ghana',
          country: 'Ghana',
          gps_coordinates: PINS.achimota,
          place_id: 'ChIJgguid',
        }],
      },
    });
    geoapify.reverse.mockResolvedValue({
      type: 'FeatureCollection',
      features: [{
        properties: {
          formatted: 'Achimota Police Station, Achimota Forest Road, Accra, Ghana',
          address_line1: 'Achimota Forest Road',
          city: 'Accra',
          state: 'Greater Accra Region',
          country: 'Ghana',
          country_code: 'gh',
        },
        geometry: { coordinates: [PINS.achimota.longitude, PINS.achimota.latitude] },
      }],
    });

    const out = await locationService.googleSearch('Ghana Girl Guides Training Center');

    // The locality the supplier is asking about is now in the label.
    expect(out.results[0].formatted).toBe(
      'Ghana Girl Guides Training Center, Achimota Forest Road, Accra, Ghana',
    );
    // Structured fields come from the reverse geocoder too.
    expect(out.results[0].street).toBe('Achimota Forest Road');
    expect(out.results[0].city).toBe('Accra');
    expect(out.results[0].name).toBe('Ghana Girl Guides Training Center');
  });

  it('never repeats a part the label already carries', async () => {
    axios.get.mockResolvedValue({
      data: {
        local_results: [{
          title: 'Coconut Grove Beach Resort',
          address: 'Elmina, Ghana',
          country: 'Ghana',
          gps_coordinates: PINS.elmina,
          place_id: 'ChIJelmina',
        }],
      },
    });
    geoapify.reverse.mockResolvedValue({
      type: 'FeatureCollection',
      features: [{
        properties: {
          formatted: 'Elmina, Ghana',
          address_line1: '',
          city: 'Elmina',
          country: 'Ghana',
          country_code: 'gh',
        },
        geometry: { coordinates: [PINS.elmina.longitude, PINS.elmina.latitude] },
      }],
    });

    const out = await locationService.googleSearch('Coconut Grove Beach Resort');

    expect(out.results[0].formatted).toBe('Coconut Grove Beach Resort, Elmina, Ghana');
  });

  it('keeps the Google label when the reverse geocoder has nothing', async () => {
    axios.get.mockResolvedValue({
      data: {
        local_results: [{
          title: 'Somewhere Remote',
          address: 'Accra, Ghana',
          country: 'Ghana',
          gps_coordinates: PINS.remote,
          place_id: 'ChIJremote',
        }],
      },
    });

    const out = await locationService.googleSearch('Somewhere Remote');

    // A slightly vague label beats losing the place entirely.
    expect(out.results[0].formatted).toBe('Somewhere Remote, Accra, Ghana');
    expect(out.results[0].street).toBe('');
  });
});
