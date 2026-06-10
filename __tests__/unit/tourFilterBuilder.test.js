const {
  buildTourFilters,
  buildSortOptions,
  validateFilterParams,
} = require('../../utils/tourFilterBuilder');

// ---------------------------------------------------------------------------
// buildTourFilters
// ---------------------------------------------------------------------------
describe('buildTourFilters', () => {
  it('returns default ACTIVE status filter with no params', () => {
    const result = buildTourFilters({});
    expect(result).toEqual({
      status: 'ACTIVE',
      supplier: {
        supplierProfile: {
          status: { in: ['ACTIVE', 'APPROVED'] },
        },
      },
    });
  });

  it('filters by category', () => {
    const result = buildTourFilters({ category: 'Cultural' });
    expect(result.AND).toContainEqual({
      category: { equals: 'Cultural', mode: 'insensitive' },
    });
  });

  it('filters by subcategory', () => {
    const result = buildTourFilters({ subcategory: 'Historical' });
    expect(result.AND).toContainEqual({
      subcategory: { equals: 'Historical', mode: 'insensitive' },
    });
  });

  it('filters by activityType', () => {
    const result = buildTourFilters({ activityType: 'Hiking' });
    expect(result.AND).toContainEqual({
      activityType: { equals: 'Hiking', mode: 'insensitive' },
    });
  });

  it('filters by primaryTheme', () => {
    const result = buildTourFilters({ primaryTheme: 'Adventure' });
    expect(result.AND).toContainEqual({
      primaryTheme: { equals: 'Adventure', mode: 'insensitive' },
    });
  });

  it('filters by city', () => {
    const result = buildTourFilters({ city: 'Accra' });
    expect(result.AND).toContainEqual({
      city: { equals: 'Accra', mode: 'insensitive' },
    });
  });

  it('filters by country', () => {
    const result = buildTourFilters({ country: 'Ghana' });
    expect(result.AND).toContainEqual({
      country: { equals: 'Ghana', mode: 'insensitive' },
    });
  });

  it('filters by region', () => {
    const result = buildTourFilters({ region: 'Central' });
    expect(result.AND).toContainEqual({
      region: { equals: 'Central', mode: 'insensitive' },
    });
  });

  it('filters by location text search across city/country/region', () => {
    const result = buildTourFilters({ location: 'Accra' });
    expect(result.AND).toContainEqual({
      OR: expect.arrayContaining([
        { city: { contains: 'Accra', mode: 'insensitive' } },
        { country: { contains: 'Accra', mode: 'insensitive' } },
        { region: { contains: 'Accra', mode: 'insensitive' } },
      ]),
    });
  });

  it('filters by minRating', () => {
    const result = buildTourFilters({ minRating: '4' });
    expect(result.averageRating).toEqual({ gte: 4 });
  });

  it('filters by minReviews', () => {
    const result = buildTourFilters({ minReviews: '10' });
    expect(result.reviewCount).toEqual({ gte: 10 });
  });

  it('filters by supplierId', () => {
    const result = buildTourFilters({ supplierId: 'supplier-1' });
    expect(result.supplierId).toBe('supplier-1');
  });

  it('filters by search text', () => {
    const result = buildTourFilters({ search: 'beach' });
    expect(result.AND).toContainEqual({
      OR: [
        { title: { contains: 'beach', mode: 'insensitive' } },
        { description: { contains: 'beach', mode: 'insensitive' } },
        { tags: { has: 'beach' } },
      ],
    });
  });

  it('filters by tags', () => {
    const result = buildTourFilters({ tags: 'adventure,beach' });
    expect(result.AND).toContainEqual({
      tags: { hasSome: ['adventure', 'beach'] },
    });
  });

  it('filters by instantConfirmation', () => {
    const result = buildTourFilters({ instantConfirmation: 'true' });
    expect(result.AND).toContainEqual({
      bookingAndTickets: { path: ['instantConfirmation'], equals: true },
    });
  });

  it('filters by freeCancellation', () => {
    const result = buildTourFilters({ freeCancellation: 'true' });
    expect(result.AND).toContainEqual({
      bookingAndTickets: { path: ['cancellationPolicy', 'type'], equals: 'flexible' },
    });
  });

  it('filters by price range (minPrice + maxPrice)', () => {
    const result = buildTourFilters({ minPrice: '50', maxPrice: '200' });
    expect(result.AND).toContainEqual({
      AND: [
        { schedulesAndPricing: { path: ['pricing', 'adult'], gte: 50 } },
        { schedulesAndPricing: { path: ['pricing', 'adult'], lte: 200 } },
      ],
    });
  });

  it('filters by priceRange preset (budget)', () => {
    const result = buildTourFilters({ priceRange: 'budget' });
    expect(result.AND).toContainEqual({
      AND: [
        { schedulesAndPricing: { path: ['pricing', 'adult'], gte: 0 } },
        { schedulesAndPricing: { path: ['pricing', 'adult'], lte: 50 } },
      ],
    });
  });

  it('filters by duration', () => {
    const result = buildTourFilters({ minDuration: '2', maxDuration: '6', durationType: 'hours' });
    expect(result.AND).toContainEqual({
      AND: [
        { durationMinutes: { gte: 120 } },
        { durationMinutes: { lte: 360 } },
      ],
    });
  });

  it('filters by dayOfWeek', () => {
    const result = buildTourFilters({ dayOfWeek: 'Monday' });
    expect(result.AND).toContainEqual({
      schedulesAndPricing: { path: ['availability', 'daysOfWeek'], array_contains: 'Monday' },
    });
  });

  it('combines multiple filters into AND array', () => {
    const result = buildTourFilters({ category: 'Cultural', city: 'Accra', minRating: '4' });
    expect(result.AND).toBeDefined();
    expect(result.AND.length).toBeGreaterThanOrEqual(2);
    expect(result.averageRating).toEqual({ gte: 4 });
  });

  it('handles theme search (generic, no primary/secondary)', () => {
    const result = buildTourFilters({ theme: 'Adventure' });
    expect(result.AND).toContainEqual({
      OR: [
        { primaryTheme: { equals: 'Adventure', mode: 'insensitive' } },
        { secondaryThemes: { some: { theme: { equals: 'Adventure', mode: 'insensitive' } } } },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// buildSortOptions
// ---------------------------------------------------------------------------
describe('buildSortOptions', () => {
  it('defaults to createdAt desc', () => {
    expect(buildSortOptions()).toEqual({ createdAt: 'desc' });
  });

  it('maps valid sort fields', () => {
    const cases = [
      { sortBy: 'rating', expected: { averageRating: 'desc' } },
      { sortBy: 'popularity', expected: { viewCount: 'desc' } },
      { sortBy: 'bookings', expected: { totalBookings: 'desc' } },
      { sortBy: 'title', expected: { title: 'desc' } },
      { sortBy: 'reviews', expected: { reviewCount: 'desc' } },
    ];
    for (const c of cases) {
      expect(buildSortOptions(c.sortBy)).toEqual(c.expected);
    }
  });

  it('respects sortOrder asc', () => {
    expect(buildSortOptions('title', 'asc')).toEqual({ title: 'asc' });
  });

  it('falls back to createdAt for unknown sort field', () => {
    expect(buildSortOptions('nonexistent')).toEqual({ createdAt: 'desc' });
  });
});

// ---------------------------------------------------------------------------
// validateFilterParams
// ---------------------------------------------------------------------------
describe('validateFilterParams', () => {
  it('returns valid for empty params', () => {
    const result = validateFilterParams({});
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates minPrice is numeric', () => {
    expect(validateFilterParams({ minPrice: 'abc' }).errors)
      .toContain('minPrice must be a valid number');
  });

  it('validates maxPrice is numeric', () => {
    expect(validateFilterParams({ maxPrice: 'xyz' }).errors)
      .toContain('maxPrice must be a valid number');
  });

  it('validates minPrice <= maxPrice', () => {
    expect(validateFilterParams({ minPrice: '100', maxPrice: '50' }).errors)
      .toContain('minPrice cannot be greater than maxPrice');
  });

  it('validates minRating range', () => {
    expect(validateFilterParams({ minRating: '6' }).errors)
      .toContain('minRating must be between 0 and 5');
    expect(validateFilterParams({ minRating: '-1' }).errors)
      .toContain('minRating must be between 0 and 5');
    expect(validateFilterParams({ minRating: 'abc' }).errors)
      .toContain('minRating must be between 0 and 5');
    expect(validateFilterParams({ minRating: '4' }).isValid).toBe(true);
  });

  it('validates geo params (lat/lng)', () => {
    expect(validateFilterParams({ lat: '100', lng: '0' }).errors)
      .toContain('lat must be a number between -90 and 90');
    expect(validateFilterParams({ lat: '5', lng: '200' }).errors)
      .toContain('lng must be a number between -180 and 180');
    expect(validateFilterParams({ lat: '5', lng: '0', radius: '-1' }).errors)
      .toContain('radius must be a positive number');
  });

  it('validates pagination', () => {
    expect(validateFilterParams({ page: '0' }).errors)
      .toContain('page must be a positive integer');
    expect(validateFilterParams({ limit: '-5' }).errors)
      .toContain('limit must be a positive integer');
    expect(validateFilterParams({ page: '1', limit: '20' }).isValid).toBe(true);
  });

  it('validates sortOrder', () => {
    expect(validateFilterParams({ sortOrder: 'invalid' }).errors)
      .toContain('sortOrder must be either "asc" or "desc"');
    expect(validateFilterParams({ sortOrder: 'asc' }).isValid).toBe(true);
    expect(validateFilterParams({ sortOrder: 'desc' }).isValid).toBe(true);
  });
});
