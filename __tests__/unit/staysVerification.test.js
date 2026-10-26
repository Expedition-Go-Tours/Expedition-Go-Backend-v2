jest.mock('../../src/core/services/prismaClient', () => ({
  stayVerificationProfile: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  stayVerificationDocument: {
    findMany: jest.fn(),
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  stayProperty: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
}));

const prisma = require('../../src/core/services/prismaClient');
const verification = require('../../src/brands/ghana/staysVerificationController');

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

const NOW = new Date('2026-10-26T12:00:00.000Z');

describe('staysVerificationController', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { supplierId: 'sup-1', body: {}, query: {}, params: {} };
    res = makeRes();
    next = jest.fn();

    prisma.stayVerificationProfile.findUnique.mockResolvedValue(null);
    prisma.stayVerificationProfile.create.mockImplementation(({ data }) => Promise.resolve({
      id: 'vp-1',
      createdAt: NOW,
      updatedAt: NOW,
      ...data,
    }));
    prisma.stayVerificationDocument.findMany.mockResolvedValue([]);
    prisma.stayProperty.findMany.mockResolvedValue([
      {
        id: 'sp-1',
        name: 'Akwaaba Coast Hotel',
        city: 'Accra',
        status: 'ACTIVE',
        data: { region: 'Greater Accra' },
      },
    ]);
  });

  it('returns the accommodation profile and its own requirements', async () => {
    await verification.getVerification(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.stayVerificationProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ supplierId: 'sup-1', status: 'PENDING' }),
    });
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.profile.supplierType).toBe('ACCOMMODATION_PROVIDER');
    expect(payload.data.profile.properties[0]).toEqual(expect.objectContaining({
      id: 'sp-1',
      name: 'Akwaaba Coast Hotel',
      region: 'Greater Accra',
      status: 'VERIFIED',
    }));
    expect(payload.data.requirements.documents.length).toBeGreaterThan(0);
    expect(payload.data.requirements.properties).toBe('required');
  });

  it('stores a new supplier document as pending', async () => {
    prisma.stayVerificationDocument.create.mockImplementation(({ data }) => Promise.resolve({
      id: 'doc-1',
      createdAt: NOW,
      updatedAt: NOW,
      ...data,
    }));

    req.file = { path: 'https://res.cloudinary.com/demo/id.pdf', originalname: 'id.pdf' };
    req.body = { type: 'GHANA_CARD' };

    await verification.addDocument(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.stayVerificationDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        supplierId: 'sup-1',
        type: 'GHANA_CARD',
        ownerType: 'SUPPLIER',
        status: 'PENDING',
        url: 'https://res.cloudinary.com/demo/id.pdf',
        fileName: 'id.pdf',
      }),
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('re-uploads a replacement and resets it to pending', async () => {
    prisma.stayVerificationDocument.findFirst.mockResolvedValue({ id: 'doc-1' });
    prisma.stayVerificationDocument.update.mockResolvedValue({
      id: 'doc-1',
      type: 'GHANA_CARD',
      ownerType: 'SUPPLIER',
      ownerId: null,
      status: 'PENDING',
      url: 'https://res.cloudinary.com/demo/new.pdf',
      fileName: 'new.pdf',
      reviewNote: null,
      uploadedAt: NOW,
    });

    req.params = { id: 'doc-1' };
    req.file = { path: 'https://res.cloudinary.com/demo/new.pdf', originalname: 'new.pdf' };

    await verification.replaceDocument(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.stayVerificationDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: expect.objectContaining({
        status: 'PENDING',
        url: 'https://res.cloudinary.com/demo/new.pdf',
        reviewNote: null,
      }),
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
