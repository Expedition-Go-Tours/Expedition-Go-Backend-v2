/**
 * Unit tests for the pure placeResolver helpers (no DB / geocoder).
 * Covers input normalisation, display-name composition and band ranking —
 * the parts that most often break silently.
 */

const {
  displayName,
  popularityScore,
  rankByPlace,
} = require('../../utils/placeResolver');
const { normalizeQuery } = require('../../utils/placeResolver');

describe('normalizeQuery', () => {
  it('trims, collapses whitespace and strips surrounding punctuation', () => {
    expect(normalizeQuery('  Accra  ')).toBe('Accra');
    expect(normalizeQuery('james   town')).toBe('james town');
    expect(normalizeQuery('"Accra!"')).toBe('Accra');
    expect(normalizeQuery('...Kakum National Park.')).toBe('Kakum National Park');
  });

  it('caps very long input', () => {
    const long = 'a'.repeat(500);
    expect(normalizeQuery(long).length).toBeLessThanOrEqual(120);
  });

  it('returns empty for non-string / empty', () => {
    expect(normalizeQuery('')).toBe('');
    expect(normalizeQuery(null)).toBe('');
    expect(normalizeQuery(undefined)).toBe('');
  });
});

describe('displayName', () => {
  it('cities and regions stand alone', () => {
    expect(displayName({ name: 'Accra', type: 'city', city: 'Accra', region: null })).toBe('Accra');
    expect(displayName({ name: 'Central Region', type: 'region', city: null, region: 'Central Region' })).toBe('Central Region');
  });

  it('localities get their nearest qualifier for disambiguation', () => {
    expect(displayName({ name: 'James Town', type: 'locality', city: 'Accra', region: 'Greater Accra Region' }))
      .toBe('James Town, Accra');
  });

  it('does not repeat a qualifier already present in the name', () => {
    expect(displayName({ name: 'Kakum National Park', type: 'attraction', city: null, region: 'Central Region' }))
      .toBe('Kakum National Park, Central Region');
    expect(displayName({ name: 'Accra Mall', type: 'locality', city: 'Accra', region: null }))
      .toBe('Accra Mall');
  });

  it('handles missing qualifier', () => {
    expect(displayName({ name: 'Nowhere', type: 'locality', city: null, region: null })).toBe('Nowhere');
  });
});

describe('rankByPlace relevance bands', () => {
  const tours = [
    { id: 'title', title: 'Makola Market Walking Tour', city: null, region: null, attractions: [], tags: [], description: '', averageRating: 3, reviewCount: 1, totalBookings: 0 },
    { id: 'attr', title: 'Accra City Tour', city: null, region: null, attractions: ['Makola Market'], tags: [], description: '', averageRating: 5, reviewCount: 100, totalBookings: 50 },
    { id: 'city', title: 'Some Tour', city: 'Accra', region: 'Greater Accra Region', attractions: [], tags: [], description: '', averageRating: 5, reviewCount: 1000, totalBookings: 500 },
    { id: 'desc', title: 'Unrelated', city: null, region: null, attractions: [], tags: [], description: 'We stop at Makola Market for shopping', averageRating: 5, reviewCount: 10, totalBookings: 1 },
    { id: 'none', title: 'Cape Coast Castle', city: 'Cape Coast', region: 'Central Region', attractions: [], tags: [], description: '', averageRating: 5, reviewCount: 999, totalBookings: 999 },
  ];

  it('orders by relevance tier, then popularity; drops non-matches', () => {
    const ranked = rankByPlace(tours, { place: 'Makola Market' });
    expect(ranked.map((t) => t.id)).toEqual(['title', 'attr', 'desc']);
    expect(ranked.find((t) => t.id === 'none')).toBeUndefined();
  });

  it('city/region equality is a mid tier', () => {
    const ranked = rankByPlace(
      [{ id: 'a', title: 'X', city: 'Accra', region: null, attractions: [], tags: [], description: '', averageRating: 5, reviewCount: 10, totalBookings: 5 }],
      { place: 'Accra' },
    );
    expect(ranked[0]._band).toBe(3);
  });

  it('popularity decides inside a tier', () => {
    const a = { id: 'a', title: 'Kakum Tour A', city: null, region: null, attractions: [], tags: [], description: '', averageRating: 4, reviewCount: 10, totalBookings: 5 };
    const b = { id: 'b', title: 'Kakum Tour B', city: null, region: null, attractions: [], tags: [], description: '', averageRating: 5, reviewCount: 200, totalBookings: 90 };
    const ranked = rankByPlace([a, b], { place: 'Kakum' });
    expect(ranked.map((t) => t.id)).toEqual(['b', 'a']);
    expect(popularityScore(b)).toBeGreaterThan(popularityScore(a));
  });

  it('does not crash on missing fields', () => {
    const ranked = rankByPlace([{ id: 'x', title: 'Kakum' }], { place: 'Kakum' });
    expect(ranked.length).toBe(1);
    expect(ranked[0]._band).toBe(1);
  });
});
