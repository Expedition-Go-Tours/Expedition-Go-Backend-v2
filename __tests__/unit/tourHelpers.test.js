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
describe('validateTourData', () => {
  it('returns valid for a complete tour data object', () => {
    const data = {
      title: 'Amazing Tour',
      description: 'A'.repeat(50),
      categorization: { category: 'Cultural' },
      schedulesAndPricing: {
        travelerDetails: {
          pricingModel: 'perPerson',
          ageGroups: [{ name: 'Adult', minAge: 13, maxAge: 99 }],
        },
        pricingSchedules: {
          currency: 'USD',
          schedules: [{
            startDate: '2026-01-01',
          }],
        },
      },
      latitude: 5.5,
      longitude: -0.2,
    };
    const result = validateTourData(data);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns errors for missing required fields', () => {
    const result = validateTourData({});
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Title is required');
    expect(result.errors).toContain('Product category is required');
    expect(result.errors).toContain('Pricing information is required');
  });

  it('returns errors for title too long', () => {
    const result = validateTourData({ title: 'X'.repeat(201) });
    expect(result.errors).toContain('Title must be less than 200 characters');
  });

  it('returns errors for description too long', () => {
    const result = validateTourData({ title: 'Valid', description: 'X'.repeat(5001) });
    expect(result.errors).toContain('Description must be less than 5000 characters');
  });

  it('validates coordinates', () => {
    const tests = [
      { latitude: 100, longitude: 0, err: 'Latitude must be a number between -90 and 90' },
      { latitude: 5, err: 'Both latitude and longitude must be provided together' },
      { longitude: -200, err: 'Longitude must be a number between -180 and 180' },
    ];
    for (const t of tests) {
      const r = validateTourData({ title: 'Valid', ...t });
      expect(r.errors).toContain(t.err);
    }
  });

  it('validates photos array length', () => {
    const r = validateTourData({ title: 'Valid', photos: new Array(21) });
    expect(r.errors).toContain('Maximum 20 photos allowed');
  });

  it('validates tags array length', () => {
    const r = validateTourData({ title: 'Valid', tags: new Array(16) });
    expect(r.errors).toContain('Maximum 15 tags allowed');
  });

  it('validates categorization structure', () => {
    const r = validateTourData({
      title: 'Valid',
      categorization: 'not-an-object',
    });
    expect(r.errors).toContain('Invalid categorization structure');
  });

  it('skips required field checks for partial updates', () => {
    const r = validateTourData({ description: 'Short', latitude: 91 }, true);
    expect(r.errors).not.toContain('Title is required');
    expect(r.errors).not.toContain('Categorization is required');
    expect(r.errors).toContain('Latitude must be a number between -90 and 90');
  });

  // ---------------------------------------------------------------------------
  // New Phase 2 validations
  // ---------------------------------------------------------------------------

  it('rejects schedule endDate before startDate', () => {
    const r = validateTourData({
      title: 'Valid Tour',
      description: 'A'.repeat(50),
      category: 'Cultural',
      pricingModel: 'perPerson',
      scheduleStartDate: '2026-06-01',
      scheduleEndDate: '2026-05-01',
    });
    expect(r.errors).toContain('Schedule end date must be on or after start date');
  });

  it('rejects invalid pricing model', () => {
    const r = validateTourData({
      title: 'Valid Tour',
      description: 'A'.repeat(50),
      category: 'Cultural',
      pricingModel: 'invalidModel',
    });
    expect(r.errors).toContain('Valid pricing model is required (perPerson or perGroup)');
  });

  it('accepts all valid pricing models', () => {
    for (const model of ['perPerson', 'perGroup']) {
      const r = validateTourData({
        title: 'Valid Tour',
        description: 'A'.repeat(50),
        category: 'Cultural',
        pricingModel: model,
      });
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
