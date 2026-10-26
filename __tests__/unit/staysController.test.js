jest.mock('../../src/core/services/prismaClient', () => ({
  stayProperty: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  },
  stayAvailabilityOverride: {
    findMany: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  stayBooking: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
  },
  stayReview: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn(),
  },
  stayOffer: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  },
  stayOfferTarget: {
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  $transaction: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const controller = require('../../src/brands/ghana/staysController');

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

const NOW = new Date('2026-10-26T12:00:00.000Z');

function row(overrides = {}) {
  return {
    id: 'sp-1',
    supplierId: 'sup-1',
    name: 'Akwaaba Coast Hotel',
    type: 'Hotel',
    city: 'Accra',
    country: 'Ghana',
    status: 'DRAFT',
    step: 1,
    data: {
      photos: [],
      rooms: [],
      ratePlans: [],
      currency: 'GHS',
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('staysController helpers', () => {
  it('maps database statuses to the dashboard vocabulary', () => {
    expect(controller._private.displayStatus('DRAFT')).toBe('Draft');
    expect(controller._private.displayStatus('PENDING_APPROVAL')).toBe('Under review');
    expect(controller._private.displayStatus('ACTIVE')).toBe('Live');
    expect(controller._private.displayStatus('INACTIVE')).toBe('Paused');
    expect(controller._private.enumStatus('Live')).toBe('ACTIVE');
    expect(controller._private.enumStatus('All')).toBeNull();
  });

  it('strips protected fields from autosave payloads', () => {
    const clean = controller._private.sanitizePropertyPayload({
      name: 'New name',
      status: 'ACTIVE',
      supplierId: 'other',
      id: 'hack',
      data: { hacked: true },
      description: 'safe',
    });
    expect(clean).toEqual({ name: 'New name', description: 'safe' });
  });

  it('clamps the builder step to 0..17', () => {
    expect(controller._private.clampStep(-5)).toBe(0);
    expect(controller._private.clampStep(99)).toBe(17);
    expect(controller._private.clampStep('4')).toBe(4);
    expect(controller._private.clampStep('nope', 3)).toBe(3);
  });

  it('serializes a row with display status and zero bookings', () => {
    const out = controller._private.serializeProperty(row({ status: 'ACTIVE', step: 17 }));
    expect(out).toEqual(expect.objectContaining({
      id: 'sp-1',
      name: 'Akwaaba Coast Hotel',
      status: 'Live',
      step: 17,
      bookings: 0,
      currency: 'GHS',
    }));
  });
});

describe('staysController endpoints', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { supplierId: 'sup-1', body: {}, query: {}, params: {} };
    res = makeRes();
    next = jest.fn();
    prisma.stayBooking.findMany.mockResolvedValue([]);
  });

  it('returns dashboard counts with zeroed booking data', async () => {
    prisma.stayProperty.findMany.mockResolvedValue([
      row({ id: 'sp-1', status: 'ACTIVE', data: { rooms: [{ id: 'r1' }], currency: 'GHS' } }),
      row({ id: 'sp-2', status: 'DRAFT' }),
    ]);

    await controller.getDashboard(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      data: expect.objectContaining({
        stats: expect.objectContaining({ liveProperties: 1, grossBookingValue: 0 }),
        actionRequired: expect.objectContaining({ draftProperties: 1 }),
        recentBookings: [],
      }),
    });
  });

  it('creates a draft with defaults and ignores protected fields', async () => {
    prisma.stayProperty.create.mockImplementation(({ data }) => Promise.resolve(row(data)));

    req.body = {
      name: '  Test Stay  ',
      type: 'Apartment',
      city: 'Accra',
      step: 3,
      status: 'ACTIVE',
      supplierId: 'attacker',
      data: { hacked: true },
    };

    await controller.createProperty(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const payload = prisma.stayProperty.create.mock.calls[0][0].data;
    expect(payload).toEqual(expect.objectContaining({
      supplierId: 'sup-1',
      name: 'Test Stay',
      type: 'Apartment',
      city: 'Accra',
      status: 'DRAFT',
      step: 3,
    }));
    expect(payload.data.status).toBeUndefined();
    expect(payload.data.hacked).toBeUndefined();
    expect(payload.data.photos).toEqual([]);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('merges autosave patches without letting status or ownership change', async () => {
    const existing = row({ data: { photos: [], rooms: [], ratePlans: [], description: 'old' } });
    prisma.stayProperty.findFirst.mockResolvedValue(existing);
    prisma.stayProperty.update.mockImplementation(({ data }) => Promise.resolve({ ...existing, ...data }));

    req.params = { id: 'sp-1' };
    req.body = {
      name: 'Renamed',
      description: 'new',
      step: 5,
      status: 'ACTIVE',
      supplierId: 'attacker',
    };

    await controller.updateProperty(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const update = prisma.stayProperty.update.mock.calls[0][0];
    expect(update.data.name).toBe('Renamed');
    expect(update.data.step).toBe(5);
    expect(update.data.status).toBeUndefined();
    expect(update.data.data.description).toBe('new');
    expect(update.data.data.status).toBeUndefined();
    expect(update.data.data.supplierId).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 404 when a property belongs to another supplier', async () => {
    prisma.stayProperty.findFirst.mockResolvedValue(null);

    req.params = { id: 'sp-1' };
    await controller.getProperty(req, res, next);

    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].statusCode).toBe(404);
  });

  it('refuses to publish an incomplete property', async () => {
    prisma.stayProperty.findFirst.mockResolvedValue(row({ name: 'Untitled property' }));

    req.params = { id: 'sp-1' };
    await controller.submitProperty(req, res, next);

    expect(prisma.stayProperty.update).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(next.mock.calls[0][0].message).toMatch(/Cannot publish property/);
  });

  it('auto-publishes a complete property', async () => {
    const complete = row({
      name: 'Complete Stay',
      data: {
        city: 'Accra',
        address: '12 Test Street',
        lat: 5.56,
        lng: -0.18,
        photos: ['a', 'b', 'c', 'd', 'e'],
        rooms: [{ id: 'r1' }],
        ratePlans: [{ id: 'p1', roomId: 'r1' }],
        pricePerNight: '120',
        startMode: 'asap',
        longStays: 'No',
        agreement: { certifyBusiness: true, certifyTerms: true },
      },
    });
    prisma.stayProperty.findFirst.mockResolvedValue(complete);
    prisma.stayProperty.update.mockResolvedValue({ ...complete, status: 'ACTIVE', step: 17 });

    req.params = { id: 'sp-1' };
    await controller.submitProperty(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.stayProperty.update).toHaveBeenCalledWith({
      where: { id: 'sp-1' },
      data: { status: 'ACTIVE', step: 17 },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: { property: expect.objectContaining({ status: 'Live', step: 17 }) },
    }));
  });

  it('keeps at least one rate plan per room', async () => {
    prisma.stayProperty.findFirst.mockResolvedValue(row({
      data: {
        rooms: [{ id: 'r1' }],
        ratePlans: [{ id: 'p1', roomId: 'r1' }],
      },
    }));

    req.params = { id: 'sp-1', planId: 'p1' };
    await controller.deleteRatePlan(req, res, next);

    expect(prisma.stayProperty.update).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });
});
