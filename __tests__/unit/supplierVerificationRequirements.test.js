/**
 * Per-operator verification requirements — the single matrix behind both the
 * up-front enforcement and the supplier dashboard checklist. These tests also
 * pin the reconciled matrix so that what the storefront wizard now displays
 * (via GET /suppliers/requirements) can never silently change shape.
 */
const {
  requirementsFor,
  upfrontSupplierDocumentTypes,
  resolveSupplierChoice,
  SUPPLIER_CHOICES,
  SUPPLIER_CHOICE_IDS,
  DOCUMENT_LABELS,
  DOCUMENTATION_GRACE_DAYS,
  enforcedUpfrontRequirementTypes,
  isEnforcedSetSatisfied,
  documentationDeadlineAfter,
} = require('../../src/core/services/supplierVerificationRequirements');

const types = (req) => req.documents.map((doc) => doc.type);
const laterTypes = (req) => req.documents.filter((doc) => doc.timing === 'later').map((doc) => doc.type);
const upfront = (req) => req.documents.filter((doc) => doc.timing === 'upfront');

describe('upfrontSupplierDocumentTypes', () => {
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
});

describe('requirementsFor', () => {
  it('adds the GTA licence to tour businesses that sell tours', () => {
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

describe('supplierChoice — the six-way wizard cards', () => {
  it('exposes the same six ids the storefront wizard offers', () => {
    expect(SUPPLIER_CHOICE_IDS).toEqual([
      'registered_company',
      'sole_proprietor',
      'individual_guide',
      'experience_host',
      'transport_company',
      'independent_driver',
    ]);
  });

  it('answers from the choice alone — no profile needed (wizard step 5)', () => {
    const fromChoice = requirementsFor({ supplierChoice: 'transport_company', services: ['Tours & Activities'], country: 'GH' });
    const fromEnum = requirementsFor({
      supplierType: 'TRANSPORTATION_PROVIDER',
      businessType: 'company',
      services: ['Tours & Activities'],
      country: 'GH',
    });
    expect(fromChoice.supplierType).toBe('TRANSPORTATION_PROVIDER');
    expect(fromChoice.supplierChoice).toBe('transport_company');
    expect(fromChoice.documents.map((d) => d.type)).toEqual(fromEnum.documents.map((d) => d.type));
  });

  it('distinguishes a registered company from a sole proprietor (both TOUR_COMPANY)', () => {
    const company = requirementsFor({ supplierChoice: 'registered_company', services: [], country: 'GH' });
    const sole = requirementsFor({ supplierChoice: 'sole_proprietor', services: [], country: 'GH' });
    expect(company.supplierChoiceLabel).toBe('Registered Company');
    expect(sole.supplierChoiceLabel).toBe('Sole Proprietor / Business');
    // Registered company is expected to work with guides; a sole proprietor may act alone.
    expect(company.guides).toBe('required');
    expect(sole.guides).toBe('optional');
    // Both are businesses, so both carry the business certificate up front.
    expect(upfront(company).map((d) => d.type)).toEqual(['GHANA_CARD', 'BUSINESS_CERTIFICATE']);
    expect(upfront(sole).map((d) => d.type)).toEqual(['GHANA_CARD', 'BUSINESS_CERTIFICATE']);
  });

  it('infers the choice for profiles created before it was persisted', () => {
    expect(resolveSupplierChoice({ supplierType: 'TOUR_COMPANY', businessType: 'company' })).toBe('registered_company');
    expect(resolveSupplierChoice({ supplierType: 'TOUR_COMPANY', businessType: 'individual' })).toBe('sole_proprietor');
    expect(resolveSupplierChoice({ supplierType: 'VEHICLE_OPERATOR' })).toBe('independent_driver');
    expect(resolveSupplierChoice({ supplierType: 'ACCOMMODATION_PROVIDER' })).toBeNull();
  });
});

describe('the reconciled "later" matrix (what the wizard promises)', () => {
  it('registered company — tours → GTA + public liability; transport → vehicle registration/insurance', () => {
    const tours = laterTypes(requirementsFor({ supplierChoice: 'registered_company', services: ['Tours & Activities'], country: 'GH' }));
    expect(tours).toEqual(expect.arrayContaining(['PROFILE_PHOTO', 'PROOF_OF_ADDRESS', 'GTA_CERTIFICATE', 'PUBLIC_LIABILITY_INSURANCE']));
    expect(tours).not.toContain('VEHICLE_REGISTRATION');

    const transport = laterTypes(requirementsFor({ supplierChoice: 'registered_company', services: ['Airport Transfers'], country: 'GH' }));
    expect(transport).toEqual(expect.arrayContaining(['PROFILE_PHOTO', 'PROOF_OF_ADDRESS']));
    expect(transport).not.toContain('GTA_CERTIFICATE');
    // Vehicles become an optional section with the lighter document set.
    const req = requirementsFor({ supplierChoice: 'registered_company', services: ['Airport Transfers'], country: 'GH' });
    expect(req.vehicles).toBe('optional');
    expect(req.vehicleDocuments.map((d) => d.type)).toEqual(['VEHICLE_REGISTRATION', 'VEHICLE_INSURANCE']);
  });

  it('individual tour guide — own licence, never the operator GTA certificate', () => {
    const req = requirementsFor({ supplierChoice: 'individual_guide', services: ['Tours & Activities'], country: 'GH' });
    expect(laterTypes(req)).toEqual(['PROFILE_PHOTO', 'TOUR_GUIDE_LICENCE']);
    expect(types(req)).not.toContain('GTA_CERTIFICATE');
    expect(types(req)).not.toContain('PUBLIC_LIABILITY_INSURANCE');

    const driving = requirementsFor({ supplierChoice: 'individual_guide', services: ['Airport Transfers'], country: 'GH' });
    expect(laterTypes(driving)).toEqual(['PROFILE_PHOTO', 'TOUR_GUIDE_LICENCE', 'DRIVERS_LICENCE']);
  });

  it('transport company — full transport set; vehicles required with all four docs', () => {
    const req = requirementsFor({ supplierChoice: 'transport_company', services: ['Tours & Activities'], country: 'GH' });
    expect(laterTypes(req)).toEqual([
      'PROFILE_PHOTO',
      'PROOF_OF_ADDRESS',
      'GTA_CERTIFICATE',
      'PUBLIC_LIABILITY_INSURANCE',
      'PASSENGER_TRANSPORT_LICENCE',
      'DRIVERS_LICENCE',
    ]);
    expect(req.vehicles).toBe('required');
    expect(req.vehicleDocuments.map((d) => d.type)).toEqual([
      'VEHICLE_REGISTRATION',
      'VEHICLE_OWNERSHIP',
      'VEHICLE_ROADWORTHINESS',
      'VEHICLE_INSURANCE',
    ]);
    expect(req.guides).toBe('optional');
    expect(req.guideDocuments.map((d) => d.type)).toEqual(['TOUR_GUIDE_LICENCE']);
  });

  it('independent driver — driver licence + passenger transport licence + vehicles', () => {
    const req = requirementsFor({ supplierChoice: 'independent_driver', services: [], country: 'GH' });
    expect(laterTypes(req)).toEqual(['PROFILE_PHOTO', 'PASSENGER_TRANSPORT_LICENCE', 'DRIVERS_LICENCE']);
    expect(req.vehicles).toBe('required');
    expect(req.guides).toBe('hidden');
  });

  it('gates public liability to tour businesses only', () => {
    const tourBusiness = requirementsFor({ supplierChoice: 'registered_company', services: ['Tours & Activities'], country: 'GH' });
    expect(types(tourBusiness)).toContain('PUBLIC_LIABILITY_INSURANCE');

    const noTours = requirementsFor({ supplierChoice: 'registered_company', services: ['Airport Transfers'], country: 'GH' });
    expect(types(noTours)).not.toContain('PUBLIC_LIABILITY_INSURANCE');
  });
});

describe('document shape (what the dashboard renders)', () => {
  it('only marks up-front documents as enforced; later ones stay advisory', () => {
    const req = requirementsFor({ supplierChoice: 'registered_company', services: ['Tours & Activities'], country: 'GH' });
    for (const doc of req.documents) {
      expect(doc.enforced).toBe(doc.timing === 'upfront');
      expect(doc.label).toBeTruthy();
      expect(doc.detail).toBeTruthy();
    }
  });

  it('labels every document type — including the four vehicle types and public liability', () => {
    expect(DOCUMENT_LABELS.VEHICLE_REGISTRATION).toBe('Vehicle registration');
    expect(DOCUMENT_LABELS.VEHICLE_OWNERSHIP).toBe('Vehicle ownership document');
    expect(DOCUMENT_LABELS.VEHICLE_ROADWORTHINESS).toBe('Roadworthiness certificate');
    expect(DOCUMENT_LABELS.VEHICLE_INSURANCE).toBe('Vehicle insurance');
    expect(DOCUMENT_LABELS.PUBLIC_LIABILITY_INSURANCE).toBe('Public liability / activity insurance');
    expect(DOCUMENT_LABELS.OTHER).toBe('Other document');
    // No label falls back to the "Other" placeholder for a real type.
    for (const label of Object.values(DOCUMENT_LABELS)) {
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('flags vehicle documents as owned by the vehicle for the repair path', () => {
    const req = requirementsFor({ supplierChoice: 'transport_company', services: [], country: 'GH' });
    for (const doc of req.vehicleDocuments) {
      expect(doc.ownerType).toBe('VEHICLE');
      expect(doc.timing).toBe('per_vehicle');
      expect(doc.required).toBe(true);
    }
    for (const doc of req.guideDocuments) {
      expect(doc.ownerType).toBe('GUIDE');
      expect(doc.timing).toBe('per_guide');
    }
  });
});

describe('matrix snapshot — every card × every service combination', () => {
  const combos = [
    [],
    ['Tours & Activities'],
    ['Airport Transfers'],
    ['Tours & Activities', 'Airport Transfers', 'Private Transport'],
  ];
  const comboLabel = (services) =>
    services.map((s) => (s === 'Tours & Activities' ? 'Tours' : s === 'Airport Transfers' ? 'Transfers' : 'Private')).join('+') || 'none';

  it('produces a stable, complete snapshot', () => {
    const snapshot = {};
    for (const choice of SUPPLIER_CHOICE_IDS) {
      for (const services of combos) {
        const req = requirementsFor({ supplierChoice: choice, services, country: 'GH' });
        snapshot[`${choice}[${comboLabel(services)}]`] = {
          documents: types(req),
          vehicles: req.vehicles,
          guides: req.guides,
          vehicleDocuments: req.vehicleDocuments.map((d) => d.type),
          guideDocuments: req.guideDocuments.map((d) => d.type),
        };
      }
    }
    expect(snapshot['registered_company[Tours]']).toEqual({
      documents: ['GHANA_CARD', 'BUSINESS_CERTIFICATE', 'PROFILE_PHOTO', 'PROOF_OF_ADDRESS', 'GTA_CERTIFICATE', 'PUBLIC_LIABILITY_INSURANCE'],
      vehicles: 'hidden',
      guides: 'required',
      vehicleDocuments: [],
      guideDocuments: ['TOUR_GUIDE_LICENCE'],
    });
    expect(snapshot['individual_guide[none]']).toEqual({
      documents: ['GHANA_CARD', 'PROFILE_PHOTO', 'TOUR_GUIDE_LICENCE'],
      vehicles: 'hidden',
      guides: 'hidden',
      vehicleDocuments: [],
      guideDocuments: [],
    });
    expect(snapshot['experience_host[Tours]']).toEqual({
      documents: ['GHANA_CARD', 'PROFILE_PHOTO'],
      vehicles: 'hidden',
      guides: 'hidden',
      vehicleDocuments: [],
      guideDocuments: [],
    });
    expect(snapshot['transport_company[Transfers]']).toEqual({
      documents: ['GHANA_CARD', 'BUSINESS_CERTIFICATE', 'PROFILE_PHOTO', 'PROOF_OF_ADDRESS', 'PASSENGER_TRANSPORT_LICENCE', 'DRIVERS_LICENCE'],
      vehicles: 'required',
      guides: 'optional',
      vehicleDocuments: ['VEHICLE_REGISTRATION', 'VEHICLE_OWNERSHIP', 'VEHICLE_ROADWORTHINESS', 'VEHICLE_INSURANCE'],
      guideDocuments: ['TOUR_GUIDE_LICENCE'],
    });
    expect(snapshot['independent_driver[none]']).toEqual({
      documents: ['GHANA_CARD', 'PROFILE_PHOTO', 'PASSENGER_TRANSPORT_LICENCE', 'DRIVERS_LICENCE'],
      vehicles: 'required',
      guides: 'hidden',
      vehicleDocuments: ['VEHICLE_REGISTRATION', 'VEHICLE_OWNERSHIP', 'VEHICLE_ROADWORTHINESS', 'VEHICLE_INSURANCE'],
      guideDocuments: [],
    });
  });

  it('matches every wizard card to a real supplier type via SUPPLIER_CHOICES', () => {
    for (const choice of SUPPLIER_CHOICE_IDS) {
      const meta = SUPPLIER_CHOICES[choice];
      expect(meta.supplierType).toMatch(/^(TOUR_COMPANY|TOUR_GUIDE|OTHER_SERVICE_PROVIDER|TRANSPORTATION_PROVIDER|VEHICLE_OPERATOR)$/);
      expect(['company', 'individual']).toContain(meta.businessType);
      expect(['business', 'individual']).toContain(meta.kind);
      expect(meta.label).toBeTruthy();
    }
  });
});

describe('the 30-day documentation window', () => {
  const business = () =>
    requirementsFor({ supplierChoice: 'registered_company', services: ['Tours & Activities'], country: 'GH' });
  const guide = () => requirementsFor({ supplierChoice: 'individual_guide', services: [], country: 'GH' });

  it('is 30 days everywhere, and served on the requirements payload', () => {
    expect(DOCUMENTATION_GRACE_DAYS).toBe(30);
    for (const req of [business(), guide()]) {
      expect(req.documentationGraceDays).toBe(30);
    }
  });

  it('enforced set = a government ID, plus a business certificate for businesses', () => {
    expect(enforcedUpfrontRequirementTypes(business())).toEqual(['GHANA_CARD', 'BUSINESS_CERTIFICATE']);
    expect(enforcedUpfrontRequirementTypes(guide())).toEqual(['GHANA_CARD']);

    // Later, per-vehicle and per-guide documents are never part of the enforced set.
    const transport = requirementsFor({ supplierChoice: 'transport_company', services: ['Tours & Activities'], country: 'GH' });
    const enforced = enforcedUpfrontRequirementTypes(transport);
    for (const doc of transport.documents) {
      if (doc.timing !== 'upfront') expect(enforced).not.toContain(doc.type);
    }
    expect(enforcedUpfrontRequirementTypes({ documents: [] })).toEqual([]);
  });

  it('is satisfied when the enforced set is on file, with ID-alias handling', () => {
    expect(
      isEnforcedSetSatisfied({ requirements: business(), uploadedTypes: ['GHANA_CARD', 'BUSINESS_CERTIFICATE'] })
    ).toBe(true);
    expect(isEnforcedSetSatisfied({ requirements: business(), uploadedTypes: ['GHANA_CARD'] })).toBe(false);
    // A national ID satisfies the identity requirement like a Ghana Card does.
    expect(
      isEnforcedSetSatisfied({ requirements: business(), uploadedTypes: ['NATIONAL_ID', 'BUSINESS_CERTIFICATE'] })
    ).toBe(true);
    expect(isEnforcedSetSatisfied({ requirements: guide(), uploadedTypes: ['GHANA_CARD'] })).toBe(true);
    // Later documents alone never satisfy the enforced set.
    expect(
      isEnforcedSetSatisfied({ requirements: guide(), uploadedTypes: ['PROFILE_PHOTO', 'TOUR_GUIDE_LICENCE'] })
    ).toBe(false);
    expect(isEnforcedSetSatisfied({ requirements: guide(), uploadedTypes: [] })).toBe(false);
  });

  it('documentationDeadlineAfter lands exactly grace days later, clock-safely', () => {
    const start = new Date('2026-09-28T12:00:00.000Z');
    expect(documentationDeadlineAfter(start).toISOString()).toBe('2026-10-28T12:00:00.000Z');
    expect(documentationDeadlineAfter(start, 2).toISOString()).toBe('2026-09-30T12:00:00.000Z');
  });
});