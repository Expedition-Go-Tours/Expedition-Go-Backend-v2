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
  reconcileAvailability,
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
    wifiIncluded: false,
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
      currency: 'USD',
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

  it('allows null price when ticketNotRequired is true alongside a paid category', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingCategories = [
      { name: 'Adult', price: 50, ticketNotRequired: false },
      { name: 'Infant', price: null, ticketNotRequired: true },
    ];
    expect(validateStoredPricing(blob)).toEqual([]);
  });

  it('rejects a tour where every pricing category is free', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingCategories = [
      { name: 'Infant', price: null, ticketNotRequired: true },
    ];
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining([
      'Add at least one pricing category with a price greater than 0',
    ]));
  });

  it('rejects negative per-category price', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingCategories = [{ name: 'Adult', price: -5, ticketNotRequired: false }];
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Pricing category "Adult": price must be greater than 0']));
  });

  it('rejects non-numeric per-category price', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingCategories = [{ name: 'Adult', price: 'abc', ticketNotRequired: false }];
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Pricing category "Adult": price must be a valid number']));
  });

  it('rejects a per-category price above the Decimal ceiling', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingCategories = [{ name: 'Adult', price: 100000000, ticketNotRequired: false }];
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining([expect.stringMatching(/cannot exceed/)]));
  });

  it('requires uniform price for sameForEveryone approach', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingApproach = 'sameForEveryone';
    blob.travelerDetails.uniformPrice = null;
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Enter a price per person']));
  });

  it('rejects a zero uniform price', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.travelerDetails.pricingApproach = 'sameForEveryone';
    blob.travelerDetails.uniformPrice = 0;
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['Price per person must be greater than 0']));
  });

  it('requires a currency code', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    delete blob.pricingSchedules.currency;
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['A currency code is required']));
  });

  it('rejects an invalid currency code', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.pricingSchedules.currency = 'NOTACODE';
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining(['"NOTACODE" is not a valid ISO 4217 currency code']));
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

  it('accepts per-schedule weekly hours when the aggregate block is empty', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.availability.scheduleType = 'operatingHours';
    blob.availability.weeklySchedule = { Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [] };
    blob.pricingSchedules.schedules = [{
      startDate: '2026-01-01',
      hasEndDate: false,
      weeklySchedule: {
        Monday: [{ startTime: '08:00', endTime: '18:00' }],
        Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [],
      },
    }];
    expect(validateStoredPricing(blob)).not.toEqual(expect.arrayContaining(['Add at least one opening hours entry']));
  });

  it('passes when all schedules share identical price copies', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    const prices = [{ ageGroup: 'Adult', retailPrice: 50 }];
    blob.pricingSchedules.schedules = [
      { startDate: '2026-01-01', hasEndDate: false, prices: prices.slice() },
      { startDate: '2026-02-01', hasEndDate: false, prices: prices.slice() },
    ];
    expect(validateStoredPricing(blob)).toEqual([]);
  });

  it('flags divergent per-schedule price copies', () => {
    const blob = JSON.parse(JSON.stringify(validBlob));
    blob.pricingSchedules.schedules = [
      { startDate: '2026-01-01', hasEndDate: false, prices: [{ ageGroup: 'Adult', retailPrice: 50 }] },
      { startDate: '2026-02-01', hasEndDate: false, prices: [{ ageGroup: 'Adult', retailPrice: 99 }] },
    ];
    expect(validateStoredPricing(blob)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Schedule pricing copies are inconsistent/),
    ]));
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

  it('labels discrete group sizes as "Group of N"', () => {
    const b = JSON.parse(JSON.stringify(blob));
    b.travelerDetails.pricingModel = 'perGroup';
    b.travelerDetails.groupSizes = [{ from: 1, to: 1, price: 300 }, { from: 2, to: 2, price: 500 }];
    const result = rebuildSchedulePrices(b);
    expect(result.pricingSchedules.schedules[0].prices).toEqual([
      { label: 'Group of 1', retailPrice: 300, groupSize: true },
      { label: 'Group of 2', retailPrice: 500, groupSize: true },
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

  it('coerces numeric-string prices to numbers', () => {
    const b = JSON.parse(JSON.stringify(blob));
    b.travelerDetails.pricingCategories = [{ name: 'Adult', price: '50' }, { name: 'Child', price: '25' }];
    const result = rebuildSchedulePrices(b);
    expect(result.travelerDetails.pricingCategories[0].price).toBe(50);
    expect(result.pricingSchedules.schedules[0].prices).toEqual([
      { ageGroup: 'Adult', retailPrice: 50 },
      { ageGroup: 'Child', retailPrice: 25 },
    ]);
  });

  it('clamps negative and overflowing source prices', () => {
    const b = JSON.parse(JSON.stringify(blob));
    b.travelerDetails.pricingCategories = [{ name: 'Adult', price: -5 }, { name: 'Child', price: 99999999999 }];
    const result = rebuildSchedulePrices(b);
    expect(result.travelerDetails.pricingCategories[0].price).toBe(0);
    expect(result.travelerDetails.pricingCategories[1].price).toBe(99999999);
    expect(result.pricingSchedules.schedules[0].prices).toEqual([
      { ageGroup: 'Adult', retailPrice: 0 },
      { ageGroup: 'Child', retailPrice: 99999999 },
    ]);
  });

  it('drops non-numeric source prices so they fail publish completeness', () => {
    const b = JSON.parse(JSON.stringify(blob));
    b.travelerDetails.pricingCategories = [{ name: 'Adult', price: 'abc' }, { name: 'Child', price: 25 }];
    const result = rebuildSchedulePrices(b);
    expect(result.travelerDetails.pricingCategories[0].price).toBeNull();
    expect(result.pricingSchedules.schedules[0].prices).toEqual([{ ageGroup: 'Child', retailPrice: 25 }]);
  });
});

// ---------------------------------------------------------------------------
// reconcileAvailability
// ---------------------------------------------------------------------------
const baseBlob = (overrides = {}) => ({
  availability: {
    scheduleType: 'operatingHours',
    timezone: 'UTC',
    operatingHoursStart: '09:00',
    operatingHoursEnd: '17:00',
  },
  pricingSchedules: {
    schedules: [
      { startDate: '2026-01-01', hasEndDate: false, type: 'operatingHours' },
    ],
  },
  ...overrides,
});

const HOURS = { Monday: [{ startTime: '09:00', endTime: '12:00' }], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [] };

function hasHours(ws) {
  return ws && Object.values(ws).some((slots) => Array.isArray(slots) && slots.length > 0);
}

describe('reconcileAvailability', () => {
  it('returns non-normalizable blobs unchanged', () => {
    expect(reconcileAvailability(null)).toBeNull();
    expect(reconcileAvailability('string')).toBe('string');
    expect(reconcileAvailability([])).toEqual([]);
    const noSchedules = { availability: {}, pricingSchedules: { schedules: undefined } };
    expect(reconcileAvailability(noSchedules)).toBe(noSchedules);
  });

  it('backfills an empty aggregate weeklySchedule from schedules[0] (the migration-drift case)', () => {
    const blob = JSON.parse(JSON.stringify(baseBlob()));
    blob.availability.weeklySchedule = {};
    blob.availability.daysOfWeek = [];
    blob.pricingSchedules.schedules[0].weeklySchedule = HOURS;
    const result = reconcileAvailability(blob);
    expect(hasHours(result.availability.weeklySchedule)).toBe(true);
    expect(result.availability.weeklySchedule).toEqual(HOURS);
    expect(result.availability.daysOfWeek).toEqual(['Monday']);
    expect(result.pricingSchedules.schedules[0].weeklySchedule).toEqual(HOURS);
  });

  it('backfills schedules[0] when the aggregate has hours but the schedule does not', () => {
    const blob = JSON.parse(JSON.stringify(baseBlob()));
    blob.availability.weeklySchedule = HOURS;
    blob.pricingSchedules.schedules[0].weeklySchedule = {};
    const result = reconcileAvailability(blob);
    expect(hasHours(result.pricingSchedules.schedules[0].weeklySchedule)).toBe(true);
  });

  it('preserves a populated aggregate and aligns schedules[0] to it when both have data', () => {
    const blob = JSON.parse(JSON.stringify(baseBlob()));
    blob.availability.weeklySchedule = HOURS;
    blob.availability.daysOfWeek = ['Monday'];
    blob.pricingSchedules.schedules[0].weeklySchedule = JSON.parse(JSON.stringify(HOURS));
    blob.pricingSchedules.schedules[0].weeklySchedule.Tuesday = [{ startTime: '10:00', endTime: '11:00' }];
    const result = reconcileAvailability(blob);
    expect(result.availability.daysOfWeek).toEqual(['Monday']);
    expect(result.pricingSchedules.schedules[0].weeklySchedule).toEqual(HOURS);
  });

  it('never invents hours when both sides are empty (cleared schedule stays empty)', () => {
    const blob = JSON.parse(JSON.stringify(baseBlob()));
    blob.availability.weeklySchedule = {};
    blob.availability.daysOfWeek = [];
    blob.pricingSchedules.schedules[0].weeklySchedule = {};
    const result = reconcileAvailability(blob);
    expect(result.availability.daysOfWeek).toEqual([]);
    expect(hasHours(result.availability.weeklySchedule)).toBe(false);
    expect(result.availability.weeklySchedule).toEqual({ Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [] });
  });

  it('syncs timeSlots from the populated side when the other is empty', () => {
    const blob = JSON.parse(JSON.stringify(baseBlob()));
    blob.availability.timeSlots = [];
    blob.pricingSchedules.schedules[0].timeSlots = ['08:00'];
    const result = reconcileAvailability(blob);
    expect(result.availability.timeSlots).toEqual(['08:00']);
  });

  it('syncs the per-schedule type with the aggregate scheduleType', () => {
    const blob = JSON.parse(JSON.stringify(baseBlob()));
    blob.availability.scheduleType = 'fixedTimeSlot';
    blob.pricingSchedules.schedules[0].type = undefined;
    const result = reconcileAvailability(blob);
    expect(result.pricingSchedules.schedules[0].type).toBe('fixedTimeSlot');
  });

  it('is idempotent — running twice yields the same result', () => {
    const blob = JSON.parse(JSON.stringify(baseBlob()));
    blob.availability.weeklySchedule = {};
    blob.availability.daysOfWeek = [];
    blob.pricingSchedules.schedules[0].weeklySchedule = HOURS;
    const once = reconcileAvailability(blob);
    const twice = reconcileAvailability(JSON.parse(JSON.stringify(once)));
    expect(twice.availability.weeklySchedule).toEqual(once.availability.weeklySchedule);
    expect(twice.availability.daysOfWeek).toEqual(once.availability.daysOfWeek);
  });
});

// ---------------------------------------------------------------------------
// calculateTourPrice — money safety
// ---------------------------------------------------------------------------
function tourWithPricing(schedulesAndPricing) {
  return { id: 'tour-1', schedulesAndPricing };
}

const basePricing = (overrides = {}) => ({
  travelerDetails: {
    pricingModel: 'perPerson',
    pricingApproach: 'dependsOnAge',
    pricingCategories: [{ name: 'Adult', price: 50 }, { name: 'Child', price: 25 }],
    minParticipants: 1,
    maxParticipants: 10,
  },
  pricingSchedules: {
    currency: 'USD',
    schedules: [{ startDate: '2026-01-01', hasEndDate: false, prices: [] }],
  },
  ...overrides,
});

describe('calculateTourPrice', () => {
  it('prices sameForEveryone from the uniform price', async () => {
    const pricing = basePricing({
      travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'sameForEveryone', uniformPrice: 50 },
    });
    const result = await calculateTourPrice(tourWithPricing(pricing), { adults: 2, children: 1 }, '2026-03-01');
    expect(result.success).toBe(true);
    expect(result.subtotal).toBe(150);
    expect(result.total).toBe(150);
    expect(result.currency).toBe('USD');
  });

  it('prices dependsOnAge per traveler', async () => {
    const result = await calculateTourPrice(tourWithPricing(basePricing()), { adults: 2, children: 1 }, '2026-03-01');
    expect(result.success).toBe(true);
    expect(result.subtotal).toBe(125);
  });

  it('prices perGroup from the matched group size', async () => {
    const pricing = basePricing({
      travelerDetails: {
        pricingModel: 'perGroup',
        pricingApproach: 'dependsOnAge',
        groupSizes: [{ from: 1, to: 4, price: 300 }, { from: 5, to: 10, price: 500 }],
      },
    });
    const result = await calculateTourPrice(tourWithPricing(pricing), { adults: 3, children: 1 }, '2026-03-01');
    expect(result.success).toBe(true);
    expect(result.subtotal).toBe(300);
  });

  it('clamps an over-100% percentage promotion so total never goes negative', async () => {
    const pricing = basePricing({
      travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'sameForEveryone', uniformPrice: 100 },
      promotions: [{ isActive: true, type: 'percentage', discountValue: 150, startDate: '2026-01-01', endDate: '2026-12-31' }],
    });
    const result = await calculateTourPrice(tourWithPricing(pricing), { adults: 1 }, '2026-03-01');
    expect(result.success).toBe(true);
    expect(result.total).toBe(0);
  });

  it('floors the total at 0 when a fixed-amount discount exceeds the subtotal', async () => {
    const pricing = basePricing({
      travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'sameForEveryone', uniformPrice: 100 },
      promotions: [{ isActive: true, type: 'fixedAmount', discountValue: 500, startDate: '2026-01-01', endDate: '2026-12-31' }],
    });
    const result = await calculateTourPrice(tourWithPricing(pricing), { adults: 1 }, '2026-03-01');
    expect(result.success).toBe(true);
    expect(result.total).toBe(0);
  });

  it('coerces numeric-string prices', async () => {
    const pricing = basePricing({
      travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'sameForEveryone', uniformPrice: '50' },
    });
    const result = await calculateTourPrice(tourWithPricing(pricing), { adults: 2 }, '2026-03-01');
    expect(result.success).toBe(true);
    expect(result.subtotal).toBe(100);
  });

  it('fails closed on a non-numeric price', async () => {
    const pricing = basePricing({
      travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'sameForEveryone', uniformPrice: 'abc' },
    });
    const result = await calculateTourPrice(tourWithPricing(pricing), { adults: 1 }, '2026-03-01');
    expect(result.success).toBe(false);
  });

  it('normalizes a missing/invalid currency to USD', async () => {
    const pricing = basePricing({
      travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'sameForEveryone', uniformPrice: 10 },
    });
    pricing.pricingSchedules.currency = '';
    const result = await calculateTourPrice(tourWithPricing(pricing), { adults: 1 }, '2026-03-01');
    expect(result.success).toBe(true);
    expect(result.currency).toBe('USD');
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
