/**
 * productToTour itinerary derivation.
 *
 * `attractions` (stop names) is the pre-existing derived column; the new
 * `itineraryCities` / `itineraryRegions` capture EVERY stop's city/region (not
 * just the first, which is what `city`/`region` hold) so a search for a town or
 * region can surface a tour that merely visits it.
 */

const { productToTour } = require('../../src/core/services/productToTour');

describe('productToTour itinerary derivation', () => {
  const flat = {
    title: 'Test Tour',
    fullDescription: 'A test tour description that is comfortably long enough.',
    keywords: [],
    locations: [
      { name: 'Cape Coast Castle', city: 'Cape Coast', region: 'Central Region' },
      { name: 'Elmina Castle', city: 'Elmina', region: 'Central Region' },
      { name: 'Wli Falls', city: 'Wli Afegame', region: 'Volta Region' },
    ],
  };

  it('derives attractions from all stop names', () => {
    const t = productToTour(flat);
    expect(t.attractions).toEqual(expect.arrayContaining(['Cape Coast Castle', 'Elmina Castle', 'Wli Falls']));
  });

  it('derives itineraryCities from all stops', () => {
    const t = productToTour(flat);
    expect(t.itineraryCities).toEqual(expect.arrayContaining(['Cape Coast', 'Elmina', 'Wli Afegame']));
  });

  it('derives itineraryRegions from all stops, deduped', () => {
    const t = productToTour(flat);
    expect([...t.itineraryRegions].sort()).toEqual(['Central Region', 'Volta Region']);
  });

  it('keeps the FIRST stop as the primary city/region', () => {
    const t = productToTour(flat);
    expect(t.city).toBe('Cape Coast');
    expect(t.region).toBe('Central Region');
  });

  it('handles missing locations without throwing', () => {
    const t = productToTour({ title: 'x', fullDescription: 'y', keywords: [] });
    expect(t.attractions).toEqual([]);
    expect(t.itineraryCities).toEqual([]);
    expect(t.itineraryRegions).toEqual([]);
  });
});
