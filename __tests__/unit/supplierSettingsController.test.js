/**
 * Tax tab data must be prefilled from the supplier's application.
 *
 * The application stores its tax details in `businessInfo` (tin, legal name,
 * business type, country) while this tab reads `compliance.taxInfo`, so every
 * new supplier used to open an empty Tax Information tab and retype what they
 * had already submitted.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  supplierProfile: { findUnique: jest.fn(), update: jest.fn() },
}));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../src/core/services/notificationRecipientService', () => ({}));
jest.mock('../../src/core/services/notificationRecipientPage', () => ({ renderNotificationRecipientPage: jest.fn() }));
jest.mock('../../src/core/services/emailService', () => ({
  sendNotificationRecipientVerificationEmail: jest.fn(),
  resolveEmailBrand: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const controller = require('../../src/core/domain/supplierSettingsController');

describe('getTaxInfo', () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { supplierId: 'u-1', user: { id: 'u-1' } };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  it('falls back to the application when no tax record was saved yet', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({
      compliance: {},
      businessDocuments: {},
      businessInfo: {
        tin: 'C0012345678',
        country: 'GH',
        legalBusinessName: 'Solo Transports Ltd',
        businessType: 'company',
      },
    });

    await controller.getTaxInfo(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taxInfo: {
            taxId: 'C0012345678',
            taxCountry: 'GH',
            legalBusinessName: 'Solo Transports Ltd',
            businessType: 'company',
          },
        }),
      })
    );
  });

  it('prefers saved tax details over the application', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({
      compliance: { taxInfo: { taxId: 'SAVED', taxCountry: 'GH', legalBusinessName: 'Saved Ltd', businessType: 'individual' } },
      businessDocuments: {},
      businessInfo: { tin: 'OLD', country: 'GH', legalBusinessName: 'Old Name', businessType: 'company' },
    });

    await controller.getTaxInfo(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taxInfo: expect.objectContaining({ taxId: 'SAVED', legalBusinessName: 'Saved Ltd', businessType: 'individual' }),
        }),
      })
    );
  });

  it('degrades cleanly for an application with no tax details at all', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({ compliance: null, businessInfo: null, businessDocuments: {} });

    await controller.getTaxInfo(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taxInfo: { taxId: '', taxCountry: '', legalBusinessName: '', businessType: 'individual' },
        }),
      })
    );
  });
});
