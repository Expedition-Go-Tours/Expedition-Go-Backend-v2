/**
 * Supplier verification controller — the vehicle-upload status guard.
 *
 * Auto-accepted suppliers are ACTIVE from submission, so they must be able to
 * add vehicles; only blocked statuses should be refused.
 */
jest.mock('../../src/core/services/prismaClient', () => {
  const tx = {
    vehicle: { create: jest.fn().mockResolvedValue({ id: 'v-1' }) },
    supplierDocument: { create: jest.fn().mockResolvedValue({}) },
  };
  return {
    supplierProfile: { findUnique: jest.fn() },
    vehicle: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), delete: jest.fn() },
    guide: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), delete: jest.fn() },
    supplierDocument: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    verificationEvent: { create: jest.fn().mockResolvedValue({}) },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn((fn) => fn(tx)),
  };
});

jest.mock('../../src/core/services/supplierVerification', () => ({
  parseDocuments: jest.fn(() => []),
  parseVehiclePhotos: jest.fn(() => ({})),
  parseVehicles: jest.fn(() => [
    { key: 'vehicle-1', make: 'Toyota', model: 'Hiace', registrationNumber: 'GT-1234-24' },
  ]),
}));

jest.mock('../../src/core/services/cloudinaryHelper', () => ({
  deleteCloudinaryImage: jest.fn(),
  isValidCloudinaryUrl: jest.fn(() => true),
}));
jest.mock('../../src/core/services/queue', () => ({ enqueueNotification: jest.fn() }));
jest.mock('../../src/core/services/adminNotificationService', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../src/core/services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const prisma = require('../../src/core/services/prismaClient');
const controller = require('../../src/core/domain/supplierVerificationController');

describe('supplierVerificationController.addVehicle', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { body: {}, user: { id: 'u-1' }, supplierId: 'u-1' };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();
  });

  it('lets an ACTIVE (auto-accepted) supplier add a vehicle', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({ id: 'sp-1', userId: 'u-1', status: 'ACTIVE' });

    await controller.addVehicle(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('refuses a suspended supplier', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({ id: 'sp-1', userId: 'u-1', status: 'SUSPENDED' });

    await controller.addVehicle(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(res.status).not.toHaveBeenCalledWith(201);
  });
});
