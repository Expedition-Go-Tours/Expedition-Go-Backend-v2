process.env.NODE_ENV = 'test';

jest.mock('../../utils/prismaClient', () => ({
  expeditionTour: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn() },
  tour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  user: { findUnique: jest.fn(), update: jest.fn() },
  booking: { create: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn(),
}));

jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));
jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(),
}));

const controller = require('../../controllers/expeditionController');
const prisma = require('../../utils/prismaClient');
const cache = require('../../utils/cacheHelper');

const mockTour = {
  id: 'tour-1', title: 'Test Tour', slug: 'test-tour',
  description: 'A fantastic test tour',
  coverPhoto: 'https://res.cloudinary.com/test/tour.jpg',
  photos: [],
  category: 'Adventure', durationMinutes: 120,
  averageRating: 4.5, reviewCount: 10,
  city: 'Cape Town', country: 'South Africa',
  supplier: { id: 'supplier-1', name: 'Test Supplier', photoURL: 'https://res.cloudinary.com/test/supplier.jpg' },
  supplierId: 'supplier-1', status: 'ACTIVE',
};

const mockExpeditionTour = {
  id: 'et-1', tourId: 'tour-1',
  displayOrder: 1, isFeatured: false, isActive: true,
  tour: mockTour,
};

prisma.expeditionTour.findFirst.mockResolvedValue(mockExpeditionTour);
cache.getOrSet.mockImplementation((key, fn) => fn());

const req = {
  params: { slug: 'test-tour' },
  query: {},
  body: {},
  user: { id: 'user-1', roles: ['customer'] },
  headers: {},
  socket: { remoteAddress: '127.0.0.1' },
  ip: '127.0.0.1',
};

let statusArg;
const res = {
  status: (code) => { statusArg = code; console.log('status called with:', code); return res; },
  json: () => console.log('json called, status was:', statusArg),
  set: () => { console.log('res.set called'); },
};
const next = (err) => {
  console.log('next called with:', err?.message || err, 'statusCode:', err?.statusCode);
};

controller.getTourBySlug(req, res, next)
  .then(() => console.log('Handler completed'))
  .catch(e => console.error('unhandled error:', e));
