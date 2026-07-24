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
});
