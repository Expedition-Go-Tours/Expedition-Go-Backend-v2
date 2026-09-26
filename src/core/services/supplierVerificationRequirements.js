/**
 * Per-operator verification requirements — the single source of truth for what
 * each supplier type must provide, once at registration ("upfront") and later
 * from the supplier dashboard ("later").
 *
 * Mirrored by the supplier dashboard's Verification page and the admin review
 * panel, and used to derive the up-front subset that `apply` enforces, so the
 * checks and the UI cannot drift apart.
 */

const DOCUMENT_LABELS = {
  GHANA_CARD: 'Ghana Card',
  NATIONAL_ID: 'National ID',
  BUSINESS_CERTIFICATE: 'Business registration certificate',
  GTA_CERTIFICATE: 'Ghana Tourism Authority licence',
  TOUR_GUIDE_LICENCE: 'Tour guide licence',
  DRIVERS_LICENCE: "Driver's licence",
  PASSENGER_TRANSPORT_LICENCE: 'Passenger transport licence',
  PROFILE_PHOTO: 'Profile photograph',
  PROOF_OF_ADDRESS: 'Proof of address',
  OTHER: 'Other document',
};

/** Supplier types that trade as a business (need a business certificate). */
const BUSINESS_SUPPLIER_TYPES = new Set([
  'TOUR_COMPANY',
  'TRANSPORTATION_PROVIDER',
  'ACCOMMODATION_PROVIDER',
]);

/**
 * `operatingInfo.services` stores the storefront's labels ("Tours & Activities",
 * "Airport Transfers", "Private Transport", "Other Experience"), but older rows
 * may hold the raw ids — match on either, case-insensitively.
 */
function hasToursService(services = []) {
  return services.some((service) => /tour|experience|activit/.test(String(service).toLowerCase()));
}

function hasTransportService(services = []) {
  return services.some((service) =>
    /transport|transfer|airport|driver|chauffeur|shuttle|rental/.test(String(service).toLowerCase())
  );
}

function document(type, required, timing) {
  return { type, label: DOCUMENT_LABELS[type] || DOCUMENT_LABELS.OTHER, required, timing };
}

/**
 * The full verification profile for a supplier.
 *
 * @param {object} input
 * @param {string} input.supplierType Prisma SupplierType
 * @param {'company'|'individual'} [input.businessType] Distinguishes a
 *   registered company from a sole proprietor (both are TOUR_COMPANY).
 * @param {string[]} [input.services] `operatingInfo.services`
 * @param {string} [input.country] `businessInfo.country` (ISO 3166-1 alpha-2)
 * @returns {{ supplierType: string, documents: Array, vehicles: 'required'|'optional'|'hidden', guides: 'required'|'optional'|'hidden' }}
 */
function requirementsFor({ supplierType, businessType, services = [], country } = {}) {
  const type = String(supplierType || '').trim().toUpperCase();
  const isGhana = String(country || '').trim().toUpperCase() === 'GH';
  const identityType = isGhana ? 'GHANA_CARD' : 'NATIONAL_ID';
  const tours = hasToursService(services);
  const transport = hasTransportService(services);

  const documents = [document(identityType, true, 'upfront')];

  if (BUSINESS_SUPPLIER_TYPES.has(type)) {
    documents.push(document('BUSINESS_CERTIFICATE', true, 'upfront'));
  }

  // Later, type-specific documents.
  if (type === 'TOUR_COMPANY') {
    documents.push(document('PROFILE_PHOTO', true, 'later'));
    documents.push(document('PROOF_OF_ADDRESS', true, 'later'));
    if (tours) documents.push(document('GTA_CERTIFICATE', true, 'later'));
  } else if (type === 'ACCOMMODATION_PROVIDER') {
    documents.push(document('PROFILE_PHOTO', true, 'later'));
  } else if (type === 'TRANSPORTATION_PROVIDER') {
    documents.push(document('PASSENGER_TRANSPORT_LICENCE', true, 'later'));
    documents.push(document('PROFILE_PHOTO', true, 'later'));
  } else if (type === 'VEHICLE_OPERATOR') {
    documents.push(document('PASSENGER_TRANSPORT_LICENCE', true, 'later'));
    documents.push(document('DRIVERS_LICENCE', true, 'later'));
    documents.push(document('PROFILE_PHOTO', true, 'later'));
  } else if (type === 'TOUR_GUIDE') {
    documents.push(document('PROFILE_PHOTO', true, 'later'));
    documents.push(document('TOUR_GUIDE_LICENCE', true, 'later'));
    if (transport) documents.push(document('DRIVERS_LICENCE', true, 'later'));
  } else {
    // OTHER_SERVICE_PROVIDER and anything unknown.
    documents.push(document('PROFILE_PHOTO', true, 'later'));
  }

  // Entities (vehicles / guides) relevant to this operator.
  let vehicles = 'hidden';
  let guides = 'hidden';

  if (type === 'TRANSPORTATION_PROVIDER' || type === 'VEHICLE_OPERATOR') {
    vehicles = 'required';
  } else if (transport) {
    vehicles = 'optional';
  }

  if (type === 'TOUR_COMPANY') {
    // A registered company is expected to work with guides; a sole proprietor
    // may act alone, so the section is offered rather than required.
    guides = businessType === 'company' ? 'required' : 'optional';
  } else if (type === 'TRANSPORTATION_PROVIDER') {
    guides = 'optional';
  }

  return { supplierType: type, documents, vehicles, guides };
}

/** The subset collected at registration — what `apply` enforces. */
function upfrontSupplierDocumentTypes(supplierType, country) {
  return requirementsFor({ supplierType, country }).documents
    .filter((doc) => doc.timing === 'upfront' && doc.required)
    .map((doc) => doc.type);
}

module.exports = {
  DOCUMENT_LABELS,
  requirementsFor,
  upfrontSupplierDocumentTypes,
};
