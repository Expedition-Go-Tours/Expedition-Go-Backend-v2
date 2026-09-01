/**
 * Unit tests for utils/geoUtils.js — pickup geoshape helpers.
 */
const {
  pointInPolygon,
  distanceMeters,
  findPickupAreaForAddress,
  resolvePickupSelection,
  isPickupBookable,
  pickupStatus,
  isPickupIncomplete,
  normalizePickupSnapshot,
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

  test('matches a location-only area by proximity to its saved point', () => {
    const pointAreas = [{ name: 'Kumasi', lat: 6.6871, lng: -1.6219, exclusions: [] }];
    const near = findPickupAreaForAddress({ name: 'Some Rd', lat: 6.6921, lng: -1.6219 }, pointAreas);
    expect(near && near.name).toBe('Kumasi');
  });

  test('rejects an address beyond the radius of a location-only area', () => {
    const pointAreas = [{ name: 'Kumasi', lat: 6.6871, lng: -1.6219 }];
    expect(findPickupAreaForAddress({ name: 'Some Rd', lat: 6.0, lng: -1.6219 }, pointAreas)).toBeNull();
  });

  test('exact name still matches a location-only area beyond the radius', () => {
    const pointAreas = [{ name: 'Kumasi', lat: 6.6871, lng: -1.6219 }];
    const match = findPickupAreaForAddress({ name: 'Kumasi', lat: 6.0, lng: -1.6219 }, pointAreas);
    expect(match && match.name).toBe('Kumasi');
  });

  test('location-only areas without coordinates keep the legacy name match', () => {
    const noCoords = [{ name: 'Legacy Area', exclusions: [] }];
    const match = findPickupAreaForAddress({ name: 'Legacy Area', lat: 6.0, lng: -1.6 }, noCoords);
    expect(match && match.name).toBe('Legacy Area');
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

  test('accepts a customer address near a location-only area by proximity', () => {
    const result = resolvePickupSelection(
      { mode: 'area', address: { name: 'Some Cbd Address', lat: 6.688, lng: -1.622 } },
      { pickupType: 'area', pickupAreas: [{ name: 'Kumasi', lat: 6.6871, lng: -1.6219, time: '07:30' }] }
    );
    expect(result.ok).toBe(true);
    expect(result.pickup).toMatchObject({ mode: 'area', areaName: 'Kumasi', time: '07:30' });
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

describe('pickupStatus', () => {
  test('deferred for empty / pickup-later / skipValidation snapshots', () => {
    expect(pickupStatus(null)).toBe('deferred');
    expect(pickupStatus({})).toBe('deferred');
    expect(pickupStatus({ pickupLater: true })).toBe('deferred');
    expect(pickupStatus({ skipValidation: true })).toBe('deferred');
  });

  test('selected when a location exists but no supplier-confirmed time', () => {
    expect(pickupStatus({ mode: 'area', areaName: 'Osu' })).toBe('selected');
    expect(pickupStatus({ mode: 'address', address: { name: 'x', address: 'y', lat: 5.6, lng: -0.2 } })).toBe('selected');
    expect(pickupStatus({ lat: 5.6, lng: -0.2 })).toBe('selected');
  });

  test('confirmed when supplier set a place or time', () => {
    expect(pickupStatus({ areaName: 'Osu', time: '09:00 AM' })).toBe('confirmed');
    expect(pickupStatus({ place: 'Marriott entrance', lat: 5.6, lng: -0.2 })).toBe('confirmed');
    expect(pickupStatus({ areaName: 'Osu', updatedBy: 'supplier-1' })).toBe('confirmed');
  });
});

describe('isPickupIncomplete', () => {
  test('true for empty / location-less snapshots', () => {
    expect(isPickupIncomplete(null)).toBe(true);
    expect(isPickupIncomplete({})).toBe(true);
    expect(isPickupIncomplete({ pickupLater: true })).toBe(true);
  });

  test('true when a location exists but time or instructions are missing', () => {
    expect(isPickupIncomplete({ areaName: 'Osu' })).toBe(true);
    expect(isPickupIncomplete({ areaName: 'Osu', time: '09:00 AM' })).toBe(true);
  });

  test('false when location + time + instructions are all present', () => {
    expect(isPickupIncomplete({ areaName: 'Osu', time: '09:00 AM', instructions: 'Blue van' })).toBe(false);
  });
});

describe('normalizePickupSnapshot', () => {
  const CONFIG = { pickupType: 'area', pickupAreas: [{ name: 'Osu', polygon: SQUARE }] };

  test('null when no selection is provided', () => {
    expect(normalizePickupSnapshot(null, CONFIG)).toBe(null);
  });

  test('defers gracefully when re-resolution fails (config changed)', () => {
    const snap = normalizePickupSnapshot({ mode: 'area', areaName: 'Gone' }, { pickupType: 'area', pickupAreas: [] });
    expect(snap.status).toBe('deferred');
    expect(snap.pickupLater).toBe(true);
  });

  test('normalizes a skipValidation selection to deferred', () => {
    const snap = normalizePickupSnapshot({ skipValidation: true }, CONFIG);
    expect(snap.status).toBe('deferred');
    expect(snap.pickupLater).toBe(true);
  });

  test('normalizes a named zone to selected', () => {
    const snap = normalizePickupSnapshot({ mode: 'area', areaName: 'Osu' }, CONFIG);
    expect(snap.status).toBe('selected');
    expect(snap.areaName).toBe('Osu');
  });

  test('forceConfirmed forces the confirmed state (supplier edit path)', () => {
    const snap = normalizePickupSnapshot({ mode: 'area', areaName: 'Osu' }, CONFIG, { forceConfirmed: true });
    expect(snap.status).toBe('confirmed');
  });
});