jest.mock('../../utils/prismaClient', () => ({
  tour: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $disconnect: jest.fn(),
}));

const prisma = require('../../utils/prismaClient');

beforeEach(() => {
  jest.clearAllMocks();
});

const {
  createSlug,
  parseJsonFields,
  validateTourData,
  validateStoredPricing,
  rebuildSchedulePrices,
  durationToMinutes,
  calculateTourPrice,
} = require('../../utils/tourHelpers');

// ---------------------------------------------------------------------------
// parseJsonFields
// ---------------------------------------------------------------------------
describe('parseJsonFields', () => {
  it('returns data unchanged if not an object', () => {
    expect(parseJsonFields(null)).toBeNull();
    expect(parseJsonFields('string')).toBe('string');
    expect(parseJsonFields(42)).toBe(42);
  });

  it('parses known JSON string fields', () => {
    const data = {
      categorization: '{"category":"Cultural"}',
      theme: '{"primary":"History"}',
      tags: '["tag1","tag2"]',
      latitude: '5.5',
      longitude: '-0.2',
      name: 'not parsed',
    };
    const result = parseJsonFields(data);
    expect(result.categorization).toEqual({ category: 'Cultural' });
    expect(result.theme).toEqual({ primary: 'History' });
    expect(result.tags).toEqual(['tag1', 'tag2']);
    expect(result.latitude).toBe(5.5);
    expect(result.longitude).toBe(-0.2);
    expect(result.name).toBe('not parsed');
  });

  it('leaves already-parsed fields untouched', () => {
    const data = { categorization: { category: 'Cultural' } };
    const result = parseJsonFields(data);
    expect(result.categorization).toEqual({ category: 'Cultural' });
  });

  it('handles invalid JSON gracefully', () => {
    const data = { categorization: '{invalid}' };
    const result = parseJsonFields(data);
    expect(result.categorization).toBe('{invalid}');
  });

  it('handles empty or missing input', () => {
    expect(parseJsonFields({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// validateTourData
// ---------------------------------------------------------------------------
// Helper to build a minimal valid product object that passes productSchema
function validProduct(overrides = {}) {
  return {
    language: 'English',
    category: 'Cultural',
    title: 'Amazing Tour',
    shortDescription: 'A short description that is at least ten chars',
    fullDescription: 'This is a comprehensive full description of the tour experience that provides travelers with detailed information about every aspect of the journey. It covers the significance of each stop along the route, the quality of service that guests can expect from our professional guides, and the unique value proposition that distinguishes this tour from all others available in the region. Our carefully curated itinerary ensures that participants enjoy an authentic and memorable cultural experience while visiting the most important landmarks and hidden gems that only locals know about. This thorough overview gives potential customers everything they need to make a well-informed booking decision with confidence.',
    highlights: ['Highlight 1', 'Highlight 2', 'Highlight 3'],
    photos: Array.from({ length: 7 }, (_, i) => `https://example.com/${i}.jpg`),
    copyrightConfirmed: true,
    meetingMode: 'meeting_point',
    guideMaterials: { audioGuide: false, infoBooklet: false },
    ...overrides,
  };
}

describe('validateTourData', () => {
  it('returns valid for a complete tour data object', () => {
    const result = validateTourData(validProduct());
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns errors for missing required fields', () => {
    const result = validateTourData({});
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns error for empty title', () => {
    const result = validateTourData(validProduct({ title: '' }));
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns error for short description', () => {
    const result = validateTourData(validProduct({ shortDescription: 'short' }));
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validates highlights array constraints', () => {
    const r = validateTourData(validProduct({ highlights: [] }));
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('validates photos minimum count', () => {
    const r = validateTourData(validProduct({ photos: [{ id: '1', url: 'x' }] }));
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('validates keywords max count', () => {
    const r = validateTourData(validProduct({ keywords: new Array(16).fill('k') }));
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('validates copyrightConfirmed must be true', () => {
    const r = validateTourData(validProduct({ copyrightConfirmed: false }));
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('skips required field checks for partial updates', () => {
    const r = validateTourData({ shortDescription: 'Short enough text' }, true);
    expect(r.errors).not.toContain('Title is required');
  });

  // ---------------------------------------------------------------------------
  // Pricing-related validations via productSchema
  // ---------------------------------------------------------------------------

  it('rejects invalid pricing model', () => {
    const r = validateTourData(validProduct({ pricingModel: 'invalidModel' }));
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('accepts all valid pricing models', () => {
    for (const model of ['perPerson', 'perGroup']) {
      const r = validateTourData(validProduct({ pricingModel: model }));
      expect(r.isValid).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// validateStoredPricing
// ---------------------------------------------------------------------------
describe('validateStoredPricing', () => {
  const validBlob = {
    travelerDetails: {
      pricingModel: 'perPerson',
      pricingApproach: 'dependsOnAge',
      pricingCategories: [{ name: 'Adult', price: 50, ticketNotRequired: false }],
      minParticipants: 1,
      maxParticipants: 10,
    },
    pricingSchedules: {
      schedules: [{ startDate: '2026-01-01', hasEndDate: false }],
    },
    availability: { scheduleType: 'fixedTimeSlot', timeSlots: ['09:00'] },
  };

  it('returns no errors for a complete blob', () => {
    expect(validateStoredPricing(validBlob)).toEqual([]);
  });

  it('rejects null, non-object, and array blobs', () => {
    expect(validateStoredPricing(null)).not.toEqual([]);
    expect(validateStoredPricing('string')).not.toEqual([]);
    expect(validateStoredPricing([])).not.toEqual([]);
  });

  it('requires at least one pricing schedule', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.pricingSchedules.schedules = [];
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Add at least one pricing schedule']));
  });

  it('flags end date before start date', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.pricingSchedules.schedules = [{ startDate: '2026-02-01', hasEndDate: true, endDate: '2026-01-01' }];
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Schedule 1: end date must be on or after the start date']));
  });

  it('requires per-category prices for dependsOnAge when not free', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingCategories = [{ name: 'Adult', price: null, ticketNotRequired: false }];
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Pricing category "Adult": price is required']));
  });

  it('allows null price when ticketNotRequired is true', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingCategories = [{ name: 'Infant', price: null, ticketNotRequired: true }];
    expect(validateStoredPricing(blob)).toEqual([]);
  });

  it('rejects negative per-category price', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingCategories = [{ name: 'Adult', price: -5, ticketNotRequired: false }];
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Pricing category "Adult": price must be 0 or greater']));
  });

  it('requires uniform price for sameForEveryone approach', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingApproach = 'sameForEveryone';
    blob.travelerDetails.uniformPrice = null;
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Enter a price per person']));
  });

  it('accepts a zero uniform price', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingApproach = 'sameForEveryone';
    blob.travelerDetails.uniformPrice = 0;
    expect(validateStoredPricing(blob)).toEqual([]);
  });

  it('requires per-group prices for perGroup model', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingModel = 'perGroup';
    blob.travelerDetails.groupSizes = [{ from: 1, to: 4, price: null }];
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Group size 1: price is required']));
  });

  it('flags min participants greater than max', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.minParticipants = 10;
    blob.travelerDetails.maxParticipants = 2;
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Min participants cannot exceed max participants']));
  });

  it('requires at least one time slot for fixedTimeSlot schedule type', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.availability.scheduleType = 'fixedTimeSlot';
    blob.availability.timeSlots = [];
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Add at least one time slot']));
  });

  it('requires weekly opening hours for operatingHours schedule type', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.availability.scheduleType = 'operatingHours';
    blob.availability.weeklySchedule = { Monday: [] };
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Add at least one opening hours entry']));
  });
});

// ---------------------------------------------------------------------------
// rebuildSchedulePrices
// ---------------------------------------------------------------------------
describe('rebuildSchedulePrices', () => {
  const blob = {
    travelerDetails: {
      pricingModel: 'perPerson',
      pricingApproach: 'dependsOnAge',
      pricingCategories: [{ name: 'Adult', price: 50 }, { name: 'Child', price: 25 }],
      uniformPrice: null,
      groupSizes: [],
    },
    pricingSchedules: {
      schedules: [
        { name: 'A', prices: [] },
        { name: 'B', prices: [{ ageGroup: 'Stale', retailPrice: 999 }] },
      ],
    },
  };

  it('regenerates prices on every schedule from pricingCategories', () => {
    const result = rebuildSchedulePrices(JSON.parse(JSON.stringify(blob)));
    const expected = [
      { ageGroup: 'Adult', retailPrice: 50 },
      { ageGroup: 'Child', retailPrice: 25 },
    ];
    for (const s of result.pricingSchedules.schedules) {
      expect(s.prices).toEqual(expected);
    }
  });

  it('builds group-size prices for perGroup models', () => {
    const b = JSON.parse(JSON.stringify(blob));
    b.travelerDetails.pricingModel = 'perGroup';
    b.travelerDetails.groupSizes = [{ from: 1, to: 4, price: 300 }, { from: 5, to: 10, price: 500 }];
    const result = rebuildSchedulePrices(b);
    expect(result.pricingSchedules.schedules[0].prices).toEqual([
      { label: 'Group of 1-4', retailPrice: 300, groupSize: true },
      { label: 'Group of 5-10', retailPrice: 500, groupSize: true },
    ]);
  });

  it('builds a uniform price entry for sameForEveryone', () => {
    const b = JSON.parse(JSON.stringify(blob));
    b.travelerDetails.pricingApproach = 'sameForEveryone';
    b.travelerDetails.uniformPrice = 75;
    const result = rebuildSchedulePrices(b);
    expect(result.pricingSchedules.schedules[0].prices).toEqual([{ ageGroup: 'Adult', retailPrice: 75 }]);
  });

  it('overwrites stale client-derived prices', () => {
    const b = JSON.parse(JSON.stringify(blob));
    b.pricingSchedules.schedules[1].prices = [{ ageGroup: 'Stale', retailPrice: 999 }];
    const result = rebuildSchedulePrices(b);
    expect(result.pricingSchedules.schedules[1].prices[0].retailPrice).toBe(50);
  });

  it('leaves invalid/non-normalizable blobs unchanged', () => {
    expect(rebuildSchedulePrices(null)).toBeNull();
    expect(rebuildSchedulePrices('string')).toBe('string');
    expect(rebuildSchedulePrices([])).toEqual([]);
    const noSchedules = { travelerDetails: {}, pricingSchedules: { schedules: undefined } };
    expect(rebuildSchedulePrices(noSchedules)).toBe(noSchedules);
  });
});

// ---------------------------------------------------------------------------
// durationToMinutes
// ---------------------------------------------------------------------------
describe('durationToMinutes', () => {
  it('converts the dashboard { value, unit } shape for every unit', () => {
    expect(durationToMinutes({ value: 2, unit: 'minutes' })).toBe(2);
    expect(durationToMinutes({ value: 2, unit: 'hours' })).toBe(120);
    expect(durationToMinutes({ value: 2, unit: 'days' })).toBe(2880);
    expect(durationToMinutes({ value: 2, unit: 'weeks' })).toBe(20160);
    expect(durationToMinutes({ value: 2, unit: 'hour' })).toBe(120);
  });

  it('supports legacy { hours, days, weeks, minutes } keys', () => {
    expect(durationToMinutes({ hours: 2 })).toBe(120);
    expect(durationToMinutes({ days: 1 })).toBe(1440);
    expect(durationToMinutes({ weeks: 1 })).toBe(10080);
    expect(durationToMinutes({ minutes: 30 })).toBe(30);
  });

  it('returns null for missing or invalid durations', () => {
    expect(durationToMinutes(null)).toBeNull();
    expect(durationToMinutes(undefined)).toBeNull();
    expect(durationToMinutes({})).toBeNull();
    expect(durationToMinutes({ value: 2, unit: 'fortnights' })).toBeNull();
    expect(durationToMinutes({ value: 'x', unit: 'hours' })).toBeNull();
    expect(durationToMinutes({ hours: 'x' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createSlug
// ---------------------------------------------------------------------------
describe('createSlug', () => {
  it('creates a slug from a title', async () => {
    prisma.tour.findUnique.mockResolvedValue(null);
    const slug = await createSlug('Amazing Tour!');
    expect(slug).toBe('amazing-tour');
  });

  it('appends number when slug exists', async () => {
    prisma.tour.findUnique
      .mockResolvedValueOnce({ id: 'existing' })
      .mockResolvedValueOnce(null);
    const slug = await createSlug('Test Tour');
    expect(slug).toBe('test-tour-1');
  });

  it('removes special characters', async () => {
    prisma.tour.findUnique.mockResolvedValue(null);
    const slug = await createSlug('Hello & World @ 2024!!!');
    expect(slug).toBe('hello-world-2024');
  });
});

// ---------------------------------------------------------------------------
// calculateTourPrice
// ---------------------------------------------------------------------------
describe('calculateTourPrice', () => {
  const baseTour = {
    id: 'test-tour-1',
    schedulesAndPricing: {
      travelerDetails: {
        pricingModel: 'perPerson',
        ageGroups: [
          { label: 'Adult', minAge: 13, maxAge: 99 },
          { label: 'Child', minAge: 6, maxAge: 12 },
          { label: 'Infant', minAge: 0, maxAge: 5 },
        ],
      },
      pricingSchedules: {
        currency: 'USD',
        schedules: [{
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          prices: [
            { ageGroup: 'Adult', retailPrice: 100 },
            { ageGroup: 'Child', retailPrice: 50 },
            { ageGroup: 'Infant', retailPrice: 0 },
          ],
        }],
      },
    },
  };

  it('calculates total for a group of travelers', async () => {
    const result = await calculateTourPrice(baseTour, { adult: 2, child: 1, infant: 0 }, '2026-06-15');
    expect(result.success).toBe(true);
    expect(result.subtotal).toBe(250);
    expect(result.total).toBe(250);
    expect(result.currency).toBe('USD');
  });

  it('returns error when no pricing available', async () => {
    const tour = { schedulesAndPricing: null };
    const result = await calculateTourPrice(tour, { adult: 1 }, '2026-06-15');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No pricing information available');
  });

  it('returns error when no schedule matches the date', async () => {
    const tour = {
      schedulesAndPricing: {
        travelerDetails: { ageGroups: [{ label: 'Adult', minAge: 13, maxAge: 99 }] },
        pricingSchedules: {
          currency: 'USD',
          schedules: [{
            startDate: '2025-01-01',
            endDate: '2025-12-31',
            prices: [{ ageGroup: 'Adult', retailPrice: 100 }],
          }],
        },
      },
    };
    const result = await calculateTourPrice(tour, { adult: 1 }, '2026-06-15');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No pricing available');
  });

  it('applies percentage promotions', async () => {
    const tour = {
      ...baseTour,
      schedulesAndPricing: {
        ...baseTour.schedulesAndPricing,
        promotions: [
          { type: 'percentage', discountValue: 10, isActive: true, startDate: '2020-01-01', endDate: '2030-12-31' },
        ],
      },
    };
    const result = await calculateTourPrice(tour, { adult: 2 }, '2026-06-15');
    expect(result.success).toBe(true);
    expect(result.subtotal).toBe(200);
    expect(result.discount).toBe(20);
    expect(result.total).toBe(180);
  });

  it('applies fixed amount promotions', async () => {
    const tour = {
      ...baseTour,
      schedulesAndPricing: {
        ...baseTour.schedulesAndPricing,
        promotions: [
          { type: 'fixedAmount', discountValue: 15, isActive: true, startDate: '2020-01-01', endDate: '2030-12-31' },
        ],
      },
    };
    const result = await calculateTourPrice(tour, { adult: 1 }, '2026-06-15');
    expect(result.success).toBe(true);
    expect(result.subtotal).toBe(100);
    expect(result.discount).toBe(15);
    expect(result.total).toBe(85);
  });

  it('ignores inactive promotions', async () => {
    const tour = {
      ...baseTour,
      schedulesAndPricing: {
        ...baseTour.schedulesAndPricing,
        promotions: [
          { type: 'percentage', discountValue: 50, isActive: false, startDate: '2020-01-01', endDate: '2030-12-31' },
        ],
      },
    };
    const result = await calculateTourPrice(tour, { adult: 1 }, '2026-06-15');
    expect(result.success).toBe(true);
    expect(result.discount).toBe(0);
    expect(result.total).toBe(100);
  });

  it('respects maximumDiscountAmount', async () => {
    const tour = {
      ...baseTour,
      schedulesAndPricing: {
        ...baseTour.schedulesAndPricing,
        promotions: [
          { type: 'percentage', discountValue: 50, maximumDiscountAmount: 30, isActive: true, startDate: '2020-01-01', endDate: '2030-12-31' },
        ],
      },
    };
    const result = await calculateTourPrice(tour, { adult: 2 }, '2026-06-15');
    expect(result.subtotal).toBe(200);
    expect(result.discount).toBe(30);
  });

  it('prices perGroup tours by total traveler count from groupSizes', async () => {
    const tour = {
      id: 'per-group-1',
      schedulesAndPricing: {
        travelerDetails: {
          pricingModel: 'perGroup',
          groupSizes: [
            { from: 1, to: 4, price: 300 },
            { from: 5, to: 10, price: 500 },
          ],
        },
        pricingSchedules: {
          currency: 'USD',
          schedules: [{
            startDate: '2026-01-01',
            endDate: '2026-12-31',
            prices: [],
          }],
        },
      },
    };
    const small = await calculateTourPrice(tour, { adult: 3, child: 1 }, '2026-06-15');
    expect(small.success).toBe(true);
    expect(small.subtotal).toBe(300);
    const large = await calculateTourPrice(tour, { adult: 5 }, '2026-06-15');
    expect(large.success).toBe(true);
    expect(large.subtotal).toBe(500);
  });

  it('fails closed for perGroup when no group size matches the traveler count', async () => {
    const tour = {
      id: 'per-group-2',
      schedulesAndPricing: {
        travelerDetails: {
          pricingModel: 'perGroup',
          groupSizes: [{ from: 1, to: 4, price: 300 }],
        },
        pricingSchedules: {
          currency: 'USD',
          schedules: [{
            startDate: '2026-01-01',
            endDate: '2026-12-31',
            prices: [],
          }],
        },
      },
    };
    const result = await calculateTourPrice(tour, { adult: 8 }, '2026-06-15');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No price available for the selected group size');
  });

  it('fails closed when perGroup data is missing entirely', async () => {
    const tour = {
      id: 'per-group-3',
      schedulesAndPricing: {
        travelerDetails: { pricingModel: 'perGroup', groupSizes: [] },
        pricingSchedules: {
          currency: 'USD',
          schedules: [{
            startDate: '2026-01-01',
            endDate: '2026-12-31',
            prices: [],
          }],
        },
      },
    };
    const result = await calculateTourPrice(tour, { adult: 2 }, '2026-06-15');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No price available');
  });

  it('prices sameForEveryone tours from uniformPrice', async () => {
    const tour = {
      id: 'uniform-1',
      schedulesAndPricing: {
        travelerDetails: {
          pricingModel: 'perPerson',
          pricingApproach: 'sameForEveryone',
          uniformPrice: 75,
        },
        pricingSchedules: {
          currency: 'USD',
          schedules: [{
            startDate: '2026-01-01',
            endDate: '2026-12-31',
            prices: [],
          }],
        },
      },
    };
    const result = await calculateTourPrice(tour, { adult: 2, child: 1 }, '2026-06-15');
    expect(result.success).toBe(true);
    expect(result.subtotal).toBe(225);
  });

  it('fails closed when an empty derived prices array has no source-of-truth price', async () => {
    const tour = {
      id: 'empty-prices-1',
      schedulesAndPricing: {
        travelerDetails: {
          pricingModel: 'perPerson',
          pricingApproach: 'dependsOnAge',
          pricingCategories: [{ name: 'Adult', price: null, ticketNotRequired: false }],
        },
        pricingSchedules: {
          currency: 'USD',
          schedules: [{
            startDate: '2026-01-01',
            endDate: '2026-12-31',
            prices: [],
          }],
        },
      },
    };
    const result = await calculateTourPrice(tour, { adult: 2 }, '2026-06-15');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No pricing available');
  });
});
