jest.mock('../../utils/prismaClient', () => {
  const mock = {
    supplierProfile: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    user: { update: jest.fn(), findUnique: jest.fn() },
    tour: { groupBy: jest.fn(), findMany: jest.fn(), count: jest.fn(), updateMany: jest.fn() },
    booking: { groupBy: jest.fn(), findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    review: { findMany: jest.fn(), aggregate: jest.fn(), count: jest.fn() },
    payout: { findMany: jest.fn(), count: jest.fn() },
    media: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    supplierDocument: { create: jest.fn().mockResolvedValue({}) },
    vehicle: { create: jest.fn().mockResolvedValue({}) },
    guide: { create: jest.fn().mockResolvedValue({}) },
    verificationEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((fn) => fn(mock)),
  };
  return mock;
});

jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/emailService', () => ({ sendSupplierStatusEmail: jest.fn() }));
jest.mock('../../utils/adminNotificationService', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../../utils/queue', () => ({ enqueueNotification: jest.fn() }));
jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url, size) => `https://cdn.example.com/${size}/${url}`) }));
jest.mock('../../utils/cloudinaryHelper', () => ({ deleteCloudinaryImage: jest.fn(), isValidCloudinaryUrl: jest.fn((url) => typeof url === 'string' && url.startsWith('https://res.cloudinary.com/')) }));
jest.mock('../../utils/cacheHelper', () => ({ getOrSet: jest.fn((key, fn) => fn()), invalidateKeys: jest.fn(() => Promise.resolve()), invalidateTourCaches: jest.fn(() => Promise.resolve()) }));
jest.mock('../../config/firebaseAdmin', () => ({ auth: () => ({ getUser: jest.fn() }) }));

const prisma = require('../../utils/prismaClient');
const { logActivity } = require('../../utils/auditLogger');
const { sendSupplierStatusEmail } = require('../../utils/emailService');
const { notifyAdmin } = require('../../utils/adminNotificationService');
const { enqueueNotification } = require('../../utils/queue');
const { cloudinaryUrl } = require('../../utils/imageOptimizer');
const { deleteCloudinaryImage } = require('../../utils/cloudinaryHelper');
const admin = require('../../config/firebaseAdmin');
const cache = require('../../utils/cacheHelper');
const controller = require('../../controllers/supplierController');

