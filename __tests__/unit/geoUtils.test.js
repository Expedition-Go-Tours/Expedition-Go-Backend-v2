/**
 * Unit tests for utils/geoUtils.js — pickup geoshape helpers.
 */
const {
  pointInPolygon,
  distanceMeters,
  findPickupAreaForAddress,
  resolvePickupSelection,
  isPickupBookable,
} = require('../../utils/geoUtils');

// A simple square around (lat 5.60, lng -0.20): [lat, lng] vertices.
const SQUARE = [
  [5.6, -0.25],
  [5.65, -0.25],
  [5.65, -0.15],
  [5.6, -0.15],
];

describe('pointInPolygon', () => {
  test('returns true for a point inside the polygon', () => {
    expect(pointInPolygon(5.625, -0.2, SQUARE)).toBe(true);
  });

  test('returns false for a point outside the polygon', () => {
    expect(pointInPolygon(5.7, -0.2, SQUARE)).toBe(false);
    expect(pointInPolygon(5.625, -0.3, SQUARE)).toBe(false);
  });

  test('treats vertices on the boundary as inside', () => {
    expect(pointInPolygon(5.6, -0.25, SQUARE)).toBe(true);
  });

  test('returns false for degenerate polygons', () => {
    expect(pointInPolygon(5.625, -0.2, [])).toBe(false);
    expect(pointInPolygon(5.625, -0.2, [[5.6, -0.25], [5.65, -0.25]])).toBe(false);
    expect(pointInPolygon(5.625, -0.2, null)).toBe(false);
  });
});

describe('distanceMeters', () => {
  test('returns ~0 for identical points', () => {
    expect(distanceMeters(5.6, -0.2, 5.6, -0.2)).toBeLessThan(1);
  });

  test('returns roughly 11 km for a 0.1 degree latitude step', () => {
    expect(distanceMeters(5.6, -0.2, 5.7, -0.2)).toBeGreaterThan(11000);
    expect(distanceMeters(5.6, -0.2, 5.7, -0.2)).toBeLessThan(11200);
  });
});

describe('findPickupAreaForAddress', () => {
  const AREAS = [
    { name: 'Osu', polygon: SQUARE, exclusions: [] },
    {
      name: 'Airport Residential',
      polygon: [
        [5.6, -0.3],
        [5.66, -0.3],
        [5.66, -0.22],
        [5.6, -0.22],
      ],
      exclusions: [
        [
          [5.62, -0.28],
          [5.64, -0.28],
          [5.64, -0.26],
          [5.62, -0.26],
        ],
      ],
    },
    { name: 'Legacy Area' },
  ];

  test('matches an address inside the shape', () => {
    const area = findPickupAreaForAddress({ lat: 5.625, lng: -0.2 }, AREAS);
    expect(area && area.name).toBe('Osu');
  });

  test('returns null for an address outside every shape', () => {
    expect(findPickupAreaForAddress({ lat: 5.8, lng: -0.2 }, AREAS)).toBeNull();
  });

  test('rejects addresses inside an exclusion zone', () => {
    const area = findPickupAreaForAddress({ lat: 5.63, lng: -0.27 }, AREAS);
    expect(area && area._excluded).toBe(true);
  });

  test('falls back to name matching for legacy areas without a polygon', () => {
    // Point is inside the "Osu" shape, so shape-first matching must win.
    const area = findPickupAreaForAddress({ name: 'Legacy Area', lat: 5.625, lng: -0.2 }, AREAS);
    expect(area && area.name).toBe('Osu');

    // Point outside every polygon with a legacy name falls back to name match.
    const legacy = findPickupAreaForAddress({ name: 'Legacy Area', lat: 6.2, lng: -0.4 }, AREAS);
    expect(legacy && legacy.name).toBe('Legacy Area');
  });

  test('returns null for invalid input', () => {
    expect(findPickupAreaForAddress(null, AREAS)).toBeNull();
    expect(findPickupAreaForAddress({ lat: 'x', lng: null }, AREAS)).toBeNull();
  });
});

describe('resolvePickupSelection', () => {
  const CONFIG = {
    pickupType: 'area',
    pickupAreas: [
      { name: 'Osu', time: '08:00', polygon: SQUARE, exclusions: [] },
      { name: 'Legacy Area' },
    ],
    pickupLocations: [
      { name: 'Marriott Hotel', lat: 5.62, lng: -0.16, pickupTime: '08:30' },
    ],
  };

  test('returns null pickup for an empty selection', () => {
    const result = resolvePickupSelection(undefined, CONFIG);
    expect(result.ok).toBe(true);
    expect(result.pickup).toBeNull();
  });

  test('accepts an address inside an area geoshape', () => {
    const result = resolvePickupSelection(
      { mode: 'area', address: { name: '123 Some St', lat: 5.625, lng: -0.2 } },
      CONFIG
    );
    expect(result.ok).toBe(true);
    expect(result.pickup).toMatchObject({ mode: 'area', areaName: 'Osu', time: '08:00' });
  });

  test('rejects an address outside every geoshape', () => {
    const result = resolvePickupSelection(
      { mode: 'area', address: { name: 'Far Away', lat: 6.2, lng: -0.4 } },
      CONFIG
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not available');
  });

  test('accepts legacy area by name when no coordinates are provided', () => {
    const result = resolvePickupSelection({ mode: 'area', areaName: 'Legacy Area' }, CONFIG);
    expect(result.ok).toBe(true);
    expect(result.pickup.areaName).toBe('Legacy Area');
  });

  test('matches a pickup location by name', () => {
    const result = resolvePickupSelection({ mode: 'address', locationName: 'Marriott Hotel' }, { pickupType: 'address', pickupLocations: CONFIG.pickupLocations });
    expect(result.ok).toBe(true);
    expect(result.pickup).toMatchObject({ mode: 'address', locationName: 'Marriott Hotel', time: '08:30' });
  });

  test('matches a pickup location by proximity', () => {
    const result = resolvePickupSelection(
      { mode: 'address', address: { name: 'Marriott Hotel', lat: 5.62001, lng: -0.16001 } },
      { pickupType: 'address', pickupLocations: CONFIG.pickupLocations }
    );
    expect(result.ok).toBe(true);
    expect(result.pickup.locationName).toBe('Marriott Hotel');
  });

  test('rejects an unknown pickup location', () => {
    const result = resolvePickupSelection(
      { mode: 'address', locationName: 'Nope Hotel' },
      { pickupType: 'address', pickupLocations: CONFIG.pickupLocations }
    );
    expect(result.ok).toBe(false);
  });

  test('errors when the tour has no pickup config at all', () => {
    const result = resolvePickupSelection({ mode: 'area', areaName: 'Osu' }, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not offer pickup');
  });

  test('skipValidation builds a snapshot without geofencing', () => {
    const result = resolvePickupSelection(
      { skipValidation: true, mode: 'area', areaName: 'Custom', instructions: 'Van' },
      CONFIG
    );
    expect(result.ok).toBe(true);
    expect(result.pickup.areaName).toBe('Custom');
  });
});

describe('isPickupBookable', () => {
  test('false when there is no pickup snapshot', () => {
    expect(isPickupBookable(null, {})).toBe(false);
  });

  test('true for a valid stored snapshot', () => {
    const pickup = { mode: 'area', areaName: 'Osu', address: { name: 'x', lat: 5.625, lng: -0.2 } };
    expect(isPickupBookable(pickup, { pickupType: 'area', pickupAreas: [{ name: 'Osu', polygon: SQUARE }] })).toBe(true);
  });
});