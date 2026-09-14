/**
 * Region-fallback tests (DB-gated).
 *
 * A place with no tours widens to its region, resolved via the curated
 * Attraction table (town/name/aliases) or the geocoder. Verified against the
 * seeded catalog: "Sekondi-Takoradi" has no tours but "Western Region" does;
 * "Aburi" has tours (no fallback); "Tamale" resolves to a region with none.
 */

const { normalizeRegion, regionForQuery } = require('../../utils/placeResolver');
const { placeTourIds } = require('../../utils/placeListing');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

describeDb('regionForQuery (Attraction -> region)', () => {
  it('resolves a town to its region', async () => {
    expect(normalizeRegion(await regionForQuery('Aburi'))).toBe('Eastern Region');
  });

  it('resolves an attraction by exact name', async () => {
    const r = await regionForQuery('Aburi Botanical Gardens');
    expect(r).toBeTruthy();
    expect(normalizeRegion(r)).toBe('Eastern Region');
  });

  it('returns null for a non-place query', async () => {
    expect(await regionForQuery('zzzz not a place zzzz')).toBeNull();
  });
});

describeDb('placeTourIds region fallback', () => {
  it('widens to the region when the place has no tours', async () => {
    const { ids, regionFallback } = await placeTourIds('Sekondi-Takoradi', { expeditionOnly: true });
    expect(ids.size).toBe(0);
    expect(regionFallback).not.toBeNull();
    expect(regionFallback.region).toBe('Western Region');
    expect(regionFallback.ids.size).toBeGreaterThan(0);
  });

  it('does NOT widen when the place already has tours', async () => {
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
