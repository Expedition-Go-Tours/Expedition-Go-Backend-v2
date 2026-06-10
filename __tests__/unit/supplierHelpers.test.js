jest.mock('../../utils/getConfig', () => jest.fn().mockResolvedValue('0.15'));

const getConfig = require('../../utils/getConfig');
const {
  validateSupplierData,
  generateVerificationChecklist,
  getSupplierTier,
  calculateSupplierMetrics,
} = require('../../utils/supplierHelpers');

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// validateSupplierData
// ---------------------------------------------------------------------------
describe('validateSupplierData', () => {
  const validFullData = {
    businessInfo: {
      legalBusinessName: 'Acme Tours Inc.',
      displayName: 'Acme Tours',
      businessType: 'company',
      country: 'US',
      address: { line1: '123 Main St', city: 'NYC', state: 'NY', postalCode: '10001' },
      phoneNumber: '+1234567890',
      website: 'https://acme.com',
    },
    operatingInfo: {
      tourCategories: ['Adventure'],
      destinations: ['USA'],
      languages: ['English'],
      yearsInBusiness: 5,
      cancellationPolicy: 'Flexible',
      meetingStyle: 'pickup',
    },
    representativeInfo: {
      fullName: 'John Doe',
      email: 'john@acme.com',
      dateOfBirth: '1990-01-01',
      address: { line1: '456 Oak Ave', city: 'NYC', state: 'NY', postalCode: '10002' },
      phoneNumber: '+1987654321',
      idType: 'passport',
      idDocumentUrl: 'https://docs.example.com/id.pdf',
    },
    businessDocuments: {
      registrationDocumentUrl: 'https://docs.example.com/reg.pdf',
      taxDocumentUrl: 'https://docs.example.com/tax.pdf',
      proofOfAddressUrl: 'https://docs.example.com/poa.pdf',
    },
    payoutInfo: {
      bankAccountName: 'Acme Tours Inc.',
      bankCountry: 'US',
      payoutCurrency: 'USD',
    },
  };

  it('returns valid for complete data', () => {
    const result = validateSupplierData(validFullData);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns errors when top-level sections are missing for new applications', () => {
    const result = validateSupplierData({});
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Business information is required');
    expect(result.errors).toContain('Operating information is required');
    expect(result.errors).toContain('Representative information is required');
  });

  it('skips top-level section checks for partial updates', () => {
    const result = validateSupplierData({}, true);
    expect(result.errors).not.toContain('Business information is required');
  });

  // --- businessInfo ---
  it('validates businessInfo fields', () => {
    const result = validateSupplierData({
      businessInfo: { businessType: 'invalid', country: 'USA', phoneNumber: 'abc', website: 'no-url' },
    });
    expect(result.errors).toContain('Legal business name is required');
    expect(result.errors).toContain('Display name is required');
    expect(result.errors).toContain('Valid business type is required (individual, company, or non_profit)');
    expect(result.errors).toContain('Valid 2-letter country code is required');
    expect(result.errors).toContain('Business address is required');
    expect(result.errors).toContain('Invalid phone number format');
    expect(result.errors).toContain('Invalid website URL format');
  });

  it('validates business address fields', () => {
    const result = validateSupplierData({
      businessInfo: { legalBusinessName: 'N', displayName: 'N', businessType: 'company', country: 'US', address: {} },
    });
    expect(result.errors).toContain('Address line 1 is required');
    expect(result.errors).toContain('City is required');
    expect(result.errors).toContain('State/Province is required');
    expect(result.errors).toContain('Postal code is required');
  });

  it('accepts valid businessInfo without optional phone/website', () => {
    const result = validateSupplierData({
      businessInfo: { legalBusinessName: 'N', displayName: 'N', businessType: 'individual', country: 'GB', address: { line1: '1', city: 'Lon', state: 'LDN', postalCode: 'SW1' } },
    });
    expect(result.errors.filter(e => e.includes('business') || e.includes('phone') || e.includes('website'))).toHaveLength(0);
  });

  // --- operatingInfo ---
  it('validates operatingInfo fields', () => {
    const result = validateSupplierData({
      operatingInfo: { yearsInBusiness: -1, meetingStyle: 'unknown' },
    });
    expect(result.errors).toContain('At least one tour category is required');
    expect(result.errors).toContain('At least one destination is required');
    expect(result.errors).toContain('At least one language is required');
    expect(result.errors).toContain('Years in business must be between 0 and 100');
    expect(result.errors).toContain('Cancellation policy is required');
    expect(result.errors).toContain('Valid meeting style is required (pickup, meeting_point, or flexible)');
  });

  it('validates yearsInBusiness upper bound', () => {
    const result = validateSupplierData({ operatingInfo: { yearsInBusiness: 101 } });
    expect(result.errors).toContain('Years in business must be between 0 and 100');
  });

  it('accepts valid operatingInfo', () => {
    const result = validateSupplierData({
      operatingInfo: { tourCategories: ['A'], destinations: ['B'], languages: ['C'], cancellationPolicy: 'X', meetingStyle: 'flexible' },
    });
    expect(result.errors.filter(e => e.includes('category') || e.includes('destination') || e.includes('language') || e.includes('Cancellation') || e.includes('meeting'))).toHaveLength(0);
  });

  // --- representativeInfo ---
  it('validates representativeInfo fields', () => {
    const result = validateSupplierData({
      representativeInfo: { email: 'not-email', dateOfBirth: '2010-01-01', idType: 'badge', idDocumentUrl: 'not-a-url' },
    });
    expect(result.errors).toContain('Representative full name is required');
    expect(result.errors).toContain('Valid email address is required');
    expect(result.errors).toContain('Representative must be between 18 and 100 years old');
    expect(result.errors).toContain('Representative address is required');
    expect(result.errors).toContain('Valid ID type is required (passport, drivers_license, or national_id)');
    expect(result.errors).toContain('Valid ID document URL is required');
  });

  it('validates representative address fields', () => {
    const result = validateSupplierData({
      representativeInfo: { fullName: 'J', email: 'j@j.com', dateOfBirth: '1990-01-01', idType: 'drivers_license', idDocumentUrl: 'https://ex.com/doc.pdf', address: {} },
    });
    expect(result.errors).toContain('Representative address line 1 is required');
    expect(result.errors).toContain('Representative city is required');
    expect(result.errors).toContain('Representative state/province is required');
    expect(result.errors).toContain('Representative postal code is required');
  });

  it('accepts valid representativeInfo without optional phone', () => {
    const result = validateSupplierData({
      representativeInfo: { fullName: 'J', email: 'j@j.com', dateOfBirth: '1990-01-01', idType: 'national_id', idDocumentUrl: 'https://ex.com/doc.pdf', address: { line1: '1', city: 'Lon', state: 'LDN', postalCode: 'SW1' } },
    });
    expect(result.errors.filter(e => e.includes('representative') || e.includes('Valid'))).toHaveLength(0);
  });

  it('validates representative dateOfBirth upper bound', () => {
    const result = validateSupplierData({
      representativeInfo: { fullName: 'J', email: 'j@j.com', dateOfBirth: '1900-01-01', idType: 'passport', idDocumentUrl: 'https://ex.com/doc.pdf', address: { line1: '1', city: 'Lon', state: 'LDN', postalCode: 'SW1' } },
    });
    expect(result.errors).toContain('Representative must be between 18 and 100 years old');
  });

  // --- businessDocuments ---
  it('validates businessDocuments fields', () => {
    const result = validateSupplierData({
      businessDocuments: { registrationDocumentUrl: 'bad', taxDocumentUrl: 'bad', proofOfAddressUrl: 'bad', licenses: 'not-array' },
    });
    expect(result.errors).toContain('Valid business registration document URL is required');
    expect(result.errors).toContain('Valid tax document URL is required');
    expect(result.errors).toContain('Valid proof of address document URL is required');
    expect(result.errors).toContain('Licenses must be an array of URLs');
  });

  it('validates license URLs', () => {
    const result = validateSupplierData({
      businessDocuments: { registrationDocumentUrl: 'https://ex.com/r.pdf', taxDocumentUrl: 'https://ex.com/t.pdf', proofOfAddressUrl: 'https://ex.com/p.pdf', licenses: ['invalid-url'] },
    });
    expect(result.errors).toContain('All license URLs must be valid');
  });

  it('accepts valid businessDocuments without licenses', () => {
    const result = validateSupplierData({
      businessDocuments: { registrationDocumentUrl: 'https://ex.com/r.pdf', taxDocumentUrl: 'https://ex.com/t.pdf', proofOfAddressUrl: 'https://ex.com/p.pdf' },
    });
    expect(result.errors.filter(e => e.includes('document'))).toHaveLength(0);
  });

  it('accepts valid licenses array', () => {
    const result = validateSupplierData({
      businessDocuments: { registrationDocumentUrl: 'https://ex.com/r.pdf', taxDocumentUrl: 'https://ex.com/t.pdf', proofOfAddressUrl: 'https://ex.com/p.pdf', licenses: ['https://ex.com/l1.pdf', 'https://ex.com/l2.pdf'] },
    });
    expect(result.errors.filter(e => e.includes('license'))).toHaveLength(0);
  });

  // --- payoutInfo ---
  it('validates payoutInfo fields', () => {
    const result = validateSupplierData({
      payoutInfo: { bankAccountName: '', bankCountry: 'USA', payoutCurrency: 'US' },
    });
    expect(result.errors).toContain('Bank account name is required');
    expect(result.errors).toContain('Valid 2-letter bank country code is required');
    expect(result.errors).toContain('Valid 3-letter payout currency code is required');
  });

  it('skips payoutInfo validation when empty-ish', () => {
    const result = validateSupplierData({ payoutInfo: { bankAccountName: '', bankCountry: '', payoutCurrency: '' } });
    expect(result.errors.filter(e => e.includes('bank') || e.includes('payout'))).toHaveLength(0);
  });

  it('accepts valid payoutInfo', () => {
    const result = validateSupplierData({ payoutInfo: { bankAccountName: 'A', bankCountry: 'GB', payoutCurrency: 'EUR' } });
    expect(result.errors.filter(e => e.includes('bank') || e.includes('payout'))).toHaveLength(0);
  });

  // --- businessInfo phone/website edge cases ---
  it('accepts valid phone and website formats', () => {
    const result = validateSupplierData({
      businessInfo: { legalBusinessName: 'N', displayName: 'N', businessType: 'company', country: 'US', address: { line1: '1', city: 'Lon', state: 'LDN', postalCode: 'SW1' }, phoneNumber: '+1 (123) 456-7890', website: 'http://example.com' },
    });
    expect(result.errors.filter(e => e.includes('phone') || e.includes('website'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateVerificationChecklist
// ---------------------------------------------------------------------------
describe('generateVerificationChecklist', () => {
  it('returns checklist with all sections completed for full profile', () => {
    const profile = {
      businessInfo: { legalBusinessName: 'A', address: { line1: '1' }, businessType: 'co', phoneNumber: '+1' },
      operatingInfo: { tourCategories: ['A'], destinations: ['B'], languages: ['C'], cancellationPolicy: 'X' },
      representativeInfo: { fullName: 'J', email: 'j@j.com', dateOfBirth: '1990-01-01', idDocumentUrl: 'https://ex.com/doc.pdf' },
      businessDocuments: { registrationDocumentUrl: 'https://ex.com/r.pdf', taxDocumentUrl: 'https://ex.com/t.pdf', proofOfAddressUrl: 'https://ex.com/p.pdf' },
      payoutInfo: { bankAccountName: 'A', bankCountry: 'US', payoutCurrency: 'USD' },
    };
    const result = generateVerificationChecklist(profile);
    expect(result.businessInfo.completed).toBe(true);
    expect(result.operatingInfo.completed).toBe(true);
    expect(result.representativeInfo.completed).toBe(true);
    expect(result.businessDocuments.completed).toBe(true);
    expect(result.payoutInfo.completed).toBe(true);
    expect(result.overall.percentage).toBe(100);
  });

  it('returns incomplete sections for missing data', () => {
    const result = generateVerificationChecklist({});
    expect(result.businessInfo.completed).toBe(false);
    expect(result.operatingInfo.completed).toBe(false);
    expect(result.representativeInfo.completed).toBe(false);
    expect(result.businessDocuments.completed).toBe(false);
    expect(result.payoutInfo.completed).toBe(false);
    expect(result.overall.percentage).toBe(0);
  });

  it('counts item-level completion correctly', () => {
    const profile = {
      businessInfo: { legalBusinessName: 'A' },
    };
    const result = generateVerificationChecklist(profile);
    expect(result.businessInfo.items[0].completed).toBe(true);
    expect(result.businessInfo.items[1].completed).toBe(false);
    expect(result.businessInfo.items[2].completed).toBe(false);
    expect(result.businessInfo.items[3].completed).toBe(false);
    expect(result.overall.percentage).toBeGreaterThan(0);
    expect(result.overall.percentage).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// getSupplierTier
// ---------------------------------------------------------------------------
describe('getSupplierTier', () => {
  it('returns platinum for top performers', async () => {
    const result = await getSupplierTier({ totalBookings: 100, averageRating: 4.8, totalEarnings: 10000 });
    expect(result.tier).toBe('platinum');
    expect(result.commissionRate).toBeCloseTo(0.1, 5);
  });

  it('returns gold for mid-tier performers', async () => {
    const result = await getSupplierTier({ totalBookings: 50, averageRating: 4.5, totalEarnings: 5000 });
    expect(result.tier).toBe('gold');
    expect(result.commissionRate).toBeCloseTo(0.12, 5);
  });

  it('returns silver for moderate performers', async () => {
    const result = await getSupplierTier({ totalBookings: 20, averageRating: 4.0, totalEarnings: 1000 });
    expect(result.tier).toBe('silver');
    expect(result.commissionRate).toBeCloseTo(0.14, 5);
  });

  it('returns bronze for new or low performers', async () => {
    const result = await getSupplierTier({ totalBookings: 0, averageRating: 0, totalEarnings: 0 });
    expect(result.tier).toBe('bronze');
    expect(result.commissionRate).toBeCloseTo(0.15, 5);
  });

  it('ensures commissionRate does not go below 0.01', async () => {
    getConfig.mockResolvedValue('0.03');
    const result = await getSupplierTier({ totalBookings: 100, averageRating: 4.8, totalEarnings: 10000 });
    expect(result.commissionRate).toBeCloseTo(0.01, 5);
  });

  it('returns bronze when some conditions not met', async () => {
    const result = await getSupplierTier({ totalBookings: 100, averageRating: 3.0, totalEarnings: 10000 });
    expect(result.tier).toBe('bronze');
  });
});

// ---------------------------------------------------------------------------
// calculateSupplierMetrics
// ---------------------------------------------------------------------------
describe('calculateSupplierMetrics', () => {
  const profile = { totalEarnings: 10000, totalBookings: 20, averageRating: 4.5 };

  it('returns zeros when no bookings or reviews', () => {
    const result = calculateSupplierMetrics(profile, [], []);
    expect(result.totalRevenue).toBe(10000);
    expect(result.totalBookings).toBe(20);
    expect(result.averageRating).toBe(4.5);
    expect(result.cancellationRate).toBe(0);
    expect(result.averageBookingValue).toBe(0);
    expect(result.repeatCustomerRate).toBe(0);
    expect(result.responseRate).toBe(0);
  });

  it('calculates cancellation rate correctly', () => {
    const bookings = [
      { status: 'CANCELLED', total: '100', customerId: 'c1' },
      { status: 'CONFIRMED', total: '200', customerId: 'c1' },
      { status: 'CONFIRMED', total: '300', customerId: 'c2' },
    ];
    const result = calculateSupplierMetrics(profile, bookings, []);
    expect(result.cancellationRate).toBe(33.33333333333333);
  });

  it('calculates average booking value from confirmed bookings', () => {
    const bookings = [
      { status: 'CONFIRMED', total: '100', customerId: 'c1' },
      { status: 'CONFIRMED', total: '200', customerId: 'c2' },
      { status: 'CANCELLED', total: '300', customerId: 'c3' },
    ];
    const result = calculateSupplierMetrics(profile, bookings, []);
    expect(result.averageBookingValue).toBe(150);
  });

  it('skips average booking value when no confirmed bookings', () => {
    const bookings = [{ status: 'CANCELLED', total: '100', customerId: 'c1' }];
    const result = calculateSupplierMetrics(profile, bookings, []);
    expect(result.averageBookingValue).toBe(0);
  });

  it('calculates repeat customer rate correctly', () => {
    const bookings = [
      { status: 'CONFIRMED', total: '100', customerId: 'c1' },
      { status: 'CONFIRMED', total: '200', customerId: 'c1' },
      { status: 'CONFIRMED', total: '300', customerId: 'c2' },
    ];
    const result = calculateSupplierMetrics(profile, bookings, []);
    expect(result.repeatCustomerRate).toBe(33.33333333333333);
  });

  it('handles single customer bookings', () => {
    const bookings = [
      { status: 'CONFIRMED', total: '100', customerId: 'c1' },
    ];
    const result = calculateSupplierMetrics(profile, bookings, []);
    expect(result.repeatCustomerRate).toBe(0);
  });

  it('calculates response rate from reviews', () => {
    const reviews = [
      { supplierResponse: 'Thanks!' },
      { supplierResponse: null },
      { supplierResponse: 'Appreciate it' },
    ];
    const result = calculateSupplierMetrics(profile, [], reviews);
    expect(result.responseRate).toBe(66.66666666666666);
  });

  it('returns zero response rate when no reviews', () => {
    const result = calculateSupplierMetrics(profile, [], []);
    expect(result.responseRate).toBe(0);
  });

  it('uses profile defaults when profile values are missing', () => {
    const result = calculateSupplierMetrics({}, [], []);
    expect(result.totalRevenue).toBe(0);
    expect(result.totalBookings).toBe(0);
    expect(result.averageRating).toBe(0);
  });
});
