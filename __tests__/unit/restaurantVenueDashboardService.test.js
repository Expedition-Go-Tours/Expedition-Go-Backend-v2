/**
 * Dashboard aggregates.
 *
 * Two things are pinned here: the attention queue is derived from real rows
 * (so it disappears when the work is done), and the activity feed never leaks
 * internal audit metadata to an owner.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  restaurantVenueReview: { count: jest.fn(), findMany: jest.fn() },
  restaurantVenueReviewResponse: { count: jest.fn(), findMany: jest.fn() },
  restaurantVenuePhoto: { count: jest.fn() },
  restaurantMenu: { count: jest.fn(), findMany: jest.fn() },
  restaurantVenueMember: { count: jest.fn() },
  restaurantVenueInvite: { count: jest.fn() },
  auditLog: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
}));

jest.mock('../../src/core/services/restaurantVenueAccess', () => ({
  assertPermission: jest.fn(),
  toSession: jest.fn((context) => ({
    venue: { id: context.venue.id, slug: context.venue.slug, name: context.venue.name },
    membership: { id: context.membership.id, role: context.membership.role },
    permissions: context.permissions,
  })),
}));

jest.mock('../../src/core/services/restaurantVenueMenuService', () => ({
  toMenu: jest.fn((menu) => menu),
}));

const prisma = require('../../src/core/services/prismaClient');
const dashboard = require('../../src/core/services/restaurantVenueDashboardService');

const VENUE = {
  id: 'v1',
  slug: 'buka-accra',
  name: 'Buka',
  city: 'Accra',
  region: 'Greater Accra',
  status: 'ACTIVE',
  timezone: 'Africa/Accra',
  coverPhoto: null,
  photos: [],
  phone: null,
  website: null,
  description: null,
  menuUrl: null,
  hours: null,
  cuisines: [],
  dietary: [],
  amenities: [],
  mealTypes: [],
  averageRating: null,
  reviewCount: 0,
  verifiedReviewCount: 0,
  distribution: null,
  lastReviewAt: null,
  rankInCity: null,
  cityVenueCount: null,
  updatedAt: new Date('2026-11-01T00:00:00Z'),
};

const CONTEXT = {
  venue: VENUE,
  membership: { id: 'm1', userId: 'u1', role: 'OWNER' },
  permissions: ['venue.edit'],
};

function zeroCounts() {
  prisma.restaurantVenueReview.count.mockResolvedValue(0);
  prisma.restaurantVenueReviewResponse.count.mockResolvedValue(0);
  prisma.restaurantVenuePhoto.count.mockResolvedValue(0);
  prisma.restaurantMenu.count.mockResolvedValue(0);
  prisma.restaurantVenueMember.count.mockResolvedValue(1);
  prisma.restaurantVenueInvite.count.mockResolvedValue(0);
  prisma.restaurantVenueReview.findMany.mockResolvedValue([]);
  prisma.restaurantVenueReviewResponse.findMany.mockResolvedValue([]);
  prisma.restaurantMenu.findMany.mockResolvedValue([]);
  prisma.auditLog.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
}

describe('restaurantVenueDashboardService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    zeroCounts();
  });

  it('lists the real gaps for an empty listing', async () => {
    const { overview } = await dashboard.getOverview(CONTEXT);
    const keys = overview.attention.map((item) => item.key);

    expect(keys).toContain('no-menu');
    expect(keys).toContain('no-cover');
    expect(keys).toContain('no-hours');
    expect(overview.completeness.score).toBe(0);
  });

  it('raises the unanswered queue only when reviews actually lack a reply', async () => {
    prisma.restaurantVenueReview.count
      .mockResolvedValueOnce(7) // total reviews
      .mockResolvedValueOnce(3) // unanswered
      .mockResolvedValueOnce(1) // negative unanswered
      .mockResolvedValueOnce(4); // with published reply

    const { overview } = await dashboard.getOverview(CONTEXT);
    const item = overview.attention.find((row) => row.key === 'unanswered-reviews');

    expect(item.title).toBe('3 reviews waiting for a reply');
    expect(item.detail).toContain('3 stars or lower');
    expect(overview.stats.unansweredReviews).toBe(3);
    expect(overview.stats.responseRate).toBe(57);
  });

  it('computes completeness from fields that exist, not a fixed score', async () => {
    const full = {
      ...VENUE,
      coverPhoto: 'https://res.cloudinary.com/x/cover.jpg',
      description: 'x'.repeat(140),
      phone: '+233201234567',
      cuisines: ['Ghanaian'],
      hours: { monday: { open: '09:00', close: '22:00' } },
    };
    prisma.restaurantVenuePhoto.count.mockImplementation(({ where }) =>
      Promise.resolve(where.status === 'PUBLISHED' ? 3 : 0),
    );
    prisma.restaurantMenu.count.mockResolvedValue(1);

    const { overview } = await dashboard.getOverview({ ...CONTEXT, venue: full });

    expect(overview.completeness.score).toBe(100);
    expect(overview.completeness.checks.every((check) => check.done)).toBe(true);
  });

  it('treats a menu link as covering the menu requirement', async () => {
    prisma.restaurantVenuePhoto.count.mockResolvedValue(0);

    const { overview } = await dashboard.getOverview({
      ...CONTEXT,
      venue: { ...VENUE, menuUrl: 'https://buka.example/menu' },
    });

    const menuCheck = overview.completeness.checks.find((check) => check.key === 'menu');
    expect(menuCheck.done).toBe(true);
    expect(overview.attention.map((row) => row.key)).not.toContain('no-menu');
  });

  it('sanitizes activity metadata: no endpoint, IP or user agent', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a1',
        userId: 'u1',
        action: 'restaurantVenue.updatedByOwner',
        resource: 'RestaurantVenue',
        resourceId: 'v1',
        createdAt: new Date('2026-11-20T09:00:00Z'),
        metadata: {
          venueId: 'v1',
          fields: ['hours'],
          endpoint: { method: 'PATCH', url: '/api/restaurant-venues/buka-accra' },
          ipAddress: '41.66.1.1',
          userAgent: 'Mozilla/5.0',
          hash: 'deadbeef',
        },
      },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Ama' }]);

    const { activity } = await dashboard.getActivity(CONTEXT, { limit: 5 });

    expect(activity[0].actor.name).toBe('Ama');
    expect(activity[0].details).toEqual({ fields: ['hours'] });
    expect(JSON.stringify(activity[0])).not.toContain('41.66.1.1');
    expect(JSON.stringify(activity[0])).not.toContain('Mozilla');
    expect(JSON.stringify(activity[0])).not.toContain('deadbeef');
  });

  it('scopes the activity query to this venue only', async () => {
    await dashboard.getActivity(CONTEXT, { limit: 5 });

    const where = prisma.auditLog.findMany.mock.calls[0][0].where;
    expect(where.AND[0].OR).toEqual(
      expect.arrayContaining([
        { resource: 'RestaurantVenue', resourceId: 'v1' },
        { metadata: { path: ['venueId'], equals: 'v1' } },
      ]),
    );
  });

  it('returns an empty series rather than inventing points', async () => {
    const insights = await dashboard.getInsights(CONTEXT, { days: 30 });

    expect(insights.hasData).toBe(false);
    expect(insights.current.count).toBe(0);
    expect(insights.current.averageRating).toBeNull();
    expect(insights.series.every((point) => point.reviews === 0)).toBe(true);
  });

  it('summarises a real review window and compares it with the previous one', async () => {
    prisma.restaurantVenueReview.findMany
      .mockResolvedValueOnce([
        { rating: 5, createdAt: new Date(), source: 'TRAVIO_VERIFIED' },
        { rating: 3, createdAt: new Date(), source: 'TRAVIO_COMMUNITY' },
      ])
      .mockResolvedValueOnce([{ rating: 4, createdAt: new Date(), source: 'TRAVIO_COMMUNITY' }]);
    prisma.restaurantVenueReviewResponse.findMany.mockResolvedValue([
      { reviewId: 'r1', createdAt: new Date() },
    ]);
    prisma.restaurantVenueReviewResponse.count.mockResolvedValue(1);

    const insights = await dashboard.getInsights(CONTEXT, { days: 30 });

    expect(insights.current).toMatchObject({
      count: 2,
      averageRating: 4,
      negative: 1,
      verified: 1,
      responseRate: 50,
    });
    expect(insights.previous.count).toBe(1);
    expect(insights.deltas.reviews).toBe(1);
    expect(insights.hasData).toBe(true);
  });
});
