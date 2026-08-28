const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

jest.mock('../../utils/prismaClient', () => ({
  travioGhanaTour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  tour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  user: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  supplierProfile: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  adminRole: { findUnique: jest.fn() },
  teamMember: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  review: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  booking: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  specialOffer: { findMany: jest.fn(), count: jest.fn() },
  newsletterSubscriber: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  tourDateOverride: { findMany: jest.fn() },
  wishlistItem: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  notification: { findMany: jest.fn(), count: jest.fn(), updateMany: jest.fn(), aggregate: jest.fn(), update: jest.fn() },
  payout: { findMany: jest.fn(), findFirst: jest.fn(), aggregate: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  payoutRequest: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  dispute: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  chatConversation: { findMany: jest.fn(), count: jest.fn() },
  cancellationRecord: { findMany: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn(),
}));

jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/emailService', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/queue', () => ({ enqueueEvent: jest.fn(() => Promise.resolve()), enqueueEmail: jest.fn(() => Promise.resolve()), enqueueNotification: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/tourHelpers', () => ({
  checkTourAvailability: jest.fn(() => Promise.resolve({ available: true, availableSpots: 10, reason: null })),
  calculateTourPrice: jest.fn(() => Promise.resolve({ success: true, currency: 'USD', subtotal: 100, fees: 5, discount: 0, total: 105 })),
  cheapestRetailPrice: jest.fn(() => 100),
}));
jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));

const app = require('../../app');
const prisma = require('../../utils/prismaClient');

const ADMIN_USER = { id: 'admin-1', name: 'Perf Admin', email: 'perf-admin@test.com', roles: ['admin'], active: true, adminRoleId: 'role-super', photoURL: '', notificationPreferences: null };
const SUPPLIER_USER = { id: 'supplier-1', name: 'Perf Supplier', email: 'perf-supplier@test.com', roles: ['supplier', 'ghana'], active: true, photoURL: '', notificationPreferences: { emailNotifications: {}, pushNotifications: {} } };
const CUSTOMER_USER = { id: 'customer-1', name: 'Perf Customer', email: 'perf-customer@test.com', roles: ['customer'], active: true, photoURL: '', notificationPreferences: null };

const USERS = { 'admin-1': ADMIN_USER, 'supplier-1': SUPPLIER_USER, 'customer-1': CUSTOMER_USER };

const adminToken = signAccessToken({ userId: 'admin-1' });
const supplierToken = signAccessToken({ userId: 'supplier-1' });
const customerToken = signAccessToken({ userId: 'customer-1' });

const ADMIN_PERMISSIONS = [
  'dashboard.*', 'analytics.view', 'tours.view', 'tours.approve', 'bookings.view',
  'dashboard.bookings', 'dashboard.revenue', 'bookings.confirm-payment', 'suppliers.view',
  'suppliers.approve', 'users.view', 'reviews.view', 'reviews.moderate', 'payouts.view',
  'payouts.approve', 'settings.access', 'audit.view', 'notifications.view',
];

const mockTour = {
  id: 'tour-1', title: 'Perf Safari Adventure', slug: 'perf-safari-adventure',
  description: 'A performance test safari tour', coverPhoto: '/perf.jpg', photos: [], category: 'Adventure',
  durationMinutes: 480, averageRating: 4.5, reviewCount: 2, status: 'ACTIVE',
  city: 'Nairobi', country: 'Kenya', supplierId: 'supplier-1',
  supplier: { id: 'supplier-1', name: 'Perf Supplier', photoURL: '', supplierProfile: { status: 'ACTIVE' } },
  schedulesAndPricing: {
    travelerDetails: { pricingModel: 'perPerson', maxTravelersPerBooking: 15, ageGroups: [{ label: 'Adult', minAge: 13, maxAge: 99 }] },
    pricingSchedules: { currency: 'USD', schedules: [{ startDate: '2026-01-01', endDate: '2027-12-31', prices: [{ ageGroup: 'Adult', retailPrice: 200, ourPrice: 180 }] }] },
  },
};

const mockGhanaTour = {
  id: 'ghana-tour-1', tourId: 'tour-1', isActive: true, isFeatured: true, displayOrder: 1,
  bookingFlow: 'DIRECT', createdAt: new Date(), updatedAt: new Date(),
  tour: mockTour,
};

