/**
 * Validation for the supplier application payload. The multipart sections used
 * to be stored verbatim, so an unknown `supplierType` blew up inside Prisma
 * (500) and malformed sections produced blank applications in the admin.
 */
const {
  normalizeSupplierType,
  parseSection,
  requestedPayoutCycle,
  validateSupplierApplication,
} = require('../../src/core/services/supplierApplicationPayload');

const validApplication = () => ({
  supplierType: 'tour_company',
  businessInfo: {
    legalBusinessName: 'Expedition-Go Tours Ltd',
    displayName: 'Expedition-Go Tours',
    businessType: 'company',
    country: 'GH',
    phoneNumber: '0244000000',
  },
  operatingInfo: { regions: ['Greater Accra'], services: ['Tours & Activities'], yearsInBusiness: 4 },
  representativeInfo: { fullName: 'Gideon Kwarteng', email: 'gideon@example.com' },
  payoutInfo: { schedule: 'MONTHLY', method: 'bank', payoutCurrency: 'GHS' },
  compliance: { acceptedTerms: true },
});

describe('supplierApplicationPayload', () => {
  it('accepts a complete storefront payload and normalises the supplier type', () => {
    const { errors, supplierType } = validateSupplierApplication(validApplication());

    expect(errors).toEqual([]);
    expect(supplierType).toBe('TOUR_COMPANY');
  });

  it('defaults the supplier type to TOUR_COMPANY when omitted', () => {
    expect(normalizeSupplierType(undefined)).toBe('TOUR_COMPANY');
    expect(validateSupplierApplication({ ...validApplication(), supplierType: undefined }).supplierType).toBe(
      'TOUR_COMPANY'
    );
  });

  it('rejects an unknown supplierType instead of letting Prisma throw', () => {
    const { errors } = validateSupplierApplication({ ...validApplication(), supplierType: 'TOUR_OPERATOR' });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('supplierType must be one of');
    expect(errors[0]).toContain('TOUR_COMPANY');
  });

  it('rejects missing or non-object sections on a new application', () => {
    const missing = validateSupplierApplication({ supplierType: 'TOUR_COMPANY' });
    expect(missing.errors).toEqual(
      expect.arrayContaining([
        'businessInfo is required',
        'operatingInfo is required',
        'representativeInfo is required',
        'payoutInfo is required',
      ])
    );

    const malformed = validateSupplierApplication({
      ...validApplication(),
      businessInfo: 'not-json',
    });
    expect(malformed.errors).toContain('businessInfo must be an object');
  });

  it('allows partial updates to omit sections but still validates the ones sent', () => {
    const partial = validateSupplierApplication(
      { payoutInfo: { method: 'bank', payoutCurrency: 'GHS' } },
      { partial: true }
    );
    expect(partial.errors).toEqual([]);

    const invalidPartial = validateSupplierApplication(
      { representativeInfo: { fullName: 'Gideon', email: 'not-an-email' } },
      { partial: true }
    );
    expect(invalidPartial.errors).toEqual(['representativeInfo.email must be a valid email address']);
  });

  it('requires a business name and validates enum-ish fields', () => {
    const { errors } = validateSupplierApplication({
      ...validApplication(),
      businessInfo: {
        businessType: 'partnership',
        country: 'Ghana',
        phoneNumber: '',
      },
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        'businessInfo.legalBusinessName or businessInfo.displayName is required',
        'businessInfo.businessType must be one of: individual, company, non_profit',
        'businessInfo.country must be an ISO 3166-1 alpha-2 code (e.g. "GH")',
        'businessInfo.phoneNumber must be a string',
      ])
    );
  });

  it('validates operating, representative and payout details', () => {
    const { errors } = validateSupplierApplication({
      ...validApplication(),
      operatingInfo: { regions: 'Greater Accra', yearsInBusiness: 250 },
      representativeInfo: { fullName: '   ' },
      payoutInfo: { schedule: 'daily', method: 'crypto', payoutCurrency: 'CEDIS' },
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        'operatingInfo.regions must be an array',
        'operatingInfo.yearsInBusiness must be a number between 0 and 100',
        'representativeInfo.fullName is required',
        'payoutInfo.schedule must be one of: WEEKLY, TWICE_MONTHLY, MONTHLY',
        'payoutInfo.method must be one of: bank, paypal, momo',
        'payoutInfo.payoutCurrency must be an ISO 4217 code (e.g. "GHS")',
      ])
    );
  });

  it('rejects a non-object compliance block', () => {
    expect(validateSupplierApplication({ ...validApplication(), compliance: true }).errors).toEqual([
      'compliance must be an object',
    ]);
  });

  it('parses multipart JSON string sections', () => {
    expect(parseSection('{"legalBusinessName":"Acme"}')).toEqual({ legalBusinessName: 'Acme' });
    expect(parseSection({ already: 'parsed' })).toEqual({ already: 'parsed' });
    expect(parseSection('not-json')).toBe('not-json');
  });

  it('maps the supplier payout choice onto a valid PayoutCycle', () => {
    expect(requestedPayoutCycle({ schedule: 'monthly' })).toBe('MONTHLY');
    expect(requestedPayoutCycle({ schedule: 'TWICE_MONTHLY' })).toBe('TWICE_MONTHLY');
    expect(requestedPayoutCycle({ schedule: 'daily' })).toBeNull();
    expect(requestedPayoutCycle({})).toBeNull();
    expect(requestedPayoutCycle(null)).toBeNull();
  });
});
