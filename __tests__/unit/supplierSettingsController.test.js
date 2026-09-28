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

describe('getBusinessProfile', () => {
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

  it("returns the application identity and supplier type alongside the profile", async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({
      businessInfo: { displayName: 'Kofi Solo Tours', supplierChoice: 'individual_guide', businessType: 'individual' },
      operatingInfo: { regions: ['Greater Accra', 'Central'], services: ['tours'] },
      representativeInfo: {
        fullName: 'Kofi Mensah',
        email: 'kofi@example.com',
        dateOfBirth: '1990-01-01',
        idType: 'national_id',
        idNumber: 'GA-123456789',
      },
      supplierType: 'TOUR_GUIDE',
      status: 'ACTIVE',
    });

    await controller.getBusinessProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          supplierType: 'TOUR_GUIDE',
          status: 'ACTIVE',
          representativeInfo: expect.objectContaining({
            fullName: 'Kofi Mensah',
            dateOfBirth: '1990-01-01',
            idType: 'national_id',
            idNumber: 'GA-123456789',
          }),
          operatingInfo: expect.objectContaining({ regions: ['Greater Accra', 'Central'] }),
        }),
      })
    );
  });

  it('degrades to empty objects when no profile exists yet', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue(null);

    await controller.getBusinessProfile(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          businessInfo: {},
          operatingInfo: {},
          representativeInfo: {},
          supplierType: null,
          status: null,
        },
      })
    );
  });
});

describe('updateBusinessProfile', () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { supplierId: 'u-1', user: { id: 'u-1' }, body: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  it("merges a nested address object and operating regions without losing existing keys", async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue({
      businessInfo: {
        displayName: 'Existing brand',
        address: { line1: 'Legacy address' },
        supplierChoice: 'individual_guide',
      },
      operatingInfo: { regions: ['Ashanti'], services: ['tours'], tourCategories: ['Cultural'] },
    });
    prisma.supplierProfile.update.mockResolvedValue({
      businessInfo: {},
      operatingInfo: {},
    });

    req.body = {
      businessInfo: {
        displayName: 'New brand',
        address: { line1: '1 Independence Ave', line2: '', city: 'Accra', state: 'Greater Accra', postalCode: 'GA-123' },
      },
      operatingInfo: { regions: ['Greater Accra', 'Central'] },
    };

    await controller.updateBusinessProfile(req, res);

    expect(prisma.supplierProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          businessInfo: expect.objectContaining({
            // pre-existing keys survive the shallow merge
            supplierChoice: 'individual_guide',
            displayName: 'New brand',
            address: { line1: '1 Independence Ave', line2: '', city: 'Accra', state: 'Greater Accra', postalCode: 'GA-123' },
          }),
          operatingInfo: expect.objectContaining({
            regions: ['Greater Accra', 'Central'],
            services: ['tours'],
            tourCategories: ['Cultural'],
          }),
        }),
      })
    );
  });

  it('returns 404 when the supplier has no profile', async () => {
    prisma.supplierProfile.findUnique.mockResolvedValue(null);
    const next = jest.fn();

    await controller.updateBusinessProfile(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(prisma.supplierProfile.update).not.toHaveBeenCalled();
  });
});
