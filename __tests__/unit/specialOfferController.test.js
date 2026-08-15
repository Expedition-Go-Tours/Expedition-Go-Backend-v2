jest.mock('../../utils/prismaClient', () => ({
  tour: { findMany: jest.fn() },
  specialOffer: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn((fn) => fn(mockTx)),
}));

let mockTx;

jest.mock('../../utils/cacheHelper', () => {
  const invalidateTourCaches = jest.fn(async () => {});
  const invalidateKey = jest.fn(async () => {});
  return {
    invalidateTourCaches,
    invalidateKey,
    TOUR_DETAIL_PREFIX: (id) => `tour:${id}`,
  };
});

jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(async () => {}) }));

const prisma = require('../../utils/prismaClient');
const cacheHelper = require('../../utils/cacheHelper');
const { createOffer, updateOffer } = require('../../controllers/specialOfferController');

const VALID_BODY = {
  name: 'Summer Sale',
  offerType: 'LIMITED_TIME',
  startDate: '2026-08-01T00:00:00Z',
  endDate: '2026-09-01T00:00:00Z',
  discountType: 'PERCENTAGE',
  discountPercentage: 15,
  targets: [{ tourId: 'tour-1' }],
};

function req(body = {}, overrides = {}) {
  return { body, supplierId: 'supplier-1', user: { id: 'user-1' }, ...overrides };
}

function run(fn, r) {
  return new Promise((resolve) => {
    const next = (err) => resolve({ error: err });
    const res = {
      json: jest.fn(() => resolve({ json: true })),
      status: jest.fn(() => res),
    };
    fn(r, res, next).catch((err) => resolve({ error: err }));
  });
}

describe('specialOfferController validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTx = {
      specialOffer: {
        create: jest.fn().mockResolvedValue({ id: 'offer-1', targets: [] }),
        update: jest.fn().mockResolvedValue({ id: 'offer-1', targets: [] }),
      },
      specialOfferTarget: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation((fn) => fn(mockTx));
    prisma.tour.findMany.mockResolvedValue([
      { id: 'tour-1', title: 'Safari', supplierId: 'supplier-1', status: 'ACTIVE' },
    ]);
    prisma.specialOffer.findMany.mockResolvedValue([]);
    prisma.specialOffer.findUnique.mockResolvedValue(null);
  });

  describe('createOffer', () => {
    it('creates an offer for owned published tours', async () => {
      const result = await run(createOffer, req(VALID_BODY));
      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.create).toHaveBeenCalled();
    });

    it('rejects targeting a tour owned by another supplier', async () => {
      prisma.tour.findMany.mockResolvedValue([
        { id: 'tour-1', title: 'Safari', supplierId: 'supplier-999', status: 'ACTIVE' },
      ]);

      const result = await run(createOffer, req(VALID_BODY));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
      expect(mockTx.specialOffer.create).not.toHaveBeenCalled();
    });

    it('rejects targeting an unpublished tour', async () => {
      prisma.tour.findMany.mockResolvedValue([
        { id: 'tour-1', title: 'Draft Safari', supplierId: 'supplier-1', status: 'DRAFT' },
      ]);

      const result = await run(createOffer, req(VALID_BODY));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
    });

    it('rejects an offer that overlaps another active offer on the same tour', async () => {
      prisma.specialOffer.findMany.mockResolvedValue([
        {
          id: 'offer-existing',
          name: 'Other Sale',
          offerType: 'LIMITED_TIME',
          startDate: new Date('2026-08-15T00:00:00Z'),
          endDate: new Date('2026-09-15T00:00:00Z'),
          targets: [{ tourId: 'tour-1', tourOptionKey: null }],
        },
      ]);

      const result = await run(createOffer, req(VALID_BODY));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(409);
      expect(mockTx.specialOffer.create).not.toHaveBeenCalled();
    });

    it('allows a window that does not overlap', async () => {
      prisma.specialOffer.findMany.mockResolvedValue([
        {
          id: 'offer-existing',
          name: 'Old Sale',
          offerType: 'LIMITED_TIME',
          startDate: new Date('2026-07-01T00:00:00Z'),
          endDate: new Date('2026-07-31T00:00:00Z'),
          targets: [{ tourId: 'tour-1', tourOptionKey: null }],
        },
      ]);

      const result = await run(createOffer, req(VALID_BODY));

      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.create).toHaveBeenCalled();
    });

    it('rejects capped offers without maxSpots', async () => {
      const body = { ...VALID_BODY, capacityType: 'CAPPED' };

      const result = await run(createOffer, req(body));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
    });

    it('rejects LIMITED_TIME offers without dates', async () => {
      const body = { ...VALID_BODY, startDate: undefined, endDate: undefined };

      const result = await run(createOffer, req(body));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
    });

    it('rejects empty targets', async () => {
      const body = { ...VALID_BODY, targets: [] };

      const result = await run(createOffer, req(body));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
    });
  });

  describe('updateOffer', () => {
    beforeEach(() => {
      prisma.specialOffer.findFirst.mockResolvedValue({
        id: 'offer-1',
        name: 'Summer Sale',
        supplierId: 'supplier-1',
        offerType: 'LIMITED_TIME',
        discountType: 'PERCENTAGE',
        discountPercentage: 15,
        capacityType: 'UNLIMITED',
        claims: 0,
        promoCode: null,
        startDate: new Date('2026-08-01T00:00:00Z'),
        endDate: new Date('2026-09-01T00:00:00Z'),
        targets: [{ tourId: 'tour-1', tourOptionKey: null }],
      });
    });

    it('rejects wiping all targets', async () => {
      const result = await run(updateOffer, req({ targets: [] }, { params: { id: 'offer-1' } }));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
    });

    it('rejects switching to CAPPED without maxSpots', async () => {
      const result = await run(updateOffer, req({ capacityType: 'CAPPED' }, { params: { id: 'offer-1' } }));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
    });

    it('rejects an update that would overlap a different active offer', async () => {
      prisma.specialOffer.findMany.mockResolvedValue([
        {
          id: 'offer-other',
          name: 'Other Sale',
          offerType: 'LIMITED_TIME',
          startDate: new Date('2026-08-15T00:00:00Z'),
          endDate: new Date('2026-12-01T00:00:00Z'),
          targets: [{ tourId: 'tour-1', tourOptionKey: null }],
        },
      ]);

      const result = await run(updateOffer, req({ endDate: '2026-12-15T00:00:00Z' }, { params: { id: 'offer-1' } }));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(409);
      expect(mockTx.specialOffer.update).not.toHaveBeenCalled();
    });

    it("does not treat the offer's own window as a conflict", async () => {
      prisma.specialOffer.findMany.mockResolvedValue([
        {
          id: 'offer-other',
          name: 'Other Sale',
          offerType: 'LIMITED_TIME',
          startDate: new Date('2026-08-15T00:00:00Z'),
          endDate: new Date('2026-12-01T00:00:00Z'),
          targets: [{ tourId: 'tour-1', tourOptionKey: 'other-option' }],
        },
      ]);

      const result = await run(updateOffer, req({ endDate: '2026-12-15T00:00:00Z' }, { params: { id: 'offer-1' } }));

      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.update).toHaveBeenCalled();
    });

    it('accepts a valid update', async () => {
      const result = await run(updateOffer, req({ discountPercentage: 25 }, { params: { id: 'offer-1' } }));

      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.update).toHaveBeenCalled();
    });
  });
});