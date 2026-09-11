/**
 * Unit tests for the pure placeResolver helpers (no DB / geocoder).
 * Covers input normalisation, display-name composition and band ranking —
 * the parts that most often break silently.
 */

const {
  displayName,
  popularityScore,
  rankByPlace,
  NEARBY_RADIUS_KM,
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

describe('rankByPlace bands', () => {
  const tours = [
    { id: 'in', latitude: 5.5, longitude: -0.2, averageRating: 3, reviewCount: 1, totalBookings: 0 },
    { id: 'near', latitude: 5.6, longitude: -0.25, averageRating: 5, reviewCount: 100, totalBookings: 50 },
    { id: 'far', latitude: 9.0, longitude: -1.0, averageRating: 5, reviewCount: 1000, totalBookings: 500 },
  ];

  it('keeps in-place before near before far, regardless of popularity', () => {
    const ranked = rankByPlace(tours, {
      lat: 5.5, lng: -0.2,
      localIds: new Set(['in']),
      radiusKm: NEARBY_RADIUS_KM,
    });
    expect(ranked.map((t) => t.id)).toEqual(['in', 'near', 'far']);
    expect(ranked[0].distanceKm).toBe(0);
    expect(ranked[1].distanceKm).toBeLessThanOrEqual(NEARBY_RADIUS_KM);
  });

  it('orders by popularity inside a band', () => {
    const a = { id: 'a', latitude: 5.5, longitude: -0.2, averageRating: 4, reviewCount: 10, totalBookings: 5 };
    const b = { id: 'b', latitude: 5.5, longitude: -0.2, averageRating: 5, reviewCount: 200, totalBookings: 90 };
    const ranked = rankByPlace([a, b], { lat: 5.5, lng: -0.2, localIds: new Set(['a', 'b']) });
    expect(ranked.map((t) => t.id)).toEqual(['b', 'a']);
    expect(popularityScore(b)).toBeGreaterThan(popularityScore(a));
  });

  it('does not crash on missing coordinates', () => {
    const ranked = rankByPlace([{ id: 'x', latitude: null, longitude: null, averageRating: null, reviewCount: null, totalBookings: null }], {
      lat: 5.5, lng: -0.2, localIds: new Set(),
    });
    expect(ranked[0].distanceKm).toBeNull();
    expect(ranked[0]._band).toBe(3);
  });
});