const mockSupplierProfile = {
  id: 'profile-1', userId: 'supplier-1', status: 'ACTIVE', supplierType: 'TOUR_COMPANY',
  businessInfo: { businessName: 'Perf Supplier Ltd', businessEmail: 'perf-supplier@test.com', phone: '+254700000001', country: 'Kenya', city: 'Nairobi' },
  operatingInfo: { languages: ['English'], regions: ['East Africa'] },
  representativeInfo: { fullName: 'Perf Supplier', email: 'perf-supplier@test.com' },
  payoutInfo: { bankName: 'Test Bank' },
  compliance: { termsAccepted: true },
  businessDocuments: {},
  totalEarnings: 0, totalBookings: 0, averageRating: null,
};

beforeEach(() => {
  jest.clearAllMocks();

  // Broad safe defaults — individual tests override as needed
  const models = ['travioGhanaTour', 'tour', 'user', 'review', 'booking', 'specialOffer', 'payout', 'notification', 'teamMember', 'payoutRequest', 'dispute', 'chatConversation', 'cancellationRecord', 'wishlistItem'];
  for (const m of models) {
    prisma[m].findMany?.mockResolvedValue([]);
    prisma[m].count?.mockResolvedValue(0);
    if (prisma[m].aggregate) prisma[m].aggregate.mockResolvedValue({ _sum: {}, _avg: {}, _count: 0, _min: {}, _max: {} });
    if (prisma[m].groupBy) prisma[m].groupBy.mockResolvedValue([]);
    if (prisma[m].update) prisma[m].update.mockResolvedValue({});
    if (prisma[m].updateMany) prisma[m].updateMany.mockResolvedValue({ count: 0 });
    if (prisma[m].create) prisma[m].create.mockResolvedValue({});
    if (prisma[m].delete) prisma[m].delete.mockResolvedValue({});
    if (prisma[m].deleteMany) prisma[m].deleteMany.mockResolvedValue({ count: 0 });
  }
  prisma.tour.findFirst.mockResolvedValue(mockTour);
  prisma.tour.findUnique.mockResolvedValue(mockTour);
  prisma.travioGhanaTour.findUnique.mockResolvedValue({ isActive: true });
  prisma.travioGhanaTour.findFirst.mockResolvedValue(mockGhanaTour);
  prisma.supplierProfile.findFirst.mockResolvedValue({ id: 'profile-1' });
  prisma.supplierProfile.findUnique.mockResolvedValue(mockSupplierProfile);
  prisma.teamMember.findFirst.mockResolvedValue(null);
  prisma.tourDateOverride.findMany.mockResolvedValue([]);
  prisma.newsletterSubscriber.findUnique.mockResolvedValue(null);
  prisma.$queryRaw.mockResolvedValue([]);
  prisma.$queryRawUnsafe.mockResolvedValue([{ currentBookings: '0' }]);
  prisma.$transaction.mockImplementation(async (cb) => (typeof cb === 'function' ? cb(prisma) : cb));

  prisma.user.findUnique.mockImplementation(({ where }) => Promise.resolve(USERS[where.id] || null));
  prisma.user.findFirst.mockResolvedValue(SUPPLIER_USER);
  prisma.adminRole.findUnique.mockResolvedValue({
    id: 'role-super', name: 'super_admin',
    permissions: ADMIN_PERMISSIONS.map((key) => ({ permission: { key } })),
  });
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('TravioGhana API — public endpoints', () => {
  it('GET /homepage returns 200', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([mockGhanaTour]);
    const res = await request(app).get('/api/travioghana/homepage');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /tours returns 200 with listing', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([mockGhanaTour]);
    prisma.travioGhanaTour.count.mockResolvedValue(1);
    const res = await request(app).get('/api/travioghana/tours');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /tours/featured returns 200', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([mockGhanaTour]);
    const res = await request(app).get('/api/travioghana/tours/featured');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /tours/sitemap returns 200', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([mockGhanaTour]);
    const res = await request(app).get('/api/travioghana/tours/sitemap');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /tours/:slug returns 200 with tour detail', async () => {
    prisma.travioGhanaTour.findFirst.mockResolvedValue(mockGhanaTour);
    const res = await request(app).get('/api/travioghana/tours/perf-safari-adventure');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /tours/:slug returns 404 for unknown tour', async () => {
    prisma.travioGhanaTour.findFirst.mockResolvedValue(null);
    const res = await request(app).get('/api/travioghana/tours/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('GET /tours/:slug/reviews returns 200', async () => {
    prisma.travioGhanaTour.findFirst.mockResolvedValue(mockGhanaTour);
    prisma.review.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/travioghana/tours/perf-safari-adventure/reviews');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /tours/:slug/similar returns 200', async () => {
    prisma.travioGhanaTour.findFirst.mockResolvedValue(mockGhanaTour);
    prisma.travioGhanaTour.findMany.mockResolvedValue([mockGhanaTour]);
    const res = await request(app).get('/api/travioghana/tours/perf-safari-adventure/similar');
    expect(res.status).toBe(200);
  });

  it('GET /tours/:slug/availability returns 200', async () => {
    prisma.travioGhanaTour.findFirst.mockResolvedValue(mockGhanaTour);
    const res = await request(app).get('/api/travioghana/tours/perf-safari-adventure/availability?startDate=2026-09-01&endDate=2026-09-10');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('POST /contact returns 200 and sends email', async () => {
    const res = await request(app)
      .post('/api/travioghana/contact')
      .send({ name: 'Jane Doe', email: 'jane@test.com', message: 'This is a sufficiently long test message.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('POST /contact returns 400 when message too short', async () => {
    const res = await request(app)
      .post('/api/travioghana/contact')
      .send({ name: 'Jane Doe', email: 'jane@test.com', message: 'short' });
    expect(res.status).toBe(400);
  });

  it('POST /subscribe returns 200', async () => {
    prisma.newsletterSubscriber.findUnique.mockResolvedValue(null);
    prisma.newsletterSubscriber.create.mockResolvedValue({ id: 'sub-1', email: 'sub@test.com' });
    const res = await request(app).post('/api/travioghana/subscribe').send({ email: 'sub@test.com' });
    expect(res.status).toBe(200);
  });

  it('POST /track-click returns 204', async () => {
    const res = await request(app)
      .post('/api/travioghana/track-click')
      .send({ event: 'cta_book_now', target: 'perf-safari-adventure' });
    expect(res.status).toBe(204);
  });

  it('POST /checkout/calculate returns 200 with pricing', async () => {
    prisma.tour.findFirst.mockResolvedValue(mockTour);
    prisma.travioGhanaTour.findUnique.mockResolvedValue({ isActive: true });
    const res = await request(app)
      .post('/api/travioghana/checkout/calculate')
      .send({ tourId: 'tour-1', travelDate: '2026-09-15', travelers: { adults: 2 } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });
});

describe('TravioGhana API — auth gating', () => {
  it.each([
    ['GET', '/api/travioghana/wishlist', null],
    ['GET', '/api/travioghana/bookings', null],
    ['GET', '/api/travioghana/supplier/dashboard', null],
    ['GET', '/api/travioghana/supplier/settings', null],
    ['GET', '/api/travioghana/admin/me', null],
    ['GET', '/api/travioghana/admin/analytics/overview', null],
    ['GET', '/api/travioghana/admin/tours', null],
  ])('%s %s returns 401 without token', async (method, path) => {
    const res = await request(app)[method.toLowerCase()](path);
    expect(res.status).toBe(401);
  });

  it('customer cannot access supplier routes', async () => {
    const res = await request(app).get('/api/travioghana/supplier/tours').set(auth(customerToken));
    expect([401, 403]).toContain(res.status);
  });

  it('supplier cannot access admin routes', async () => {
    const res = await request(app).get('/api/travioghana/admin/me').set(auth(supplierToken));
    expect([401, 403]).toContain(res.status);
  });
});

describe('TravioGhana API — customer endpoints', () => {
  it('GET /wishlist returns 200', async () => {
    const res = await request(app).get('/api/travioghana/wishlist').set(auth(customerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /bookings returns 200', async () => {
    const res = await request(app).get('/api/travioghana/bookings').set(auth(customerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });
});

describe('TravioGhana API — supplier endpoints', () => {
  it('GET /dashboard returns 200', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([{ tourId: 'tour-1' }]);
    prisma.booking.aggregate.mockResolvedValue({ _sum: { grossAmount: 1050 } });
    const res = await request(app).get('/api/travioghana/supplier/dashboard').set(auth(supplierToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /monthly-revenue returns 200', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([{ tourId: 'tour-1' }]);
    prisma.booking.groupBy.mockResolvedValue([]);
    const res = await request(app).get('/api/travioghana/supplier/monthly-revenue').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /tours returns 200', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([mockGhanaTour]);
    prisma.travioGhanaTour.count.mockResolvedValue(1);
    const res = await request(app).get('/api/travioghana/supplier/tours').set(auth(supplierToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /reviews returns 200 (uses customer relation)', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([{ tourId: 'tour-1' }]);
    prisma.review.findMany.mockResolvedValue([{ id: 'rev-1', rating: 5, customer: { id: 'customer-1', name: 'Perf Customer' }, tour: { id: 'tour-1', title: 'Test' } }]);
    prisma.review.count.mockResolvedValue(1);
    const res = await request(app).get('/api/travioghana/supplier/reviews').set(auth(supplierToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.reviews).toHaveLength(1);
  });

  it('GET /availability/:tourId returns 200', async () => {
    prisma.tour.findFirst.mockResolvedValue(mockTour);
    const res = await request(app).get('/api/travioghana/supplier/availability/tour-1').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /settings returns 200', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...SUPPLIER_USER,
      supplierProfile: mockSupplierProfile,
    });
    const res = await request(app).get('/api/travioghana/supplier/settings').set(auth(supplierToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /settings/business-profile returns 200', async () => {
    const res = await request(app).get('/api/travioghana/supplier/settings/business-profile').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /settings/notification-preferences returns 200', async () => {
    const res = await request(app).get('/api/travioghana/supplier/settings/notification-preferences').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /settings/tax-info returns 200', async () => {
    const res = await request(app).get('/api/travioghana/supplier/settings/tax-info').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /settings/booking-rules returns 200', async () => {
    const res = await request(app).get('/api/travioghana/supplier/settings/booking-rules').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /settings/team/my-role returns 200', async () => {
    prisma.supplierProfile.findFirst.mockResolvedValue({ id: 'profile-1' });
    const res = await request(app).get('/api/travioghana/supplier/settings/team/my-role').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /settings/team/members returns 200', async () => {
    prisma.teamMember.findMany.mockResolvedValue([]);
    prisma.teamMember.count.mockResolvedValue(0);
    const res = await request(app).get('/api/travioghana/supplier/settings/team/members').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /special-offers returns 200', async () => {
    prisma.specialOffer.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/travioghana/supplier/special-offers').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /cancellation/summary returns 200', async () => {
    const res = await request(app).get('/api/travioghana/supplier/cancellation/summary').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /finance/summary returns 200', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([{ tourId: 'tour-1' }]);
    prisma.booking.aggregate.mockResolvedValue({ _sum: { grossAmount: 1000 }, _count: 5 });
    const res = await request(app).get('/api/travioghana/supplier/finance/summary').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /payouts returns 200', async () => {
    prisma.payout.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/travioghana/supplier/payouts').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });

  it('GET /notifications returns 200', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/travioghana/supplier/notifications').set(auth(supplierToken));
    expect(res.status).toBe(200);
  });
});

describe('TravioGhana API — admin endpoints', () => {
  it('GET /me returns 200', async () => {
    prisma.user.findUnique.mockResolvedValue(ADMIN_USER);
    const res = await request(app).get('/api/travioghana/admin/me').set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('GET /analytics/overview returns 200', async () => {
    prisma.travioGhanaTour.count.mockResolvedValue(1);
    prisma.booking.count.mockResolvedValue(0);
    prisma.booking.aggregate.mockResolvedValue({ _sum: { grossAmount: 0 } });
    const res = await request(app).get('/api/travioghana/admin/analytics/overview').set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('GET /tours returns 200', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([mockGhanaTour]);
    prisma.travioGhanaTour.count.mockResolvedValue(1);
    const res = await request(app).get('/api/travioghana/admin/tours').set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('GET /suppliers returns 200 with ghana suppliers', async () => {
    prisma.user.findMany.mockResolvedValue([{ ...SUPPLIER_USER, supplierProfile: mockSupplierProfile }]);
    prisma.user.count.mockResolvedValue(1);
    const res = await request(app).get('/api/travioghana/admin/suppliers').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /suppliers/:id returns 200 with merged supplier shape', async () => {
    prisma.user.findFirst.mockResolvedValue(SUPPLIER_USER);
    prisma.supplierProfile.findUnique.mockResolvedValue(mockSupplierProfile);
    prisma.travioGhanaTour.findMany.mockResolvedValue([]);
    prisma.booking.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/travioghana/admin/suppliers/supplier-1').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.supplier.id).toBe('profile-1');
  });

  it('GET /suppliers/:id/profile returns 200', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue(mockSupplierProfile);
    const res = await request(app).get('/api/travioghana/admin/suppliers/supplier-1/profile').set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('GET /ai/status returns 200', async () => {
    prisma.travioGhanaTour.count.mockResolvedValue(1);
    const res = await request(app).get('/api/travioghana/admin/ai/status').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /ai/failed returns 200', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/travioghana/admin/ai/failed').set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('GET /reviews/pending returns 200', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([{ tourId: 'tour-1' }]);
    prisma.review.findMany.mockResolvedValue([]);
    prisma.review.count.mockResolvedValue(0);
    const res = await request(app).get('/api/travioghana/admin/reviews/pending').set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('GET /notifications returns 200', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);
    const res = await request(app).get('/api/travioghana/admin/notifications').set(auth(adminToken));
    expect(res.status).toBe(200);
  });
});
