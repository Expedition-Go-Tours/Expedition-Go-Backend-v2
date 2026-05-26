const mockVerifyIdToken = jest.fn();
jest.mock('../../config/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));

jest.mock('../../utils/prismaClient', () => ({
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
  },
}));

const { protect, restrictTo } = require('../../middleware/authMiddleware');

const mockReq = (overrides = {}) => ({
  headers: {},
  cookies: {},
  ...overrides,
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const mockUser = {
  id: 'user-1',
  firebaseUid: 'firebase-uid-1',
  name: 'John Doe',
  email: 'john@test.com',
  photoURL: '',
  roles: ['customer'],
  active: true,
};

beforeEach(() => {
  mockVerifyIdToken.mockClear();
  const p = require('../../utils/prismaClient');
  p.user.findUnique.mockClear();
  p.user.findFirst.mockClear();
  p.user.create.mockClear();
});

describe('DEV mode bypass', () => {
  const OLD_ENV = process.env.NODE_ENV;

  afterAll(() => { process.env.NODE_ENV = OLD_ENV; });

  it('creates dev user', async () => {
    process.env.NODE_ENV = 'development';
    const prisma = require('../../utils/prismaClient');
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ ...mockUser, firebaseUid: 'dev-uid', roles: ['admin'] });

    const req = mockReq({ headers: { authorization: 'Bearer test-token' } });
    const next = jest.fn();
    await protect(req, mockRes(), next);

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ firebaseUid: 'dev-uid' }) }),
    );
    expect(req.user).toBeDefined();
    expect(next).toHaveBeenCalled();
  });

  it('uses existing dev user', async () => {
    process.env.NODE_ENV = 'development';
    const prisma = require('../../utils/prismaClient');
    prisma.user.findFirst.mockResolvedValue({ ...mockUser, firebaseUid: 'dev-uid', roles: ['admin'] });

    const req = mockReq({ headers: { authorization: 'Bearer test-token' } });
    const next = jest.fn();
    await protect(req, mockRes(), next);

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(next).toHaveBeenCalled();
  });
});

describe('Firebase token verification', () => {
  it('passes with valid token', async () => {
    const prisma = require('../../utils/prismaClient');
    mockVerifyIdToken.mockResolvedValue({ uid: 'firebase-uid-1' });
    prisma.user.findUnique.mockResolvedValue(mockUser);

    const req = mockReq({ headers: { authorization: 'Bearer valid-token' } });
    const next = jest.fn();
    await protect(req, mockRes(), next);

    expect(mockVerifyIdToken).toHaveBeenCalledWith('valid-token');
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { firebaseUid: 'firebase-uid-1' } }),
    );
    expect(req.user).toEqual(mockUser);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 if no token', async () => {
    const req = mockReq();
    const next = jest.fn();
    await protect(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('returns 404 if user not found', async () => {
    const prisma = require('../../utils/prismaClient');
    mockVerifyIdToken.mockResolvedValue({ uid: 'unknown' });
    prisma.user.findUnique.mockResolvedValue(null);

    const req = mockReq({ headers: { authorization: 'Bearer tok' } });
    const next = jest.fn();
    await protect(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('returns 403 if user deactivated', async () => {
    const prisma = require('../../utils/prismaClient');
    mockVerifyIdToken.mockResolvedValue({ uid: 'firebase-uid-1' });
    prisma.user.findUnique.mockResolvedValue({ ...mockUser, active: false });

    const req = mockReq({ headers: { authorization: 'Bearer tok' } });
    const next = jest.fn();
    await protect(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

});

describe('restrictTo', () => {
  it('allows matching role', () => {
    const mw = restrictTo('admin');
    mw({ user: { roles: ['admin'] } }, null, jest.fn());
  });

  it('blocks non-matching role', () => {
    const next = jest.fn();
    restrictTo('admin')({ user: { roles: ['customer'] } }, null, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('blocks missing user', () => {
    const next = jest.fn();
    restrictTo('admin')({}, null, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});
