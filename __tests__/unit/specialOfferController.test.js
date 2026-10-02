jest.mock('../../src/core/services/prismaClient', () => ({
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

jest.mock('../../src/core/services/cacheHelper', () => {
  const invalidateTourCaches = jest.fn(async () => {});
  const invalidateKey = jest.fn(async () => {});
  return {
    invalidateTourCaches,
    invalidateKey,
    TOUR_DETAIL_PREFIX: (id) => `tour:${id}`,
  };
});

jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(async () => {}) }));

const prisma = require('../../src/core/services/prismaClient');
const cacheHelper = require('../../src/core/services/cacheHelper');
const { createOffer, updateOffer, getOffers } = require('../../src/core/domain/specialOfferController');

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

  describe('inclusive end-date semantics', () => {
    // `computeStatus` compares against the real clock, so anchor the fixtures
    // to whole UTC days relative to now: "today" must read active, "yesterday"
    // must read expired.
    function endOfUtcDayOffset(offset) {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, 23, 59, 59, 999));
    }

    function captureJson(fn, r) {
      return new Promise((resolve) => {
        const next = (err) => resolve({ error: err });
        const res = {
          json: jest.fn((payload) => resolve({ json: payload })),
          status: jest.fn(() => res),
        };
        fn(r, res, next).catch((err) => resolve({ error: err }));
      });
    }

    function statusOffer(endDate) {
      return {
        id: 'offer-1',
        name: 'Sale',
        offerType: 'LIMITED_TIME',
        isActive: true,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        endDate,
        discountType: 'PERCENTAGE',
        discountPercentage: 10,
        capacityType: 'UNLIMITED',
        maxSpots: null,
        spotsSold: 0,
        targets: [],
      };
    }

    it('stores createOffer endDate at the last millisecond of the chosen UTC day', async () => {
      const result = await run(createOffer, req(VALID_BODY));

      expect(result.error).toBeUndefined();
      const data = mockTx.specialOffer.create.mock.calls[0][0].data;
      expect(data.endDate.toISOString()).toBe('2026-09-01T23:59:59.999Z');
      // The start date keeps its start-of-day meaning.
      expect(data.startDate.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    it('accepts an offer that starts and ends on the same day', async () => {
      const body = { ...VALID_BODY, startDate: '2026-08-01T00:00:00Z', endDate: '2026-08-01T00:00:00Z' };

      const result = await run(createOffer, req(body));

      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.create).toHaveBeenCalled();
      expect(mockTx.specialOffer.create.mock.calls[0][0].data.endDate.toISOString()).toBe('2026-08-01T23:59:59.999Z');
    });

    it('rejects an unparseable end date rather than storing Invalid Date', async () => {
      const result = await run(createOffer, req({ ...VALID_BODY, endDate: 'not-a-date' }));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
      expect(mockTx.specialOffer.create).not.toHaveBeenCalled();
    });

    it('stores updateOffer endDate at the last millisecond of the chosen UTC day', async () => {
      const result = await run(updateOffer, req({ endDate: '2026-12-15T00:00:00Z' }, { params: { id: 'offer-1' } }));

      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.update.mock.calls[0][0].data.endDate.toISOString()).toBe('2026-12-15T23:59:59.999Z');
    });

    it('leaves endDate alone when the update does not send one', async () => {
      const result = await run(updateOffer, req({ discountPercentage: 25 }, { params: { id: 'offer-1' } }));

      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.update.mock.calls[0][0].data.endDate).toBeUndefined();
    });

    it('reports an offer as active through the whole of its end date', async () => {
      prisma.specialOffer.findMany.mockResolvedValue([statusOffer(endOfUtcDayOffset(0))]);

      const { json } = await captureJson(getOffers, req({}, { query: {} }));

      expect(json.data.offers[0].status).toBe('active');
    });

    it('reports an offer as expired once its end day has fully passed', async () => {
      prisma.specialOffer.findMany.mockResolvedValue([statusOffer(endOfUtcDayOffset(-1))]);

      const { json } = await captureJson(getOffers, req({}, { query: {} }));

      expect(json.data.offers[0].status).toBe('expired');
    });
  });

  describe('weekday-limited offers', () => {
    it('rejects creating a weekday offer with no weekdays selected', async () => {
      const result = await run(createOffer, req({
        ...VALID_BODY,
        timeSlotMode: 'SPECIFIC_WEEKDAYS',
        specificWeekdays: [],
      }));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toMatch(/weekday/i);
      expect(mockTx.specialOffer.create).not.toHaveBeenCalled();
    });

    it('accepts a weekday offer with at least one weekday', async () => {
      const result = await run(createOffer, req({
        ...VALID_BODY,
        timeSlotMode: 'SPECIFIC_WEEKDAYS',
        specificWeekdays: ['monday', 'friday'],
      }));

      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.create.mock.calls[0][0].data.specificWeekdays).toEqual(['monday', 'friday']);
    });

    // The engine compares against the lowercase output of new Date().getDay(),
    // so a payload of "Monday" would store cleanly and then never match a
    // single date — an offer that silently never applies.
    it('normalises weekday casing so the engine can actually match it', async () => {
      const result = await run(createOffer, req({
        ...VALID_BODY,
        timeSlotMode: 'SPECIFIC_WEEKDAYS',
        specificWeekdays: ['Monday', '  FRIDAY  '],
      }));

      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.create.mock.calls[0][0].data.specificWeekdays).toEqual(['monday', 'friday']);
    });

    it('rejects an unrecognised weekday name rather than storing a never-matching offer', async () => {
      const result = await run(createOffer, req({
        ...VALID_BODY,
        timeSlotMode: 'SPECIFIC_WEEKDAYS',
        specificWeekdays: ['funday'],
      }));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toMatch(/funday/);
      expect(mockTx.specialOffer.create).not.toHaveBeenCalled();
    });

    it('does not require weekdays when the offer applies all days', async () => {
      const result = await run(createOffer, req({ ...VALID_BODY, timeSlotMode: 'ALL_DAYS', specificWeekdays: [] }));

      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.create).toHaveBeenCalled();
    });

    it('rejects an update that empties the weekday list', async () => {
      prisma.specialOffer.findFirst.mockResolvedValue({
        id: 'offer-1',
        name: 'Sale',
        supplierId: 'supplier-1',
        offerType: 'LIMITED_TIME',
        discountType: 'PERCENTAGE',
        discountPercentage: 15,
        capacityType: 'UNLIMITED',
        promoCode: null,
        timeSlotMode: 'SPECIFIC_WEEKDAYS',
        specificWeekdays: ['monday'],
        startDate: new Date('2026-08-01T00:00:00Z'),
        endDate: new Date('2026-09-01T23:59:59.999Z'),
        targets: [{ tourId: 'tour-1', tourOptionKey: null }],
      });

      const result = await run(
        updateOffer,
        req({ timeSlotMode: 'SPECIFIC_WEEKDAYS', specificWeekdays: [] }, { params: { id: 'offer-1' } })
      );

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toMatch(/weekday/i);
      expect(mockTx.specialOffer.update).not.toHaveBeenCalled();
    });
  });

  describe('offer name validation', () => {
    beforeEach(() => {
      prisma.specialOffer.findFirst.mockResolvedValue({
        id: 'offer-1',
        name: 'Summer Sale',
        supplierId: 'supplier-1',
        offerType: 'LIMITED_TIME',
        discountType: 'PERCENTAGE',
        discountPercentage: 15,
        capacityType: 'UNLIMITED',
        promoCode: null,
        startDate: new Date('2026-08-01T00:00:00Z'),
        endDate: new Date('2026-09-01T23:59:59.999Z'),
        targets: [{ tourId: 'tour-1', tourOptionKey: null }],
      });
    });

    // createOffer rejected a blank name; updateOffer never did, so a PUT could
    // wipe an offer's name while every other field passed validation.
    it('rejects a blanked name on update', async () => {
      const result = await run(updateOffer, req({ name: '   ' }, { params: { id: 'offer-1' } }));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toMatch(/name/i);
      expect(mockTx.specialOffer.update).not.toHaveBeenCalled();
    });

    it('rejects a name longer than the 60 characters the builder advertises', async () => {
      const result = await run(createOffer, req({ ...VALID_BODY, name: 'x'.repeat(61) }));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toMatch(/60/);
      expect(mockTx.specialOffer.create).not.toHaveBeenCalled();
    });

    it('rejects an over-long name on update too', async () => {
      const result = await run(updateOffer, req({ name: 'x'.repeat(61) }, { params: { id: 'offer-1' } }));

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.statusCode).toBe(400);
      expect(mockTx.specialOffer.update).not.toHaveBeenCalled();
    });

    it('still accepts a normal name on update', async () => {
      const result = await run(updateOffer, req({ name: '  Autumn Sale  ' }, { params: { id: 'offer-1' } }));

      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.update.mock.calls[0][0].data.name).toBe('Autumn Sale');
    });

    it('ignores an omitted name instead of rejecting the whole update', async () => {
      const result = await run(updateOffer, req({ discountPercentage: 20 }, { params: { id: 'offer-1' } }));

      expect(result.error).toBeUndefined();
      expect(mockTx.specialOffer.update.mock.calls[0][0].data.name).toBeUndefined();
    });
  });

  // There are two status producers in the backend — the shared controller and
  // the supplier-scoped list. The list page reads one, the detail modal and
  // builder read the other. If they ever disagree, the badge a supplier sees
  // after saving contradicts the one they saw while editing.
  describe('status parity between the shared controller and the supplier list', () => {
    const d = (offset) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000);

    // Local copy: the file's captureJson is scoped to the sibling describe.
    function captureJsonOnce(fn, r) {
      return new Promise((resolve) => {
        const next = (err) => resolve({ error: err });
        const res = {
          json: jest.fn((payload) => resolve({ json: payload })),
          status: jest.fn(() => res),
        };
        fn(r, res, next).catch((err) => resolve({ error: err }));
      });
    }
    const row = (overrides) => ({
      id: 'offer-1',
      name: 'Sale',
      offerType: 'LIMITED_TIME',
      isActive: true,
      startDate: d(-30),
      endDate: d(1),
      discountType: 'PERCENTAGE',
      discountPercentage: 10,
      capacityType: 'UNLIMITED',
      maxSpots: null,
      spotsSold: 0,
      targets: [],
      ...overrides,
    });

    it('reports the same status from both endpoints for every state', async () => {
      // src/core/supplier exports a factory, and getSpecialOffers lives on the
      // controller it returns.
      const makeSupplierController = require('../../src/core/supplier');
      const supplierController = makeSupplierController('ghana');

      const rows = [
        row({ id: 'a', isActive: false, startDate: d(-30), endDate: d(-1) }),
        row({ id: 'b', isActive: false, startDate: d(-30), endDate: d(1) }),
        row({ id: 'c', isActive: true, startDate: d(-30), endDate: d(1) }),
        row({ id: 'd', isActive: true, startDate: d(1), endDate: d(5) }),
        row({ id: 'e', isActive: true, startDate: d(-30), endDate: d(-1) }),
      ];
      prisma.specialOffer.findMany.mockResolvedValue(rows);

      const shared = await captureJsonOnce(getOffers, req({}, { query: {} }));
      const listed = await captureJsonOnce(supplierController.getSpecialOffers, req({}));

      expect(shared.error).toBeUndefined();
      expect(listed.error).toBeUndefined();

      const fromShared = shared.json.data.offers.map((o) => o.status);
      const fromList = listed.json.data.offers.map((o) => o.status);

      expect(fromShared).toEqual(['expired', 'expired', 'active', 'scheduled', 'expired']);
      expect(fromList).toEqual(fromShared);
    });
  });
});