jest.mock('../../utils/prismaClient', () => ({
  payoutMethod: { findMany: jest.fn(), count: jest.fn(), create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(), findUnique: jest.fn() },
  user: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
}));

jest.mock('../../utils/adminNotificationService', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url, size) => `https://cdn.example.com/${size}/${url}`) }));
jest.mock('../../config/firebaseAdmin', () => ({ auth: () => ({ getUser: jest.fn() }) }));

const prisma = require('../../utils/prismaClient');
const { notifyAdmin } = require('../../utils/adminNotificationService');
const { logActivity } = require('../../utils/auditLogger');
const { cloudinaryUrl } = require('../../utils/imageOptimizer');
const admin = require('../../config/firebaseAdmin');
const controller = require('../../controllers/payoutMethodController');

describe('payoutMethodController', () => {
  let req, res, next;

  const mockMethod = {
    id: 'pm-1',
    supplierId: 's-1',
    type: 'BANK_TRANSFER',
    currency: 'USD',
    isDefault: true,
    verified: false,
    bankName: 'Test Bank',
    bankAddress: '123 St',
    bankCountry: 'US',
    accountName: 'Supplier',
    accountNumber: '123456',
    routingNumber: '021000021',
    swiftCode: 'TESTUS33',
    iban: null,
    sortCode: null,
    branchCode: null,
    branchName: null,
    paypalEmail: null,
    createdAt: new Date(),
    supplier: { id: 's-1', name: 'Supplier', email: 's@t.com' },
  };

  const mockSupplier = { id: 's-1', name: 'Supplier', email: 's@t.com', photoURL: 'p.jpg', firebaseUid: 'fb-1', supplierProfile: { status: 'APPROVED' }, payoutMethods: [mockMethod] };

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {}, supplierId: 's-1', user: { id: 's-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    prisma.payoutMethod.findMany.mockResolvedValue([mockMethod]);
    prisma.payoutMethod.count.mockResolvedValue(1);
    prisma.payoutMethod.create.mockResolvedValue(mockMethod);
    prisma.payoutMethod.findFirst.mockResolvedValue(mockMethod);
    prisma.payoutMethod.findUnique.mockResolvedValue(mockMethod);
    prisma.payoutMethod.update.mockResolvedValue(mockMethod);
    prisma.payoutMethod.updateMany.mockResolvedValue({ count: 1 });
    prisma.payoutMethod.delete.mockResolvedValue(mockMethod);
    prisma.user.findUnique.mockResolvedValue(mockSupplier);
    prisma.user.findMany.mockResolvedValue([mockSupplier]);
    prisma.user.count.mockResolvedValue(1);
    notifyAdmin.mockResolvedValue();
    logActivity.mockResolvedValue();
    cloudinaryUrl.mockImplementation((url, size) => `https://cdn.example.com/${size}/${url}`);
    admin.auth = () => ({ getUser: jest.fn().mockResolvedValue({ photoURL: 'fb-photo.jpg' }) });
  });

  // ============================
  // getMyMethods
  // ============================
  describe('getMyMethods', () => {
    it('returns supplier payout methods', async () => {
      await controller.getMyMethods(req, res, next);
      expect(prisma.payoutMethod.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { supplierId: 's-1' } })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ methods: expect.any(Array) }) }));
    });
  });

  // ============================
  // addMethod
  // ============================
  describe('addMethod', () => {
    it('returns 400 when type missing', async () => {
      await controller.addMethod(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 for BANK_TRANSFER without accountName/accountNumber', async () => {
      req.body = { type: 'BANK_TRANSFER' };
      await controller.addMethod(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 for PAYPAL without paypalEmail', async () => {
      req.body = { type: 'PAYPAL' };
      await controller.addMethod(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('creates BANK_TRANSFER method', async () => {
      req.body = { type: 'BANK_TRANSFER', accountName: 'Supplier', accountNumber: '123456' };

      await controller.addMethod(req, res, next);

      expect(prisma.payoutMethod.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'BANK_TRANSFER', accountName: 'Supplier', accountNumber: '123456' }) })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout_method.added' }));
      expect(notifyAdmin).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('persists optional bank branch fields', async () => {
      req.body = { type: 'BANK_TRANSFER', accountName: 'Supplier', accountNumber: '123456', branchName: 'Oxford Circus', branchCode: '20-33-44' };

      await controller.addMethod(req, res, next);

      expect(prisma.payoutMethod.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ branchName: 'Oxford Circus', branchCode: '20-33-44' }) })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('creates PAYPAL method', async () => {
      req.body = { type: 'PAYPAL', paypalEmail: 'supplier@paypal.com' };

      await controller.addMethod(req, res, next);

      expect(prisma.payoutMethod.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ paypalEmail: 'supplier@paypal.com' }) })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('auto-sets isDefault for first method', async () => {
      prisma.payoutMethod.count.mockResolvedValue(0);
      req.body = { type: 'BANK_TRANSFER', accountName: 'S', accountNumber: '123' };

      await controller.addMethod(req, res, next);

      expect(prisma.payoutMethod.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isDefault: true }) })
      );
    });

    it('handles notifyAdmin failure gracefully', async () => {
      req.body = { type: 'BANK_TRANSFER', accountName: 'S', accountNumber: '123' };
      notifyAdmin.mockRejectedValue(new Error('Notify error'));

      await controller.addMethod(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  // ============================
  // updateMethod
  // ============================
  describe('updateMethod', () => {
    it('returns 404 when method not found', async () => {
      req.params = { id: 'nonexistent' };
      prisma.payoutMethod.findFirst.mockResolvedValue(null);
      await controller.updateMethod(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('updates method fields', async () => {
      req.params = { id: 'pm-1' };
      req.body = { bankName: 'New Bank', currency: 'EUR' };

      await controller.updateMethod(req, res, next);

      expect(prisma.payoutMethod.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'pm-1' }, data: expect.objectContaining({ bankName: 'New Bank', currency: 'EUR', verified: false }) })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout_method.updated' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('unsets isDefault on existing methods when setting new default', async () => {
      req.params = { id: 'pm-1' };
      req.body = { isDefault: true };

      await controller.updateMethod(req, res, next);

      expect(prisma.payoutMethod.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { supplierId: 's-1', id: { not: 'pm-1' } }, data: { isDefault: false } })
      );
    });

    it('handles partial updates', async () => {
      req.params = { id: 'pm-1' };
      req.body = { paypalEmail: 'new@pp.com' };

      await controller.updateMethod(req, res, next);

      expect(prisma.payoutMethod.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ paypalEmail: 'new@pp.com', verified: false }) })
      );
    });

    it('updates branch fields', async () => {
      req.params = { id: 'pm-1' };
      req.body = { branchName: 'Oxford Circus', branchCode: '20-33-44' };

      await controller.updateMethod(req, res, next);

      expect(prisma.payoutMethod.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ branchName: 'Oxford Circus', branchCode: '20-33-44', verified: false }) })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ============================
  // deleteMethod
  // ============================
  describe('deleteMethod', () => {
    it('returns 404 when method not found', async () => {
      req.params = { id: 'nonexistent' };
      prisma.payoutMethod.findFirst.mockResolvedValue(null);
      await controller.deleteMethod(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('deletes method and logs activity', async () => {
      req.params = { id: 'pm-1' };

      await controller.deleteMethod(req, res, next);

      expect(prisma.payoutMethod.delete).toHaveBeenCalledWith({ where: { id: 'pm-1' } });
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout_method.deleted' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('reassigns default to next method when deleting default', async () => {
      req.params = { id: 'pm-1' };
      prisma.payoutMethod.findFirst
        .mockResolvedValueOnce(mockMethod)
        .mockResolvedValueOnce({ ...mockMethod, id: 'pm-2' });

      await controller.deleteMethod(req, res, next);

      expect(prisma.payoutMethod.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'pm-2' }, data: { isDefault: true } })
      );
    });

    it('skips reassignment when no other methods exist', async () => {
      req.params = { id: 'pm-1' };
      prisma.payoutMethod.findFirst
        .mockResolvedValueOnce(mockMethod)
        .mockResolvedValueOnce(null);

      await controller.deleteMethod(req, res, next);

      expect(prisma.payoutMethod.update).not.toHaveBeenCalled();
    });
  });

  // ============================
  // getSupplierMethods (admin)
  // ============================
  describe('getSupplierMethods', () => {
    it('returns 404 when supplier not found', async () => {
      req.params = { supplierId: 'nonexistent' };
      prisma.user.findUnique.mockResolvedValue(null);
      await controller.getSupplierMethods(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns supplier and their methods', async () => {
      req.params = { supplierId: 's-1' };
      await controller.getSupplierMethods(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ supplier: expect.any(Object), methods: expect.any(Array) }) })
      );
    });
  });

  // ============================
  // getAllSuppliersMethods (admin)
  // ============================
  describe('getAllSuppliersMethods', () => {
    it('returns all suppliers with payout methods', async () => {
      await controller.getAllSuppliersMethods(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ suppliers: expect.any(Array), pagination: expect.any(Object) }) })
      );
    });

    it('filters by hasMethod=true', async () => {
      req.query = { hasMethod: 'true' };
      await controller.getAllSuppliersMethods(req, res, next);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ payoutMethods: { some: {} } }) })
      );
    });

    it('filters by hasMethod=false', async () => {
      req.query = { hasMethod: 'false' };
      await controller.getAllSuppliersMethods(req, res, next);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ payoutMethods: { none: {} } }) })
      );
    });

    it('resolves Firebase photoURL when missing', async () => {
      prisma.user.findMany.mockResolvedValue([{ ...mockSupplier, photoURL: '' }]);

      await controller.getAllSuppliersMethods(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.suppliers[0].photoURL).toBe('fb-photo.jpg');
    });

    it('handles Firebase fetch failure gracefully', async () => {
      prisma.user.findMany.mockResolvedValue([{ ...mockSupplier, photoURL: '' }]);
      admin.auth = () => ({ getUser: jest.fn().mockRejectedValue(new Error('FB error')) });

      await controller.getAllSuppliersMethods(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.suppliers[0].photoURL).toBe('');
    });

    it('supports pagination', async () => {
      req.query = { page: '2', limit: '5' };
      prisma.user.count.mockResolvedValue(12);

      await controller.getAllSuppliersMethods(req, res, next);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 })
      );
      const body = res.json.mock.calls[0][0];
      expect(body.data.pagination.totalPages).toBe(3);
    });
  });

  // ============================
  // verifyPayoutMethod (admin)
  // ============================
  describe('verifyPayoutMethod', () => {
    it('returns 404 when method not found', async () => {
      req.params = { id: 'nonexistent' };
      prisma.payoutMethod.findUnique.mockResolvedValue(null);
      await controller.verifyPayoutMethod(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('verifies payout method', async () => {
      req.params = { id: 'pm-1' };
      req.body = { verified: true };

      await controller.verifyPayoutMethod(req, res, next);

      expect(prisma.payoutMethod.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'pm-1' }, data: { verified: true } })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout_method.verified' }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('unverifies payout method', async () => {
      req.params = { id: 'pm-1' };
      req.body = { verified: false };

      await controller.verifyPayoutMethod(req, res, next);

      expect(prisma.payoutMethod.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'pm-1' }, data: { verified: false } })
      );
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout_method.unverified' }));
    });

    it('defaults verified to true when not provided', async () => {
      req.params = { id: 'pm-1' };

      await controller.verifyPayoutMethod(req, res, next);

      expect(prisma.payoutMethod.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { verified: true } })
      );
    });
  });

  // ============================
  // getPayoutMethodSummary (admin)
  // ============================
  describe('getPayoutMethodSummary', () => {
    it('computes coverage, readiness, and type mix', async () => {
      const suppliers = [
        { id: 's-1', name: 'A', email: 'a@t.com', payoutMethods: [{ id: 'm1', type: 'BANK_TRANSFER', verified: true, isDefault: true }] },
        { id: 's-2', name: 'B', email: 'b@t.com', payoutMethods: [{ id: 'm2', type: 'PAYPAL', verified: false, isDefault: false }, { id: 'm3', type: 'PAYPAL', verified: true, isDefault: true }] },
        { id: 's-3', name: 'C', email: 'c@t.com', payoutMethods: [] },
        { id: 's-4', name: 'D', email: 'd@t.com', payoutMethods: [{ id: 'm4', type: 'BANK_TRANSFER', verified: true, isDefault: true }] },
      ];
      prisma.user.findMany.mockResolvedValue(suppliers);

      await controller.getPayoutMethodSummary(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(res.status).toHaveBeenCalledWith(200);
      expect(body.data.totalSuppliers).toBe(4);
      expect(body.data.withMethod).toBe(3);
      expect(body.data.needSetup).toBe(1);
      expect(body.data.unverified).toBe(1);
      expect(body.data.hasDefault).toBe(3);
      expect(body.data.typeMix).toEqual({
        BANK_TRANSFER: { total: 2, verified: 2 },
        PAYPAL: { total: 2, verified: 1 },
      });
    });
  });
});
