/**
 * Owner replies.
 *
 * The invariants worth protecting: a reply is moderated, a review can only hold
 * one live reply, a published reply is removed rather than edited, and a reply
 * cannot smuggle a link or an email address onto a public review.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  $transaction: jest.fn(),
  restaurantVenueReview: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  restaurantVenueReviewResponse: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/restaurantVenueService', () => ({
  BRANDS: ['ghana', 'africa', 'expedition'],
  encodeCursor: jest.fn(() => 'cursor-next'),
  decodeReviewCursor: jest.fn(() => null),
}));

jest.mock('../../src/core/services/restaurantVenueAccess', () => ({
  assertPermission: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const responses = require('../../src/core/services/restaurantVenueResponseService');

const CONTEXT = {
  venue: { id: 'v1', slug: 'buka-accra', name: 'Buka' },
  membership: { id: 'm1', userId: 'u1', role: 'OWNER' },
  permissions: ['reviews.reply'],
};

const REVIEW = { id: 'r1', authorId: 'guest1', rating: 2 };

function responseRow(overrides = {}) {
  return {
    id: 'resp1',
    reviewId: 'r1',
    venueId: 'v1',
    body: 'Thank you for the feedback, we are fixing the wait on Friday nights.',
    status: 'PENDING',
    authorRole: 'OWNER',
    createdAt: new Date('2026-11-20T10:00:00Z'),
    updatedAt: new Date('2026-11-20T10:00:00Z'),
    author: { name: 'Ama', photoURL: null },
    ...overrides,
  };
}

describe('restaurantVenueResponseService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((fn) => fn(prisma));
    prisma.restaurantVenueReview.findFirst.mockResolvedValue(REVIEW);
    prisma.restaurantVenueReviewResponse.findFirst.mockResolvedValue(null);
    prisma.restaurantVenueReviewResponse.create.mockImplementation((args) =>
      Promise.resolve(responseRow({ ...args.data, author: { name: 'Ama', photoURL: null } })),
    );
  });

  it('submits a reply as PENDING, never straight to published', async () => {
    const created = await responses.createResponse(
      CONTEXT,
      { reviewId: 'r1', body: 'Thank you for the feedback, we are fixing the wait on Friday nights.' },
      { headers: {} },
    );

    expect(created.status).toBe('PENDING');
    expect(prisma.restaurantVenueReviewResponse.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reviewId: 'r1', venueId: 'v1', status: 'PENDING' }),
      }),
    );
  });

  it('refuses a second live reply to the same review', async () => {
    prisma.restaurantVenueReviewResponse.findFirst.mockResolvedValue({ id: 'resp0' });

    await expect(
      responses.createResponse(
        CONTEXT,
        { reviewId: 'r1', body: 'Thank you for the feedback, we are fixing the wait on Friday nights.' },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ errorCode: 'RESPONSE_ALREADY_EXISTS', statusCode: 409 });
    expect(prisma.restaurantVenueReviewResponse.create).not.toHaveBeenCalled();
  });

  it('rejects a reply that contains a link', async () => {
    await expect(
      responses.createResponse(
        CONTEXT,
        { reviewId: 'r1', body: 'Thanks for coming! Book again at https://buka.example tonight.' },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ errorCode: 'REPLY_CONTAINS_URL', statusCode: 400 });
  });

  it('rejects a reply that contains an email address', async () => {
    await expect(
      responses.createResponse(
        CONTEXT,
        { reviewId: 'r1', body: 'Sorry about that. Email reservations@buka.example and we will fix it.' },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ errorCode: 'REPLY_CONTAINS_EMAIL', statusCode: 400 });
  });

  it('rejects a reply shorter than the minimum', async () => {
    await expect(
      responses.createResponse(CONTEXT, { reviewId: 'r1', body: 'Thanks!' }, { headers: {} }),
    ).rejects.toMatchObject({ errorCode: 'REPLY_TOO_SHORT' });
  });

  it('refuses to reply to a review that is not approved', async () => {
    prisma.restaurantVenueReview.findFirst.mockResolvedValue(null);

    await expect(
      responses.createResponse(
        CONTEXT,
        { reviewId: 'r1', body: 'Thank you for the feedback, we are fixing the wait on Friday nights.' },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ errorCode: 'REVIEW_NOT_FOUND', statusCode: 404 });
  });

  it('refuses a reply to the owner’s own review', async () => {
    prisma.restaurantVenueReview.findFirst.mockResolvedValue({ ...REVIEW, authorId: 'u1' });

    await expect(
      responses.createResponse(
        CONTEXT,
        { reviewId: 'r1', body: 'Thank you for the feedback, we are fixing the wait on Friday nights.' },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ errorCode: 'CANNOT_REPLY_TO_OWN_REVIEW' });
  });

  it('marks a deleted published reply REMOVED so the history survives', async () => {
    prisma.restaurantVenueReviewResponse.findFirst.mockResolvedValue(
      responseRow({ status: 'PUBLISHED' }),
    );
    prisma.restaurantVenueReviewResponse.update.mockImplementation((args) =>
      Promise.resolve(responseRow({ ...args.data })),
    );

    const result = await responses.deleteResponse(
      CONTEXT,
      { responseId: 'resp1' },
      { headers: {} },
    );

    expect(result.status).toBe('REMOVED');
    expect(prisma.restaurantVenueReviewResponse.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'resp1' } }),
    );
  });

  it('publishes a pending reply only through moderation', async () => {
    prisma.restaurantVenueReviewResponse.findUnique.mockResolvedValue({
      ...responseRow(),
      venue: { id: 'v1', slug: 'buka-accra', name: 'Buka' },
      review: { id: 'r1', rating: 2 },
    });
    prisma.restaurantVenueReviewResponse.update.mockImplementation((args) =>
      Promise.resolve(responseRow({ ...args.data })),
    );

    const result = await responses.moderateResponse({
      responseId: 'resp1',
      adminId: 'admin1',
      action: 'publish',
      req: { headers: {} },
    });

    expect(result.status).toBe('PUBLISHED');
    expect(prisma.restaurantVenueReviewResponse.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PUBLISHED', moderatedBy: 'admin1' }),
      }),
    );
  });

  it('will not moderate a reply twice', async () => {
    prisma.restaurantVenueReviewResponse.findUnique.mockResolvedValue({
      ...responseRow({ status: 'PUBLISHED' }),
      venue: { id: 'v1' },
      review: { id: 'r1' },
    });

    await expect(
      responses.moderateResponse({
        responseId: 'resp1',
        adminId: 'admin1',
        action: 'publish',
        req: { headers: {} },
      }),
    ).rejects.toMatchObject({ errorCode: 'RESPONSE_ALREADY_MODERATED' });
  });

  it('counts only reviews without a live reply as unanswered', async () => {
    prisma.restaurantVenueReview.findMany.mockResolvedValue([]);
    prisma.restaurantVenueReview.count.mockResolvedValue(0);

    await responses.listVenueReviews(CONTEXT, { filter: 'unanswered' });

    const where = prisma.restaurantVenueReview.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      venueId: 'v1',
      status: 'APPROVED',
      responses: { none: { status: { in: ['PENDING', 'PUBLISHED'] } } },
    });
  });

  it('reports a review as answered only when a reply is pending or published', async () => {
    prisma.restaurantVenueReview.findMany.mockResolvedValue([
      {
        id: 'r1',
        rating: 2,
        photos: [],
        companions: [],
        source: 'TRAVIO_COMMUNITY',
        author: { name: 'Kofi', photoURL: null },
        responses: [{ ...responseRow({ status: 'REJECTED' }) }],
      },
    ]);
    prisma.restaurantVenueReview.count.mockResolvedValue(1);

    const data = await responses.listVenueReviews(CONTEXT, { filter: 'all' });

    expect(data.reviews[0].answered).toBe(false);
    expect(data.reviews[0].response.status).toBe('REJECTED');
  });
});