describe('supplierController', () => {
  let req, res, next;

  const mockProfile = {
    id: 'sp-1',
    userId: 'u-1',
    status: 'PENDING',
    businessInfo: { legalBusinessName: 'Acme' },
    operatingInfo: { tourCategories: ['Adventure'] },
    representativeInfo: { fullName: 'John' },
    payoutInfo: { bankAccountName: 'A' },
    businessDocuments: { registrationDocumentUrl: 'https://ex.com/r.pdf' },
    compliance: { termsAccepted: true },
    totalEarnings: '5000',
    totalBookings: 20,
    averageRating: 4.5,
    createdAt: new Date(),
    user: { id: 'u-1', name: 'John', email: 'john@test.com', photoURL: 'photo.jpg', firebaseUid: 'fb-1', createdAt: new Date() },
  };

  const mockTourGroupBy = () => [
    { status: 'ACTIVE', _count: 5 },
    { status: 'DRAFT', _count: 3 },
  ];
  const mockBookingGroupBy = () => [
    { status: 'CONFIRMED', _count: 10 },
    { status: 'PENDING', _count: 4 },
    { status: 'COMPLETED', _count: 6 },
    { status: 'CANCELLED', _count: 2 },
  ];
  const mockReviews = () => [
    { id: 'r1', rating: 5, comment: 'Great', customer: { id: 'c1', name: 'C', photoURL: null }, tour: { id: 't1', title: 'T' } },
  ];
  const mockBookings = () => [
    { id: 'b1', bookingNumber: 'BN-001', travelDate: new Date(), paidAt: new Date(), grossAmount: '200', supplierPayout: '170', platformCommission: '30', commissionRate: '0.15', currency: 'USD', tour: { id: 't1', title: 'Tour' }, customer: { id: 'c1', name: 'C', email: 'c@t.com' }, payouts: [{ id: 'p1', status: 'PAID', paidAt: new Date() }] },
  ];
  const mockPayouts = () => [
    { id: 'p1', amount: '500', status: 'PAID', createdAt: new Date(), booking: { tour: { title: 'Tour' } } },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, user: { id: 'u-1' }, supplierId: 'u-1', files: undefined };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    prisma.supplierProfile.findUnique.mockResolvedValue(null);
    prisma.supplierProfile.create.mockResolvedValue(mockProfile);
    prisma.supplierProfile.update.mockResolvedValue(mockProfile);
    prisma.supplierProfile.findMany.mockResolvedValue([]);
    prisma.supplierProfile.count.mockResolvedValue(0);
    prisma.user.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.tour.groupBy.mockResolvedValue(mockTourGroupBy());
    prisma.tour.findMany.mockResolvedValue([]);
    prisma.tour.count.mockResolvedValue(0);
    prisma.tour.updateMany.mockResolvedValue({ count: 0 });
    prisma.booking.groupBy.mockResolvedValue(mockBookingGroupBy());
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.count.mockResolvedValue(0);
    prisma.booking.aggregate.mockResolvedValue({ _sum: { grossAmount: '5000', platformCommission: '800', supplierPayout: '4000' } });
    prisma.review.findMany.mockResolvedValue([]);
    prisma.review.aggregate.mockResolvedValue({ _avg: { rating: 4.5 }, _count: 10 });
    prisma.payout.findMany.mockResolvedValue([]);
    prisma.payout.count.mockResolvedValue(0);
    logActivity.mockResolvedValue();
    sendSupplierStatusEmail.mockResolvedValue();
    notifyAdmin.mockResolvedValue();
    enqueueNotification.mockResolvedValue();
    cloudinaryUrl.mockImplementation((url, size) => `https://cdn.example.com/${size}/${url}`);
    deleteCloudinaryImage.mockResolvedValue();
    admin.auth = () => ({ getUser: jest.fn().mockResolvedValue({ photoURL: 'fb-photo.jpg' }) });
  });

  // ============================
  // applyToBeSupplier
  // ============================
  describe('applyToBeSupplier', () => {
    it('returns 400 if application already exists', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);

      await controller.applyToBeSupplier(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: 'You already have a supplier application' }));
    });

    it('returns 400 if required fields are missing', async () => {
      await controller.applyToBeSupplier(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('businessInfo') }));
    });

    it('creates supplier profile and returns 201', async () => {
      req.body = {
        businessInfo: { legalBusinessName: 'Acme' },
        operatingInfo: { tourCategories: ['Adventure'] },
        representativeInfo: { fullName: 'John' },
        payoutInfo: { bankAccountName: 'A' },
      };

      await controller.applyToBeSupplier(req, res, next);

      expect(prisma.supplierProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'u-1',
            status: 'PENDING',
          }),
        })
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u-1' }, data: { roles: { push: 'supplier' } } })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'supplier.applied' }));
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    });

    it('parses JSON string fields for multipart form data', async () => {
      req.body = {
        businessInfo: '{"legalBusinessName":"Acme"}',
        operatingInfo: '{"tourCategories":["Adventure"]}',
        representativeInfo: '{"fullName":"John"}',
        payoutInfo: '{"bankAccountName":"A"}',
      };

      await controller.applyToBeSupplier(req, res, next);

      expect(prisma.supplierProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            businessInfo: { legalBusinessName: 'Acme' },
            operatingInfo: { tourCategories: ['Adventure'] },
          }),
        })
      );
    });

    it('handles file uploads for business documents', async () => {
      req.body = {
        businessInfo: { legalBusinessName: 'Acme' },
        operatingInfo: { tourCategories: ['Adventure'] },
        representativeInfo: { fullName: 'John' },
        payoutInfo: { bankAccountName: 'A' },
      };
      req.files = {
        registrationDocument: [{ path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/reg.pdf' }],
        taxDocument: [{ path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/tax.pdf' }],
        proofOfAddress: [{ path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/poa.pdf' }],
        idDocument: [{ path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/id.pdf' }],
        licenses: [{ path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/l1.pdf' }, { path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/l2.pdf' }],
      };

      await controller.applyToBeSupplier(req, res, next);

      expect(prisma.supplierProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            businessDocuments: expect.objectContaining({
              registrationDocument: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/reg.pdf',
              taxDocument: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/tax.pdf',
              proofOfAddress: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/poa.pdf',
              idDocument: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/id.pdf',
              licenses: ['https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/l1.pdf', 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-documents/l2.pdf'],
            }),
          }),
        })
      );
    });

    it('handles compliance field parsing', async () => {
      req.body = {
        businessInfo: { legalBusinessName: 'Acme' },
        operatingInfo: { tourCategories: ['Adventure'] },
        representativeInfo: { fullName: 'John' },
        payoutInfo: { bankAccountName: 'A' },
        compliance: '{"termsAccepted":true}',
      };

      await controller.applyToBeSupplier(req, res, next);

      expect(prisma.supplierProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            compliance: { termsAccepted: true },
          }),
        })
      );
    });

    it('defaults compliance to termsAccepted false when not provided', async () => {
      req.body = {
        businessInfo: { legalBusinessName: 'Acme' },
        operatingInfo: { tourCategories: ['Adventure'] },
        representativeInfo: { fullName: 'John' },
        payoutInfo: { bankAccountName: 'A' },
      };

      await controller.applyToBeSupplier(req, res, next);

      expect(prisma.supplierProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            compliance: { termsAccepted: false },
          }),
        })
      );
    });
  });

  // ============================
  // getApplicationStatus
  // ============================
  describe('getApplicationStatus', () => {
    it('returns 404 when no application exists', async () => {
      await controller.getApplicationStatus(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns the supplier profile', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);

      await controller.getApplicationStatus(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success', data: expect.objectContaining({ supplierProfile: mockProfile }) })
      );
    });
  });

  // ============================
  // updateApplication
  // ============================
  describe('updateApplication', () => {
    it('returns 404 when no application exists', async () => {
      await controller.updateApplication(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when application is not modifiable', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue({ ...mockProfile, status: 'APPROVED' });

      await controller.updateApplication(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('updates application when status is PENDING', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      req.body = { businessInfo: { legalBusinessName: 'Updated' } };

      await controller.updateApplication(req, res, next);

      expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u-1' } })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('updates application when status is UNDER_REVIEW', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue({ ...mockProfile, status: 'UNDER_REVIEW' });
      req.body = { operatingInfo: { tourCategories: ['New'] } };

      await controller.updateApplication(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('parses JSON string fields in update', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      req.body = { businessInfo: '{"legalBusinessName":"Updated"}' };

      await controller.updateApplication(req, res, next);

      expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ businessInfo: { legalBusinessName: 'Updated' } }),
        })
      );
    });
  });

  // ============================
  // getDashboard
  // ============================
  describe('getDashboard', () => {
    it('returns 404 when supplier profile not found', async () => {
      await controller.getDashboard(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns dashboard with aggregated stats', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.review.findMany.mockResolvedValue(mockReviews());
      prisma.review.count.mockResolvedValue(mockReviews().length);

      await controller.getDashboard(req, res, next);

      expect(prisma.tour.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ by: ['status'], where: { supplierId: 'u-1' } })
      );
      expect(prisma.booking.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['status'],
          where: {
            tour: { supplierId: 'u-1' },
            createdAt: { gte: expect.any(Date) },
          },
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            earnings: expect.any(Object),
            tours: expect.objectContaining({ total: 8, active: 5, draft: 3 }),
            bookings: expect.objectContaining({ total: 22, confirmed: 10 }),
            reviews: expect.objectContaining({ averageRating: 4.5, totalReviews: mockReviews().length, recentReviews: expect.any(Array) }),
          }),
        })
      );
    });

    it('handles empty tour groups', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.tour.groupBy.mockResolvedValue([]);
      prisma.booking.groupBy.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);

      await controller.getDashboard(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.tours.total).toBe(0);
      expect(body.data.bookings.total).toBe(0);
    });
  });

  // ============================
  // getEarnings
  // ============================
  describe('getEarnings', () => {
    it('returns earnings with pagination', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.booking.findMany.mockResolvedValue(mockBookings());
      prisma.booking.count.mockResolvedValue(1);

      await controller.getEarnings(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            summary: expect.objectContaining({
              totalEarnings: 5000,
              totalRevenue: 5000,
              totalCommission: 800,
              totalBookings: 1,
            }),
            earnings: expect.any(Array),
            pagination: expect.objectContaining({ currentPage: 1, totalCount: 1 }),
          }),
        })
      );
    });

    it('filters by date range when provided', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      req.query = { startDate: '2026-01-01', endDate: '2026-12-31' };

      await controller.getEarnings(req, res, next);

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: expect.objectContaining({ gte: expect.any(Date), lte: expect.any(Date) }),
          }),
        })
      );
    });

    it('supports pagination parameters', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      req.query = { page: '2', limit: '10' };
      prisma.booking.count.mockResolvedValue(25);

      await controller.getEarnings(req, res, next);

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 })
      );
      const body = res.json.mock.calls[0][0];
      expect(body.data.pagination.totalPages).toBe(3);
    });

    it('handles empty earnings gracefully', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.booking.count.mockResolvedValue(0);

      await controller.getEarnings(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.earnings).toEqual([]);
      expect(body.data.pagination.totalCount).toBe(0);
    });
  });

  // ============================
  // getPayouts
  // ============================
  describe('getPayouts', () => {
    it('returns payouts with pagination', async () => {
      prisma.payout.findMany.mockResolvedValue(mockPayouts());
      prisma.payout.count.mockResolvedValue(1);

      await controller.getPayouts(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            payouts: expect.any(Array),
            pagination: expect.objectContaining({ currentPage: 1, totalCount: 1 }),
          }),
        })
      );
    });

    it('filters by status when provided', async () => {
      req.query = { status: 'PAID' };

      await controller.getPayouts(req, res, next);

      expect(prisma.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ supplierId: 'u-1', status: 'PAID' }) })
      );
    });

    it('handles pagination', async () => {
      req.query = { page: '2', limit: '5' };
      prisma.payout.count.mockResolvedValue(12);

      await controller.getPayouts(req, res, next);

      expect(prisma.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 })
      );
      const body = res.json.mock.calls[0][0];
      expect(body.data.pagination.totalPages).toBe(3);
    });

    it('handles empty payouts', async () => {
      await controller.getPayouts(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.payouts).toEqual([]);
    });
  });

  // ============================
  // getAllApplications (admin)
  // ============================
  describe('getAllApplications', () => {
    it('returns paginated applications', async () => {
      const apps = [{ ...mockProfile, user: { id: 'u-1', name: 'John', email: 'john@test.com', photoURL: 'photo.jpg', firebaseUid: 'fb-1', createdAt: new Date() } }];
      prisma.supplierProfile.findMany.mockResolvedValue(apps);
      prisma.supplierProfile.count.mockResolvedValue(1);

      await controller.getAllApplications(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            applications: expect.any(Array),
            pagination: expect.objectContaining({ currentPage: 1, hasNextPage: false }),
          }),
        })
      );
    });

    it('filters by status', async () => {
      req.query = { status: 'PENDING' };

      await controller.getAllApplications(req, res, next);

      expect(prisma.supplierProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'PENDING' } })
      );
    });

    it('fetches photoURL from firebase when missing', async () => {
      const appWithNoPhoto = [{ ...mockProfile, user: { id: 'u-1', name: 'John', email: 'john@test.com', photoURL: '', firebaseUid: 'fb-1', createdAt: new Date() } }];
      prisma.supplierProfile.findMany.mockResolvedValue(appWithNoPhoto);
      prisma.supplierProfile.count.mockResolvedValue(1);

      await controller.getAllApplications(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.applications[0].user.photoURL).toBe('fb-photo.jpg');
    });

    it('handles firebase fetch failure gracefully', async () => {
      const appWithNoPhoto = [{ ...mockProfile, user: { id: 'u-1', name: 'John', email: 'john@test.com', photoURL: '', firebaseUid: 'fb-1', createdAt: new Date() } }];
      prisma.supplierProfile.findMany.mockResolvedValue(appWithNoPhoto);
      prisma.supplierProfile.count.mockResolvedValue(1);
      admin.auth = () => ({ getUser: jest.fn().mockRejectedValue(new Error('FB error')) });

      await controller.getAllApplications(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.applications[0].user.photoURL).toBe('');
    });
  });

  // ============================
  // reviewApplication (admin)
  // ============================
  describe('reviewApplication', () => {
    it('returns 400 for invalid action', async () => {
      req.body = { action: 'invalid' };

      await controller.reviewApplication(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 when notes missing for reject', async () => {
      req.body = { action: 'reject' };

      await controller.reviewApplication(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 when notes missing for request_info', async () => {
      req.body = { action: 'request_info' };

      await controller.reviewApplication(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when application not found', async () => {
      req.params = { id: 'sp-1' };
      req.body = { action: 'approve' };

      await controller.reviewApplication(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('approves application and sends email', async () => {
      req.params = { id: 'sp-1' };
      req.body = { action: 'approve', notes: 'Looks good' };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);

      await controller.reviewApplication(req, res, next);

      expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sp-1' }, data: expect.objectContaining({ status: 'APPROVED' }) })
      );
      expect(sendSupplierStatusEmail).toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'supplier.approve' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('rejects application', async () => {
      req.params = { id: 'sp-1' };
      req.body = { action: 'reject', notes: 'Incomplete docs' };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);

      await controller.reviewApplication(req, res, next);

      expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) })
      );
    });

    it('requests info (UNDER_REVIEW)', async () => {
      req.params = { id: 'sp-1' };
      req.body = { action: 'request_info', notes: 'Need more' };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);

      await controller.reviewApplication(req, res, next);

      expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'UNDER_REVIEW' }) })
      );
    });

    it('handles email send failure gracefully', async () => {
      req.params = { id: 'sp-1' };
      req.body = { action: 'approve' };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      sendSupplierStatusEmail.mockRejectedValue(new Error('Email error'));

      await controller.reviewApplication(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // suspendSupplier (admin)
  // ============================
  describe('suspendSupplier', () => {
    it('returns 400 when suspending without reason', async () => {
      req.params = { id: 'sp-1' };
      req.body = { suspend: true };

      await controller.suspendSupplier(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when supplier not found', async () => {
      req.params = { id: 'sp-1' };
      req.body = { suspend: true, reason: 'Violation' };

      await controller.suspendSupplier(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('suspends supplier', async () => {
      req.params = { id: 'sp-1' };
      req.body = { suspend: true, reason: 'Violation' };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.tour.findMany.mockResolvedValue([{ id: 't-1', slug: 'acme-tour' }]);

      await controller.suspendSupplier(req, res, next);

      expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sp-1' }, data: expect.objectContaining({ status: 'SUSPENDED' }) })
      );
      expect(cache.invalidateTourCaches).toHaveBeenCalledWith('t-1', 'acme-tour');
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'supplier.suspended' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('reactivates supplier', async () => {
      req.params = { id: 'sp-1' };
      req.body = { suspend: false };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.tour.findMany.mockResolvedValue([]);

      await controller.suspendSupplier(req, res, next);

      expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) })
      );
      expect(cache.invalidateKeys).toHaveBeenCalledWith(['expedition:sitemap']);
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'supplier.reactivated' }));
    });
  });

  // ============================
  // activateSupplier (admin)
  // ============================
  describe('activateSupplier', () => {
    it('returns 404 when supplier not found', async () => {
      req.params = { id: 'sp-1' };

      await controller.activateSupplier(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when supplier not in APPROVED status', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);

      await controller.activateSupplier(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('activates approved supplier', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue({ ...mockProfile, status: 'APPROVED' });

      await controller.activateSupplier(req, res, next);

      expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sp-1' }, data: { status: 'ACTIVE' } })
      );
      expect(sendSupplierStatusEmail).toHaveBeenCalled();
      expect(enqueueNotification).toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'supplier.activated' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('handles enqueueNotification failure gracefully', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue({ ...mockProfile, status: 'APPROVED' });
      enqueueNotification.mockRejectedValue(new Error('Queue error'));

      await controller.activateSupplier(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('handles notifyAdmin failure gracefully', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue({ ...mockProfile, status: 'APPROVED' });
      notifyAdmin.mockRejectedValue(new Error('Notify error'));

      await controller.activateSupplier(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('handles activation email failure gracefully', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue({ ...mockProfile, status: 'APPROVED' });
      sendSupplierStatusEmail.mockRejectedValue(new Error('Email error'));

      await controller.activateSupplier(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // archiveSupplier (admin)
  // ============================
  describe('archiveSupplier', () => {
    it('returns 404 when supplier not found', async () => {
      req.params = { id: 'sp-1' };

      await controller.archiveSupplier(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('archives supplier, hides tours, deactivates account, preserves bookings', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        user: { id: 'u-1', name: 'John', email: 'john@test.com' },
      });
      prisma.tour.updateMany.mockResolvedValue({ count: 4 });
      prisma.tour.findMany.mockResolvedValue([
        { id: 't-1', slug: 'tour-one' },
        { id: 't-2', slug: 'tour-two' },
      ]);

      await controller.archiveSupplier(req, res, next);

      expect(prisma.tour.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ supplierId: 'u-1' }), data: { status: 'ARCHIVED' } })
      );
      expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sp-1' },
          data: expect.objectContaining({
            status: 'SUSPENDED',
            archiveSnapshot: expect.objectContaining({ tourIds: ['t-1', 't-2'] }),
          }),
        })
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u-1' }, data: { active: false } })
      );
      expect(cache.invalidateTourCaches).toHaveBeenCalledWith('t-1', 'tour-one');
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'supplier.archived' }));
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ archivedTours: 4 }) }));
    });

    it('returns 409 when already archived', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        status: 'SUSPENDED',
        user: { id: 'u-1', name: 'John', email: 'john@test.com', active: false },
      });

      await controller.archiveSupplier(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    });
  });

  // ============================
  // restoreSupplier (admin)
  // ============================
  describe('restoreSupplier', () => {
    it('returns 404 when supplier not found', async () => {
      req.params = { id: 'sp-1' };

      await controller.restoreSupplier(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 409 when supplier is not archived', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        status: 'ACTIVE',
        user: { id: 'u-1', name: 'John', email: 'john@test.com', active: true },
      });

      await controller.restoreSupplier(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    });

    it('restores supplier and reactivates snapshot tours', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        status: 'SUSPENDED',
        archiveSnapshot: { archivedAt: '2026-07-30T00:00:00.000Z', tourIds: ['t-1', 't-2'] },
        user: { id: 'u-1', name: 'John', email: 'john@test.com', active: false },
      });
      prisma.tour.updateMany.mockResolvedValue({ count: 2 });
      prisma.tour.findMany.mockResolvedValue([
        { id: 't-1', slug: 'tour-one' },
        { id: 't-2', slug: 'tour-two' },
      ]);

      await controller.restoreSupplier(req, res, next);

      expect(prisma.tour.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: ['t-1', 't-2'] }, supplierId: 'u-1', status: 'ARCHIVED' }),
          data: { status: 'ACTIVE' },
        })
      );
      expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sp-1' }, data: { status: 'ACTIVE', archiveSnapshot: null } })
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u-1' }, data: { active: true } })
      );
      expect(sendSupplierStatusEmail).toHaveBeenCalledWith('john@test.com', 'ACTIVE', expect.anything());
      expect(cache.invalidateTourCaches).toHaveBeenCalledWith('t-1', 'tour-one');
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'supplier.restored' }));
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ restoredTours: 2 }) }));
    });

    it('restores legacy archived supplier by reactivating all ARCHIVED tours', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        status: 'SUSPENDED',
        archiveSnapshot: null,
        user: { id: 'u-1', name: 'John', email: 'john@test.com', active: false },
      });
      prisma.tour.updateMany.mockResolvedValue({ count: 3 });
      prisma.tour.findMany.mockResolvedValue([]);

      await controller.restoreSupplier(req, res, next);

      expect(prisma.tour.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ supplierId: 'u-1', status: 'ARCHIVED' }),
          data: { status: 'ACTIVE' },
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'supplier.restored' }));
    });

    it('returns 400 when manual tourIds is invalid', async () => {
      req.params = { id: 'sp-1' };
      req.body = { tourIds: [] };
      prisma.supplierProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        status: 'SUSPENDED',
        user: { id: 'u-1', name: 'John', email: 'john@test.com', active: false },
      });

      await controller.restoreSupplier(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(prisma.tour.updateMany).not.toHaveBeenCalled();
    });

    it('manual tourIds override takes precedence for legacy suppliers', async () => {
      req.params = { id: 'sp-1' };
      req.body = { tourIds: ['t-9', 't-10'] };
      prisma.supplierProfile.findUnique.mockResolvedValue({
        ...mockProfile,
        status: 'SUSPENDED',
        archiveSnapshot: null,
        user: { id: 'u-1', name: 'John', email: 'john@test.com', active: false },
      });
      prisma.tour.updateMany.mockResolvedValue({ count: 2 });
      prisma.tour.findMany.mockResolvedValue([]);

      await controller.restoreSupplier(req, res, next);

      expect(prisma.tour.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: ['t-9', 't-10'] }, supplierId: 'u-1', status: 'ARCHIVED' }),
          data: { status: 'ACTIVE' },
        })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({
        action: 'supplier.restored',
        metadata: expect.objectContaining({ selection: 'manual', requestedTourIds: ['t-9', 't-10'] }),
      }));
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // getSupplierOverview
  // ============================
  describe('getSupplierOverview', () => {
    it('returns 404 when supplier not found', async () => {
      req.params = { id: 'sp-1' };

      await controller.getSupplierOverview(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns supplier overview with aggregated data', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.booking.count.mockResolvedValue(22);
      prisma.tour.findMany.mockResolvedValue([]);

      await controller.getSupplierOverview(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            earnings: 5000,
            totalBookings: 22,
            tours: expect.any(Object),
            bookings: expect.any(Object),
            tourCommissions: expect.any(Array),
          }),
        })
      );
    });

    it('calculates tour commissions correctly', async () => {
      req.params = { id: 'sp-1' };
      const profile = { ...mockProfile, userId: 'u-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue(profile);
      prisma.booking.count.mockResolvedValue(2);
      prisma.tour.findMany.mockResolvedValue([
        {
          id: 't1',
          title: 'Tour 1',
          _count: { bookings: 2 },
          bookings: [
            { platformCommission: '30', grossAmount: '200', status: 'CONFIRMED' },
            { platformCommission: '20', grossAmount: '150', status: 'COMPLETED' },
          ],
        },
      ]);

      await controller.getSupplierOverview(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.tourCommissions).toEqual([
        { id: 't1', title: 'Tour 1', bookings: 2, commission: 50, revenue: 350 },
      ]);
    });

    it('handles empty tour groups gracefully', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.tour.groupBy.mockResolvedValue([]);
      prisma.booking.groupBy.mockResolvedValue([]);

      await controller.getSupplierOverview(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.tours.total).toBe(0);
      expect(body.data.bookings.total).toBe(0);
    });
  });

  // ============================
  // getSupplierTours
  // ============================
  describe('getSupplierTours', () => {
    it('returns 404 when supplier not found', async () => {
      req.params = { id: 'sp-1' };

      await controller.getSupplierTours(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns paginated tours', async () => {
      req.params = { id: 'sp-1' };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      const tours = [
        { id: 't1', title: 'Tour 1', coverPhoto: 'c.jpg', slug: 'tour-1', status: 'ACTIVE', averageRating: 4.5, city: 'NYC', country: 'US', createdAt: new Date(), _count: { bookings: 5, reviews: 3 } },
      ];
      prisma.tour.findMany.mockResolvedValue(tours);
      prisma.tour.count.mockResolvedValue(1);

      await controller.getSupplierTours(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data.tours[0].totalBookings).toBe(5);
      expect(body.data.tours[0].reviewCount).toBe(3);
      expect(body.data.pagination.currentPage).toBe(1);
    });

    it('filters by status', async () => {
      req.params = { id: 'sp-1' };
      req.query = { status: 'ACTIVE' };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);

      await controller.getSupplierTours(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE' }) })
      );
    });

    it('handles pagination', async () => {
      req.params = { id: 'sp-1' };
      req.query = { page: '2', limit: '5' };
      prisma.supplierProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.tour.count.mockResolvedValue(12);

      await controller.getSupplierTours(req, res, next);

      expect(prisma.tour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 })
      );
      const body = res.json.mock.calls[0][0];
      expect(body.data.pagination.totalPages).toBe(3);
    });
  });

  // ============================
  // uploadLogo
  // ============================
  describe('uploadLogo', () => {
    it('returns 400 when no file uploaded', async () => {
      await controller.uploadLogo(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('updates user logoUrl and returns it', async () => {
      req.file = { path: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-logos/logo.png' };
      prisma.user.update.mockResolvedValue({ logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-logos/logo.png' });

      await controller.uploadLogo(req, res, next);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u-1' }, data: { logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-logos/logo.png' } })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v12345/supplier-logos/logo.png' }) })
      );
    });
  });
});
