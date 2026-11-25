/**
 * Rules that must hold even if every route and UI is bypassed: provenance,
 * the visit rules, and the aggregate/audit side effects of each transition.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  $transaction: jest.fn(),
  restaurantVenue: { findFirst: jest.fn() },
  restaurantVenueReview: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  restaurantVenueReviewReport: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  invalidateRestaurantVenueCaches: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(),
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueAggregation: jest.fn(),
}));

jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/cloudinaryHelper', () => ({
  isValidCloudinaryUrl: jest.fn((url) => String(url).includes('res.cloudinary.com')),
}));

jest.mock('../../src/core/services/restaurantVenueRatings', () => ({
  addApprovedRating: jest.fn(() => Promise.resolve()),
  removeApprovedRating: jest.fn(() => Promise.resolve()),
}));

const prisma = require('../../src/core/services/prismaClient');
const ratings = require('../../src/core/services/restaurantVenueRatings');
const { mintReviewProof } = require('../../src/core/services/restaurantReviewProof');
const { logActivity } = require('../../src/core/services/auditLogger');
const write = require('../../src/core/services/restaurantVenueWriteService');

const VENUE = { id: 'v1', slug: 'buka-accra', name: 'Buka', city: 'Accra' };
const AUTHOR = { id: 'u1', email: 'guest@example.com' };
const REQ = { headers: { 'user-agent': 'jest' }, ip: '127.0.0.1' };

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function reviewInput(over = {}) {
  return {
    rating: 5,
    title: 'Worth the queue',
    body: 'The jollof was smoky and the service was warm from start to finish.',
    companions: ['COUPLES'],
    visitedAt: daysAgo(3),
    ...over,
  };
}

describe('restaurantVenueWriteService', () => {
  const originalSecret = process.env.RESTAURANT_REVIEW_TOKEN_SECRET;

  beforeAll(() => {
    process.env.RESTAURANT_REVIEW_TOKEN_SECRET = 'test-review-secret';
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.RESTAURANT_REVIEW_TOKEN_SECRET;
    else process.env.RESTAURANT_REVIEW_TOKEN_SECRET = originalSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((fn) => fn(prisma));
    prisma.restaurantVenue.findFirst.mockResolvedValue(VENUE);
    prisma.restaurantVenueReview.findFirst.mockResolvedValue(null);
    prisma.restaurantVenueReview.findUnique.mockResolvedValue(null);
    prisma.restaurantVenueReview.create.mockImplementation((args) =>
      Promise.resolve({
        ...args.data,
        id: 'r1',
        createdAt: new Date(),
        author: { name: 'Guest', photoURL: '' },
      }),
    );
    prisma.restaurantVenueReview.update.mockImplementation((args) =>
      Promise.resolve({ ...args.data }),
    );
    prisma.restaurantVenueReviewReport.findFirst.mockResolvedValue(null);
    prisma.restaurantVenueReviewReport.create.mockImplementation((args) =>
      Promise.resolve({ ...args.data, id: 'rep1', status: 'OPEN', createdAt: new Date() }),
    );
    prisma.restaurantVenueReviewReport.findUnique.mockResolvedValue(null);
  });

  describe('createReview', () => {
    it('starts a community review as PENDING without touching the aggregate', async () => {
      const result = await write.createReview({
        slugOrId: 'buka-accra',
        brand: 'ghana',
        author: AUTHOR,
        input: reviewInput(),
        req: REQ,
      });

      const data = prisma.restaurantVenueReview.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        venueId: 'v1',
        authorId: 'u1',
        source: 'TRAVIO_COMMUNITY',
        status: 'PENDING',
        proofRef: null,
        proofMethod: null,
        visitKey: daysAgo(3).slice(0, 7),
        companions: ['COUPLES'],
      });
      expect(data.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.ipHash).not.toBe('127.0.0.1');
      expect(ratings.addApprovedRating).not.toHaveBeenCalled();
      expect(result.status).toBe('PENDING');
      expect(result.verified).toBe(false);
    });

    it('ignores client-supplied provenance and approves a signed invite', async () => {
      const invite = mintReviewProof({
        venueId: 'v1',
        proofMethod: 'QR_RECEIPT',
        visitDate: daysAgo(2),
      });

      const result = await write.createReview({
        slugOrId: 'buka-accra',
        brand: 'ghana',
        author: AUTHOR,
        input: reviewInput({
          proofToken: invite.token,
          source: 'IMPORTED',
          verified: false,
          status: 'REJECTED',
          visitedAt: daysAgo(300),
        }),
        req: REQ,
      });

      const data = prisma.restaurantVenueReview.create.mock.calls[0][0].data;
      expect(data.source).toBe('TRAVIO_VERIFIED');
      expect(data.status).toBe('APPROVED');
      expect(data.proofMethod).toBe('QR_RECEIPT');
      expect(data.proofRef).toBe(invite.proofRef);
      // The token's visit date wins over one the caller tried to supply.
      expect(data.visitedAt.toISOString().slice(0, 10)).toBe(daysAgo(2));
      expect(ratings.addApprovedRating).toHaveBeenCalledWith(prisma, 'v1', {
        rating: 5,
        verified: true,
      });
      expect(result.verified).toBe(true);
    });

    it('refuses a second review inside the 30-day cooldown', async () => {
      prisma.restaurantVenueReview.findFirst.mockResolvedValue({
        visitedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      });

      await expect(
        write.createReview({
          slugOrId: 'buka-accra',
          brand: 'ghana',
          author: AUTHOR,
          input: reviewInput({ visitedAt: daysAgo(1) }),
          req: REQ,
        }),
      ).rejects.toMatchObject({ errorCode: 'REVIEW_COOLDOWN', statusCode: 409 });
      expect(prisma.restaurantVenueReview.create).not.toHaveBeenCalled();
    });

    it('counts the cooldown from the last submission, not from an old visit', async () => {
      prisma.restaurantVenueReview.findFirst.mockResolvedValue({
        // The meal was months ago, but the review was posted yesterday.
        visitedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      });

      await expect(
        write.createReview({
          slugOrId: 'buka-accra',
          brand: 'ghana',
          author: AUTHOR,
          input: reviewInput({ visitedAt: daysAgo(119) }),
          req: REQ,
        }),
      ).rejects.toMatchObject({ errorCode: 'REVIEW_COOLDOWN' });
    });

    it('refuses a visit older than a year', async () => {
      await expect(
        write.createReview({
          slugOrId: 'buka-accra',
          brand: 'ghana',
          author: AUTHOR,
          input: reviewInput({ visitedAt: daysAgo(400) }),
          req: REQ,
        }),
      ).rejects.toMatchObject({ errorCode: 'VISIT_TOO_OLD' });
    });

    it('refuses a visit in the future', async () => {
      await expect(
        write.createReview({
          slugOrId: 'buka-accra',
          brand: 'ghana',
          author: AUTHOR,
          input: reviewInput({ visitedAt: daysAgo(-2) }),
          req: REQ,
        }),
      ).rejects.toMatchObject({ errorCode: 'VISIT_IN_FUTURE' });
    });

    it('turns a duplicate visit into a readable 409', async () => {
      prisma.restaurantVenueReview.create.mockRejectedValue({
        code: 'P2002',
        meta: { target: ['venueId', 'authorId', 'visitKey'] },
      });

      await expect(
        write.createReview({
          slugOrId: 'buka-accra',
          brand: 'ghana',
          author: AUTHOR,
          input: reviewInput(),
          req: REQ,
        }),
      ).rejects.toMatchObject({ errorCode: 'REVIEW_ALREADY_EXISTS', statusCode: 409 });
    });

    it('turns a redeemed invite into a readable 409', async () => {
      const invite = mintReviewProof({ venueId: 'v1', proofMethod: 'EMAIL_INVITE' });
      prisma.restaurantVenueReview.create.mockRejectedValue({
        code: 'P2002',
        meta: { target: 'proofRef' },
      });

      await expect(
        write.createReview({
          slugOrId: 'buka-accra',
          brand: 'ghana',
          author: AUTHOR,
          input: reviewInput({ proofToken: invite.token }),
          req: REQ,
        }),
      ).rejects.toMatchObject({ errorCode: 'PROOF_ALREADY_USED', statusCode: 409 });
    });

    it('refuses photos that were never uploaded', async () => {
      await expect(
        write.createReview({
          slugOrId: 'buka-accra',
          brand: 'ghana',
          author: AUTHOR,
          input: reviewInput({ photos: ['https://example.com/photo.jpg'] }),
          req: REQ,
        }),
      ).rejects.toMatchObject({ errorCode: 'INVALID_PHOTOS' });
    });
  });

  describe('deleteOwnReview', () => {
    it('archives the row, releases the visit slot and removes the rating', async () => {
      prisma.restaurantVenueReview.findFirst.mockResolvedValue({
        id: 'r1',
        venueId: 'v1',
        authorId: 'u1',
        status: 'APPROVED',
        rating: 5,
        source: 'TRAVIO_VERIFIED',
        visitKey: '2026-11',
      });

      const result = await write.deleteOwnReview({
        slugOrId: 'buka-accra',
        brand: 'ghana',
        reviewId: 'r1',
        author: AUTHOR,
        req: REQ,
      });

      expect(ratings.removeApprovedRating).toHaveBeenCalledWith(prisma, 'v1', {
        rating: 5,
        verified: true,
      });
      expect(prisma.restaurantVenueReview.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: expect.objectContaining({
          status: 'ARCHIVED',
          visitKey: '2026-11:a:r1',
        }),
      });
      expect(result).toEqual({ id: 'r1', status: 'ARCHIVED' });
    });

    it('does not let one author archive another author’s review', async () => {
      prisma.restaurantVenueReview.findFirst.mockResolvedValue(null);

      await expect(
        write.deleteOwnReview({
          slugOrId: 'buka-accra',
          brand: 'ghana',
          reviewId: 'r1',
          author: AUTHOR,
          req: REQ,
        }),
      ).rejects.toMatchObject({ errorCode: 'REVIEW_NOT_FOUND', statusCode: 404 });
    });
  });

  describe('replaceOwnReview', () => {
    const approved = {
      id: 'r1',
      venueId: 'v1',
      authorId: 'u1',
      status: 'APPROVED',
      rating: 5,
      source: 'TRAVIO_VERIFIED',
      proofMethod: 'QR_RECEIPT',
      proofRef: 'proof-1',
      visitKey: '2026-11',
      visitedAt: new Date('2026-11-02T00:00:00.000Z'),
      photos: [],
    };

    it('archives the old row, releases its proof and sends the replacement to moderation', async () => {
      prisma.restaurantVenueReview.findFirst.mockResolvedValue(approved);

      const result = await write.replaceOwnReview({
        slugOrId: 'buka-accra',
        brand: 'ghana',
        reviewId: 'r1',
        author: AUTHOR,
        input: reviewInput({ rating: 4 }),
        req: REQ,
      });

      expect(ratings.removeApprovedRating).toHaveBeenCalledWith(prisma, 'v1', {
        rating: 5,
        verified: true,
      });
      expect(prisma.restaurantVenueReview.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: expect.objectContaining({
          status: 'ARCHIVED',
          visitKey: '2026-11:u:r1',
          proofRef: 'proof-1:u:r1',
          flagReason: 'author_updated',
        }),
      });

      const data = prisma.restaurantVenueReview.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        source: 'TRAVIO_VERIFIED',
        proofMethod: 'QR_RECEIPT',
        proofRef: null,
        status: 'PENDING',
        visitKey: '2026-11',
        rating: 4,
        companions: ['COUPLES'],
      });
      expect(result).toMatchObject({ status: 'PENDING', verified: true, rating: 4 });
    });

    it('does not let one author replace another author’s review', async () => {
      prisma.restaurantVenueReview.findFirst.mockResolvedValue(null);

      await expect(
        write.replaceOwnReview({
          slugOrId: 'buka-accra',
          brand: 'ghana',
          reviewId: 'r1',
          author: AUTHOR,
          input: reviewInput(),
          req: REQ,
        }),
      ).rejects.toMatchObject({ errorCode: 'REVIEW_NOT_FOUND', statusCode: 404 });
      expect(prisma.restaurantVenueReview.create).not.toHaveBeenCalled();
    });
  });

  describe('moderateReview', () => {
    const baseReview = {
      id: 'r1',
      venueId: 'v1',
      authorId: 'u2',
      rating: 4,
      source: 'TRAVIO_COMMUNITY',
      status: 'PENDING',
      visitedAt: new Date(Date.now() - 3 * 86400000),
      title: 'Good',
      body: null,
      photos: [],
      proofMethod: null,
      createdAt: new Date(),
      venue: VENUE,
    };

    it('adds the rating when a pending review is approved', async () => {
      prisma.restaurantVenueReview.findUnique.mockResolvedValue(baseReview);

      const result = await write.moderateReview({
        reviewId: 'r1',
        adminId: 'admin1',
        action: 'approve',
        req: REQ,
      });

      expect(ratings.addApprovedRating).toHaveBeenCalledWith(prisma, 'v1', {
        rating: 4,
        verified: false,
      });
      expect(result.status).toBe('APPROVED');
    });

    it('removes the rating when an approved review is rejected', async () => {
      prisma.restaurantVenueReview.findUnique.mockResolvedValue({
        ...baseReview,
        status: 'APPROVED',
      });

      await write.moderateReview({
        reviewId: 'r1',
        adminId: 'admin1',
        action: 'reject',
        reason: 'Not a first-hand visit',
        req: REQ,
      });

      expect(ratings.removeApprovedRating).toHaveBeenCalled();
      expect(prisma.restaurantVenueReview.update.mock.calls[0][0].data.status).toBe('REJECTED');
    });

    it('does not resurrect a review the author archived', async () => {
      prisma.restaurantVenueReview.findUnique.mockResolvedValue({
        ...baseReview,
        status: 'ARCHIVED',
      });

      await expect(
        write.moderateReview({
          reviewId: 'r1',
          adminId: 'admin1',
          action: 'approve',
          req: REQ,
        }),
      ).rejects.toMatchObject({ errorCode: 'REVIEW_NOT_ACTIVE', statusCode: 409 });
      expect(ratings.addApprovedRating).not.toHaveBeenCalled();
    });

    it('does not double-count when flagging a review that was already hidden', async () => {
      prisma.restaurantVenueReview.findUnique.mockResolvedValue(baseReview);

      await write.moderateReview({
        reviewId: 'r1',
        adminId: 'admin1',
        action: 'flag',
        reason: 'Needs a second look',
        req: REQ,
      });

      expect(ratings.addApprovedRating).not.toHaveBeenCalled();
      expect(ratings.removeApprovedRating).not.toHaveBeenCalled();
    });
  });

  describe('reports', () => {
    const reportedReview = {
      id: 'r1',
      venueId: 'v1',
      authorId: 'u2',
      rating: 5,
      source: 'TRAVIO_VERIFIED',
      status: 'APPROVED',
      venue: VENUE,
    };

    it('opens a report and increments the counter', async () => {
      prisma.restaurantVenueReview.findFirst.mockResolvedValue(reportedReview);

      const report = await write.submitReport({
        slugOrId: 'buka-accra',
        brand: 'ghana',
        reviewId: 'r1',
        reporter: AUTHOR,
        input: { reason: 'Not a real visit', detail: 'They never ate there' },
        req: REQ,
      });

      expect(report).toMatchObject({ status: 'OPEN', classification: null });
      expect(prisma.restaurantVenueReview.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { reportCount: { increment: 1 } },
      });
    });

    it('refuses a report by the review author', async () => {
      prisma.restaurantVenueReview.findFirst.mockResolvedValue({
        ...reportedReview,
        authorId: AUTHOR.id,
      });

      await expect(
        write.submitReport({
          slugOrId: 'buka-accra',
          brand: 'ghana',
          reviewId: 'r1',
          reporter: AUTHOR,
          input: { reason: 'I want my five stars back' },
          req: REQ,
        }),
      ).rejects.toMatchObject({ errorCode: 'CANNOT_REPORT_OWN_REVIEW' });
    });

    it('removes a review only for an upheld FAKE report', async () => {
      prisma.restaurantVenueReviewReport.findUnique.mockResolvedValue({
        id: 'rep1',
        reviewId: 'r1',
        reason: 'No such visit',
        status: 'OPEN',
        review: reportedReview,
      });

      const result = await write.resolveReport({
        reportId: 'rep1',
        adminId: 'admin1',
        classification: 'FAKE',
        outcome: 'UPHELD',
        req: REQ,
      });

      expect(ratings.removeApprovedRating).toHaveBeenCalled();
      expect(prisma.restaurantVenueReview.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: expect.objectContaining({ status: 'REMOVED' }),
      });
      expect(result.reviewStatus).toBe('REMOVED');
    });

    it('keeps the review when a CONTESTED report is upheld', async () => {
      prisma.restaurantVenueReviewReport.findUnique.mockResolvedValue({
        id: 'rep1',
        reviewId: 'r1',
        reason: 'The food was not that bad',
        status: 'OPEN',
        review: reportedReview,
      });

      const result = await write.resolveReport({
        reportId: 'rep1',
        adminId: 'admin1',
        classification: 'CONTESTED',
        outcome: 'UPHELD',
        req: REQ,
      });

      expect(prisma.restaurantVenueReview.update).not.toHaveBeenCalled();
      expect(ratings.removeApprovedRating).not.toHaveBeenCalled();
      expect(result.reviewStatus).toBe('APPROVED');
    });
  });

  it('mints an invite without writing the token to the audit log', async () => {
    const invite = await write.createInvite({
      slugOrId: 'buka-accra',
      brand: 'ghana',
      adminId: 'admin1',
      input: { proofMethod: 'EMAIL_INVITE', email: 'guest@example.com' },
      req: REQ,
    });

    expect(invite.token).toContain('.');
    const logged = JSON.stringify(logActivity.mock.calls[0][0]);
    expect(logged).not.toContain(invite.token);
  });
});
