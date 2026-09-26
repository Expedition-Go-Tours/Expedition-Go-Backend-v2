/**
 * Per-operator verification requirements — the single matrix behind both the
 * up-front enforcement and the supplier dashboard checklist.
 */
const {
  requirementsFor,
  upfrontSupplierDocumentTypes,
} = require('../../src/core/services/supplierVerificationRequirements');

const types = (req) => req.documents.map((doc) => doc.type);

describe('requirementsFor', () => {
  it('requires an ID for everyone and a business certificate for businesses', () => {
    expect(upfrontSupplierDocumentTypes('TOUR_COMPANY', 'GH')).toEqual(['GHANA_CARD', 'BUSINESS_CERTIFICATE']);
    expect(upfrontSupplierDocumentTypes('TRANSPORTATION_PROVIDER', 'GH')).toEqual(['GHANA_CARD', 'BUSINESS_CERTIFICATE']);
    expect(upfrontSupplierDocumentTypes('ACCOMMODATION_PROVIDER', 'GH')).toEqual(['GHANA_CARD', 'BUSINESS_CERTIFICATE']);
    expect(upfrontSupplierDocumentTypes('TOUR_GUIDE', 'GH')).toEqual(['GHANA_CARD']);
    expect(upfrontSupplierDocumentTypes('VEHICLE_OPERATOR', 'GH')).toEqual(['GHANA_CARD']);
    expect(upfrontSupplierDocumentTypes('OTHER_SERVICE_PROVIDER', 'GH')).toEqual(['GHANA_CARD']);
  });

  it('uses the national ID outside Ghana', () => {
    expect(upfrontSupplierDocumentTypes('TOUR_GUIDE', 'US')).toEqual(['NATIONAL_ID']);
  });

  it('adds the GTA licence to tour companies that sell tours', () => {
    const withTours = requirementsFor({ supplierType: 'TOUR_COMPANY', businessType: 'company', services: ['Tours & Activities'], country: 'GH' });
    expect(types(withTours)).toContain('GTA_CERTIFICATE');
    expect(withTours.guides).toBe('required');

    const withoutTours = requirementsFor({ supplierType: 'TOUR_COMPANY', businessType: 'individual', services: [], country: 'GH' });
    expect(types(withoutTours)).not.toContain('GTA_CERTIFICATE');
    // A sole proprietor may work alone.
    expect(withoutTours.guides).toBe('optional');
    expect(withoutTours.vehicles).toBe('hidden');
  });

  it('gives transport operators vehicles and their transport documents', () => {
    const transport = requirementsFor({ supplierType: 'TRANSPORTATION_PROVIDER', services: ['Airport Transfers'], country: 'GH' });
    expect(types(transport)).toEqual(
      expect.arrayContaining(['BUSINESS_CERTIFICATE', 'PASSENGER_TRANSPORT_LICENCE'])
    );
    expect(transport.vehicles).toBe('required');
    expect(transport.guides).toBe('optional');

    const driver = requirementsFor({ supplierType: 'VEHICLE_OPERATOR', services: [], country: 'GH' });
    expect(types(driver)).toEqual(
      expect.arrayContaining(['PASSENGER_TRANSPORT_LICENCE', 'DRIVERS_LICENCE'])
    );
    expect(driver.vehicles).toBe('required');
    expect(driver.guides).toBe('hidden');
  });

  it('only asks a tour guide for a driver licence when they offer transport', () => {
    const plain = requirementsFor({ supplierType: 'TOUR_GUIDE', services: ['Tours & Activities'], country: 'GH' });
    expect(types(plain)).toContain('TOUR_GUIDE_LICENCE');
    expect(types(plain)).not.toContain('DRIVERS_LICENCE');
    expect(plain.vehicles).toBe('hidden');

    const withTransport = requirementsFor({ supplierType: 'TOUR_GUIDE', services: ['Private Transport'], country: 'GH' });
    expect(types(withTransport)).toContain('DRIVERS_LICENCE');
    expect(withTransport.vehicles).toBe('optional');
  });

  it('keeps an experience host to the basics', () => {
    const host = requirementsFor({ supplierType: 'OTHER_SERVICE_PROVIDER', services: ['Other Experience'], country: 'GH' });
    expect(types(host)).toEqual(['GHANA_CARD', 'PROFILE_PHOTO']);
    expect(host.vehicles).toBe('hidden');
    expect(host.guides).toBe('hidden');
  });

  it('degrades safely for an unknown or missing type', () => {
    const unknown = requirementsFor({});
    expect(unknown.documents.length).toBeGreaterThan(0);
    expect(unknown.vehicles).toBe('hidden');
    expect(unknown.guides).toBe('hidden');
    // Every requirement carries a human label for the UI.
    for (const doc of unknown.documents) expect(doc.label).toBeTruthy();
  });
});
