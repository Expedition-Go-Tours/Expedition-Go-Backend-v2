jest.mock('../../src/core/services/restaurantVenueService', () => ({
  listVenues: jest.fn(),
  getVenue: jest.fn(),
  resolveVenueId: jest.fn(),
  listReviews: jest.fn(),
}));

jest.mock('../../src/core/services/restaurantVenueWriteService', () => ({
  createReview: jest.fn(),
  deleteOwnReview: jest.fn(),
  submitReport: jest.fn(),
  listPendingReviews: jest.fn(),
  moderateReview: jest.fn(),
  resolveReport: jest.fn(),
  createInvite: jest.fn(),
}));

const service = require('../../src/core/services/restaurantVenueService');
const writeService = require('../../src/core/services/restaurantVenueWriteService');
const controller = require('../../src/core/domain/restaurantVenueController');

function mockRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('restaurantVenueController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the list payload under the standard envelope', async () => {
    const data = { venues: [], pagination: { limit: 20, hasMore: false, nextCursor: null } };
    service.listVenues.mockResolvedValue(data);
    const res = mockRes();

    await controller.listVenues({ query: { brand: 'ghana' } }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'success', data });
  });

  it('404s a venue that is not listed for the brand', async () => {
    service.getVenue.mockResolvedValue(null);
    const next = jest.fn();

    await controller.getVenue(
      { params: { slugOrId: 'missing' }, query: { brand: 'ghana' } },
      mockRes(),
      next,
    );

    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(404);
    expect(error.errorCode).toBe('VENUE_NOT_FOUND');
  });

  it('resolves the venue id before listing reviews', async () => {
    service.resolveVenueId.mockResolvedValue('v1');
    service.listReviews.mockResolvedValue({
      reviews: [],
      distribution: null,
      pagination: { limit: 10, hasMore: false, nextCursor: null },
    });
    const res = mockRes();

    await controller.listReviews(
      { params: { slugOrId: 'buka' }, query: { brand: 'ghana', limit: 10 } },
      res,
      jest.fn(),
    );

    expect(service.listReviews).toHaveBeenCalledWith('v1', {
      limit: 10,
      cursor: undefined,
      rating: undefined,
      verified: undefined,
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        data: expect.objectContaining({ venueId: 'v1' }),
      }),
    );
  });

  it('404s reviews for an unknown venue instead of returning an empty list', async () => {
    service.resolveVenueId.mockResolvedValue(null);
    const next = jest.fn();

    await controller.listReviews(
      { params: { slugOrId: 'missing' }, query: { brand: 'ghana' } },
      mockRes(),
      next,
    );

    expect(service.listReviews).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(404);
  });

  it('passes the authenticated author through to the review write service', async () => {
    const author = { id: 'u1', email: 'guest@example.com' };
    writeService.createReview.mockResolvedValue({ id: 'r1', status: 'PENDING' });
    const res = mockRes();
    const req = {
      params: { slugOrId: 'buka' },
      query: { brand: 'ghana' },
      body: { rating: 5, body: 'A long enough review.' },
      user: author,
    };

    await controller.createReview(req, res, jest.fn());

    expect(writeService.createReview).toHaveBeenCalledWith({
      slugOrId: 'buka',
      brand: 'ghana',
      author,
      input: req.body,
      req,
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('never takes an author id from the request body on delete', async () => {
    writeService.deleteOwnReview.mockResolvedValue({ id: 'r1', status: 'ARCHIVED' });
    const req = {
      params: { slugOrId: 'buka', reviewId: 'r1' },
      query: { brand: 'ghana' },
      body: { authorId: 'someone-else' },
      user: { id: 'u1' },
    };

    await controller.deleteReview(req, mockRes(), jest.fn());

    expect(writeService.deleteOwnReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'r1', author: { id: 'u1' } }),
    );
  });

  it('uses the admin identity from the token for moderation and report decisions', async () => {
    writeService.moderateReview.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
    writeService.resolveReport.mockResolvedValue({ id: 'rep1', reviewStatus: 'REMOVED' });
    const req = {
      params: { reviewId: 'r1' },
      body: { action: 'approve', reason: 'Looks first-hand' },
      user: { id: 'admin1' },
    };

    await controller.moderateReview(req, mockRes(), jest.fn());
    await controller.resolveReport(
      {
        params: { reportId: 'rep1' },
        body: { classification: 'FAKE', outcome: 'UPHELD' },
        user: { id: 'admin1' },
      },
      mockRes(),
      jest.fn(),
    );

    expect(writeService.moderateReview).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: 'admin1', action: 'approve' }),
    );
    expect(writeService.resolveReport).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: 'admin1', classification: 'FAKE' }),
    );
  });
});
