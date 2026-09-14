const { normalizeRegion, regionForQuery } = require('../../utils/placeResolver');
const { placeTourIds } = require('../../utils/placeListing');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

describeDb('regionForQuery (Attraction -> region)', () => {
  // Skip tests that rely on geocoding if the provider is not configured.
  const geoAvailable = !!process.env.GEOAPIFY_API_KEY;
  const itIfGeo = geoAvailable ? it : it.skip;

  itIfGeo('resolves a town to its region', async () => {
    expect(normalizeRegion(await regionForQuery('Aburi'))).toBe('Eastern Region');
  });

  itIfGeo('resolves an attraction by exact name', async () => {
    const r = await regionForQuery('Aburi Botanical Gardens');
    expect(r).toBeTruthy();
    expect(normalizeRegion(r)).toBe('Eastern Region');
  });

  it('returns null for a non-place query', async () => {
    expect(await regionForQuery('zzzz not a place zzzz')).toBeNull();
  });
});

describeDb('placeTourIds region fallback', () => {
  // Widen fallback tests also need geocoding to resolve regions.
  const geoAvailable = !!process.env.GEOAPIFY_API_KEY;
  const itIfGeo = geoAvailable ? it : it.skip;

  itIfGeo('widens to the region when the place has no tours', async () => {
    const { ids, regionFallback } = await placeTourIds('Sekondi-Takoradi', { expeditionOnly: true });
    expect(ids.size).toBe(0);
    expect(regionFallback).not.toBeNull();
    expect(regionFallback.region).toBe('Western Region');
    expect(regionFallback.ids.size).toBeGreaterThan(0);
  });

  itIfGeo('does NOT widen when the place already has tours', async () => {
    const { ids, regionFallback } = await placeTourIds('Aburi', { expeditionOnly: true });
    expect(ids.size).toBeGreaterThan(0);
    expect(regionFallback).toBeNull();
  });

  it('stays empty when the region has no tours either', async () => {
    const { regionFallback } = await placeTourIds('Tamale', { expeditionOnly: true });
    // Northern Region has no published tours → nothing to widen to.
    expect(regionFallback).toBeNull();
  });
});
