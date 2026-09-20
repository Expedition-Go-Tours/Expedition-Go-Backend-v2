const {
  majorCityForTour,
  destinationCityFor,
  destinationCityFromPatch,
  listMajorCities,
  normalizePlace,
} = require('../../src/core/services/destinationCities');
const {
  capitalForRegion,
  canonicalGhanaRegion,
  regionForCapital,
} = require('../../src/core/services/ghanaRegions');

/** Minimal index mirroring buildMajorCityIndex() output. */
function makeIndex() {
  const cities = [
    { name: 'Accra', region: 'Greater Accra', lat: 5.6, lng: -0.19 },
    { name: 'Kumasi', region: 'Ashanti', lat: 6.69, lng: -1.62 },
    { name: 'Cape Coast', region: 'Central', lat: 5.11, lng: -1.24 },
    { name: 'Koforidua', region: 'Eastern', lat: 6.09, lng: -0.26 },
    { name: 'Sekondi-Takoradi', region: 'Western', lat: 4.93, lng: -1.76 },
    { name: 'Damongo', region: 'Savannah', lat: 9.08, lng: -1.82 },
  ];
  const localityToRegion = new Map([
    ['aburi', 'Eastern'],
    ['boti', 'Eastern'],
    ['adukrom', 'Eastern'],
    ['bonwire', 'Ashanti'],
    ['nyankumasi ahenkro', 'Ashanti'],
    ['nzulezo', 'Western'],
    ['mole village', 'Savannah'],
    ['ada foah', 'Greater Accra'],
    ['hwakpo', 'Greater Accra'],
    ['dedenya', 'Greater Accra'],
  ]);
  return {
    cities,
    cityByKey: new Map(cities.map((c) => [normalizePlace(c.name), c])),
    localityToRegion,
  };
}

describe('ghanaRegions', () => {
  it('normalises region spellings', () => {
    expect(canonicalGhanaRegion('Eastern')).toBe('Eastern');
    expect(canonicalGhanaRegion('eastern region')).toBe('Eastern');
    expect(canonicalGhanaRegion('  Greater Accra Region ')).toBe('Greater Accra');
    expect(canonicalGhanaRegion('Narnia')).toBeNull();
    expect(canonicalGhanaRegion(null)).toBeNull();
  });

  it('maps region to capital', () => {
    expect(capitalForRegion('Greater Accra Region')).toBe('Accra');
    expect(capitalForRegion('Savannah')).toBe('Damongo');
    expect(capitalForRegion('Western')).toBe('Sekondi-Takoradi');
    expect(capitalForRegion('Unknown')).toBeNull();
  });

  it('maps capital to region', () => {
    expect(regionForCapital('Koforidua')).toBe('Eastern');
    expect(regionForCapital('nowhere')).toBeNull();
  });
});

describe('majorCityForTour', () => {
  const index = makeIndex();

  it('uses Tour.region first', () => {
    expect(majorCityForTour({ region: 'Greater Accra Region', city: 'Dedenya' }, index)).toBe('Accra');
  });

  it('rolls a locality city up to its region capital', () => {
    expect(majorCityForTour({ region: null, city: 'Aburi' }, index)).toBe('Koforidua');
    expect(majorCityForTour({ region: null, city: 'Boti' }, index)).toBe('Koforidua');
    expect(majorCityForTour({ region: null, city: 'Adukrom' }, index)).toBe('Koforidua');
    expect(majorCityForTour({ region: null, city: 'Nzulezo' }, index)).toBe('Sekondi-Takoradi');
    expect(majorCityForTour({ region: null, city: 'Mole Village' }, index)).toBe('Damongo');
    expect(majorCityForTour({ region: null, city: 'Bonwire' }, index)).toBe('Kumasi');
    expect(majorCityForTour({ region: null, city: 'Ada Foah' }, index)).toBe('Accra');
  });

  it('matches a capital city name directly', () => {
    expect(majorCityForTour({ region: null, city: 'Kumasi' }, index)).toBe('Kumasi');
  });

  it('falls back to itinerary regions', () => {
    expect(
      majorCityForTour({ region: null, city: null, itineraryRegions: ['Central Region'] }, index)
    ).toBe('Cape Coast');
  });

  it('falls back to the nearest capital by coordinates', () => {
    expect(
      majorCityForTour({ region: null, city: null, latitude: 5.55, longitude: -0.17 }, index)
    ).toBe('Accra');
  });

  it('rejects coordinates far from every capital', () => {
    expect(
      majorCityForTour({ region: null, city: null, latitude: -30, longitude: 100 }, index)
    ).toBeNull();
  });

  it('scans the title as a last resort', () => {
    expect(
      majorCityForTour({ region: null, city: null, title: 'Accra Night Live Experience' }, index)
    ).toBe('Accra');
  });

  it('leaves non-Ghana tours unmapped so the caller keeps their city', () => {
    expect(
      majorCityForTour({ country: 'Kenya', region: 'Nairobi', city: 'Nairobi' }, index)
    ).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(majorCityForTour({ region: null, city: null, title: 'Mystery Tour' }, index)).toBeNull();
    expect(majorCityForTour(null, index)).toBeNull();
  });
});

describe('destinationCityFor', () => {
  const index = makeIndex();

  it('maps a Ghana tour to its curated capital', () => {
    expect(destinationCityFor({ country: 'Ghana', region: 'Eastern Region', city: 'Aburi' }, index)).toBe('Koforidua');
  });

  it("keeps a non-Ghana tour's own city", () => {
    expect(destinationCityFor({ country: 'Kenya', city: 'Nairobi' }, index)).toBe('Nairobi');
  });

  it('returns null for an unmappable Ghana tour', () => {
    expect(destinationCityFor({ country: 'Ghana', city: null, title: 'Mystery' }, index)).toBeNull();
  });
});

describe('destinationCityFromPatch', () => {
  const index = makeIndex();

  it('uses the patch when it carries location', async () => {
    expect(await destinationCityFromPatch({ city: 'Aburi', country: 'Ghana' }, null, index)).toBe('Koforidua');
  });

  it('falls back to the existing row when the patch omits location', async () => {
    const existing = { city: 'Aburi', country: 'Ghana', region: null };
    expect(await destinationCityFromPatch({ title: 'Renamed' }, existing, index)).toBe('Koforidua');
  });

  it('prefers the patch over the existing row', async () => {
    const existing = { city: 'Aburi', country: 'Ghana' };
    expect(await destinationCityFromPatch({ city: 'Nzulezo' }, existing, index)).toBe('Sekondi-Takoradi');
  });
});

describe('listMajorCities', () => {
  it('returns the curated cities sorted by name', async () => {
    const cities = await listMajorCities(makeIndex());
    expect(cities.map((c) => c.name)).toEqual([
      'Accra', 'Cape Coast', 'Damongo', 'Koforidua', 'Kumasi', 'Sekondi-Takoradi',
    ]);
    expect(cities.find((c) => c.name === 'Accra').region).toBe('Greater Accra');
  });
});
